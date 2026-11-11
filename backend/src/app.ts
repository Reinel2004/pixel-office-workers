// HTTP layer: auth, permission checks, JSON API, server-sent events, and static files.
// Built on node:http only, so there is no framework to keep patched.

import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import type { AiStatus, DateRange, Discussion, DiscussionInput, Job, LiveAgentId, OrderPick, Permission, ReportType, SessionUser, UiReview, UiReviewInput, UiVerifyInput } from '../shared/live';
import { ORDER_REF_PATTERN, UI_REVIEW_LIMITS } from '../shared/live';
import { buildChecklist } from '../shared/qc';
import { UiReviewError, type UiReviewService } from './uireview/uireview';
import { shopCounts } from './reports/calc';
import { LiveRefresher } from './live/refresher';
import { HealthLog, SecurityLog } from './monitor/monitor';
import { DiscussionError, type DiscussionService } from './discuss/discussions';
import { FB_MAX_SCHEDULE_DAYS, FB_MIN_SCHEDULE_MINUTES, MAX_IMAGE_BYTES, MAX_POST_CHARS, VIDEO_CHUNK_BYTES, type FacebookStatus, CATALOG_MAX_IMAGE_BYTES, type CatalogAddResult, type CatalogProductInput, type CatalogStatus } from '../shared/live';
import { FacebookClient, FacebookError, type PostResult } from './social/facebook';
import { readRaw, VideoUploadError, type VideoUploads } from './social/videos';
import { manilaDate, validateRange } from '../shared/manila';
import type { FinanceSource, OrderSource } from './adapters/types';
import { Auth, SESSION_COOKIE, parseCookies } from './auth';
import type { AppConfig } from './config';
import { JOB_DEFS, JobRunner, SubmitError, checkImage, jobTypesFor } from './jobs/runner';
import { IntegrationError } from './http/errors';
import { validateLimits, type AiUsageMeter } from './ai/usage';
import { buildAttention, ordersWebUrl } from './attention/attention';
import type { OrderRecord } from './adapters/types';
import { CatalogError, checkCatalogImage, checkProduct, type CatalogClient } from './catalog/catalog';

export interface AppDeps {
  config: AppConfig;
  auth: Auth;
  runner: JobRunner;
  finance: FinanceSource;
  orders: OrderSource;
  /** Whether free-text AI tasks are available (never includes the key). */
  aiStatus?: () => AiStatus;
  /** Facebook Page posting, when configured. */
  facebook?: FacebookClient | null;
  /** Task log (who posted what, when; never the token or photo). */
  audit?: (entry: Record<string, unknown>) => void;
  /** Response times and failures of outgoing calls (for the Systems Monitor). */
  health?: HealthLog;
  /** Team discussions (bounded multi-agent AI); absent when not wired (e.g. some tests). */
  discussions?: DiscussionService | null;
  /** UI Review (Aya, Kim, Rey); absent when not wired. */
  uiReviews?: UiReviewService | null;
  /** Video uploads for Facebook video posts; absent when not wired. */
  videos?: VideoUploads | null;
  /** AI usage tracker (requests, tokens, limits); absent when not wired. */
  aiUsage?: AiUsageMeter | null;
  /** The online catalog (Kat adds approved products); absent when not set up. */
  catalog?: CatalogClient | null;
  log?: (line: string) => void;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, limit = 16 * 1024): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error('too large');
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  const v = JSON.parse(text);
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
  return v as Record<string, unknown>;
}

/**
 * The visitor's address, for sign-in throttling. Behind a proxy (TRUST_PROXY=true) every request
 * comes from the proxy, so the first X-Forwarded-For entry is used instead. That header can be
 * forged by someone calling the server directly, which is why sign-in is also throttled per
 * username (see Auth.login).
 */
function clientKey(req: IncomingMessage, trustProxy: boolean) {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  return req.socket.remoteAddress ?? 'unknown';
}

export function createApp(deps: AppDeps) {
  const { config, auth, runner } = deps;
  const streams = new Map<ServerResponse, { user: SessionUser; sessionId: string }>();

  runner.on('job', (job: Job) => {
    for (const [res, s] of streams) {
      if (!auth.get(s.sessionId)) {
        res.write(`event: session-expired\ndata: {}\n\n`);
        res.end();
        streams.delete(res);
        continue;
      }
      if (s.user.username === job.requestedBy) res.write(`event: job\ndata: ${JSON.stringify(job)}\n\n`);
    }
  });
  // Live updates (Workshop carpenters, scheduled Facebook posts): one shared check every
  // config.liveRefreshMs, only while someone has the office open; changes are pushed to each open
  // office whose account may see them.
  const LIVE_PERMISSION: Record<string, Permission> = { shop: 'orders:read', 'fb-scheduled': 'social:post' };
  // The open orders are read for the Workshop, Joy's picker and the Attention list. The last read is
  // kept for a few minutes so the Attention list normally needs no extra request.
  let openCache: { at: number; orders: OrderRecord[] } | null = null;
  let openFail: { at: number; error: string } | null = null;
  let openInflight: Promise<OrderRecord[]> | null = null;
  const readOpen = async () => {
    const orders = await deps.orders.listOpenOrders();
    openCache = { at: Date.now(), orders };
    openFail = null;
    return orders;
  };
  const cachedOpen = async (): Promise<{ orders: OrderRecord[] | null; error: string | null }> => {
    if (deps.orders.status().state !== 'ready') return { orders: null, error: null }; // shown as a connection problem instead
    const fresh = Math.max(config.liveRefreshMs * 1.5, 180_000);
    if (openCache && Date.now() - openCache.at < fresh) return { orders: openCache.orders, error: null };
    if (openFail && Date.now() - openFail.at < 60_000) return { orders: openCache?.orders ?? null, error: openFail.error };
    openInflight ??= readOpen().finally(() => (openInflight = null));
    try {
      return { orders: await openInflight, error: null };
    } catch (e) {
      const error = e instanceof IntegrationError ? e.message : 'The order system could not be read.';
      openFail = { at: Date.now(), error };
      return { orders: openCache?.orders ?? null, error };
    }
  };
  const liveEvent = (name: string, v: unknown) => `event: ${name}\ndata: ${JSON.stringify(name === 'shop' ? { shop: v } : { posts: v })}\n\n`;
  const refresher = new LiveRefresher(
    [
      {
        name: 'shop',
        read: async () => {
          if (deps.orders.status().state !== 'ready') return null;
          const open = await readOpen();
          return shopCounts(open, deps.orders.carpenterRoster ?? null, deps.orders.capabilities.carpenters === true, manilaDate(), new Date().toISOString());
        },
        fingerprint: (v) => ({ ...(v as Record<string, unknown>), asOf: undefined }),
      },
      { name: 'fb-scheduled', read: async () => (deps.facebook ? deps.facebook.scheduled() : null) },
    ],
    {
      intervalMs: config.liveRefreshMs,
      maxBackoffMs: 15 * 60_000,
      hasListeners: () => streams.size > 0,
      onChange: (name, v) => {
        if (v === null) return;
        for (const [res, s] of streams) if (s.user.permissions.includes(LIVE_PERMISSION[name])) res.write(liveEvent(name, v));
      },
      log: deps.log,
    },
  );

  // ---------------------------------------------------------------- Systems team (Sam, Ivy)
  const security = new SecurityLog();
  const startedAt = Date.now();
  /** Refused requests, classified once the response is sent (sign-ins are recorded in their route). */
  const noteRefusal = (req: IncomingMessage, res: ServerResponse, path: string, source: string) => {
    const code = res.statusCode;
    if (path === '/api/auth/login' && code !== 403) return;
    const user = session(req)?.user.username ?? null;
    if (code === 403) {
      const mutating = req.method !== 'GET' && req.method !== 'HEAD';
      security.record(mutating && !csrfOk(req) ? 'csrf_blocked' : 'permission_denied', { user, source, path });
    } else if (code === 429) security.record('rate_limited', { user, source, path });
    else if (code === 401 && path !== '/api/auth/me' && path !== '/api/events') security.record('not_signed_in', { source, path });
  };
  const healthReport = () => {
    const sys = (id: 'orders' | 'finance') => {
      const st = id === 'orders' ? deps.orders.status() : deps.finance.status();
      return { id, name: st.name, setup: st.state, problems: st.problems, ...(deps.health?.summary(id) ?? {}) };
    };
    const ai = aiStatus();
    return {
      asOf: new Date().toISOString(),
      server: {
        mode: config.production ? 'production' : 'development',
        uptimeMinutes: Math.round((Date.now() - startedAt) / 60_000),
        memoryMB: Math.round(process.memoryUsage().rss / 1_048_576),
        nodeVersion: process.version,
        signedInSessions: auth.activeCount(),
        openOffices: streams.size,
      },
      systems: [sys('orders'), sys('finance')],
      ai: {
        setup: ai.ready ? 'ready' : 'not_configured',
        model: ai.model,
        problems: ai.problems,
        ...(deps.health?.summary('gemini') ?? {}),
        ...(deps.aiUsage ? { usage: deps.aiUsage.summary() } : {}),
      },
      facebook: {
        setup: deps.facebook ? 'ready' : 'not_configured',
        problems: deps.facebook ? [] : config.facebook.problems,
        appSecretProof: !!config.facebook.appSecret,
        ...(deps.health?.summary('facebook') ?? {}),
      },
      catalog: {
        setup: deps.catalog ? 'ready' : 'not_configured',
        repo: config.catalog.repo,
        problems: deps.catalog ? [] : config.catalog.problems,
        ...(deps.health?.summary('github') ?? {}),
      },
      liveUpdates: refresher.status(),
      tasks: runner.stats(),
      notes: [
        'Request counts and times cover the last 24 hours since the server started; they are kept in memory only and reset on restart.',
        'failuresByStatus: 401/403 usually mean a wrong or expired token, 429 too many requests, 5xx a problem on that system, TIMEOUT or NETWORK that it could not be reached.',
      ],
    };
  };
  const securityReport = (hours: number) => {
    const warnings: string[] = [];
    if (config.production && !config.cookieSecure) warnings.push('Production without secure cookies (APP_COOKIE_SECURE should be true).');
    if (config.production && !config.appOrigin) warnings.push('APP_ORIGIN is not set in production.');
    if (config.production && config.allowInsecureLocal) warnings.push('Insecure local connections are allowed in production.');
    if (deps.facebook && !config.facebook.appSecret) warnings.push('Facebook App Secret is not set, so requests are sent without appsecret_proof.');
    const admins = config.users.filter((u) => u.role === 'admin').length;
    if (admins > 3) warnings.push(`${admins} accounts have the admin role; consider fewer.`);
    return {
      asOf: new Date().toISOString(),
      ...security.summary(hours),
      settings: {
        mode: config.production ? 'production' : 'development',
        secureCookies: config.cookieSecure,
        appOriginSet: !!config.appOrigin,
        behindProxy: config.trustProxy,
        accounts: config.users.length,
        accountsByRole: config.users.reduce<Record<string, number>>((m, u) => ((m[u.role] = (m[u.role] ?? 0) + 1), m), {}),
        sessionHours: Math.round(config.sessionTtlMs / 3_600_000),
        warnings,
      },
      notes: [
        'Events are kept in server memory for up to 7 days and reset on restart. Client addresses are never stored, only an anonymous fingerprint to count distinct sources.',
        'A few failed sign-ins are normal (typos). Many failures from one source, or for usernames that do not exist, can mean someone is guessing passwords.',
      ],
    };
  };
  const monitor = { health: healthReport, security: securityReport };

  // Team discussions: progress goes only to the owner's open offices.
  deps.discussions?.on('discussion', (d: Discussion) => {
    for (const [res, s] of streams) if (s.user.username === d.owner) res.write(`event: discussion\ndata: ${JSON.stringify(d)}\n\n`);
  });

  // UI Reviews: progress goes only to the owner's open offices (never the screenshots).
  deps.uiReviews?.on('review', (r: UiReview) => {
    for (const [res, s] of streams) if (s.user.username === r.owner) res.write(`event: uireview\ndata: ${JSON.stringify(r)}\n\n`);
  });

  const heartbeat = setInterval(() => {
    for (const [res, s] of streams) {
      if (!auth.get(s.sessionId)) {
        res.write(`event: session-expired\ndata: {}\n\n`);
        res.end();
        streams.delete(res);
      } else res.write(`: ping\n\n`);
    }
    auth.sweep();
  }, 25_000);
  heartbeat.unref?.();

  const systems = () => [deps.finance.status(), deps.orders.status()];
  const aiStatus = (): AiStatus => deps.aiStatus?.() ?? { ready: false, provider: 'gemini', model: null, problems: ['GEMINI_API_KEY is not set.'] };

  /** Same-origin protection for state-changing requests (on top of SameSite=Strict cookies). */
  function csrfOk(req: IncomingMessage) {
    if (req.headers['x-wad-request'] !== '1') return false;
    const origin = req.headers.origin;
    if (!origin) return true;
    if (config.appOrigin) return origin === config.appOrigin;
    const host = req.headers.host;
    return !!host && (origin === `http://${host}` || origin === `https://${host}`);
  }

  function session(req: IncomingMessage) {
    return auth.get(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL) {
    const method = req.method ?? 'GET';
    const path = url.pathname;

    if (path === '/api/health' && method === 'GET') return send(res, 200, { ok: true, service: 'wad-ai-office' });

    if (path === '/api/auth/login' && method === 'POST') {
      if (!csrfOk(req)) return send(res, 403, { error: 'Request blocked by cross-site protection.' });
      let body: Record<string, unknown>;
      try {
        body = await readJson(req);
      } catch {
        return send(res, 400, { error: 'Invalid request body.' });
      }
      const username = typeof body.username === 'string' ? body.username.slice(0, 64) : '';
      const password = typeof body.password === 'string' ? body.password.slice(0, 256) : '';
      if (!username || !password) return send(res, 400, { error: 'Enter your username and password.' });
      const s = await auth.login(username, password, clientKey(req, config.trustProxy));
      // Security log: a real account name only; what someone typed for an unknown account is not kept.
      const known = config.users.some((u) => u.username === username);
      const who = { user: known ? username : null, unknownUser: !known, source: clientKey(req, config.trustProxy), path };
      if (s === 'throttled') {
        security.record('login_throttled', who);
        return send(res, 429, { error: 'Too many failed sign-in attempts. Try again in a few minutes.' });
      }
      if (!s) {
        security.record('login_failed', who);
        return send(res, 401, { error: 'Incorrect username or password.' });
      }
      security.record('login_ok', who);
      deps.log?.(`[auth] sign-in ok user=${s.user.username}`);
      return send(res, 200, { user: s.user }, { 'Set-Cookie': auth.cookie(s) });
    }

    const s = session(req);

    if (path === '/api/auth/logout' && method === 'POST') {
      if (!csrfOk(req)) return send(res, 403, { error: 'Request blocked by cross-site protection.' });
      auth.logout(s?.id);
      return send(res, 200, { ok: true }, { 'Set-Cookie': auth.cookie(null) });
    }

    if (!s) return send(res, 401, { error: 'Sign in to use Connected Mode.', code: 'SIGNED_OUT' });

    if (path === '/api/auth/me' && method === 'GET') return send(res, 200, { user: s.user });
    if (path === '/api/systems' && method === 'GET') return send(res, 200, { systems: systems() });
    if (path === '/api/report-types' && method === 'GET')
      return send(res, 200, { types: jobTypesFor(s.user), maxRangeDays: config.maxRangeDays, ai: aiStatus() });

    if (path === '/api/ai/tasks' && method === 'POST') {
      if (!csrfOk(req)) return send(res, 403, { error: 'Request blocked by cross-site protection.' });
      let body: Record<string, unknown>;
      try {
        // Room for one photo (base64 is about 4/3 of the photo's size).
        body = await readJson(req, Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 64 * 1024);
      } catch {
        // The rest of the upload is never read, so this connection cannot be reused: close it.
        return send(res, 413, { error: 'The request is too large. Use a smaller photo.' }, { Connection: 'close' });
      }
      if (typeof body.agent !== 'string' || typeof body.prompt !== 'string') return send(res, 400, { error: 'Choose an agent and type a task.' });
      const img = body.image as { mimeType?: unknown; data?: unknown } | undefined;
      if (img !== undefined && (typeof img !== 'object' || img === null || typeof img.mimeType !== 'string' || typeof img.data !== 'string'))
        return send(res, 400, { error: 'The photo could not be read.' });
      if (body.orderRef !== undefined && typeof body.orderRef !== 'string') return send(res, 400, { error: 'That order number is not valid.' });
      try {
        const { job, deduplicated } = runner.submitAi(
          s.user,
          body.agent as LiveAgentId,
          body.prompt,
          img ? { mimeType: img.mimeType as string, data: img.data as string } : undefined,
          body.orderRef as string | undefined,
          typeof body.key === 'string' ? body.key.slice(0, 64) : undefined,
          body.video,
        );
        return send(res, deduplicated ? 200 : 202, { job: structuredClone(job), deduplicated });
      } catch (e) {
        if (e instanceof SubmitError) return send(res, e.status, { error: e.message });
        throw e;
      }
    }
    // AI usage tracker: totals for admin and manager accounts; limits and prices for admins.
    if (path === '/api/ai/usage' && method === 'GET') {
      if (!s.user.permissions.includes('ai:usage')) return send(res, 403, { error: 'Your account cannot see AI usage.' });
      if (!deps.aiUsage) return send(res, 503, { error: 'AI usage tracking is not available on this server.' });
      return send(res, 200, { usage: deps.aiUsage.report(s.user) });
    }
    if (path === '/api/ai/usage/limits' && method === 'POST') {
      if (!csrfOk(req)) return send(res, 403, { error: 'Request blocked by cross-site protection.' });
      if (!s.user.permissions.includes('ai:limits')) return send(res, 403, { error: 'Only admin accounts can change AI limits.' });
      if (!deps.aiUsage) return send(res, 503, { error: 'AI usage tracking is not available on this server.' });
      let body: Record<string, unknown>;
      try {
        body = await readJson(req, 4 * 1024);
      } catch {
        return send(res, 400, { error: 'Invalid request body.' });
      }
      const before = deps.aiUsage.limits;
      if (body.reset === true) deps.aiUsage.setLimits(null);
      else {
        const v = validateLimits(body.limits);
        if ('error' in v) return send(res, 400, { error: v.error });
        deps.aiUsage.setLimits(v.limits);
      }
      deps.audit?.({ event: 'ai-usage.limits', user: s.user.username, reset: body.reset === true, before, after: deps.aiUsage.limits, at: new Date().toISOString() });
      deps.log?.(`[ai-usage] limits ${body.reset === true ? 'reset to defaults' : 'changed'} by ${s.user.username}`);
      return send(res, 200, { usage: deps.aiUsage.report(s.user) });
    }
    // Attention needed: failed connections, blocked work, AI limits and overdue orders, for this user.
    if (path === '/api/attention' && method === 'GET') {
      const report = await buildAttention(s.user, {
        systems,
        health: deps.health,
        aiStatus,
        facebookProblems: () => (deps.facebook ? [] : config.facebook.problems.length ? config.facebook.problems : ['Facebook posting is not set up.']),
        jobs: (u) => runner.list(u),
        discussions: deps.discussions ? (u) => deps.discussions!.list(u) : undefined,
        uiReviews: deps.uiReviews && s.user.permissions.includes('ui:review') ? (u) => deps.uiReviews!.list(u) : undefined,
        aiUsage: deps.aiUsage,
        openOrders: cachedOpen,
        ordersWebUrl: ordersWebUrl(config.systems.orders.baseUrl),
      });
      return send(res, 200, { attention: report });
    }
    if (path.startsWith('/api/facebook/')) return handleFacebook(req, res, path, method, s.user);
    if (path.startsWith('/api/catalog/')) return handleCatalog(req, res, path, method, s.user);
    if (path === '/api/discussions' || path.startsWith('/api/discussions/')) return handleDiscussions(req, res, path, method, s.user);
    if (path === '/api/ui-reviews' || path.startsWith('/api/ui-reviews/')) return handleUiReviews(req, res, path, method, s.user);

    // Tess's inspection checklist for one order, built by code from its piece specifications.
    if (path === '/api/orders/checklist' && method === 'GET') {
      if (!s.user.permissions.includes('orders:read')) return send(res, 403, { error: 'Your account cannot read orders.' });
      const ref = url.searchParams.get('order') ?? '';
      if (!ORDER_REF_PATTERN.test(ref)) return send(res, 400, { error: 'That order number is not valid.' });
      if (!deps.orders.getOrderSpec) return send(res, 503, { error: 'This server cannot read order specifications.' });
      try {
        const spec = await deps.orders.getOrderSpec(ref);
        return send(res, 200, { checklist: buildChecklist(spec, new Date().toISOString()) });
      } catch (e) {
        if (e instanceof IntegrationError) return send(res, e.code === 'NOT_SUPPORTED' ? 404 : 502, { error: e.message, code: e.code });
        throw e;
      }
    }

    // The Workshop room: how many open orders are at each production stage (counts only).
    if (path === '/api/orders/workshop' && method === 'GET') {
      if (!s.user.permissions.includes('orders:read')) return send(res, 403, { error: 'Your account cannot read orders.' });
      try {
        const open = await readOpen();
        const available = deps.orders.capabilities.carpenters === true;
        return send(res, 200, { shop: shopCounts(open, deps.orders.carpenterRoster ?? null, available, manilaDate(), new Date().toISOString()) });
      } catch (e) {
        if (e instanceof IntegrationError) return send(res, 502, { error: e.message, code: e.code });
        throw e;
      }
    }

    // Open orders for Joy's order picker: number, customer name, status and due date only.
    if (path === '/api/orders/open' && method === 'GET') {
      if (!s.user.permissions.includes('orders:read')) return send(res, 403, { error: 'Your account cannot read orders.' });
      try {
        const open = await readOpen();
        const orders: OrderPick[] = open
          .map((o) => ({ ref: o.ref, customer: o.customerName?.trim() || null, status: o.status, dueDate: o.dueDate }))
          .sort((a, b) => (a.customer ?? '\uffff').localeCompare(b.customer ?? '\uffff') || a.ref.localeCompare(b.ref))
          .slice(0, 500);
        return send(res, 200, { orders });
      } catch (e) {
        if (e instanceof IntegrationError) return send(res, 502, { error: e.message, code: e.code });
        throw e;
      }
    }
    if (path === '/api/jobs' && method === 'GET') return send(res, 200, { jobs: runner.list(s.user) });

    if (path === '/api/jobs' && method === 'POST') {
      if (!csrfOk(req)) return send(res, 403, { error: 'Request blocked by cross-site protection.' });
      let body: Record<string, unknown>;
      try {
        body = await readJson(req);
      } catch {
        return send(res, 400, { error: 'Invalid request body.' });
      }
      const type = body.type as ReportType;
      if (typeof type !== 'string' || !(type in JOB_DEFS)) return send(res, 400, { error: 'Unknown report type.' });
      const range = { from: body.from, to: body.to } as DateRange;
      const problem = validateRange(range, config.maxRangeDays);
      if (problem) return send(res, 400, { error: problem });
      try {
        const { job, deduplicated } = runner.submit(s.user, type, range);
        return send(res, deduplicated ? 200 : 202, { job: structuredClone(job), deduplicated });
      } catch (e) {
        if (e instanceof SubmitError) return send(res, e.status, { error: e.message });
        throw e;
      }
    }

    const m = path.match(/^\/api\/jobs\/([0-9a-f-]{36})$/);
    if (m && method === 'GET') {
      const job = runner.get(m[1], s.user);
      return job ? send(res, 200, { job }) : send(res, 404, { error: 'Report not found.' });
    }
    // Task Board actions (owner only): cancel, reply to the agent, mark an answer complete.
    const act = path.match(/^\/api\/jobs\/([0-9a-f-]{36})\/(cancel|follow-up|complete)$/);
    if (act && method === 'POST') {
      if (!csrfOk(req)) return send(res, 403, { error: 'Request blocked by cross-site protection.' });
      let body: Record<string, unknown> = {};
      try {
        body = await readJson(req, 16 * 1024);
      } catch {
        return send(res, 400, { error: 'Invalid request body.' });
      }
      try {
        if (act[2] === 'cancel') return send(res, 200, { job: structuredClone(runner.cancel(s.user, act[1])) });
        if (act[2] === 'complete') return send(res, 200, { job: structuredClone(runner.complete(s.user, act[1])) });
        const { job, deduplicated } = runner.followUp(s.user, act[1], typeof body.text === 'string' ? body.text : '', typeof body.key === 'string' ? body.key.slice(0, 64) : undefined);
        return send(res, deduplicated ? 200 : 202, { job: structuredClone(job), deduplicated });
      } catch (e) {
        if (e instanceof SubmitError) return send(res, e.status, { error: e.message });
        throw e;
      }
    }

    if (path === '/api/events' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...SECURITY_HEADERS });
      res.write(`retry: 3000\n`);
      res.write(`event: snapshot\ndata: ${JSON.stringify({ user: s.user, systems: systems(), ai: aiStatus(), jobs: runner.list(s.user) })}\n\n`);
      streams.set(res, { user: s.user, sessionId: s.id });
      req.on('close', () => streams.delete(res));
      // The latest live values this account may see, then keep them coming while the office is open.
      for (const name of Object.keys(LIVE_PERMISSION)) {
        const v = refresher.latest(name);
        if (v !== null && s.user.permissions.includes(LIVE_PERMISSION[name])) res.write(liveEvent(name, v));
      }
      refresher.ensureRunning();
      return;
    }

    return send(res, 404, { error: 'Not found.' });
  }

  // ---------------------------------------------------------------- Facebook posting
  // Every post is approved by a person in the office (the AI never calls these).
  const fbKeys = new Map<string, { at: number; result?: PostResult; pending: boolean }>();
  const fbRecent = new Map<string, number[]>();

  async function facebookStatus(): Promise<FacebookStatus> {
    const fb = deps.facebook;
    if (!fb) return { configured: false, pageName: null, problems: config.facebook.problems.length ? config.facebook.problems : ['Facebook posting is not set up.'] };
    return { configured: true, pageName: await fb.pageName(), problems: [] };
  }

  function fbFail(res: ServerResponse, e: unknown) {
    if (e instanceof FacebookError) return send(res, e.httpStatus, { error: e.message, code: e.code });
    if (e instanceof SubmitError) return send(res, e.status, { error: e.message });
    throw e;
  }

  // ---------------------------------------------------------------- Catalog (Kat)
  // A person approves every product in the office; the AI never calls these. One approval (key)
  // adds at most one product, even if the button is pressed twice or the request is resent.
  const catKeys = new Map<string, { at: number; pending: boolean; result?: CatalogAddResult }>();
  const catRecent = new Map<string, number[]>();

  async function catalogStatus(): Promise<CatalogStatus> {
    const c = deps.catalog;
    if (!c) return { configured: false, repo: null, branch: null, siteUrl: config.catalog.siteUrl, products: null, problems: config.catalog.problems.length ? config.catalog.problems : ['The catalog is not set up.'] };
    try {
      return { configured: true, repo: c.repo, branch: c.branch, siteUrl: c.siteUrl, products: await c.productCount(), problems: [] };
    } catch (e) {
      return { configured: true, repo: c.repo, branch: c.branch, siteUrl: c.siteUrl, products: null, problems: [e instanceof CatalogError ? e.message : 'The catalog could not be read.'] };
    }
  }

  async function handleCatalog(req: IncomingMessage, res: ServerResponse, path: string, method: string, user: SessionUser) {
    if (!user.permissions.includes('catalog:write')) return send(res, 403, { error: 'Your account cannot add products to the catalog.' });
    if (path === '/api/catalog/status' && method === 'GET') return send(res, 200, { catalog: await catalogStatus() });
    if (path !== '/api/catalog/products' || method !== 'POST') return send(res, 404, { error: 'Not found.' });
    if (!csrfOk(req)) return send(res, 403, { error: 'Request blocked by cross-site protection.' });
    const c = deps.catalog;
    if (!c) return send(res, 503, { error: 'The catalog is not set up on the server (CATALOG_GITHUB_TOKEN).' });
    let body: Record<string, unknown>;
    try {
      body = await readJson(req, Math.ceil((CATALOG_MAX_IMAGE_BYTES * 4) / 3) + 32 * 1024);
    } catch {
      return send(res, 413, { error: 'The request is too large. Use a smaller photo.' }, { Connection: 'close' });
    }
    const key = typeof body.key === 'string' && /^[\w-]{8,64}$/.test(body.key) ? `${user.username}|${body.key}` : null;
    if (!key) return send(res, 400, { error: 'Missing request key.' });
    const seen = catKeys.get(key);
    if (seen?.pending) return send(res, 409, { error: 'This product is already being added.' });
    if (seen?.result) return send(res, 200, { product: seen.result, repeated: true });
    let product: CatalogProductInput;
    let image: ReturnType<typeof checkCatalogImage>;
    try {
      product = checkProduct(body.product);
      image = checkCatalogImage(body.image);
    } catch (e) {
      if (e instanceof CatalogError) return send(res, e.httpStatus, { error: e.message, code: e.code });
      throw e;
    }
    const now = Date.now();
    const recent = (catRecent.get(user.username) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= 20) return send(res, 429, { error: 'That is 20 products in the last hour. Please wait before adding more.' });
    catRecent.set(user.username, [...recent, now]);
    catKeys.set(key, { at: now, pending: true });
    for (const [k, v] of catKeys) if (now - v.at > 86_400_000) catKeys.delete(k);
    try {
      const result = await c.add(product, image, user.username);
      catKeys.set(key, { at: now, pending: false, result });
      deps.audit?.({ event: 'catalog.added', user: user.username, productId: result.productId, commit: result.commitSha, category: product.category, imageBytes: image.bytes, at: new Date().toISOString() });
      deps.log?.(`[catalog] product ${result.productId} added by ${user.username}`);
      return send(res, 200, { product: result, repeated: false });
    } catch (e) {
      // A timeout may still have gone through: keep the key blocked so a re-press can't add it twice.
      if (e instanceof CatalogError && e.code === 'TIMEOUT') catKeys.set(key, { at: now, pending: true });
      else catKeys.delete(key);
      deps.audit?.({ event: 'catalog.failed', user: user.username, code: e instanceof CatalogError ? e.code : 'ERROR', at: new Date().toISOString() });
      if (e instanceof CatalogError)
        return send(res, e.httpStatus, { error: e.code === 'TIMEOUT' ? `${e.message} It may still have been added: check the catalog before trying again.` : e.message, code: e.code });
      throw e;
    }
  }

  /**
   * Team discussions. Every route is limited to the signed-in owner; the discussion itself only
   * ever sees data this user's permissions allow (checked when the evidence is gathered).
   */
  async function handleDiscussions(req: IncomingMessage, res: ServerResponse, path: string, method: string, user: SessionUser) {
    const svc = deps.discussions;
    if (!svc) return send(res, 503, { error: 'Team discussions are not available on this server.' });
    if (path === '/api/discussions' && method === 'GET') return send(res, 200, { discussions: svc.list(user) });
    if (path === '/api/discussions' && method === 'POST') {
      if (!csrfOk(req)) return send(res, 403, { error: 'Request blocked by cross-site protection.' });
      let body: Record<string, unknown>;
      try {
        body = await readJson(req, 8 * 1024);
      } catch {
        return send(res, 400, { error: 'Invalid request body.' });
      }
      try {
        const { discussion, deduplicated } = svc.start(user, body as unknown as DiscussionInput);
        return send(res, deduplicated ? 200 : 202, { discussion, deduplicated });
      } catch (e) {
        if (e instanceof DiscussionError) return send(res, e.status, { error: e.message, ...(e.existingId ? { existingId: e.existingId } : {}) });
        throw e;
      }
    }
    const one = path.match(/^\/api\/discussions\/([0-9a-f-]{36})(\/cancel)?$/);
    if (one && method === 'GET' && !one[2]) {
      const d = svc.get(user, one[1]);
      return d ? send(res, 200, { discussion: d }) : send(res, 404, { error: 'Discussion not found.' });
    }
    if (one && method === 'POST' && one[2]) {
      if (!csrfOk(req)) return send(res, 403, { error: 'Request blocked by cross-site protection.' });
      const d = svc.cancel(user, one[1]);
      return d ? send(res, 200, { discussion: d }) : send(res, 404, { error: 'Discussion not found.' });
    }
    return send(res, 404, { error: 'Not found.' });
  }

  /**
   * UI Review. Every route is limited to the signed-in owner and the ui:review permission.
   * Screenshots are checked and kept in server memory only; the office never opens the page.
   */
  async function handleUiReviews(req: IncomingMessage, res: ServerResponse, path: string, method: string, user: SessionUser) {
    if (!user.permissions.includes('ui:review')) return send(res, 403, { error: 'Your account cannot use UI Review.' });
    const svc = deps.uiReviews;
    if (!svc) return send(res, 503, { error: 'UI Review is not available on this server.' });
    const fail = (e: unknown) => {
      if (e instanceof UiReviewError) return send(res, e.status, { error: e.message, ...(e.existingId ? { existingId: e.existingId } : {}) });
      throw e;
    };
    const body = async (): Promise<Record<string, unknown> | null> => {
      try {
        // Room for the screenshots (base64 is about 4/3 of their size).
        return await readJson(req, Math.ceil((UI_REVIEW_LIMITS.maxTotalBytes * 4) / 3) + 64 * 1024);
      } catch {
        // The rest of the upload is never read, so this connection cannot be reused: close it.
        send(res, 413, { error: 'The screenshots are too large. Use smaller ones.' }, { Connection: 'close' });
        return null;
      }
    };
    if (path === '/api/ui-reviews' && method === 'GET') return send(res, 200, { reviews: svc.list(user) });
    if (path === '/api/ui-reviews' && method === 'POST') {
      if (!csrfOk(req)) return send(res, 403, { error: 'Request blocked by cross-site protection.' });
      const b = await body();
      if (!b) return;
      try {
        const { review, deduplicated } = svc.start(user, b as unknown as UiReviewInput);
        deps.audit?.({ event: 'ui-review.started', user: user.username, reviewId: review.id, site: review.site, shots: review.before.length, at: new Date().toISOString() });
        return send(res, deduplicated ? 200 : 202, { review, deduplicated });
      } catch (e) {
        return fail(e);
      }
    }
    const one = path.match(/^\/api\/ui-reviews\/([0-9a-f-]{36})(?:\/(accept|verify|cancel))?$/);
    if (!one) return send(res, 404, { error: 'Not found.' });
    if (method === 'GET' && !one[2]) {
      const r = svc.get(user, one[1]);
      return r ? send(res, 200, { review: r }) : send(res, 404, { error: 'Review not found.' });
    }
    if (method !== 'POST' || !one[2]) return send(res, 404, { error: 'Not found.' });
    if (!csrfOk(req)) return send(res, 403, { error: 'Request blocked by cross-site protection.' });
    try {
      if (one[2] === 'cancel') {
        const r = svc.cancel(user, one[1]);
        return r ? send(res, 200, { review: r }) : send(res, 404, { error: 'Review not found.' });
      }
      const b = await body();
      if (!b) return;
      if (one[2] === 'accept') {
        const r = svc.accept(user, one[1], b.changes);
        return r ? send(res, 200, { review: r }) : send(res, 404, { error: 'Review not found.' });
      }
      const { review, deduplicated } = svc.verify(user, one[1], b as unknown as UiVerifyInput);
      if (!deduplicated) deps.audit?.({ event: 'ui-review.recheck', user: user.username, reviewId: review.id, at: new Date().toISOString() });
      return send(res, deduplicated ? 200 : 202, { review, deduplicated });
    } catch (e) {
      return fail(e);
    }
  }

  async function handleFacebook(req: IncomingMessage, res: ServerResponse, path: string, method: string, user: SessionUser) {
    if (!user.permissions.includes('social:post')) return send(res, 403, { error: 'Your account cannot post to Facebook.' });
    if (path === '/api/facebook/status' && method === 'GET') return send(res, 200, { facebook: await facebookStatus() });
    const fb = deps.facebook;
    if (!fb) return send(res, 503, { error: 'Facebook posting is not set up on the server (FACEBOOK_PAGE_ID / FACEBOOK_PAGE_TOKEN).' });

    if (path === '/api/facebook/scheduled' && method === 'GET') {
      try {
        return send(res, 200, { posts: await fb.scheduled() });
      } catch (e) {
        return fbFail(res, e);
      }
    }

    const del = path.match(/^\/api\/facebook\/scheduled\/([0-9_]{3,60})$/);
    if (del && method === 'DELETE') {
      if (!csrfOk(req)) return send(res, 403, { error: 'Request blocked by cross-site protection.' });
      try {
        await fb.cancel(del[1]);
        refresher.poke('fb-scheduled');
        deps.audit?.({ event: 'facebook.cancelled', user: user.username, postId: del[1], at: new Date().toISOString() });
        return send(res, 200, { ok: true });
      } catch (e) {
        if (e instanceof FacebookError && e.code !== 'INVALID')
          return send(res, e.httpStatus, { error: `${e.message} You can also cancel it in Meta Business Suite → Planner.`, code: e.code });
        return fbFail(res, e);
      }
    }

    // ---------------------------------------------------------------- videos
    // 1) POST /api/facebook/videos {bytes, mimeType}          -> an upload id
    // 2) PUT  /api/facebook/videos/:id?offset=N  (raw piece)   -> progress   (repeat)
    // 3) POST /api/facebook/videos/:id/post {message, scheduleAt} -> posting starts (202)
    // 4) GET  /api/facebook/videos/:id                         -> state, progress, the post
    if (path.startsWith('/api/facebook/videos')) {
      const vids = deps.videos;
      if (!vids) return send(res, 503, { error: 'Video posting is not available on this server.' });
      const vfail = (e: unknown) => {
        if (e instanceof VideoUploadError) return send(res, e.status, { error: e.message }, e.status === 413 ? { Connection: 'close' } : {});
        return fbFail(res, e);
      };
      if (method !== 'GET' && !csrfOk(req)) return send(res, 403, { error: 'Request blocked by cross-site protection.' });
      try {
        if (path === '/api/facebook/videos' && method === 'POST') {
          const body = await readJson(req, 4 * 1024).catch(() => null);
          if (!body) return send(res, 400, { error: 'Invalid request body.' });
          return send(res, 201, { upload: vids.create(user.username, body.bytes, body.mimeType) });
        }
        const one = path.match(/^\/api\/facebook\/videos\/([0-9a-f-]{36})(\/post)?$/);
        if (!one) return send(res, 404, { error: 'Not found.' });
        const id = one[1];
        if (!one[2] && method === 'GET') return send(res, 200, { upload: vids.status(user.username, id) });
        if (!one[2] && method === 'DELETE') {
          vids.discard(user.username, id);
          return send(res, 200, { ok: true });
        }
        if (!one[2] && method === 'PUT') {
          const offset = Number(new URL(req.url ?? '', 'http://x').searchParams.get('offset'));
          if (!Number.isSafeInteger(offset) || offset < 0) return send(res, 400, { error: 'Missing offset.' });
          const chunk = await readRaw(req, VIDEO_CHUNK_BYTES);
          return send(res, 200, { upload: await vids.append(user.username, id, offset, chunk) });
        }
        if (one[2] && method === 'POST') {
          const body = await readJson(req, 16 * 1024).catch(() => null);
          if (!body) return send(res, 400, { error: 'Invalid request body.' });
          const message = typeof body.message === 'string' ? body.message.replace(/\r\n/g, '\n').trim() : '';
          if (!message) return send(res, 400, { error: 'Write the post text first.' });
          if (message.length > MAX_POST_CHARS) return send(res, 400, { error: `Keep the post under ${MAX_POST_CHARS} characters.` });
          let at: number | undefined;
          if (body.scheduleAt !== undefined && body.scheduleAt !== null) {
            const t = typeof body.scheduleAt === 'string' ? Date.parse(body.scheduleAt) : NaN;
            if (!Number.isFinite(t)) return send(res, 400, { error: 'Choose a valid date and time.' });
            if (t < Date.now() + FB_MIN_SCHEDULE_MINUTES * 60_000) return send(res, 400, { error: `Schedule at least ${FB_MIN_SCHEDULE_MINUTES} minutes ahead (Facebook's rule).` });
            if (t > Date.now() + FB_MAX_SCHEDULE_DAYS * 86_400_000) return send(res, 400, { error: `Facebook can schedule at most ${FB_MAX_SCHEDULE_DAYS} days ahead.` });
            at = Math.floor(t / 1000);
          }
          const current = vids.status(user.username, id);
          if (current.state === 'received') {
            const now = Date.now();
            const recent = (fbRecent.get(user.username) ?? []).filter((x) => now - x < 3_600_000);
            if (recent.length >= 10) return send(res, 429, { error: 'That is 10 posts in the last hour. Please wait before posting more.' });
            fbRecent.set(user.username, [...recent, now]);
          }
          const upload = vids.post(user.username, id, { message, at }, fb, {
            done: (r) => {
              if (at) refresher.poke('fb-scheduled');
              deps.audit?.({ event: at ? 'facebook.video.scheduled' : 'facebook.video.posted', user: user.username, postId: r.postId, scheduledAt: r.scheduledAt, messageChars: message.length, videoBytes: current.bytes, at: new Date().toISOString() });
            },
            failed: (e) => deps.audit?.({ event: 'facebook.video.failed', user: user.username, code: e instanceof FacebookError ? e.code : 'ERROR', at: new Date().toISOString() }),
          });
          return send(res, 202, { upload });
        }
        return send(res, 404, { error: 'Not found.' });
      } catch (e) {
        return vfail(e);
      }
    }

    if (path === '/api/facebook/posts' && method === 'POST') {
      if (!csrfOk(req)) return send(res, 403, { error: 'Request blocked by cross-site protection.' });
      let body: Record<string, unknown>;
      try {
        body = await readJson(req, Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 64 * 1024);
      } catch {
        // The rest of the upload is never read, so this connection cannot be reused: close it.
        return send(res, 413, { error: 'The request is too large. Use a smaller photo.' }, { Connection: 'close' });
      }
      const key = typeof body.key === 'string' && /^[\w-]{8,64}$/.test(body.key) ? `${user.username}|${body.key}` : null;
      if (!key) return send(res, 400, { error: 'Missing request key.' });
      // The same approval can only post once, even if the button is pressed twice or the request is resent.
      const seen = fbKeys.get(key);
      if (seen?.pending) return send(res, 409, { error: 'This post is already being sent.' });
      if (seen?.result) return send(res, 200, { post: seen.result, repeated: true });

      const message = typeof body.message === 'string' ? body.message.replace(/\r\n/g, '\n').trim() : '';
      if (!message) return send(res, 400, { error: 'Write the post text first.' });
      if (message.length > MAX_POST_CHARS) return send(res, 400, { error: `Keep the post under ${MAX_POST_CHARS} characters.` });
      let at: number | undefined;
      if (body.scheduleAt !== undefined && body.scheduleAt !== null) {
        const t = typeof body.scheduleAt === 'string' ? Date.parse(body.scheduleAt) : NaN;
        if (!Number.isFinite(t)) return send(res, 400, { error: 'Choose a valid date and time.' });
        const now = Date.now();
        if (t < now + FB_MIN_SCHEDULE_MINUTES * 60_000) return send(res, 400, { error: `Schedule at least ${FB_MIN_SCHEDULE_MINUTES} minutes ahead (Facebook's rule).` });
        if (t > now + FB_MAX_SCHEDULE_DAYS * 86_400_000) return send(res, 400, { error: `Facebook can schedule at most ${FB_MAX_SCHEDULE_DAYS} days ahead.` });
        at = Math.floor(t / 1000);
      }
      let image: { mimeType: string; data: string } | undefined;
      const img = body.image as { mimeType?: unknown; data?: unknown } | undefined;
      if (img !== undefined && img !== null) {
        if (typeof img !== 'object' || typeof img.mimeType !== 'string' || typeof img.data !== 'string') return send(res, 400, { error: 'The photo could not be read.' });
        try {
          const checked = checkImage('carlo', { mimeType: img.mimeType, data: img.data });
          image = { mimeType: checked.meta.mimeType, data: checked.data };
        } catch (e) {
          return fbFail(res, e);
        }
      }
      const now = Date.now();
      const recent = (fbRecent.get(user.username) ?? []).filter((t) => now - t < 3_600_000);
      if (recent.length >= 10) return send(res, 429, { error: 'That is 10 posts in the last hour. Please wait before posting more.' });
      fbRecent.set(user.username, [...recent, now]);

      fbKeys.set(key, { at: now, pending: true });
      for (const [k, v] of fbKeys) if (now - v.at > 86_400_000) fbKeys.delete(k);
      try {
        const result = await fb.publish({ message, image, at });
        if (at) refresher.poke('fb-scheduled');
        fbKeys.set(key, { at: now, pending: false, result });
        deps.audit?.({
          event: at ? 'facebook.scheduled' : 'facebook.posted',
          user: user.username,
          postId: result.postId,
          scheduledAt: result.scheduledAt,
          messageChars: message.length,
          ...(image ? { imageBytes: Math.floor((image.data.length * 3) / 4) } : {}),
          at: new Date().toISOString(),
        });
        return send(res, 200, { post: result, repeated: false });
      } catch (e) {
        // A timeout may still have posted: keep the key blocked so a quick re-press can't double-post.
        if (e instanceof FacebookError && e.code === 'TIMEOUT') fbKeys.set(key, { at: now, pending: true });
        else fbKeys.delete(key);
        deps.audit?.({ event: 'facebook.failed', user: user.username, code: e instanceof FacebookError ? e.code : 'ERROR', at: new Date().toISOString() });
        return fbFail(res, e);
      }
    }
    return send(res, 404, { error: 'Not found.' });
  }

  function serveStatic(_req: IncomingMessage, res: ServerResponse, url: URL) {
    if (!config.staticDir) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
      return res.end('This is the WAD AI Office API server. Open the office through its front end.');
    }
    const root = resolve(config.staticDir);
    if (!existsSync(root)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Front-end not built. Run `npm run build`, or use `npm run dev` during development.');
    }
    let rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    let file = join(root, rel);
    if (!file.startsWith(root)) {
      res.writeHead(403);
      return res.end();
    }
    if (!existsSync(file) || statSync(file).isDirectory()) {
      rel = 'index.html';
      file = join(root, rel);
    }
    const type = MIME[extname(file)] ?? 'application/octet-stream';
    const cache = rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache, ...SECURITY_HEADERS });
    createReadStream(file).pipe(res);
  }

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        // The client address is read now: once the response ends the connection may already be gone.
        let source = 'unknown';
        try {
          source = clientKey(req, config.trustProxy);
        } catch {
          /* no socket address */
        }
        res.once('finish', () => {
          try {
            noteRefusal(req, res, url.pathname, source);
          } catch {
            /* the security log must never break a request */
          }
        });
        await handleApi(req, res, url);
      }
      else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, url);
      else send(res, 405, { error: 'Method not allowed.' });
    } catch {
      deps.log?.(`[http] internal error on ${req.method} ${url.pathname}`);
      if (!res.headersSent) send(res, 500, { error: 'Unexpected server error.' });
      else res.end();
    }
  };
  return {
    handler,
    close: () => {
      clearInterval(heartbeat);
      refresher.stop();
    },
    streams,
    refresher,
    monitor,
  };
}
