// Team discussions: round order, limits, permissions, cancellation, partial failures, retries,
// persistence and read-only behaviour. Gemini is faked; no network.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Discussion, SessionUser, SystemStatus } from '../../shared/live';
import type { FinanceRecord, FinanceSource, OrderRecord, OrderSource } from '../adapters/types';
import { GeminiClient } from '../ai/gemini';
import { DiscussionError, DiscussionService, DiscussionStore } from '../discuss/discussions';

const admin: SessionUser = { username: 'owner', role: 'admin', permissions: ['finance:read', 'orders:read', 'social:post', 'system:read'] };
const ops: SessionUser = { username: 'ops', role: 'operations', permissions: ['orders:read'] };
const fin: SessionUser = { username: 'fin', role: 'finance', permissions: ['finance:read'] };
const status = (id: 'finance' | 'orders'): SystemStatus => ({ id, name: id, state: 'ready', host: `${id}.test`, problems: [], capabilities: {} });

/** Read-only fakes that record every method called on them. */
function sources(calls: string[] = []) {
  const order = (ref: string, over: Partial<OrderRecord> = {}): OrderRecord =>
    ({ ref, orderId: ref, status: 'In Progress', isClosed: false, dueDate: '2026-10-20', progressPercent: 40, stage: 'assembling', createdDate: '2026-10-01', customerName: 'Maria Secret', grossCentavos: 1000000, downpaymentCentavos: 300000, ...over }) as OrderRecord;
  const orders: OrderSource = {
    id: 'orders',
    capabilities: { orders: true, progress: true, dueDates: true, closedStatuses: true, sharedOrderId: false, payments: true },
    status: () => status('orders'),
    listOrders: async () => (calls.push('orders.listOrders'), [order('ORD-1'), order('ORD-2', { status: 'Delivered', isClosed: true })]),
    listOpenOrders: async () => (calls.push('orders.listOpenOrders'), [order('ORD-1')]),
  };
  const finance: FinanceSource = {
    id: 'finance',
    capabilities: { income: true, expenses: true, budgets: false, sharedOrderId: false, budgetsByCategory: false },
    status: () => status('finance'),
    listIncome: async () => (calls.push('finance.listIncome'), [{ ref: 'INC-1', kind: 'income', date: '2026-10-02', centavos: 5000000, currency: 'PHP', category: null, orderId: null } as FinanceRecord]),
    listExpenses: async () => (calls.push('finance.listExpenses'), []),
    listBudgets: async () => (calls.push('finance.listBudgets'), []),
  };
  return { orders, finance, calls };
}

const PROPOSAL = { findings: [{ text: 'One order is overdue.', kind: 'fact', evidence: ['E3', 'E99'] }], actions: [{ text: 'Check the assembly bench.', kind: 'recommendation', evidence: [] }], assumptions: [], missingInfo: ['Capacity'] };
const REVIEW = { critiques: [{ about: 'Paolo', text: 'Capacity is not in the evidence.' }], constraints: [], tradeoffs: [], improvements: ['Track capacity'] };
const SYNTH = { summary: 'Delays come from assembly.', approach: 'Track the assembly stage.', reasoning: 'E3 shows it.', actions: [{ text: 'Review assembly daily', owner: 'Paolo', evidence: ['E3'] }], risks: [], openQuestions: [], disagreements: [] };

type Script = (info: { round: 'proposal' | 'review' | 'synthesis'; agent: string; body: any; signal?: AbortSignal }) => Promise<Response> | Response;
const ok = (v: unknown, usage = true) =>
  new Response(
    JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(v) }] }, finishReason: 'STOP' }], ...(usage ? { usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 } } : {}) }),
    { status: 200 },
  );
const defaultScript: Script = ({ round }) => ok(round === 'proposal' ? PROPOSAL : round === 'review' ? REVIEW : SYNTH);

function fake(script: Script = defaultScript) {
  const bodies: any[] = [];
  const urls: string[] = [];
  const methods: string[] = [];
  const fetchImpl = (async (url: URL, init?: RequestInit) => {
    urls.push(String(url));
    methods.push(init?.method ?? 'GET');
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    const sys: string = body.systemInstruction.parts[0].text;
    const round = /Round 1 of 2/.test(sys) ? 'proposal' : /Round 2 of 2/.test(sys) ? 'review' : 'synthesis';
    const agent = /^You are (\w+)/.exec(sys)![1];
    return script({ round, agent, body, signal: init?.signal ?? undefined });
  }) as unknown as typeof fetch;
  return { ai: new GeminiClient({ apiKey: 'k', model: 'gemini-test', timeoutMs: 5000, maxRetries: 0, fetchImpl }), bodies, urls, methods };
}

function service(over: { ai?: GeminiClient | null; file?: string | null; calls?: string[]; limits?: object } = {}) {
  const s = sources(over.calls);
  return new DiscussionService({
    ai: over.ai === undefined ? fake().ai : over.ai,
    finance: s.finance,
    orders: s.orders,
    store: new DiscussionStore(over.file ?? null),
    knowledgeDir: join(tmpdir(), 'no-such-knowledge'),
    maxRangeDays: 366,
    now: () => new Date('2026-11-07T02:00:00Z'),
    sleep: async () => {},
    limits: { retryDelayMs: 0, rateLimitDelayMs: 0, ...over.limits },
  });
}

function finished(svc: DiscussionService, id: string): Promise<Discussion> {
  return new Promise((resolve) => {
    const on = (d: Discussion) => {
      if (d.id === id && ['completed', 'failed', 'cancelled'].includes(d.status)) {
        svc.off('discussion', on);
        resolve(d);
      }
    };
    svc.on('discussion', on);
  });
}

const input = { topic: 'Why are our orders delayed?', participants: ['paolo', 'bea'] as ('paolo' | 'bea')[], range: { from: '2026-10-01', to: '2026-10-31' } };

test('rounds run in order: separate proposals, then reviews, then Chief; statuses follow the state machine', async () => {
  const g = fake();
  const svc = service({ ai: g.ai });
  const seen: string[] = [];
  svc.on('discussion', (d: Discussion) => seen[seen.length - 1] !== d.status && seen.push(d.status));
  const { discussion } = svc.start(admin, input);
  const d = await finished(svc, discussion.id);
  assert.equal(d.status, 'completed');
  assert.deepEqual(seen, ['queued', 'gathering', 'proposals', 'reviews', 'synthesizing', 'completed']);
  assert.equal(g.bodies.length, 5, '2 proposals + 2 reviews + 1 synthesis');
  const rounds = g.bodies.map((b) => (/Round 1 of 2/.test(b.systemInstruction.parts[0].text) ? 'P' : /Round 2 of 2/.test(b.systemInstruction.parts[0].text) ? 'R' : 'S'));
  assert.deepEqual(rounds, ['P', 'P', 'R', 'R', 'S']);
  const text = (b: any) => b.contents[0].parts[0].text as string;
  // Round 1 never sees anyone's proposal; round 2 does; Chief also gets the reviews.
  assert.ok(g.bodies.slice(0, 2).every((b) => !text(b).includes('ROUND 1 PROPOSALS')));
  assert.ok(g.bodies.slice(2, 4).every((b) => text(b).includes('ROUND 1 PROPOSALS') && !text(b).includes('ROUND 2 REVIEWS')));
  assert.ok(text(g.bodies[4]).includes('ROUND 2 REVIEWS'));
  // Each request carries its own role.
  assert.match(g.bodies[0].systemInstruction.parts[0].text, /^You are (Paolo|Bea)/);
  assert.match(g.bodies[4].systemInstruction.parts[0].text, /^You are Chief/);
  // JSON answers are enforced; evidence ids not given to the agent are dropped; facts need evidence.
  assert.equal(g.bodies[0].generationConfig.responseMimeType, 'application/json');
  const p = d.messages.find((m) => m.round === 'proposal')!;
  assert.deepEqual(p.proposal!.findings[0].evidence.includes('E99'), false);
  assert.equal(p.droppedRefs, 1);
  assert.equal(d.messages.find((m) => m.round === 'synthesis')!.synthesis!.actions[0].owner, 'Paolo');
  assert.equal(d.aiRequests, 5);
  assert.deepEqual(d.usage, { promptTokens: 500, outputTokens: 100, totalTokens: 600 });
  assert.equal(d.partial, false);
  assert.ok(d.evidence.length > 0 && d.evidence.every((e) => e.retrievedAt && e.id.startsWith('E')));
});

test('participant limits, duplicates, Chief as participant, topic length and one active discussion per user', async () => {
  const svc = service();
  const bad = (p: string[]) => assert.throws(() => svc.start(admin, { ...input, participants: p as any }), (e: DiscussionError) => e.status === 400);
  bad(['paolo']);
  bad(['paolo', 'bea', 'rosa', 'mika', 'dev']);
  bad(['paolo', 'chief']);
  bad(['paolo', 'paolo']);
  bad(['paolo', 'nobody']);
  assert.throws(() => svc.start(admin, { ...input, topic: 'x'.repeat(201) }), (e: DiscussionError) => e.status === 400);
  assert.throws(() => svc.start(admin, { ...input, range: { from: '2026-10-31', to: '2026-10-01' } }), (e: DiscussionError) => e.status === 400);
  const a = svc.start(admin, { ...input, key: 'click-key-123' });
  const again = svc.start(admin, { ...input, key: 'click-key-123' });
  assert.equal(again.deduplicated, true);
  assert.equal(again.discussion.id, a.discussion.id);
  assert.throws(() => svc.start(admin, input), (e: DiscussionError) => e.status === 409 && e.existingId === a.discussion.id);
  await finished(svc, a.discussion.id);
  assert.throws(() => service({ ai: null }).start(admin, input), (e: DiscussionError) => e.status === 503);
});

test('permissions hold for the whole discussion: no finance evidence for operations, no orders for finance, no names', async () => {
  const g = fake();
  const svc = service({ ai: g.ai });
  const d = await finished(svc, svc.start(ops, input).discussion.id);
  assert.equal(d.status, 'completed');
  assert.ok(d.evidence.every((e) => e.system === 'orders'));
  const all = JSON.stringify(g.bodies);
  assert.ok(!all.includes('Income, expenses') && !all.includes('Balances on open orders') && !all.includes('50000.00'));
  assert.ok(!all.includes('Maria Secret'), 'customer names never reach Gemini');

  const g2 = fake();
  const svc2 = service({ ai: g2.ai });
  const d2 = await finished(svc2, svc2.start(fin, { ...input, participants: ['bea', 'rosa'] }).discussion.id);
  assert.ok(d2.evidence.every((e) => e.system === 'finance'));
  assert.ok(!JSON.stringify(g2.bodies).includes('ORD-1'));
});

test('only the owner can read, list or cancel a discussion', async () => {
  const svc = service();
  const { discussion } = svc.start(admin, input);
  assert.equal(svc.get(ops, discussion.id), null);
  assert.equal(svc.cancel(ops, discussion.id), null);
  assert.equal(svc.list(ops).length, 0);
  assert.equal(svc.list(admin).length, 1);
  await finished(svc, discussion.id);
});

test('cancel aborts in-flight requests, schedules nothing new and ignores late answers', async () => {
  let started = 0;
  let release: () => void = () => {};
  const g = fake(({ signal }) => {
    started++;
    return new Promise<Response>((resolve, reject) => {
      release = () => resolve(ok(PROPOSAL));
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  });
  const svc = service({ ai: g.ai, limits: { concurrency: 1 } });
  const { discussion } = svc.start(admin, input);
  while (started === 0) await new Promise((r) => setTimeout(r, 5));
  const c = svc.cancel(admin, discussion.id)!;
  assert.equal(c.status, 'cancelled');
  release(); // a late answer after cancelling
  await new Promise((r) => setTimeout(r, 30));
  const d = svc.get(admin, discussion.id)!;
  assert.equal(d.status, 'cancelled');
  assert.equal(started, 1, 'no new requests after cancelling');
  assert.ok(d.messages.every((m) => m.status === 'cancelled' || m.status === 'waiting' || m.status === 'skipped'));
  assert.ok(!d.messages.some((m) => m.proposal), 'the late answer was ignored');
});

test('a transient failure is retried once; a participant that still fails is labelled and Chief writes a partial summary', async () => {
  let paoloCalls = 0;
  const g = fake((info) => {
    if (info.round === 'proposal' && info.agent === 'Paolo') {
      paoloCalls++;
      return new Response('{"error":{"message":"busy"}}', { status: 503 });
    }
    return defaultScript(info);
  });
  const svc = service({ ai: g.ai });
  const d = await finished(svc, svc.start(admin, input).discussion.id);
  assert.equal(paoloCalls, 2, 'one try plus exactly one retry');
  assert.equal(d.status, 'completed');
  assert.equal(d.partial, true);
  const paolo = d.messages.find((m) => m.round === 'proposal' && m.agent === 'paolo')!;
  assert.equal(paolo.status, 'failed');
  assert.equal(paolo.attempts, 2);
  // Only one proposal: peer review is skipped (with the reason), Chief still summarises.
  assert.ok(d.messages.filter((m) => m.round === 'review').every((m) => m.status === 'skipped' && m.error));
  const chief = d.messages.find((m) => m.round === 'synthesis')!;
  assert.ok(chief.synthesis!.limitations.some((l) => l.startsWith("Paolo's proposal is missing")));
  assert.ok(JSON.stringify(g.bodies[g.bodies.length - 1]).includes('missing'));
});

test('a non-transient error is not retried; if every proposal fails the discussion fails without a summary', async () => {
  let calls = 0;
  const g = fake(() => {
    calls++;
    return new Response('{"error":{"message":"bad"}}', { status: 400 });
  });
  const svc = service({ ai: g.ai });
  const d = await finished(svc, svc.start(admin, input).discussion.id);
  assert.equal(calls, 2, 'one request per specialist, no retries, no Chief');
  assert.equal(d.status, 'failed');
  assert.match(d.error!, /No specialist produced a proposal/);
  assert.ok(!d.messages.some((m) => m.synthesis));
});

test('discussions are saved; a discussion cut off by a restart is reloaded as failed, never as running', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wad-disc-'));
  const file = join(dir, 'discussions.json');
  const svc = service({ file });
  const d = await finished(svc, svc.start(admin, input).discussion.id);
  const reloaded = service({ file });
  assert.equal(reloaded.get(admin, d.id)?.status, 'completed');
  assert.equal(reloaded.get(admin, d.id)?.messages.length, 5);

  const running: Discussion = { ...d, id: '00000000-0000-4000-8000-000000000001', status: 'proposals', finishedAt: null, messages: d.messages.map((m) => ({ ...m, status: 'working' })) };
  writeFileSync(file, JSON.stringify({ version: 1, discussions: [running] }));
  const afterRestart = service({ file }).get(admin, running.id)!;
  assert.equal(afterRestart.status, 'failed');
  assert.match(afterRestart.error!, /Interrupted/);
  assert.ok(afterRestart.messages.every((m) => m.status === 'cancelled'));
});

test('read-only: only list/read methods of the business systems are used, and only Gemini is posted to', async () => {
  const calls: string[] = [];
  const g = fake();
  const svc = service({ ai: g.ai, calls });
  await finished(svc, svc.start(admin, input).discussion.id);
  assert.ok(calls.length > 0 && calls.every((c) => /\.list[A-Z]/.test(c)));
  assert.ok(g.urls.every((u) => u.startsWith('https://generativelanguage.googleapis.com/')));
  assert.ok(g.methods.every((m) => m === 'POST'));
  // The evidence snapshot is read once and reused for every request.
  assert.equal(calls.filter((c) => c === 'orders.listOpenOrders').length, 1);
  assert.equal(calls.filter((c) => c === 'orders.listOrders').length, 1);
});

test('the server never creates demo discussions', async () => {
  const svc = service();
  const { discussion } = svc.start(admin, input);
  assert.equal(discussion.mode, 'connected');
  await finished(svc, discussion.id);
});
