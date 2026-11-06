// HTTP layer: auth, permission checks, JSON API, server-sent events, and static files.
// Built on node:http only, so there is no framework to keep patched.

import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import type { AiStatus, DateRange, Job, LiveAgentId, ReportType, SessionUser } from '../shared/live';
import { MAX_IMAGE_BYTES } from '../shared/live';
import { validateRange } from '../shared/manila';
import type { FinanceSource, OrderSource } from './adapters/types';
import { Auth, SESSION_COOKIE, parseCookies } from './auth';
import type { AppConfig } from './config';
import { JOB_DEFS, JobRunner, SubmitError, jobTypesFor } from './jobs/runner';

export interface AppDeps {
  config: AppConfig;
  auth: Auth;
  runner: JobRunner;
  finance: FinanceSource;
  orders: OrderSource;
  /** Whether free-text AI tasks are available (never includes the key). */
  aiStatus?: () => AiStatus;
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
      try {
        const { job, deduplicated } = runner.submitAi(
          s.user,
          body.agent as LiveAgentId,
          body.prompt,
          img ? { mimeType: img.mimeType as string, data: img.data as string } : undefined,
        );
        return send(res, deduplicated ? 200 : 202, { job: structuredClone(job), deduplicated });
      } catch (e) {
        if (e instanceof SubmitError) return send(res, e.status, { error: e.message });
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
      return;
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
  return { handler, close: () => clearInterval(heartbeat), streams };
}
