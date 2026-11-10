// HTTP-level tests: sign-in, cross-site protection, permissions, SSE job events.

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { FinanceAdapter } from '../adapters/finance';
import { OrdersAdapter } from '../adapters/orders';
import { createApp } from '../app';
import { DiscussionService, DiscussionStore } from '../discuss/discussions';
import { Auth, hashPassword } from '../auth';
import { loadConfig } from '../config';
import { ApiClient } from '../http/client';
import { JobRunner } from '../jobs/runner';

let server: Server;
let base = '';
let closeApp: () => void;
let monitor: ReturnType<typeof createApp>['monitor'];

before(async () => {
  const users = `owner:admin:${await hashPassword('correct horse 1')},ops:operations:${await hashPassword('correct horse 2')}`;
  const { config } = loadConfig({
    APP_USERS: users,
    API_ALLOWED_HOSTS: 'orders.test.example',
    ORDERS_API_BASE_URL: 'https://orders.test.example/api/',
    ORDERS_API_TOKEN: 'test-orders-token-must-stay-secret',
    TASK_LOG_FILE: '',
    STATIC_DIR: 'does-not-exist',
  } as NodeJS.ProcessEnv);
  const fetchImpl = (async () => {
    throw new Error('no network in tests');
  }) as typeof fetch;
  const finance = new FinanceAdapter(config.systems.finance, new ApiClient(config.systems.finance, { timeoutMs: 100, maxRetries: 0, fetchImpl }));
  const orders = new OrdersAdapter(config.systems.orders, new ApiClient(config.systems.orders, { timeoutMs: 100, maxRetries: 0, fetchImpl }));
  const runner = new JobRunner({ finance, orders, maxConcurrent: 2 });
  const discussions = new DiscussionService({ ai: null, finance, orders, store: new DiscussionStore(null), knowledgeDir: 'no-such-dir', maxRangeDays: 366 });
  const app = createApp({ config, auth: new Auth(config), runner, finance, orders, discussions });
  closeApp = app.close;
  monitor = app.monitor;
  server = createServer(app.handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  closeApp();
  server.closeAllConnections();
  server.close();
});

const post = (path: string, body: unknown, cookie = '', csrf = true) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(csrf ? { 'x-wad-request': '1' } : {}), ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

async function login(username: string, password: string) {
  const r = await post('/api/auth/login', { username, password });
  assert.equal(r.status, 200);
  const set = r.headers.get('set-cookie')!;
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Strict/);
  return set.split(';')[0];
}

test('API requires sign-in', async () => {
  assert.equal((await fetch(base + '/api/systems')).status, 401);
  assert.equal((await fetch(base + '/api/events')).status, 401);
  assert.equal((await fetch(base + '/api/health')).status, 200);
});

test('wrong password and missing cross-site header are refused', async () => {
  assert.equal((await post('/api/auth/login', { username: 'owner', password: 'nope' })).status, 401);
  assert.equal((await post('/api/auth/login', { username: 'owner', password: 'correct horse 1' }, '', false)).status, 403);
});

test('system status never exposes secrets and reflects missing configuration', async () => {
  const cookie = await login('owner', 'correct horse 1');
  const r = await (await fetch(base + '/api/systems', { headers: { cookie } })).json();
  const byId = Object.fromEntries(r.systems.map((s: { id: string }) => [s.id, s]));
  assert.equal(byId.finance.state, 'not_configured');
  assert.equal(byId.orders.state, 'ready');
  assert.ok(byId.finance.problems.some((p: string) => p.includes('FINANCE_API_TOKEN is not set')));
  assert.equal(byId.orders.host, 'orders.test.example');
  assert.ok(!JSON.stringify(r).includes('scrypt'));
  assert.ok(!JSON.stringify(r).includes('test-orders-token-must-stay-secret'));
});

test('server enforces role permissions and validates date ranges', async () => {
  const cookie = await login('ops', 'correct horse 2');
  assert.equal((await post('/api/jobs', { type: 'finance.summary', from: '2026-10-01', to: '2026-10-31' }, cookie)).status, 403);
  assert.equal((await post('/api/jobs', { type: 'orders.status', from: '2026-10-31', to: '2026-10-01' }, cookie)).status, 400);
  assert.equal((await post('/api/jobs', { type: 'orders.delete', from: '2026-10-01', to: '2026-10-31' }, cookie)).status, 400);
  const types = await (await fetch(base + '/api/report-types', { headers: { cookie } })).json();
  assert.equal(types.types.find((t: { type: string }) => t.type === 'finance.summary').allowed, false);
});

test('job events stream over SSE and end in a clear failure when the API is unreachable', async () => {
  const cookie = await login('owner', 'correct horse 1');
  const ctrl = new AbortController();
  const res = await fetch(base + '/api/events', { headers: { cookie }, signal: ctrl.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body!.getReader();
  const submit = await post('/api/jobs', { type: 'orders.overdue', from: '2026-10-01', to: '2026-10-31' }, cookie);
  assert.equal(submit.status, 202);
  let buf = '';
  const statuses: string[] = [];
  let final: { status: string; steps: { error?: { code: string } }[] } | null = null;
  while (!final) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += new TextDecoder().decode(value);
    for (const block of buf.split('\n\n').slice(0, -1)) {
      if (!block.includes('event: job')) continue;
      const job = JSON.parse(block.split('data: ')[1]);
      statuses.push(job.status);
      if (job.status === 'failed' || job.status === 'completed') final = job;
    }
    buf = buf.slice(buf.lastIndexOf('\n\n') + 2);
  }
  ctrl.abort();
  assert.deepEqual([...new Set(statuses)], ['queued', 'working', 'failed']);
  assert.equal(final!.steps[0].error?.code, 'NETWORK');
});

test('sign-out ends the session', async () => {
  const cookie = await login('owner', 'correct horse 1');
  assert.equal((await post('/api/auth/logout', {}, cookie)).status, 200);
  assert.equal((await fetch(base + '/api/auth/me', { headers: { cookie } })).status, 401);
});

test('the AI task route accepts a photo-sized request and refuses an oversized one', async () => {
  const cookie = await login('owner', 'correct horse 1');
  const photo = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(2 * 1024 * 1024)]).toString('base64');
  // Gets past the size check (this test server has no AI key, so it ends at "not set up").
  const ok = await post('/api/ai/tasks', { agent: 'carlo', prompt: 'Caption', image: { mimeType: 'image/jpeg', data: photo } }, cookie);
  assert.equal(ok.status, 503);
  const huge = 'A'.repeat(5 * 1024 * 1024);
  const tooBig = await post('/api/ai/tasks', { agent: 'carlo', prompt: 'Caption', image: { mimeType: 'image/jpeg', data: huge } }, cookie);
  assert.equal(tooBig.status, 413);
  const bad = await post('/api/ai/tasks', { agent: 'carlo', prompt: 'Caption', image: 'nope' }, cookie);
  assert.equal(bad.status, 400);
});

test('the security log counts sign-ins and refusals without addresses or typed usernames', async () => {
  const before = monitor.security(1);
  await post('/api/auth/login', { username: 'owner', password: 'wrong password' });
  await post('/api/auth/login', { username: 'not-a-real-user-xyz', password: 'whatever' });
  const cookie = await login('ops', 'correct horse 2');
  await post('/api/jobs', { type: 'finance.summary', range: { from: '2026-10-01', to: '2026-10-31' } }, cookie, false); // no cross-site header
  const r = await fetch(base + '/api/facebook/status', { headers: { cookie } }); // ops cannot post
  assert.equal(r.status, 403);
  await new Promise((res) => setTimeout(res, 50)); // let 'finish' handlers run
  const s = monitor.security(1) as any;
  assert.equal(s.signIns.failed - (before as any).signIns.failed, 2);
  assert.equal(s.signIns.failedByAccount.owner - ((before as any).signIns.failedByAccount.owner ?? 0), 1);
  assert.equal(s.signIns.failedForUnknownUsernames >= 1, true);
  assert.ok(s.signIns.ok >= 1);
  assert.ok(s.crossSiteRequestsBlocked >= 1);
  assert.ok(s.permissionDeniedByArea.facebook >= 1);
  const text = JSON.stringify(s);
  assert.ok(!text.includes('not-a-real-user-xyz') && !text.includes('127.0.0.1') && !text.includes('wrong password'));
  const h = monitor.health() as any;
  assert.equal(h.server.mode, 'development');
  assert.ok(!JSON.stringify(h).includes('test-orders-token-must-stay-secret'));
});

test('discussion routes: sign-in, cross-site protection, owner-only access, and no AI means no discussion', async () => {
  assert.equal((await fetch(base + '/api/discussions')).status, 401);
  const cookie = await login('ops', 'correct horse 2');
  const list = await fetch(base + '/api/discussions', { headers: { cookie } });
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json()).discussions, []);
  const body = { topic: 'Why are orders delayed?', participants: ['paolo', 'lia'] };
  assert.equal((await post('/api/discussions', body, cookie, false)).status, 403);
  const r = await post('/api/discussions', body, cookie);
  assert.equal(r.status, 503); // GEMINI_API_KEY not set in this test server
  assert.match((await r.json()).error, /GEMINI_API_KEY/);
  const other = await fetch(base + '/api/discussions/00000000-0000-4000-8000-000000000000', { headers: { cookie } });
  assert.equal(other.status, 404);
  assert.equal((await post('/api/discussions/00000000-0000-4000-8000-000000000000/cancel', {}, cookie)).status, 404);
});
