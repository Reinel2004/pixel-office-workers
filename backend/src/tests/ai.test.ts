// AI tasks: Gemini request shape, tool calls, permissions, failures. Gemini is faked; no network.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Job, SessionUser, SystemStatus } from '../../shared/live';
import type { FinanceRecord, FinanceSource, OrderRecord, OrderSource } from '../adapters/types';
import { GeminiClient } from '../ai/gemini';
import { MAX_TOOL_CALLS, toolsFor } from '../ai/tasks';
import { IntegrationError } from '../http/errors';
import { JobRunner, SubmitError } from '../jobs/runner';

const admin: SessionUser = { username: 'owner', role: 'admin', permissions: ['finance:read', 'orders:read'] };
const ops: SessionUser = { username: 'ops', role: 'operations', permissions: ['orders:read'] };
const status = (id: 'finance' | 'orders'): SystemStatus => ({ id, name: id, state: 'ready', host: `${id}.test`, problems: [], capabilities: {} });

const finance: FinanceSource = {
  id: 'finance',
  capabilities: { income: true, expenses: true, budgets: true, sharedOrderId: false, budgetsByCategory: false },
  status: () => status('finance'),
  listIncome: async () => [{ ref: 'INC-1', kind: 'income', date: '2026-10-02', centavos: 1500000, currency: 'PHP', category: null, orderId: null } as FinanceRecord],
  listExpenses: async () => [{ ref: 'EXP-1', kind: 'expense', date: '2026-10-03', centavos: 120050, currency: 'PHP', category: 'Utilities', orderId: null } as FinanceRecord],
  listBudgets: async () => [],
};
const orders = (over: Partial<OrderSource> = {}): OrderSource => ({
  id: 'orders',
  capabilities: { orders: true, progress: true, dueDates: true, closedStatuses: true, sharedOrderId: false },
  status: () => status('orders'),
  listOrders: async () => [],
  listOpenOrders: async () => [
    { ref: 'ORD-A', orderId: 'GRP-A', status: 'In Progress', isClosed: false, dueDate: '2026-10-20', progressPercent: 50, stage: 'assembling', createdDate: '2026-10-01' } as OrderRecord,
  ],
  ...over,
});

/** A fake Gemini: returns the scripted replies in order and records each request body. */
function fakeGemini(replies: unknown[], statusCodes: number[] = []) {
  const bodies: Record<string, unknown>[] = [];
  const urls: string[] = [];
  const headers: Headers[] = [];
  let i = 0;
  const fetchImpl = (async (url: URL, init?: RequestInit) => {
    urls.push(String(url));
    headers.push(new Headers(init?.headers));
    bodies.push(JSON.parse(String(init?.body)));
    const code = statusCodes[i] ?? 200;
    const reply = replies[i++] ?? { candidates: [{ content: { role: 'model', parts: [{ text: 'fallback' }] } }] };
    return new Response(JSON.stringify(reply), { status: code, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const ai = new GeminiClient({ apiKey: 'test-gemini-key', model: 'gemini-test', timeoutMs: 2000, maxRetries: 0, fetchImpl });
  return { ai, bodies, urls, headers };
}

function runner(ai: GeminiClient, over: { orders?: OrderSource; knowledgeDir?: string } = {}) {
  return new JobRunner({
    finance,
    orders: over.orders ?? orders(),
    maxConcurrent: 1,
    now: () => new Date('2026-11-05T02:00:00Z'),
    ai: { ai, maxToolRounds: 3, maxRangeDays: 366, knowledgeDir: over.knowledgeDir ?? join(tmpdir(), 'no-such-knowledge-dir') },
  });
}

function done(r: JobRunner, id: string): Promise<Job> {
  return new Promise((resolve) => {
    const on = (j: Job) => {
      if (j.id === id && (j.status === 'completed' || j.status === 'failed')) {
        r.off('job', on);
        resolve(j);
      }
    };
    r.on('job', on);
  });
}

test('an AI task calls a data tool, gets code-calculated data, and returns the answer with sources', async () => {
  const g = fakeGemini([
    { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'get_open_orders', args: {} }, thoughtSignature: 'sig1' }] } }] },
    { candidates: [{ content: { role: 'model', parts: [{ text: 'ORD-A is **16 days** overdue.' }] }, finishReason: 'STOP' }] },
  ]);
  const r = runner(g.ai);
  const { job } = r.submitAi(admin, 'paolo', '  Which orders are overdue?  ');
  assert.equal(job.prompt, 'Which orders are overdue?');
  const final = await done(r, job.id);
  assert.equal(final.status, 'completed');
  const res = final.steps[0].result!;
  assert.equal(res.generatedBy, 'ai');
  assert.equal(res.answer, 'ORD-A is **16 days** overdue.');
  assert.equal(res.model, 'gemini-test');
  assert.deepEqual(res.lookups, [{ tool: 'get_open_orders', detail: 'all open orders', ok: true }]);
  assert.equal(res.sources[0].system, 'orders');
  assert.deepEqual(res.references, ['ORD-A']);

  // Request shape: key in header (not URL), model in path, Paolo gets only order tools.
  assert.equal(g.urls[0], 'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent');
  assert.equal(g.headers[0].get('x-goog-api-key'), 'test-gemini-key');
  const tools = (g.bodies[0].tools as { functionDeclarations: { name: string }[] }[])[0].functionDeclarations.map((d) => d.name);
  assert.deepEqual(tools.sort(), ['get_open_orders', 'get_orders']);
  // Second request carries the model's turn unchanged (thought signature) and the tool result.
  const contents = g.bodies[1].contents as { role: string; parts: Record<string, any>[] }[];
  assert.equal(contents[1].parts[0].thoughtSignature, 'sig1');
  const toolResult = contents[2].parts[0].functionResponse.response;
  assert.equal(toolResult.overdueCount, 1);
  assert.equal(toolResult.overdue[0].daysOverdue, 16);
  assert.equal(toolResult.calculatedByCode, true);
});

test('finance totals are given to the AI already calculated, in pesos', async () => {
  const g = fakeGemini([
    { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'get_finance', args: { from: '2026-10-01', to: '2026-10-31' } } }] } }] },
    { candidates: [{ content: { role: 'model', parts: [{ text: 'Net ₱13,799.50.' }] } }] },
  ]);
  const r = runner(g.ai);
  const final = await done(r, r.submitAi(admin, 'bea', 'How did October go?').job.id);
  assert.equal(final.status, 'completed');
  const resp = (g.bodies[1].contents as any[])[2].parts[0].functionResponse.response;
  assert.deepEqual(resp.totals.net, [{ currency: 'PHP', amount: '13799.50' }]);
  assert.equal(resp.expensesByCategory[0].category, 'Utilities');
});

test("a user's permissions limit the AI's tools: an operations user gets no finance tool from Bea", async () => {
  assert.deepEqual(toolsFor('bea', ops), []);
  assert.deepEqual(toolsFor('chief', ops).sort(), ['get_open_orders', 'get_orders']);
  const g = fakeGemini([
    // The model tries the finance tool anyway; it must be refused, not run.
    { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'get_finance', args: { from: '2026-10-01', to: '2026-10-31' } } }] } }] },
    { candidates: [{ content: { role: 'model', parts: [{ text: 'I cannot see finance data for your account.' }] } }] },
  ]);
  const r = runner(g.ai);
  const final = await done(r, r.submitAi(ops, 'bea', 'Show October income').job.id);
  assert.equal(g.bodies[0].tools, undefined);
  assert.match(String(g.bodies[0].systemInstruction && JSON.stringify(g.bodies[0].systemInstruction)), /cannot use: get_finance/);
  assert.equal(final.steps[0].result?.lookups?.[0].ok, false);
  assert.equal(final.steps[0].result?.sources.length, 0);
});

test('a failed data lookup is reported to the AI as unavailable, never filled in', async () => {
  const g = fakeGemini([
    { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'get_open_orders', args: {} } }] } }] },
    { candidates: [{ content: { role: 'model', parts: [{ text: 'Order data is unavailable right now.' }] } }] },
  ]);
  const r = runner(g.ai, { orders: orders({ listOpenOrders: async () => Promise.reject(new IntegrationError('TIMEOUT', 'Order system timed out.', 'orders')) }) });
  const final = await done(r, r.submitAi(admin, 'nina', 'Plan deliveries').job.id);
  assert.equal(final.status, 'completed');
  const resp = (g.bodies[1].contents as any[])[2].parts[0].functionResponse.response;
  assert.equal(resp.error, 'Order system timed out.');
  assert.match(final.steps[0].result!.summary, /some lookups failed/);
});

test('Gemini quota, bad key and unknown model become clear errors', async () => {
  for (const [code, body, expected] of [
    [429, { error: { message: 'Resource exhausted' } }, 'RATE_LIMITED'],
    [400, { error: { message: 'API key not valid. Please pass a valid API key.', details: [{ reason: 'API_KEY_INVALID' }] } }, 'AUTH_FAILED'],
    [404, { error: { message: 'models/x is not found' } }, 'NOT_CONFIGURED'],
  ] as const) {
    const g = fakeGemini([body], [code]);
    const r = runner(g.ai);
    const final = await done(r, r.submitAi(admin, 'carlo', `Write a caption ${code}`).job.id);
    assert.equal(final.status, 'failed');
    assert.equal(final.steps[0].error?.code, expected);
    assert.ok(!JSON.stringify(final).includes('test-gemini-key'));
  }
});

test('too many lookups in one task stops instead of looping', async () => {
  const call = { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'get_open_orders', args: {} } }] } }] };
  const g = fakeGemini([call, call, call, call, call]);
  const r = runner(g.ai);
  const final = await done(r, r.submitAi(admin, 'chief', 'Loop forever').job.id);
  assert.equal(final.status, 'failed');
  assert.equal(g.bodies.length, 4); // 1 + maxToolRounds (3)
  // The last request forbids further lookups, and the repeated identical lookup hit the order system once.
  assert.deepEqual(g.bodies[3].toolConfig, { functionCallingConfig: { mode: 'NONE' } });
  assert.equal(g.bodies[0].toolConfig, undefined);
  assert.equal(final.steps[0].result, undefined);
});

test('identical lookups are fetched once, and one task makes at most MAX_TOOL_CALLS lookups', async () => {
  let fetches = 0;
  const src = orders({ listOrders: async () => (fetches++, []) });
  const many = Array.from({ length: 10 }, (_, i) => ({ functionCall: { name: 'get_orders', args: { from: `2026-10-${String(i + 1).padStart(2, '0')}`, to: '2026-10-31' } } }));
  const g = fakeGemini([
    { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'get_orders', args: { from: '2026-10-01', to: '2026-10-31' } } }] } }] },
    { candidates: [{ content: { role: 'model', parts: many } }] },
    { candidates: [{ content: { role: 'model', parts: [{ text: 'Done.' }] } }] },
  ]);
  const r = runner(g.ai, { orders: src });
  const final = await done(r, r.submitAi(admin, 'paolo', 'Check October').job.id);
  assert.equal(final.status, 'completed');
  assert.equal(fetches, MAX_TOOL_CALLS); // 10 asked + 1 repeat, only 6 distinct fetched
  assert.equal(g.bodies.length, 3);
  assert.deepEqual(g.bodies[2].toolConfig, { functionCallingConfig: { mode: 'NONE' } });
  assert.ok(final.steps[0].result!.lookups!.some((l) => /lookup limit reached/.test(l.detail)));
});

test('Gemini is not retried by default: a 503 costs one request and fails clearly', async () => {
  let calls = 0;
  const fetchImpl = (async () => (calls++, new Response('{}', { status: 503 }))) as unknown as typeof fetch;
  const ai = new GeminiClient({ apiKey: 'k', model: 'm', timeoutMs: 1000, fetchImpl });
  await assert.rejects(ai.generate({ contents: [] }), (e: IntegrationError) => e.code === 'UPSTREAM_ERROR');
  assert.equal(calls, 1);
});

test('Rosa reads balances calculated by code; operations users get no balances', async () => {
  const open: OrderRecord[] = [
    { ref: 'ORD-F', orderId: 'F', status: 'Finished', isClosed: false, dueDate: '2026-11-01', progressPercent: 100, stage: 'done', createdDate: '2026-10-01', grossCentavos: 2500000, downpaymentCentavos: 1000000, customerName: 'Juana Dela Cruz' },
    { ref: 'ORD-P', orderId: 'P', status: 'Pending', isClosed: false, dueDate: '2026-12-01', progressPercent: 0, stage: 'production', createdDate: '2026-10-20', grossCentavos: 800050, downpaymentCentavos: 0 },
    { ref: 'ORD-Z', orderId: 'Z', status: 'In Progress', isClosed: false, dueDate: null, progressPercent: 50, stage: 'roughing', createdDate: '2026-10-21', grossCentavos: 500000, downpaymentCentavos: 500000 },
  ];
  const src = orders({ listOpenOrders: async () => open });
  src.capabilities.payments = true;
  const g = fakeGemini([
    { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'get_collections', args: {} } }] } }] },
    { candidates: [{ content: { role: 'model', parts: [{ text: 'ORD-F owes ₱15,000.00.' }] } }] },
  ]);
  const r = runner(g.ai, { orders: src });
  const final = await done(r, r.submitAi(admin, 'rosa', 'Who owes us?').job.id);
  assert.equal(final.status, 'completed');
  const resp = (g.bodies[1].contents as any[])[2].parts[0].functionResponse.response;
  assert.equal(resp.totalBalance, '23000.50');
  assert.equal(resp.totalDownpayments, '15000.00');
  assert.equal(resp.balanceReadyForDelivery, '15000.00');
  assert.equal(resp.ordersWithBalance, 2);
  assert.equal(resp.noDownpaymentCount, 1);
  assert.equal(resp.rows[0].ref, 'ORD-F'); // finished orders first
  assert.equal(resp.rows[0].daysOverdue, 4);
  assert.equal(resp.calculatedByCode, true);
  // The name is shown in the office but never sent to Gemini.
  assert.ok(!JSON.stringify(g.bodies).includes('Juana'));
  assert.deepEqual(final.steps[0].result!.customers, { 'ORD-F': 'Juana Dela Cruz' });

  assert.deepEqual(toolsFor('rosa', ops), ['get_open_orders']);
  assert.ok(!toolsFor('chief', ops).includes('get_collections'));
});

test('Rosa says balances are unavailable when the order system has no payment fields', async () => {
  const g = fakeGemini([
    { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'get_collections', args: {} } }] } }] },
    { candidates: [{ content: { role: 'model', parts: [{ text: 'Balances are unavailable.' }] } }] },
  ]);
  const r = runner(g.ai);
  await done(r, r.submitAi(admin, 'rosa', 'Who owes us?').job.id);
  const resp = (g.bodies[1].contents as any[])[2].parts[0].functionResponse.response;
  assert.match(resp.error, /did not provide order prices/);
});

test('business notes from the knowledge folder reach the AI; README is skipped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wad-knowledge-'));
  writeFileSync(join(dir, 'prices.md'), 'Flush door, 36x80: ₱4,500');
  writeFileSync(join(dir, 'README.md'), 'instructions for humans');
  const g = fakeGemini([{ candidates: [{ content: { role: 'model', parts: [{ text: 'Quotation draft…' }] } }] }]);
  const r = runner(g.ai, { knowledgeDir: dir });
  const final = await done(r, r.submitAi(admin, 'marco', 'Quote 2 flush doors').job.id);
  assert.equal(final.status, 'completed');
  const sys = JSON.stringify(g.bodies[0].systemInstruction);
  assert.match(sys, /Flush door, 36x80/);
  assert.doesNotMatch(sys, /instructions for humans/);
  assert.equal(g.bodies[0].tools, undefined); // Marco has no live-data tools
});

test('AI tasks are refused when no key is configured, and prompts are validated', () => {
  const r = new JobRunner({ finance, orders: orders(), maxConcurrent: 1 });
  assert.throws(() => r.submitAi(admin, 'paolo', 'hi'), (e: unknown) => e instanceof SubmitError && e.status === 503);
  const g = fakeGemini([]);
  const r2 = runner(g.ai);
  assert.throws(() => r2.submitAi(admin, 'paolo', '   '), (e: unknown) => e instanceof SubmitError && e.status === 400);
  assert.throws(() => r2.submitAi(admin, 'nobody' as never, 'hi'), (e: unknown) => e instanceof SubmitError && e.status === 400);
  assert.throws(() => r2.submitAi(admin, 'paolo', 'x'.repeat(601)), (e: unknown) => e instanceof SubmitError && e.status === 400);
});

test('the task log records the prompt length, never the prompt text', async () => {
  const entries: Record<string, unknown>[] = [];
  const g = fakeGemini([{ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }] }]);
  const r = new JobRunner({ finance, orders: orders(), maxConcurrent: 1, log: (e) => entries.push(e), ai: { ai: g.ai, maxToolRounds: 3, maxRangeDays: 366, knowledgeDir: 'nope' } });
  await done(r, r.submitAi(admin, 'carlo', 'Secret plan for Mrs Santos').job.id);
  assert.ok(entries.length >= 2);
  assert.ok(!JSON.stringify(entries).includes('Santos'));
  assert.equal(entries[0].promptChars, 'Secret plan for Mrs Santos'.length);
});


test('Mika: trends, product mix and pipeline are calculated by code; values only with finance access', async () => {
  const mk = (ref: string, date: string, status: string, stage: string | null, gross: number, products: { category: string; type: string; wood: string; finish: string; qty: number; centavos: number }[], last?: string) =>
    ({ ref, orderId: ref, status, isClosed: status === 'Delivered', dueDate: '2026-10-15', progressPercent: null, stage, createdDate: date, grossCentavos: gross, downpaymentCentavos: 0, customerName: `Customer ${ref}`, lastProgressDate: last ?? null, products }) as OrderRecord;
  const list = [
    mk('ORD-1', '2026-08-03', 'Delivered', 'done', 2_000_000, [{ category: 'Door', type: 'Carved', wood: 'Narra', finish: 'With Varnish', qty: 2, centavos: 2_000_000 }]),
    mk('ORD-2', '2026-09-10', 'In Progress', 'finishing', 1_300_000, [{ category: 'Door', type: 'Ordinary', wood: 'Mahogany', finish: 'With Varnish', qty: 1, centavos: 1_300_000 }], '2026-10-20'),
    mk('ORD-3', '2026-10-01', 'Pending', 'production', 900_050, [{ category: 'Door', type: 'Carved', wood: 'Narra', finish: 'Without Varnish', qty: 1, centavos: 900_050 }], '2026-11-01'),
  ];
  const src = orders({ listOrders: async () => list, listOpenOrders: async () => list.filter((o) => !o.isClosed) });
  src.capabilities.payments = true;
  src.capabilities.products = true;
  src.capabilities.stageDates = true;
  const fc = (name: string, args: Record<string, unknown> = {}) => ({ functionCall: { name, args } });
  const g = fakeGemini([
    { candidates: [{ content: { role: 'model', parts: [fc('get_order_trends', { from: '2026-08-01', to: '2026-10-31' }), fc('get_product_mix', { from: '2026-08-01', to: '2026-10-31' }), fc('get_production_pipeline')] } }] },
    { candidates: [{ content: { role: 'model', parts: [{ text: 'Carved narra doors lead.' }] } }] },
  ]);
  const r = runner(g.ai, { orders: src });
  const final = await done(r, r.submitAi(admin, 'mika', 'How are we doing?').job.id);
  assert.equal(final.status, 'completed');
  const [trends, mix, pipe] = (g.bodies[1].contents as any[])[2].parts.map((p: any) => p.functionResponse.response);
  assert.deepEqual(trends.periods.map((p: any) => [p.period, p.orders]), [['2026-08', 1], ['2026-09', 1], ['2026-10', 1]]);
  assert.equal(trends.totalOrderValue, '42000.50');
  assert.equal(trends.periods[0].averageOrderValue, '20000.00');
  assert.equal(mix.pieces, 4);
  assert.equal(mix.byWood[0].name, 'Narra');
  assert.equal(mix.byWood[0].pieces, 3);
  assert.equal(mix.byWood[0].sharePercent, 75);
  assert.equal(mix.topCombinations[0].name, 'Door · Carved · Narra · With Varnish');
  assert.equal(pipe.openOrders, 2);
  assert.equal(pipe.slowestStage, 'finishing'); // last moved 2026-10-20, longer ago than production's 2026-11-01
  assert.equal(pipe.stages.find((s: any) => s.stage === 'finishing').averageDaysSinceLastProgress, 16);
  // no customer names in anything sent to Gemini; the office still gets them for display
  assert.ok(!JSON.stringify(g.bodies).includes('Customer ORD'));
  assert.equal(final.steps[0].result!.customers!['ORD-2'], 'Customer ORD-2');

  // An operations user: trends without money, and no finance trends at all.
  assert.deepEqual(toolsFor('mika', ops).sort(), ['get_order_trends', 'get_orders', 'get_product_mix', 'get_production_pipeline']);
  const g2 = fakeGemini([
    { candidates: [{ content: { role: 'model', parts: [fc('get_order_trends', { from: '2026-08-01', to: '2026-10-31' })] } }] },
    { candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }] },
  ]);
  const r2 = runner(g2.ai, { orders: src });
  await done(r2, r2.submitAi(ops, 'mika', 'Order trend please').job.id);
  const t2 = (g2.bodies[1].contents as any[])[2].parts[0].functionResponse.response;
  assert.equal(t2.totalOrderValue, undefined);
  assert.equal(t2.periods[0].orderValue, undefined);
  assert.equal(t2.periods[0].orders, 1);
});

test('Mika: monthly finance trends with best and worst month', async () => {
  const fin: FinanceSource = {
    ...finance,
    listIncome: async () =>
      [
        { ref: 'I1', kind: 'income', date: '2026-09-05', centavos: 5_000_000, currency: 'PHP', category: null, orderId: null },
        { ref: 'I2', kind: 'income', date: '2026-10-05', centavos: 1_000_000, currency: 'PHP', category: null, orderId: null },
      ] as FinanceRecord[],
    listExpenses: async () =>
      [
        { ref: 'E1', kind: 'expense', date: '2026-09-07', centavos: 1_000_000, currency: 'PHP', category: 'Rent', orderId: null },
        { ref: 'E2', kind: 'expense', date: '2026-10-08', centavos: 1_500_000, currency: 'PHP', category: 'Utilities', orderId: null },
      ] as FinanceRecord[],
  };
  const g = fakeGemini([
    { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'get_finance_trends', args: { from: '2026-09-01', to: '2026-10-31' } } }] } }] },
    { candidates: [{ content: { role: 'model', parts: [{ text: 'September was best.' }] } }] },
  ]);
  const r = new JobRunner({ finance: fin, orders: orders(), maxConcurrent: 1, now: () => new Date('2026-11-05T02:00:00Z'), ai: { ai: g.ai, maxToolRounds: 3, maxRangeDays: 366, knowledgeDir: 'nope' } });
  const final = await done(r, r.submitAi(admin, 'mika', 'Best month?').job.id);
  assert.equal(final.status, 'completed');
  const t = (g.bodies[1].contents as any[])[2].parts[0].functionResponse.response;
  assert.deepEqual(t.months.map((m: any) => [m.month, m.net]), [['2026-09', '40000.00'], ['2026-10', '-5000.00']]);
  assert.equal(t.bestMonthByNet, '2026-09');
  assert.equal(t.worstMonthByNet, '2026-10');
  assert.deepEqual(t.months[1].largestExpenseCategory, { category: 'Utilities', amount: '15000.00' });
});


// A real (tiny) JPEG header followed by filler bytes; enough for the signature check.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]).toString('base64');

test('Carlo: a photo goes to Gemini with the request, and is never logged or kept', async () => {
  const entries: Record<string, unknown>[] = [];
  const g = fakeGemini([{ candidates: [{ content: { role: 'model', parts: [{ text: '**What I see**\n- A carved door\n\n**Caption**\nCrafted with care.' }] } }] }]);
  const r = new JobRunner({ finance, orders: orders(), maxConcurrent: 1, log: (e) => entries.push(e), ai: { ai: g.ai, maxToolRounds: 3, maxRangeDays: 366, knowledgeDir: 'nope' } });
  const { job } = r.submitAi(admin, 'carlo', '', { mimeType: 'image/jpeg', data: `data:image/jpeg;base64,${JPEG}` });
  assert.equal(job.prompt, 'Write a Facebook caption for this photo.'); // empty text is fine with a photo
  assert.equal(job.image?.mimeType, 'image/jpeg');
  assert.equal(job.image?.bytes, 204);
  assert.equal(job.image?.sha256.length, 16);
  const final = await done(r, job.id);
  assert.equal(final.status, 'completed');
  // The photo comes first, then the text, in the first message; the photo rules are in the instructions.
  const parts = (g.bodies[0].contents as any[])[0].parts;
  assert.deepEqual(parts[0], { inlineData: { mimeType: 'image/jpeg', data: JPEG } });
  assert.equal(parts[1].text, 'Write a Facebook caption for this photo.');
  assert.match(JSON.stringify(g.bodies[0].systemInstruction), /A photo is attached/);
  // Never in the task log or the job snapshot; dropped from memory after the task.
  assert.ok(!JSON.stringify(entries).includes(JPEG.slice(0, 40)));
  assert.ok(entries.some((e) => e.imageBytes === 204));
  assert.ok(!JSON.stringify(final).includes(JPEG.slice(0, 40)));
  assert.equal((r as any).images.size, 0);
});

test('photos are checked: only Carlo, only real JPEG/PNG/WebP, size-limited', () => {
  const g = fakeGemini([]);
  const r = runner(g.ai);
  const code = (fn: () => unknown) => {
    try {
      fn();
      return 0;
    } catch (e) {
      return (e as SubmitError).status;
    }
  };
  assert.equal(code(() => r.submitAi(admin, 'bea', 'Look', { mimeType: 'image/jpeg', data: JPEG })), 400); // Bea takes no photos
  assert.equal(code(() => r.submitAi(admin, 'carlo', 'Look', { mimeType: 'image/gif', data: JPEG })), 400); // type not allowed
  assert.equal(code(() => r.submitAi(admin, 'carlo', 'Look', { mimeType: 'image/png', data: JPEG })), 400); // bytes are not a PNG
  assert.equal(code(() => r.submitAi(admin, 'carlo', 'Look', { mimeType: 'image/jpeg', data: Buffer.from('<script>alert(1)</script>').toString('base64') })), 400);
  assert.equal(code(() => r.submitAi(admin, 'carlo', 'Look', { mimeType: 'image/jpeg', data: 'not base64 !!!' })), 400);
  const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(3 * 1024 * 1024 + 10)]).toString('base64');
  assert.equal(code(() => r.submitAi(admin, 'carlo', 'Look', { mimeType: 'image/jpeg', data: big })), 413);
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(50)]).toString('base64');
  assert.equal(code(() => r.submitAi(admin, 'carlo', 'Caption please', { mimeType: 'image/webp', data: webp })), 0);
});
