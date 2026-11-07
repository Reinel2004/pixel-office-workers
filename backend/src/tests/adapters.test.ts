// Adapters against the WAD CEO API shapes (api/ceo/records.php and api/ceo/office-orders.php).
import assert from 'node:assert/strict';
import test from 'node:test';
import { FinanceAdapter, toCentavos } from '../adapters/finance';
import { OrdersAdapter } from '../adapters/orders';
import { ApiClient } from '../http/client';

const range = { from: '2026-10-01', to: '2026-10-31' };

function setup(id: 'finance' | 'orders', body: unknown) {
  const seen: { url: string; auth: string | null }[] = [];
  const fetchImpl = (async (url: URL, init?: RequestInit) => {
    seen.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') });
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const cfg = { id, name: id, baseUrl: new URL(`https://${id}.test/api/`), token: 'secret-token', problems: [] };
  const client = new ApiClient(cfg, { timeoutMs: 1000, maxRetries: 0, fetchImpl, authHeaders: async () => ({ Authorization: 'Bearer secret-token' }) });
  return { cfg, client, seen };
}

test('amounts convert to exact centavos', () => {
  assert.equal(toCentavos('1234.50', 'f', 'finance'), 123450);
  assert.equal(toCentavos('0.1', 'f', 'finance'), 10);
  assert.equal(toCentavos('19.99', 'f', 'finance'), 1999);
  assert.equal(toCentavos(250, 'f', 'finance'), 25000);
  assert.throws(() => toCentavos('12.345', 'f', 'finance'));
  assert.throws(() => toCentavos('abc', 'f', 'finance'));
});

test('finance adapter reads records.php once per report with the Bearer token', async () => {
  const { cfg, client, seen } = setup('finance', {
    success: true,
    data: {
      currency: 'PHP',
      truncated: false,
      income: [{ id: 7, date: '2026-10-03', amount: '15000.00', status: 'Received' }],
      expenses: [{ id: 9, date: '2026-10-04', amount: '1200.50', category: 'Utilities' }],
      budgets: [{ month: '2026-10', amount: '50000.00' }],
    },
  });
  const f = new FinanceAdapter(cfg, client);
  assert.equal(f.status().state, 'ready');
  const [inc, exp, bud] = await Promise.all([f.listIncome(range), f.listExpenses(range), f.listBudgets(range)]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://finance.test/api/ceo/records?from=2026-10-01&to=2026-10-31');
  assert.equal(seen[0].auth, 'Bearer secret-token');
  assert.deepEqual(inc[0], { ref: 'INC-7', kind: 'income', date: '2026-10-03', centavos: 1500000, currency: 'PHP', category: null, orderId: null });
  assert.equal(exp[0].centavos, 120050);
  assert.equal(exp[0].category, 'Utilities');
  assert.equal(bud[0].ref, 'BUDGET-2026-10');
});

test('finance adapter refuses a truncated result', async () => {
  const { cfg, client } = setup('finance', { success: true, data: { currency: 'PHP', truncated: true, income: [], expenses: [], budgets: [] } });
  await assert.rejects(new FinanceAdapter(cfg, client).listIncome(range), { code: 'RESULT_TOO_LARGE' });
});

test('orders adapter maps statuses, progress and due dates', async () => {
  const { cfg, client, seen } = setup('orders', {
    success: true,
    data: {
      truncated: false,
      payments_available: true,
      carpenters_available: true,
      carpenter_roster: ['Ramon ', '', 'Jun', 42],
      orders: [
        { carpenters: [' Ramon', 'Ramon', ''], hamba_carpenters: ['Jun'], order_number: 'ORD-1', group_id: 'GRP-1', status: 'Finished', order_date: '2026-10-02', due_date: '2026-10-20', items: 4, items_done: 4, least_stage: 'done', gross_price: '25000.50', downpayment: '10000.00', customer_name: ' Juan Santos ', last_progress_at: '2026-10-18', products: [{ category: 'Door', type: 'Carved', wood: 'Narra', finish: 'With Varnish', qty: 4, value: '25000.50' }] },
        { order_number: 'ORD-2', group_id: 'GRP-2', status: 'In Progress', order_date: '2026-10-05', due_date: '0000-00-00', items: 2, items_done: 0, least_stage: null },
        { order_number: 'ORD-3', group_id: 'GRP-3', status: 'Delivered', order_date: '2026-10-06', due_date: null, items: 1, items_done: 1, least_stage: 'done' },
      ],
    },
  });
  const o = new OrdersAdapter(cfg, client);
  const rows = await o.listOrders(range);
  assert.equal(seen[0].url, 'https://orders.test/api/ceo/office-orders.php?from=2026-10-01&to=2026-10-31');
  assert.equal(seen[0].auth, 'Bearer secret-token');
  assert.deepEqual(rows.map((r) => r.isClosed), [false, false, true]);
  assert.equal(rows[0].progressPercent, 100);
  assert.equal(rows[1].progressPercent, null);
  assert.equal(rows[1].dueDate, null);
  assert.equal(o.capabilities.payments, true);
  assert.equal(rows[0].grossCentavos, 2500050);
  assert.equal(rows[0].downpaymentCentavos, 1000000);
  assert.equal(rows[1].grossCentavos, null);
  assert.equal(rows[0].customerName, 'Juan Santos');
  assert.equal(rows[0].lastProgressDate, '2026-10-18');
  assert.deepEqual(rows[0].products, [{ category: 'Door', type: 'Carved', wood: 'Narra', finish: 'With Varnish', qty: 4, centavos: 2500050 }]);
  assert.equal(rows[1].products, undefined);
  assert.equal(rows[1].customerName, null);
  assert.deepEqual(rows[0].carpenters, ['Ramon']);
  assert.deepEqual(rows[0].hambaCarpenters, ['Jun']);
  assert.deepEqual(rows[1].carpenters, []);
  assert.equal(o.capabilities.carpenters, true);
  assert.deepEqual(o.carpenterRoster, ['Ramon', 'Jun']);
  const open = await o.listOpenOrders();
  assert.match(seen[1].url, /office-orders\.php\?open=1$/);
  assert.deepEqual(open.map((r) => r.ref), ['ORD-1', 'ORD-2']);
});

test('an API error message is reported, not treated as data', async () => {
  const { cfg, client } = setup('orders', { success: false, message: 'Server misconfiguration' });
  await assert.rejects(new OrdersAdapter(cfg, client).listOpenOrders(), { code: 'UPSTREAM_ERROR' });
});
