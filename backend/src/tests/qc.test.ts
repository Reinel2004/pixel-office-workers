// Tess (Quality Control Assistant): the inspection checklist is built by code from the order's
// piece specifications, never guessed; the adapter reads office-order-spec.php; the AI gets the
// checklist but never the staff notes (they can contain customer details).

import assert from 'node:assert/strict';
import test from 'node:test';
import type { OrderSpec, PieceSpec, SessionUser } from '../../shared/live';
import { buildChecklist, checklistText, hardwareMentions } from '../../shared/qc';
import type { OrderSource } from '../adapters/types';
import { OrdersAdapter } from '../adapters/orders';
import { GeminiClient } from '../ai/gemini';
import { runAiTask } from '../ai/tasks';
import { ApiClient } from '../http/client';

const piece = (over: Partial<PieceSpec> = {}): PieceSpec => ({
  category: 'Door',
  type: 'Panel Door',
  size: '36 x 84',
  thickness: '1.75"',
  wood: 'Narra',
  finish: 'With Varnish',
  jamb: 'With Hamba',
  jambWood: 'Mahogany',
  jambSize: '2 x 6',
  cnc: true,
  tableShape: null,
  length: null,
  width: null,
  height: null,
  notes: null,
  hasDesignPhoto: true,
  hasColorSample: false,
  stage: 'finishing',
  ...over,
});
const spec = (pieces: PieceSpec[]): OrderSpec => ({ ref: 'ORD-AB12', status: 'In Progress', dueDate: '2026-11-20', pieces, truncated: false });
const items = (c: ReturnType<typeof buildChecklist>, g = 0) => c.groups[g].items;
const find = (c: ReturnType<typeof buildChecklist>, re: RegExp, g = 0) => items(c, g).find((i) => re.test(i.text));

test('a door checklist copies every expected value from the order and covers all five areas', () => {
  const c = buildChecklist(spec([piece(), piece({ stage: 'done' })]), '2026-11-07T00:00:00Z');
  assert.equal(c.groups.length, 1, 'identical pieces are checked together');
  assert.equal(c.groups[0].qty, 2);
  assert.deepEqual(c.groups[0].stages.sort(), ['done', 'finishing']);
  assert.equal(find(c, /size/)?.expected, '36 x 84');
  assert.equal(find(c, /thickness/)?.expected, '1.75"');
  assert.equal(find(c, /Design matches/)?.expected, 'Panel Door');
  assert.ok(find(c, /CNC/));
  assert.ok(find(c, /design photo/));
  assert.equal(find(c, /Wood is/)?.expected, 'Narra');
  assert.equal(find(c, /Finish is/)?.expected, 'With Varnish');
  assert.equal(find(c, /Jamb wood/)?.expected, 'Mahogany');
  assert.equal(find(c, /Jamb size/)?.expected, '2 x 6');
  assert.ok(find(c, /fits the jamb/));
  assert.ok(!find(c, /colour sample/), 'no colour-sample check without a sample');
  const areas = new Set(items(c).map((i) => i.area));
  for (const a of ['dimensions', 'design', 'finish', 'jamb', 'hardware', 'general']) assert.ok(areas.has(a as never), `has ${a}`);
  // No hardware in the notes: marked "not recorded", never guessed.
  const hw = find(c, /Hardware \(hinges/);
  assert.equal(hw?.missing, true);
  assert.equal(hw?.expected, null);
  assert.ok(c.warnings.some((w) => /Hardware is not a field/.test(w)));
});

test('missing values are flagged "not recorded" instead of being filled in', () => {
  const c = buildChecklist(spec([piece({ size: null, thickness: null, finish: null, jamb: null, wood: null, type: null })]), 'x');
  for (const re of [/size/, /thickness/, /Design matches/, /Wood is/, /Finish is/, /with or without/]) {
    const it = find(c, re);
    assert.ok(it, `item ${re}`);
    assert.equal(it!.missing, true, `${re} is missing`);
    assert.equal(it!.expected, null);
  }
  assert.ok(c.warnings.some((w) => /not recorded/.test(w)));
  assert.match(c.groups[0].label, /design not recorded/);
});

test('without a jamb, unfinished, and dining tables get the right checks', () => {
  const noJamb = buildChecklist(spec([piece({ jamb: 'Without Hamba', finish: 'Without Varnish' })]), 'x');
  assert.ok(find(noJamb, /No jamb ordered/));
  assert.ok(!find(noJamb, /Jamb wood/));
  assert.ok(find(noJamb, /Left unfinished/));
  assert.ok(!find(noJamb, /Even coat/));

  const table = buildChecklist(
    spec([piece({ category: 'Dining', type: 'Dining table', size: null, thickness: null, jamb: null, jambWood: null, jambSize: null, cnc: null, tableShape: 'Rectangle', length: '72', width: '36', height: '30' })]),
    'x',
  );
  assert.equal(find(table, /length × width × height/)?.expected, '72 × 36 × 30');
  assert.equal(find(table, /Table shape/)?.expected, 'Rectangle');
  assert.ok(!items(table).some((i) => i.area === 'jamb'), 'tables have no jamb checks');
  assert.ok(!find(table, /thickness/));
});

test('hardware comes only from the notes, in English or Filipino', () => {
  assert.deepEqual(hardwareMentions('Lagyan ng bisagra at seradura, black handle'), ['hinges', 'lockset', 'handle']);
  assert.deepEqual(hardwareMentions('no special instructions'), []);
  assert.deepEqual(hardwareMentions(null), []);
  const c = buildChecklist(spec([piece({ notes: 'Install 3 hinges and a lockset' })]), 'x');
  const hw = find(c, /mentioned in the notes/);
  assert.equal(hw?.expected, 'hinges, lockset');
  assert.equal(hw?.missing, undefined);
  assert.deepEqual(c.groups[0].notes, ['Install 3 hinges and a lockset']);
});

test('the printable text has a box per check and the not-recorded warnings', () => {
  const c = buildChecklist(spec([piece({ size: null })]), 'x');
  const t = checklistText(c, 'Juan');
  assert.match(t, /Inspection checklist — ORD-AB12 \(Juan\)/);
  assert.match(t, /\[ \] Measure the size \(height × width\) — NOT RECORDED, confirm with sales/);
  assert.match(t, /\[ \] Jamb wood: Mahogany/);
  assert.match(t, /Inspected by:/);
  assert.equal(buildChecklist(spec([]), 'x').warnings[0], 'WAD Order Management returned no pieces for this order.');
});

test('the adapter reads office-order-spec.php read-only and maps every field', async () => {
  const seen: { url: string; method: string; auth: string | null }[] = [];
  const body = {
    success: true,
    data: {
      order_number: 'ORD-AB12',
      status: 'In Progress',
      due_date: '2026-11-20',
      pieces: [{ category: 'Door', type: 'Panel', size: '36x84', thickness: '1.75', wood: 'Narra', finish: 'With Varnish', hamba: 'With Hamba', hamba_wood: 'Narra', hamba_size: '2x6', requires_cnc: true, notes: 'hinges', has_image: true, has_color_image: false, stage: 'done', customer_name: 'SHOULD NOT APPEAR' }],
      truncated: false,
    },
  };
  const fetchImpl = (async (url: URL, init?: RequestInit) => {
    seen.push({ url: String(url), method: init?.method ?? 'GET', auth: new Headers(init?.headers).get('authorization') });
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const cfg = { id: 'orders' as const, name: 'orders', baseUrl: new URL('https://orders.test/api/'), token: 'secret-token', problems: [] };
  const o = new OrdersAdapter(cfg, new ApiClient(cfg, { timeoutMs: 1000, maxRetries: 0, fetchImpl, authHeaders: async () => ({ Authorization: 'Bearer secret-token' }) }));
  const s = await o.getOrderSpec('ORD-AB12');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'GET');
  assert.equal(seen[0].url, 'https://orders.test/api/ceo/office-order-spec.php?order=ORD-AB12');
  assert.equal(seen[0].auth, 'Bearer secret-token');
  assert.equal(s.pieces[0].jamb, 'With Hamba');
  assert.equal(s.pieces[0].jambWood, 'Narra');
  assert.equal(s.pieces[0].cnc, true);
  assert.equal(s.pieces[0].hasDesignPhoto, true);
  assert.ok(!JSON.stringify(s).includes('SHOULD NOT APPEAR'), 'unknown fields are dropped');
  await assert.rejects(o.getOrderSpec('ORD 1; DROP'), /not valid/);
  assert.equal(seen.length, 1, 'an invalid number is never sent');
});

test('a missing order (or a server without the PHP file) is a clear NOT_SUPPORTED error', async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({ success: false, message: 'Order not found.' }), { status: 404, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  const cfg = { id: 'orders' as const, name: 'orders', baseUrl: new URL('https://orders.test/api/'), token: 't', problems: [] };
  const o = new OrdersAdapter(cfg, new ApiClient(cfg, { timeoutMs: 1000, maxRetries: 0, fetchImpl }));
  await assert.rejects(o.getOrderSpec('ORD-NOPE'), (e: { code: string; message: string }) => e.code === 'NOT_SUPPORTED' && /office-order-spec\.php/.test(e.message));
});

test("Tess's AI task gets the code-built checklist but never the staff notes", async () => {
  const bodies: any[] = [];
  const fetchImpl = (async (_url: URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'Checklist ready.' }] }, finishReason: 'STOP' }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const orders = {
    id: 'orders',
    capabilities: { orders: true, progress: true, dueDates: true, closedStatuses: true, sharedOrderId: false },
    status: () => ({ id: 'orders', name: 'orders', state: 'ready', host: 'orders.test', problems: [], capabilities: {} }),
    listOrders: async () => [],
    listOpenOrders: async () => [],
    getOrderSpec: async () => spec([piece({ notes: 'Call Maria Santos before delivery. Fit hinges.' })]),
  } as unknown as OrderSource;
  const user: SessionUser = { username: 'ops', role: 'operations', permissions: ['orders:read'] };
  const out = await runAiTask(
    { ai: new GeminiClient({ apiKey: 'k', model: 'm', timeoutMs: 1000, maxRetries: 0, fetchImpl }), finance: {} as never, orders, maxToolRounds: 2, maxRangeDays: 366, knowledgeDir: 'no-such-dir' },
    user,
    'tess',
    'Make the checklist in Tagalog',
    undefined,
    'ORD-AB12',
  );
  assert.equal(out.answer, 'Checklist ready.');
  assert.equal(bodies.length, 1);
  const sent = JSON.stringify(bodies[0]);
  assert.ok(!sent.includes('Maria Santos'), 'notes never reach the AI');
  assert.match(sent, /Mahogany/);
  assert.match(sent, /hardwareInNotes/);
  assert.match(sent, /hinges/);
  assert.match(sent, /Quality-control rules/);
  assert.ok(out.lookups.some((l) => l.tool === 'selected_order' && l.ok));
});
