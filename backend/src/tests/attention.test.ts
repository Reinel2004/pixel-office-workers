// Attention needed: which items appear for whom, their severity and links, and that the list is
// built by code from what the server already knows (no AI, at most one open-orders read).

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import type { AttentionReport, Discussion, Job, SessionUser, SystemStatus, UiReview } from '../../shared/live';
import { FinanceAdapter } from '../adapters/finance';
import { OrdersAdapter, toOrder } from '../adapters/orders';
import type { OrderRecord } from '../adapters/types';
import { AiUsageMeter, NO_LIMITS } from '../ai/usage';
import { buildAttention, ordersWebUrl, type AttentionDeps } from '../attention/attention';
import { createApp } from '../app';
import { Auth, hashPassword } from '../auth';
import { loadConfig } from '../config';
import { ApiClient } from '../http/client';
import { JobRunner } from '../jobs/runner';
import { HealthLog } from '../monitor/monitor';

const NOW = new Date('2026-11-10T04:00:00Z'); // 12:00 in Manila
const admin: SessionUser = { username: 'owner', role: 'admin', permissions: ['finance:read', 'orders:read', 'social:post', 'system:read', 'ui:review', 'ai:usage', 'ai:limits'] };
const fin: SessionUser = { username: 'fin', role: 'finance', permissions: ['finance:read'] };

const ready = (id: 'orders' | 'finance'): SystemStatus => ({ id, name: id === 'orders' ? 'WAD Order Management' : 'WAD Furniture Management', state: 'ready', host: 'x', problems: [], capabilities: {} });
const order = (ref: string, due: string | null, over: Partial<OrderRecord> = {}): OrderRecord => ({
  ref,
  orderId: ref,
  recordId: 100 + Number(ref.replace(/\D/g, '')),
  status: 'In Progress',
  isClosed: false,
  dueDate: due,
  progressPercent: 50,
  stage: 'Sanding',
  createdDate: null,
  customerName: 'Juan',
  ...over,
});

function deps(over: Partial<AttentionDeps> = {}): AttentionDeps {
  return {
    systems: () => [ready('orders'), ready('finance')],
    aiStatus: () => ({ ready: true, provider: 'gemini', model: 'm', problems: [] }),
    facebookProblems: () => [],
    jobs: () => [],
    openOrders: async () => ({ orders: [], error: null }),
    ordersWebUrl: 'https://orders.test/',
    now: () => NOW,
    ...over,
  };
}

test('overdue orders: most overdue first, critical after a week, linked to their page; finance users never see them', async () => {
  let reads = 0;
  const d = deps({
    openOrders: async () => (
      reads++,
      {
        orders: [
          order('ORD-1', '2026-11-08'),
          order('ORD-2', '2026-10-20'),
          order('ORD-3', '2026-11-10'), // due today: not overdue
          order('ORD-4', '2026-11-01', { isClosed: true }),
          order('ORD-5', null),
        ],
        error: null,
      }
    ),
  });
  const r = await buildAttention(admin, d);
  const overdue = r.items.filter((i) => i.kind === 'overdue');
  assert.deepEqual(overdue.map((i) => i.id), ['overdue:ORD-2', 'overdue:ORD-1']);
  assert.equal(overdue[0].severity, 'critical');
  assert.equal(overdue[1].severity, 'warning');
  assert.match(overdue[1].title, /ORD-1 \(Juan\) is 2 days overdue/);
  assert.deepEqual(overdue[1].link, { kind: 'external', url: 'https://orders.test/view_order.php?id=101', label: 'Open in WAD Order Management' });
  assert.equal(r.overdueTotal, 2);
  assert.ok(r.notes.some((n) => /1 open order/.test(n)), 'orders without a due date are mentioned');
  assert.equal(reads, 1);

  const f = await buildAttention(fin, d);
  assert.equal(f.items.filter((i) => i.kind === 'overdue').length, 0);
  assert.equal(f.overdueTotal, null);
  assert.equal(reads, 1, 'no order read for an account that cannot see orders');
});

test('an order without its record number has no link, and the note says what to upload', async () => {
  const r = await buildAttention(admin, deps({ openOrders: async () => ({ orders: [order('ORD-1', '2026-11-01', { recordId: null })], error: null }) }));
  assert.equal(r.items[0].link, null);
  assert.ok(r.notes.some((n) => /office-orders\.php/.test(n)));
  const failed = await buildAttention(admin, deps({ openOrders: async () => ({ orders: null, error: 'Timed out' }) }));
  assert.ok(failed.notes.some((n) => /could not be checked: Timed out/.test(n)));
});

test('connections: not set up, and recent failures with a plain-language cause', async () => {
  const health = new HealthLog(() => NOW.getTime());
  for (let i = 0; i < 3; i++) health.record('orders', { ok: false, ms: 10, status: 401 });
  health.record('gemini', { ok: false, ms: 10, status: 503 });
  const r = await buildAttention(
    admin,
    deps({
      health,
      systems: () => [ready('orders'), { ...ready('finance'), state: 'not_configured', problems: ['FINANCE_API_TOKEN is not set.'] }],
      facebookProblems: () => ['FACEBOOK_PAGE_ID is not set.'],
    }),
  );
  const byId = Object.fromEntries(r.items.map((i) => [i.id, i]));
  assert.equal(byId['conn-fail:orders'].severity, 'critical');
  assert.match(byId['conn-fail:orders'].detail, /HTTP 401.*token/);
  assert.equal(byId['conn-fail:gemini'].severity, 'warning');
  assert.match(byId['conn-setup:finance'].detail, /FINANCE_API_TOKEN/);
  assert.equal(byId['conn-setup:facebook'].severity, 'info');
  assert.equal(r.items[0].id, 'conn-fail:orders', 'critical first');

  // A failure followed by a success is no longer shown; neither is an old one.
  health.record('orders', { ok: true, ms: 10, status: 200 });
  const old = new HealthLog(() => NOW.getTime() - 2 * 3600_000);
  old.record('gemini', { ok: false, ms: 10, status: 'TIMEOUT' });
  const r2 = await buildAttention(admin, deps({ health }));
  assert.ok(!r2.items.some((i) => i.id === 'conn-fail:orders'));
  const r3 = await buildAttention(admin, deps({ health: old }));
  assert.ok(!r3.items.some((i) => i.kind === 'connection'));
  // A finance-only account is not told about the order system.
  const r4 = await buildAttention(fin, deps({ health }));
  assert.ok(!r4.items.some((i) => i.id.endsWith(':orders')));
});

test('blocked work: own failed tasks, discussions and UI Reviews from the last 7 days, linked to the record', async () => {
  const job = (id: string, finishedAt: string, code = 'TIMEOUT'): Job =>
    ({ id, type: 'ai.task', title: `Task ${id}`, status: 'failed', createdAt: finishedAt, finishedAt, steps: [], error: { code, message: `boom ${id}`, retryable: false } }) as unknown as Job;
  const r = await buildAttention(
    admin,
    deps({
      jobs: () => [job('a', '2026-11-09T10:00:00Z', 'AI_LIMIT'), job('b', '2026-10-01T10:00:00Z'), { ...job('c', '2026-11-09T11:00:00Z'), status: 'completed' } as Job],
      discussions: () => [{ id: 'd1', status: 'failed', topic: 'Pricing', error: 'Gemini down', updatedAt: '2026-11-09T09:00:00Z', finishedAt: '2026-11-09T09:00:00Z' } as unknown as Discussion],
      uiReviews: () => [{ id: 'u1', status: 'proposed', page: 'Orders', error: 'Re-check failed', updatedAt: '2026-11-09T08:00:00Z' } as unknown as UiReview],
    }),
  );
  const blocked = r.items.filter((i) => i.kind === 'blocked');
  assert.deepEqual(blocked.map((i) => i.id).sort(), ['discussion:d1', 'job:a', 'uireview:u1']);
  const a = blocked.find((i) => i.id === 'job:a')!;
  assert.equal(a.severity, 'critical');
  assert.match(a.title, /^Task blocked/);
  assert.deepEqual(a.link, { kind: 'job', id: 'a', label: 'Open the task' });
  assert.match(blocked.find((i) => i.id === 'uireview:u1')!.title, /re-check failed/);
});

test('AI limits: everyone hears when blocked; warnings only for accounts that see usage', async () => {
  const aiUsage = new AiUsageMeter({ file: null, defaults: { ...NO_LIMITS, dailyRequests: 0 }, model: 'm', now: () => NOW });
  const r = await buildAttention(admin, deps({ aiUsage, now: () => NOW }));
  const lim = r.items.find((i) => i.id === 'limit:dailyRequests')!;
  assert.equal(lim.severity, 'critical');
  assert.match(lim.detail, /or you raise it/);
  assert.deepEqual(lim.link, { kind: 'systems', label: 'Open AI usage' });
  const f = await buildAttention(fin, deps({ aiUsage }));
  assert.equal(f.items.find((i) => i.id === 'limit:dailyRequests')?.link, null);
  assert.match(f.items.find((i) => i.id === 'limit:dailyRequests')!.detail, /ask an admin/);
});

test('order links: the web address comes from the approved API address; the record number from the API', () => {
  assert.equal(ordersWebUrl(new URL('https://wad-order-management.wadcatalog.com/api/')), 'https://wad-order-management.wadcatalog.com/');
  assert.equal(ordersWebUrl(null), null);
  const o = toOrder({ order_number: 'ORD-9', status: 'Pending', record_id: 42 }, 'Orders', 'orders');
  assert.equal(o.recordId, 42);
  assert.equal(toOrder({ order_number: 'ORD-9', status: 'Pending', record_id: '42; drop' }, 'Orders', 'orders').recordId, null);
});

test('HTTP: signed-in users get their own list; signed-out users get 401', async () => {
  const users = `owner:admin:${await hashPassword('pw-owner-1')},fin:finance:${await hashPassword('pw-fin-1')}`;
  const { config } = loadConfig({ APP_USERS: users, TASK_LOG_FILE: '', STATIC_DIR: 'does-not-exist' } as NodeJS.ProcessEnv);
  const noNet = (async () => {
    throw new Error('no network in tests');
  }) as typeof fetch;
  const finance = new FinanceAdapter(config.systems.finance, new ApiClient(config.systems.finance, { timeoutMs: 100, maxRetries: 0, fetchImpl: noNet }));
  const orders = new OrdersAdapter(config.systems.orders, new ApiClient(config.systems.orders, { timeoutMs: 100, maxRetries: 0, fetchImpl: noNet }));
  const app = createApp({ config, auth: new Auth(config), runner: new JobRunner({ finance, orders, maxConcurrent: 1 }), finance, orders });
  const server = createServer(app.handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = async (username: string, password: string) =>
    (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-wad-request': '1' }, body: JSON.stringify({ username, password }) })).headers
      .get('set-cookie')!
      .split(';')[0];
  try {
    assert.equal((await fetch(base + '/api/attention')).status, 401);
    const own = await login('owner', 'pw-owner-1');
    const a = (await (await fetch(base + '/api/attention', { headers: { cookie: own } })).json()) as { attention: AttentionReport };
    // Nothing is configured in this test server: both systems and the AI show as not set up.
    assert.ok(a.attention.items.some((i) => i.id === 'conn-setup:orders'));
    assert.ok(a.attention.items.some((i) => i.id === 'conn-setup:gemini'));
    const f = await login('fin', 'pw-fin-1');
    const b = (await (await fetch(base + '/api/attention', { headers: { cookie: f } })).json()) as { attention: AttentionReport };
    assert.ok(!b.attention.items.some((i) => i.id === 'conn-setup:orders'), 'finance accounts are not told about the order system');
    assert.ok(b.attention.items.some((i) => i.id === 'conn-setup:finance'));
  } finally {
    app.close();
    server.closeAllConnections();
    server.close();
  }
});
