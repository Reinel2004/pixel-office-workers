// Job runner lifecycle tests with in-memory test doubles of the adapter interfaces.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Job, SessionUser, SystemStatus } from '../../shared/live';
import { FinanceAdapter } from '../adapters/finance';
import { OrdersAdapter } from '../adapters/orders';
import type { FinanceRecord, FinanceSource, OrderRecord, OrderSource } from '../adapters/types';
import { ApiClient } from '../http/client';
import { IntegrationError } from '../http/errors';
import { JobRunner, SubmitError } from '../jobs/runner';

const admin: SessionUser = { username: 'owner', role: 'admin', permissions: ['finance:read', 'orders:read'] };
const ops: SessionUser = { username: 'ops', role: 'operations', permissions: ['orders:read'] };
const range = { from: '2026-10-01', to: '2026-10-31' };
const status = (id: 'finance' | 'orders'): SystemStatus => ({ id, name: id, state: 'ready', host: `${id}.test`, problems: [], capabilities: {} });

function fakeFinance(over: Partial<FinanceSource> = {}): FinanceSource {
  return {
    id: 'finance',
    capabilities: { income: true, expenses: true, budgets: false, sharedOrderId: true, budgetsByCategory: false },
    status: () => status('finance'),
    listIncome: async () => [{ ref: 'I1', kind: 'income', date: '2026-10-02', centavos: 100_00, currency: 'PHP', category: null, orderId: 'O1' } as FinanceRecord],
    listExpenses: async () => [],
    listBudgets: async () => [],
    ...over,
  };
}
function fakeOrders(over: Partial<OrderSource> = {}): OrderSource {
  return {
    id: 'orders',
    capabilities: { orders: true, progress: true, dueDates: true, closedStatuses: true, sharedOrderId: true },
    status: () => status('orders'),
    listOrders: async () => [{ ref: 'O1', orderId: 'O1', status: 'In production', isClosed: false, dueDate: '2026-10-20', progressPercent: 40, stage: null, createdDate: null } as OrderRecord],
    listOpenOrders: async () => [],
    ...over,
  };
}

function waitFor(runner: JobRunner, id: string): Promise<{ final: Job; history: Job[] }> {
  const history: Job[] = [];
  return new Promise((resolve) => {
    const on = (j: Job) => {
      if (j.id !== id) return;
      history.push(j);
      if (j.status === 'completed' || j.status === 'failed') {
        runner.off('job', on);
        resolve({ final: j, history });
      }
    };
    runner.on('job', on);
  });
}

test('lifecycle: queued -> working -> completed with validated result and sources', async () => {
  const r = new JobRunner({ finance: fakeFinance(), orders: fakeOrders(), maxConcurrent: 1 });
  const p = new Promise<Job[]>((res) => {
    const h: Job[] = [];
    r.on('job', (j: Job) => {
      h.push(j);
      if (j.status === 'completed' || j.status === 'failed') res(h);
    });
  });
  r.submit(admin, 'finance.summary', range);
  const history = await p;
  assert.deepEqual([...new Set(history.map((j) => j.status))], ['queued', 'working', 'completed']);
  const step = history.at(-1)!.steps[0];
  assert.equal(step.status, 'completed');
  assert.equal(step.result?.sources[0].system, 'finance');
  assert.deepEqual(step.result?.references, ['I1']);
});

test('real adapters without an API token fail clearly and send no request', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response('{}');
  }) as typeof fetch;
  const cfg = (id: 'finance' | 'orders') => ({ id, name: id, baseUrl: new URL(`https://${id}.test/`), token: null, problems: [] });
  const finance = new FinanceAdapter(cfg('finance'), new ApiClient(cfg('finance'), { timeoutMs: 100, maxRetries: 0, fetchImpl }));
  const orders = new OrdersAdapter(cfg('orders'), new ApiClient(cfg('orders'), { timeoutMs: 100, maxRetries: 0, fetchImpl }));
  const r = new JobRunner({ finance, orders, maxConcurrent: 2 });
  const { job } = r.submit(admin, 'combined.report', range);
  const { final } = await waitFor(r, job.id);
  assert.equal(final.status, 'failed');
  assert.equal(final.steps[0].error?.code, 'NOT_CONFIGURED');
  assert.equal(final.steps[1].error?.code, 'NOT_CONFIGURED');
  assert.equal(final.steps[2].error?.code, 'DEPENDENCY_FAILED');
  assert.equal(calls, 0);
  assert.equal(finance.status().state, 'not_configured');
});

test('"no records" completes as empty, distinct from an error', async () => {
  const r = new JobRunner({ finance: fakeFinance({ listIncome: async () => [] }), orders: fakeOrders(), maxConcurrent: 1 });
  const { job } = r.submit(admin, 'finance.summary', range);
  const { final } = await waitFor(r, job.id);
  assert.equal(final.status, 'completed');
  assert.equal(final.steps[0].result?.empty, true);
  assert.match(final.steps[0].result!.summary, /No income/);
});

test('permission denied from the API is reported as such', async () => {
  const r = new JobRunner({
    finance: fakeFinance(),
    orders: fakeOrders({ listOpenOrders: async () => Promise.reject(new IntegrationError('PERMISSION_DENIED', 'denied', 'orders', 403)) }),
    maxConcurrent: 1,
  });
  const { job } = r.submit(admin, 'orders.overdue', range);
  const { final } = await waitFor(r, job.id);
  assert.equal(final.error?.code, 'PERMISSION_DENIED');
});

test('combined: one system failing never produces a partial "completed" report', async () => {
  const r = new JobRunner({
    finance: fakeFinance({ listIncome: async () => Promise.reject(new IntegrationError('TIMEOUT', 't', 'finance')) }),
    orders: fakeOrders(),
    maxConcurrent: 1,
  });
  const { job } = r.submit(admin, 'combined.report', range);
  const { final } = await waitFor(r, job.id);
  assert.equal(final.status, 'failed');
  assert.equal(final.steps[1].status, 'completed');
  assert.equal(final.steps[2].error?.code, 'DEPENDENCY_FAILED');
});

test('invalid adapter output fails validation instead of completing', async () => {
  const r = new JobRunner({
    finance: fakeFinance({ listIncome: async () => [{ ref: 'X', kind: 'income', date: '2026-10-01', centavos: 10.5, currency: 'PHP', category: null, orderId: null }] }),
    orders: fakeOrders(),
    maxConcurrent: 1,
  });
  const { job } = r.submit(admin, 'finance.summary', range);
  const { final } = await waitFor(r, job.id);
  assert.equal(final.status, 'failed');
});

test('permissions are enforced and duplicate submissions are merged', async () => {
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  const r = new JobRunner({ finance: fakeFinance(), orders: fakeOrders({ listOrders: async () => (await gate, []) }), maxConcurrent: 1 });
  assert.throws(() => r.submit(ops, 'finance.summary', range), (e: unknown) => e instanceof SubmitError && e.status === 403);
  const a = r.submit(ops, 'orders.status', range);
  const b = r.submit(ops, 'orders.status', range);
  assert.equal(b.deduplicated, true);
  assert.equal(a.job.id, b.job.id);
  assert.equal(r.list(admin).length, 0); // users only see their own reports
  release();
  await waitFor(r, a.job.id);
});

test('task log entries carry no amounts or record contents', async () => {
  const lines: Record<string, unknown>[] = [];
  const r = new JobRunner({ finance: fakeFinance(), orders: fakeOrders(), maxConcurrent: 1, log: (e) => lines.push(e) });
  const { job } = r.submit(admin, 'finance.summary', range);
  await waitFor(r, job.id);
  const text = JSON.stringify(lines);
  assert.ok(!text.includes('10000') && !text.includes('I1'));
  assert.ok(lines.some((l) => l.event === 'finished'));
});

test('every emitted snapshot has a higher revision', async () => {
  const r = new JobRunner({ finance: fakeFinance(), orders: fakeOrders(), maxConcurrent: 1 });
  const { job } = r.submit(admin, 'combined.report', range);
  const { history } = await waitFor(r, job.id);
  const revs = history.map((j) => j.rev);
  assert.deepEqual(revs, [...revs].sort((a, b) => a - b));
  assert.equal(new Set(revs).size, revs.length);
});

test('overdue report shows customer names next to order numbers, and the task log never has them', async () => {
  const lines: Record<string, unknown>[] = [];
  const open = [
    { ref: 'ORD-1', orderId: 'G1', status: 'Pending', isClosed: false, dueDate: '2026-10-01', progressPercent: 0, stage: null, createdDate: null, customerName: 'Maria Reyes' },
    { ref: 'ORD-2', orderId: 'G2', status: 'Pending', isClosed: false, dueDate: '2099-01-01', progressPercent: 0, stage: null, createdDate: null, customerName: 'Not Overdue' },
  ] as OrderRecord[];
  const r = new JobRunner({ finance: fakeFinance(), orders: fakeOrders({ listOpenOrders: async () => open }), maxConcurrent: 1, log: (e) => lines.push(e), now: () => new Date('2026-11-05T02:00:00Z') });
  const { job } = r.submit(admin, 'orders.overdue', range);
  const { final } = await waitFor(r, job.id);
  assert.equal(final.status, 'completed');
  assert.deepEqual(final.steps[0].result?.customers, { 'ORD-1': 'Maria Reyes' });
  assert.ok(!JSON.stringify(lines).includes('Maria'));
});
