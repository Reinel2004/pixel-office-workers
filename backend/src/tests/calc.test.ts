// Report calculations. Records below are hand-written test fixtures for our normalized types;
// they are not WAD data and are not used anywhere outside the tests.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addDays, manilaDate, presetRange, validateRange } from '../../shared/manila';
import type { FinanceRecord, OrderRecord } from '../adapters/types';
import { combine, financeSummary, orderStatus, overdueOrders, sumByCurrency } from '../reports/calc';

const range = { from: '2026-10-01', to: '2026-10-31' };
const fr = (ref: string, kind: 'income' | 'expense', centavos: number, extra: Partial<FinanceRecord> = {}): FinanceRecord => ({
  ref,
  kind,
  date: '2026-10-10',
  centavos,
  currency: 'PHP',
  category: null,
  orderId: null,
  ...extra,
});
const ord = (ref: string, extra: Partial<OrderRecord> = {}): OrderRecord => ({
  ref,
  orderId: ref,
  status: 'In production',
  isClosed: false,
  dueDate: '2026-11-10',
  progressPercent: null,
  stage: null,
  createdDate: null,
  ...extra,
});

test('money sums are exact integers per currency', () => {
  assert.deepEqual(sumByCurrency([{ centavos: 10, currency: 'PHP' }, { centavos: 20, currency: 'PHP' }, { centavos: 5, currency: 'USD' }]), [
    { currency: 'PHP', centavos: 30 },
    { currency: 'USD', centavos: 5 },
  ]);
  assert.throws(() => sumByCurrency([{ centavos: 1.5, currency: 'PHP' }]));
});

test('finance summary: totals, categories, and no budget comparison unless confirmed', () => {
  const inc = [fr('I1', 'income', 1_850_000), fr('I2', 'income', 620_000)];
  const exp = [fr('E1', 'expense', 300_000, { category: 'Lumber' }), fr('E2', 'expense', 50_050, { category: 'Hardware' })];
  const budgets = [{ ref: 'B1', name: 'Lumber Oct', centavos: 500_000, currency: 'PHP', category: 'Lumber' }];
  const a = financeSummary(range, inc, exp, budgets, false);
  assert.deepEqual(a.report.income, [{ currency: 'PHP', centavos: 2_470_000 }]);
  assert.deepEqual(a.report.net, [{ currency: 'PHP', centavos: 2_119_950 }]);
  assert.equal(a.report.budgetComparison, 'unavailable');
  assert.equal(a.report.budgets[0].spent, null);
  const b = financeSummary(range, inc, exp, budgets, true);
  assert.deepEqual(b.report.budgets[0].remaining, [{ currency: 'PHP', centavos: 200_000 }]);
});

test('overdue uses the Manila date and never guesses closed state', () => {
  const today = '2026-11-05';
  const { report } = overdueOrders(
    [
      ord('A', { dueDate: '2026-11-01' }),
      ord('B', { dueDate: '2026-11-05' }),
      ord('C', { dueDate: '2026-10-01', isClosed: true }),
      ord('D', { dueDate: '2026-10-01', isClosed: null }),
      ord('E', { dueDate: null }),
    ],
    today,
  );
  assert.deepEqual(report.overdue.map((o) => [o.ref, o.daysOverdue]), [['A', 4]]);
  assert.equal(report.undetermined, 2);
});

test('order status hides open/overdue counts when status meanings are unknown', () => {
  const r1 = orderStatus(range, [ord('A'), ord('B', { status: 'Ready' })], '2026-11-05', true);
  assert.equal(r1.report.open, 2);
  const r2 = orderStatus(range, [ord('A')], '2026-11-05', false);
  assert.equal(r2.report.open, null);
  assert.ok(r2.notes.length > 0);
});

test('combined report links only by verified order ID and explains gaps', () => {
  const orders = [ord('WAD-1'), ord('WAD-2'), ord('WAD-3')];
  const income = [fr('I1', 'income', 1_000_000, { orderId: 'WAD-1' }), fr('I2', 'income', 500_000, { orderId: 'WAD-2' }), fr('I3', 'income', 9, { orderId: 'WAD-99' })];
  const expenses = [fr('E1', 'expense', 400_000, { orderId: 'WAD-1' }), fr('E2', 'expense', 1_000)];
  const { report, notes } = combine(range, orders, income, expenses, true);
  assert.deepEqual(
    report.matched.map((m) => [m.orderRef, m.recordedMargin[0].centavos, m.costsIncomplete]),
    [
      ['WAD-1', 600_000, false],
      ['WAD-2', 500_000, true],
    ],
  );
  assert.equal(report.financeWithoutOrderId, 1);
  assert.deepEqual(report.financeOrderIdNotFound, ['WAD-99']);
  assert.deepEqual(report.ordersWithoutFinance, ['WAD-3']);
  assert.ok(notes.some((n) => /costs are incomplete/.test(n)));
});

test('combined report refuses to link without a verified shared ID', () => {
  const { report, notes } = combine(range, [ord('WAD-1')], [fr('I1', 'income', 5, { orderId: 'WAD-1' })], [], false);
  assert.equal(report.linking, 'unavailable');
  assert.equal(report.matched.length, 0);
  assert.ok(notes[0].includes('not linked'));
});

test('Manila dates and range presets', () => {
  assert.equal(manilaDate(new Date('2026-11-05T16:30:00Z')), '2026-11-06'); // 00:30 next day in Manila
  assert.deepEqual(presetRange('lastMonth', '2026-01-15'), { from: '2025-12-01', to: '2025-12-31' });
  assert.deepEqual(presetRange('last7', '2026-11-05'), { from: '2026-10-30', to: '2026-11-05' });
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.match(validateRange({ from: '2026-11-05', to: '2026-11-01' }, 366)!, /before/);
  assert.match(validateRange({ from: '2026-02-30', to: '2026-03-01' }, 366)!, /format/);
  assert.equal(validateRange({ from: '2026-01-01', to: '2026-12-31' }, 366), null);
});
