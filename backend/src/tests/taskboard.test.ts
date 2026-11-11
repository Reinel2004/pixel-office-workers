// Automatic data lookup and the Task Board: topics and periods detected by code, records read
// before the AI answers (only what the user may see), limitations stated instead of guessed,
// employee names kept out of Gemini, and task statuses, follow-ups, cancellation, review,
// de-duplication, permissions and persistence. Gemini and the business systems are faked.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Job, SessionUser, SystemStatus } from '../../shared/live';
import type { CashAdvanceData, FinanceRecord, FinanceSource, OrderRecord, OrderSource } from '../adapters/types';
import { GeminiClient } from '../ai/gemini';
import { detectDomains, detectRange, matchEmployees, planLookup, runLookups } from '../ai/lookup';
import { createApp } from '../app';
import { Auth, hashPassword } from '../auth';
import { loadConfig } from '../config';
import { IntegrationError } from '../http/errors';
import { JobRunner, SubmitError, TaskStore } from '../jobs/runner';

const TODAY = '2026-11-10';
const NOW = new Date('2026-11-10T02:00:00Z');
const admin: SessionUser = { username: 'owner', role: 'admin', permissions: ['finance:read', 'orders:read'] };
const ops: SessionUser = { username: 'ops', role: 'operations', permissions: ['orders:read'] };
const ready = (id: 'finance' | 'orders'): SystemStatus => ({ id, name: id, state: 'ready', host: `${id}.test`, problems: [], capabilities: {} });

const advances: CashAdvanceData = {
  currency: 'PHP',
  issued: [{ ref: 'CA-1', employeeRef: 'EMP-7', employeeName: 'Pedro Santos', position: 'Carpenter', dateIssued: '2026-10-05', centavos: 500000, remainingCentavos: 200000, status: 'Partially Paid' }],
  outstanding: [
    { ref: 'CA-1', employeeRef: 'EMP-7', employeeName: 'Pedro Santos', position: 'Carpenter', dateIssued: '2026-10-05', centavos: 500000, remainingCentavos: 200000, status: 'Partially Paid' },
    { ref: 'CA-0', employeeRef: 'EMP-3', employeeName: 'Maria Cruz', position: 'Painter', dateIssued: '2026-08-01', centavos: 100000, remainingCentavos: 100000, status: 'Outstanding' },
  ],
  repayments: [{ ref: 'CAP-1', advanceRef: 'CA-1', employeeRef: 'EMP-7', date: '2026-10-20', centavos: 300000 }],
};

function finance(over: Partial<FinanceSource> = {}, calls: string[] = []): FinanceSource {
  return {
    id: 'finance',
    capabilities: { income: true, expenses: true, budgets: true, sharedOrderId: false, budgetsByCategory: false },
    status: () => ready('finance'),
    listIncome: async (r) => (calls.push(`income ${r.from} ${r.to}`), [
      { ref: 'INC-1', kind: 'income', date: '2026-10-02', centavos: 1500000, currency: 'PHP', category: null, orderId: null, status: 'Received' },
      { ref: 'INC-2', kind: 'income', date: '2026-10-09', centavos: 250050, currency: 'PHP', category: null, orderId: null, status: 'Pending' },
    ] as FinanceRecord[]),
    listExpenses: async (r) => (calls.push(`expenses ${r.from} ${r.to}`), [
      { ref: 'EXP-1', kind: 'expense', date: '2026-10-03', centavos: 120050, currency: 'PHP', category: 'Utilities', orderId: null },
      { ref: 'EXP-2', kind: 'expense', date: '2026-10-04', centavos: 99950, currency: 'PHP', category: 'Lumber', orderId: null },
      { ref: 'EXP-3', kind: 'expense', date: '2026-10-05', centavos: 30000, currency: 'PHP', category: 'Utilities', orderId: null },
    ] as FinanceRecord[]),
    listBudgets: async () => [],
    listCashAdvances: async (r) => (calls.push(`advances ${r.from} ${r.to}`), advances),
    ...over,
  };
}
const orders = (over: Partial<OrderSource> = {}): OrderSource => ({
  id: 'orders',
  capabilities: { orders: true, progress: true, dueDates: true, closedStatuses: true, sharedOrderId: false, payments: true },
  status: () => ready('orders'),
  listOrders: async () => [],
  listOpenOrders: async () => [
    { ref: 'ORD-A', orderId: 'GRP-A', status: 'Finished', isClosed: false, dueDate: '2026-11-01', progressPercent: 100, stage: null, createdDate: '2026-10-01', customerName: 'Juan Reyes', grossCentavos: 3000000, downpaymentCentavos: 1000000 } as OrderRecord,
  ],
  ...over,
});

test('topics and periods are detected by code (English and Tagalog)', () => {
  assert.deepEqual(detectDomains('How much did we spend last month?'), ['expenses']);
  assert.deepEqual(detectDomains('Magkano ang gastos at bayad ngayong buwan?'), ['expenses', 'payments']);
  assert.deepEqual(detectDomains("What is Pedro's cash advance?"), ['cash_advances']);
  assert.deepEqual(detectDomains('Write a caption for this door'), []);
  assert.deepEqual(detectRange('expenses last month', TODAY)?.range, { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(detectRange('gastos noong nakaraang buwan', TODAY)?.range, { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(detectRange('payments in October', TODAY)?.range, { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(detectRange('expenses in December', TODAY)?.range, { from: '2025-12-01', to: '2025-12-31' }, 'a later month without a year is last year');
  assert.deepEqual(detectRange('from 2026-09-01 to 2026-09-15', TODAY)?.range, { from: '2026-09-01', to: '2026-09-15' });
  assert.deepEqual(detectRange('last 7 days', TODAY)?.range, { from: '2026-11-04', to: '2026-11-10' });
  assert.deepEqual(detectRange('this week', TODAY)?.range, { from: '2026-11-09', to: '2026-11-10' }, 'weeks start on Monday');
  assert.equal(detectRange('May I see the expenses?', TODAY), null, '"May I" is not the month');
  const p = planLookup('How much did we spend?', TODAY, 366)!;
  assert.equal(p.stated, false);
  assert.deepEqual(p.range, { from: '2026-11-01', to: TODAY });
  assert.match(p.rangeLabel, /no period was named/);
  const follow = planLookup('and last month?', TODAY, 366, 'How much did we spend this month?')!;
  assert.deepEqual(follow.domains, ['expenses'], 'a follow-up keeps the topic');
  assert.deepEqual(follow.range, { from: '2026-10-01', to: '2026-10-31' });
  assert.equal(planLookup('expenses in 2025', TODAY, 90)!.range.from, '2025-10-03', 'longer than the limit: the last days only');
});

test('expenses, payments and balances: totals by code, with source, period and retrieval time', async () => {
  const plan = planLookup('expenses and payments last month', TODAY, 366)!;
  const out = await runLookups(plan, admin, 'expenses and payments last month', { finance: finance(), orders: orders() }, TODAY);
  const exp = out.lookups.find((l) => l.domain === 'expenses')!;
  assert.equal(exp.status, 'ok');
  assert.deepEqual(exp.range, { from: '2026-10-01', to: '2026-10-31' });
  assert.equal(exp.figures[0].value, '₱2,500.00', '1,200.50 + 999.50 + 300.00');
  assert.equal(exp.source?.host, 'finance.test');
  assert.ok(exp.retrievedAt);
  const paid = out.lookups.find((l) => l.title.startsWith('Payments received'))!;
  assert.equal(paid.figures[0].value, '₱17,500.50');
  assert.ok(paid.figures.some((f) => f.label === 'Pending' && f.value.startsWith('₱2,500.50')));
  const bal = out.lookups.find((l) => l.title.startsWith('Balances'))!;
  assert.equal(bal.figures[0].value, '₱20,000.00');
  assert.equal(bal.range, null, 'balances are "right now"');
  assert.equal(out.customers['ORD-A'], 'Juan Reyes', 'names go to the browser…');
  assert.ok(!JSON.stringify(out.facts).includes('Juan'), '…never to the AI');
});

test('missing permission, an unconnected system and a failed read become stated limitations', async () => {
  const plan = planLookup('expenses and orders this month', TODAY, 366)!;
  const o = await runLookups(plan, ops, 'expenses and orders this month', { finance: finance(), orders: orders() }, TODAY);
  const exp = o.lookups.find((l) => l.domain === 'expenses')!;
  assert.equal(exp.status, 'not_allowed');
  assert.match(exp.message!, /finance:read/);
  assert.equal(o.lookups.find((l) => l.domain === 'orders')?.status, 'empty', 'orders still read for an orders account');

  const off = finance({ status: () => ({ ...ready('finance'), state: 'not_configured', problems: ['FINANCE_API_TOKEN is not set.'] }) });
  const a = await runLookups(planLookup('expenses', TODAY, 366)!, admin, 'expenses', { finance: off, orders: orders() }, TODAY);
  assert.equal(a.lookups[0].status, 'unavailable');
  assert.match(a.lookups[0].message!, /not connected: FINANCE_API_TOKEN/);
  assert.equal(a.lookups[0].figures.length, 0, 'no figures, no estimates');

  const failing = finance({ listCashAdvances: async () => { throw new IntegrationError('NOT_SUPPORTED', 'WAD Furniture Management does not have api/ceo/cash-advances.php yet (upload it to the server).', 'finance', 404); } });
  const b = await runLookups(planLookup('cash advances', TODAY, 366)!, admin, 'cash advances', { finance: failing, orders: orders() }, TODAY);
  assert.equal(b.lookups[0].status, 'unavailable');
  assert.match(b.lookups[0].message!, /cash-advances\.php/);
  assert.equal((b.facts[0] as { status: string }).status, 'unavailable');
});

test('cash advances: totals by code, names matched by code and kept away from the AI', async () => {
  const text = 'How much is the cash advance of Pedro this month?';
  const out = await runLookups(planLookup(text, TODAY, 366)!, admin, text, { finance: finance(), orders: orders() }, TODAY);
  const ca = out.lookups[0];
  assert.equal(ca.status, 'ok');
  assert.deepEqual(ca.figures.map((f) => f.value), ['₱5,000.00 (1)', '₱3,000.00', '₱3,000.00 (2)', '2']);
  const facts = JSON.stringify(out.facts);
  assert.ok(!facts.includes('Pedro') && !facts.includes('Maria'), 'no employee names for the AI');
  assert.ok(facts.includes('"employeesNamedInTheQuestion":["EMP-7"]'));
  assert.equal(out.employees['EMP-7'], 'Pedro Santos');
  assert.deepEqual(matchEmployees('vale ni cruz', advances.outstanding), ['EMP-3']);
});

// ---------------------------------------------------------------- Task Board

function gemini(replies: (string | 'hang')[]) {
  const bodies: Record<string, unknown>[] = [];
  let i = 0;
  const fetchImpl = (async (_url: URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const r = replies[i++] ?? 'fallback';
    if (r === 'hang')
      return new Promise<Response>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    return new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: r }] }, finishReason: 'STOP' }] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { ai: new GeminiClient({ apiKey: 'k', model: 'gemini-test', timeoutMs: 5000, maxRetries: 0, fetchImpl }), bodies };
}

function board(ai: GeminiClient, over: { file?: string | null; fin?: FinanceSource; maxConcurrent?: number } = {}) {
  return new JobRunner({
    finance: over.fin ?? finance(),
    orders: orders(),
    maxConcurrent: over.maxConcurrent ?? 1,
    now: () => NOW,
    store: new TaskStore(over.file ?? null),
    ai: { ai, maxToolRounds: 2, maxRangeDays: 366, knowledgeDir: join(tmpdir(), 'no-such-knowledge-dir') },
  });
}

const settled = (r: JobRunner, id: string, want: Job['status'][] = ['ready_for_review', 'needs_info', 'completed', 'failed', 'cancelled']) =>
  new Promise<Job>((res) => {
    const cur = r.list(admin).find((j) => j.id === id) ?? r.list(ops).find((j) => j.id === id);
    if (cur && want.includes(cur.status)) return res(structuredClone(cur));
    const on = (j: Job) => j.id === id && want.includes(j.status) && (r.off('job', on), res(j));
    r.on('job', on);
  });

test('Bea: expenses are read before Gemini answers, and the answer is ready for review with sources', async () => {
  const calls: string[] = [];
  const g = gemini(['We spent **₱2,500.00** in October 2026.']);
  const r = board(g.ai, { fin: finance({}, calls) });
  const { job } = r.submitAi(admin, 'bea', 'How much did we spend last month?');
  const final = await settled(r, job.id);
  assert.equal(final.status, 'ready_for_review');
  assert.deepEqual(calls, ['expenses 2026-10-01 2026-10-31'], 'read by code, before the AI, once');
  const sent = JSON.stringify(g.bodies[0]);
  assert.match(sent, /Live data the office retrieved/);
  assert.match(sent, /2500\.00/);
  assert.match(sent, /quote it exactly with its period/);
  const res = final.steps[0].result!;
  assert.equal(res.dataLookups?.[0].domain, 'expenses');
  assert.equal(res.sources[0].system, 'finance');
  assert.deepEqual(final.thread?.map((t) => t.role), ['user', 'agent']);
});

test('needs information -> reply -> answer with the conversation -> mark complete', async () => {
  const g = gemini(['Which employee do you mean?\n**Needs information:** yes', 'EMP-7 still owes ₱2,000.00.']);
  const r = board(g.ai);
  const { job } = r.submitAi(admin, 'chief', 'How much is the cash advance?');
  let j = await settled(r, job.id);
  assert.equal(j.status, 'needs_info');
  assert.equal(j.steps[0].result?.answer, 'Which employee do you mean?', 'the marker line is removed');
  assert.throws(() => r.complete(ops, job.id), (e: SubmitError) => e.status === 404, 'other accounts cannot touch it');
  r.followUp(admin, job.id, 'Pedro');
  j = await settled(r, job.id, ['ready_for_review', 'failed']);
  assert.equal(j.status, 'ready_for_review');
  // The second request carries the conversation: the question, the agent's question, then the reply.
  const contents = g.bodies[1].contents as { role: string; parts: { text?: string }[] }[];
  assert.deepEqual(contents.map((c) => c.role), ['user', 'model', 'user']);
  assert.match(contents[2].parts[0].text!, /Follow-up from owner: Pedro/);
  assert.match(JSON.stringify(contents[2]), /employeesNamedInTheQuestion/, 'the topic carries over, and Pedro is matched by code');
  assert.ok(!JSON.stringify(g.bodies[1]).includes('Pedro Santos'));
  assert.deepEqual(j.thread?.map((t) => `${t.role}:${t.outcome ?? ''}`), ['user:', 'agent:needs_info', 'user:', 'agent:answered']);
  j = r.complete(admin, job.id);
  assert.equal(j.status, 'completed');
  assert.equal(j.reviewedBy, 'owner');
  assert.throws(() => r.complete(admin, job.id), (e: SubmitError) => e.status === 409);
});

test('cancel: a queued task never runs; a working one is aborted and stays cancelled', async () => {
  const g = gemini(['hang', 'should never be sent']);
  const r = board(g.ai, { maxConcurrent: 1 });
  const a = r.submitAi(admin, 'chief', 'Write a short team update.').job;
  const b = r.submitAi(admin, 'lia', 'Draft a welcome message.').job;
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(r.get(b.id, admin)?.status, 'queued');
  assert.equal(r.cancel(admin, b.id).status, 'cancelled');
  assert.equal(r.cancel(admin, a.id).status, 'cancelled');
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(r.get(a.id, admin)?.status, 'cancelled');
  assert.equal(r.get(a.id, admin)?.steps[0].status, 'cancelled');
  assert.equal(g.bodies.length, 1, 'the queued task never reached Gemini');
  assert.throws(() => r.cancel(admin, a.id), (e: SubmitError) => e.status === 409);
  assert.throws(() => r.followUp(admin, a.id, 'go on'), (e: SubmitError) => e.status === 409);
});

test('duplicates: the same submission key, or an identical in-flight request, returns the same task', async () => {
  const g = gemini(['hang']);
  const r = board(g.ai);
  const first = r.submitAi(admin, 'chief', 'Plan the week.', undefined, undefined, 'key-1');
  const again = r.submitAi(admin, 'chief', 'Plan the week, please.', undefined, undefined, 'key-1');
  assert.equal(again.job.id, first.job.id);
  assert.equal(again.deduplicated, true);
  assert.equal(r.submitAi(admin, 'chief', 'Plan the week.').deduplicated, true);
  assert.throws(() => r.followUp(admin, first.job.id, 'More detail'), (e: SubmitError) => e.status === 409, 'no follow-up while it is still working');
  r.cancel(admin, first.job.id);
});

test('the board survives a restart: running tasks come back as interrupted; names are not saved', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'wad-tasks-')), 'tasks.json');
  const g = gemini(['Done.', 'hang']);
  const r = board(g.ai, { file });
  const ok = r.submitAi(admin, 'rosa', 'Which orders still have a balance?').job;
  await settled(r, ok.id);
  const running = r.submitAi(admin, 'chief', 'Long task').job;
  await new Promise((res) => setTimeout(res, 20));
  r.flush();
  const text = readFileSync(file, 'utf8');
  assert.ok(!text.includes('Juan Reyes'), 'customer names are not written to disk');
  const r2 = board(gemini([]).ai, { file });
  const list = r2.list(admin);
  assert.equal(list.find((j) => j.id === ok.id)?.status, 'ready_for_review');
  const back = list.find((j) => j.id === running.id)!;
  assert.equal(back.status, 'failed');
  assert.match(back.error!.message, /Interrupted/);
  assert.equal(r2.list(ops).length, 0, 'still only visible to the owner');
  r.cancel(admin, running.id);
});

test('HTTP: cancel, follow-up and complete need the owner and the cross-site header', async () => {
  const users = `owner:admin:${await hashPassword('pw-owner-1')},ops:operations:${await hashPassword('pw-ops-1')}`;
  const { config } = loadConfig({ APP_USERS: users, TASK_LOG_FILE: '', STATIC_DIR: 'does-not-exist' } as NodeJS.ProcessEnv);
  const g = gemini(['Which month?\n**Needs information:** yes', 'October.']);
  const runner = board(g.ai);
  const app = createApp({ config, auth: new Auth(config), runner, finance: finance(), orders: orders() });
  const server = createServer(app.handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, cookie: string, csrf = true) =>
    fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', cookie, ...(csrf ? { 'x-wad-request': '1' } : {}) }, body: JSON.stringify(body) });
  const login = async (u: string, p: string) => (await post('/api/auth/login', { username: u, password: p }, '')).headers.get('set-cookie')!.split(';')[0];
  try {
    const own = await login('owner', 'pw-owner-1');
    const { job } = (await (await post('/api/ai/tasks', { agent: 'chief', prompt: 'Summarise the month', key: 'k1' }, own)).json()) as { job: Job };
    const again = (await (await post('/api/ai/tasks', { agent: 'chief', prompt: 'Summarise the month', key: 'k1' }, own)).json()) as { job: Job; deduplicated: boolean };
    assert.equal(again.job.id, job.id);
    await settled(runner, job.id);
    const other = await login('ops', 'pw-ops-1');
    assert.equal((await post(`/api/jobs/${job.id}/follow-up`, { text: 'October' }, other)).status, 404);
    assert.equal((await post(`/api/jobs/${job.id}/follow-up`, { text: 'October' }, own, false)).status, 403);
    assert.equal((await post(`/api/jobs/${job.id}/follow-up`, { text: '' }, own)).status, 400);
    assert.equal((await post(`/api/jobs/${job.id}/follow-up`, { text: 'October' }, own)).status, 202);
    await settled(runner, job.id, ['ready_for_review', 'failed']);
    const done = (await (await post(`/api/jobs/${job.id}/complete`, {}, own)).json()) as { job: Job };
    assert.equal(done.job.status, 'completed');
    assert.equal((await post(`/api/jobs/${job.id}/cancel`, {}, own)).status, 409);
  } finally {
    app.close();
    server.closeAllConnections();
    server.close();
  }
});
