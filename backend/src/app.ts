// HTTP layer: auth, permission checks, JSON API, server-sent events, and static files.
// Built on node:http only, so there is no framework to keep patched.

import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import type { AiStatus, DateRange, Job, LiveAgentId, OrderPick, Permission, ReportType, SessionUser } from '../shared/live';
import { shopCounts } from './reports/calc';
import { LiveRefresher } from './live/refresher';
import { FB_MAX_SCHEDULE_DAYS, FB_MIN_SCHEDULE_MINUTES, MAX_IMAGE_BYTES, MAX_POST_CHARS, type FacebookStatus } from '../shared/live';
import { FacebookClient, FacebookError, type PostResult } from './social/facebook';
import { manilaDate, validateRange } from '../shared/manila';
import type { FinanceSource, OrderSource } from './adapters/types';
import { Auth, SESSION_COOKIE, parseCookies } from './auth';
import type { AppConfig } from './config';
import { JOB_DEFS, JobRunner, SubmitError, checkImage, jobTypesFor } from './jobs/runner';
import { IntegrationError } from './http/errors';

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
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
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
  const liveEvent = (name: string, v: unknown) => `event: ${name}\ndata: ${JSON.stringify(name === 'shop' ? { shop: v } : { posts: v })}\n\n`;
  const refresher = new LiveRefresher(
    [
      {
        name: 'shop',
        read: async () => {
          if (deps.orders.status().state !== 'ready') return null;
          const open = await deps.orders.listOpenOrders();
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
      if (s === 'throttled') return send(res, 429, { error: 'Too many failed sign-in attempts. Try again in a few minutes.' });
      if (!s) return send(res, 401, { error: 'Incorrect username or password.' });
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
        return send(res, 413, { error: 'The request is too large. Use a smaller photo.' });
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
        );
        return send(res, deduplicated ? 200 : 202, { job: structuredClone(job), deduplicated });
      } catch (e) {
        if (e instanceof SubmitError) return send(res, e.status, { error: e.message });
        throw e;
      }
    }
    if (path.startsWith('/api/facebook/')) return handleFacebook(req, res, path, method, s.user);

    // The Workshop room: how many open orders are at each production stage (counts only).
    if (path === '/api/orders/workshop' && method === 'GET') {
      if (!s.user.permissions.includes('orders:read')) return send(res, 403, { error: 'Your account cannot read orders.' });
      try {
        const open = await deps.orders.listOpenOrders();
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
        const open = await deps.orders.listOpenOrders();
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

    if (path === '/api/facebook/posts' && method === 'POST') {
      if (!csrfOk(req)) return send(res, 403, { error: 'Request blocked by cross-site protection.' });
      let body: Record<string, unknown>;
      try {
        body = await readJson(req, Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 64 * 1024);
      } catch {
        return send(res, 413, { error: 'The request is too large. Use a smaller photo.' });
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
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
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
  };
}
