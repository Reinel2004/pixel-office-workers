// Report calculations. All money is integer centavos, grouped by currency; amounts in
// different currencies are never added together. These functions only work with records the
// adapters returned — they never fill gaps with estimates.

import type {
  CombinedReport,
  DateRange,
  FinanceReport,
  Money,
  OrderRow,
  OrderStatusReport,
  OverdueReport,
  ShopCarpenter,
  ShopCounts,
} from '../../shared/live';
import { daysBetween } from '../../shared/manila';
import type { BudgetRecord, FinanceRecord, OrderRecord } from '../adapters/types';

export function sumByCurrency(rows: { centavos: number; currency: string }[]): Money[] {
  const m = new Map<string, number>();
  for (const r of rows) {
    if (!Number.isSafeInteger(r.centavos)) throw new Error('Amount is not an integer number of centavos.');
    m.set(r.currency, (m.get(r.currency) ?? 0) + r.centavos);
    if (!Number.isSafeInteger(m.get(r.currency)!)) throw new Error('Total exceeds safe integer range.');
  }
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, centavos]) => ({ currency, centavos }));
}

export function subtract(a: Money[], b: Money[]): Money[] {
  const m = new Map<string, number>();
  for (const x of a) m.set(x.currency, (m.get(x.currency) ?? 0) + x.centavos);
  for (const x of b) m.set(x.currency, (m.get(x.currency) ?? 0) - x.centavos);
  return [...m.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([currency, centavos]) => ({ currency, centavos }));
}

export function financeSummary(
  range: DateRange,
  income: FinanceRecord[],
  expenses: FinanceRecord[],
  budgets: BudgetRecord[] | null,
  budgetsByCategory: boolean,
): { report: FinanceReport; notes: string[] } {
  const notes: string[] = [];
  const inc = sumByCurrency(income);
  const exp = sumByCurrency(expenses);
  const cats = new Map<string, FinanceRecord[]>();
  for (const e of expenses) {
    const k = e.category ?? 'Uncategorized';
    cats.set(k, [...(cats.get(k) ?? []), e]);
  }
  const canCompare = budgetsByCategory && !!budgets && budgets.every((b) => b.category !== null);
  if (budgets === null) notes.push('Budgets were not included: the budget endpoint is not available.');
  else if (budgets.length && !canCompare) notes.push('Budget vs. actual is not shown: it is not confirmed that budgets are tracked by the same categories as expenses.');
  if (inc.length > 1 || exp.length > 1) notes.push('Records use more than one currency; totals are shown per currency and not combined.');
  const report: FinanceReport = {
    kind: 'finance.summary',
    range,
    income: inc,
    expenses: exp,
    net: subtract(inc, exp),
    expensesByCategory: [...cats.entries()]
      .map(([category, rows]) => ({ category, amounts: sumByCurrency(rows) }))
      .sort((a, b) => (b.amounts[0]?.centavos ?? 0) - (a.amounts[0]?.centavos ?? 0)),
    budgets: (budgets ?? []).map((b) => {
      const amounts = [{ currency: b.currency, centavos: b.centavos }];
      if (!canCompare) return { ref: b.ref, name: b.name, amounts, spent: null, remaining: null };
      const spent = sumByCurrency(expenses.filter((e) => e.category === b.category && e.currency === b.currency));
      return { ref: b.ref, name: b.name, amounts, spent, remaining: subtract(amounts, spent) };
    }),
    budgetComparison: canCompare ? 'available' : 'unavailable',
  };
  return { report, notes };
}

function toRow(o: OrderRecord, today: string): OrderRow {
  const overdue = o.isClosed === false && o.dueDate !== null && o.dueDate < today;
  return {
    ref: o.ref,
    status: o.status,
    dueDate: o.dueDate,
    progressPercent: o.progressPercent,
    stage: o.stage,
    daysOverdue: overdue ? daysBetween(o.dueDate!, today) : null,
  };
}

export function orderStatus(range: DateRange, orders: OrderRecord[], today: string, closedKnown: boolean): { report: OrderStatusReport; notes: string[] } {
  const notes: string[] = [];
  const counts = new Map<string, number>();
  for (const o of orders) counts.set(o.status, (counts.get(o.status) ?? 0) + 1);
  const unknownClosed = orders.filter((o) => o.isClosed === null).length;
  if (!closedKnown || unknownClosed) notes.push('Open/overdue counts are not shown for orders whose status values are not documented as open or closed.');
  const rows = orders.map((o) => toRow(o, today));
  return {
    report: {
      kind: 'orders.status',
      range,
      byStatus: [...counts.entries()].map(([status, count]) => ({ status, count })).sort((a, b) => b.count - a.count),
      open: closedKnown && !unknownClosed ? orders.filter((o) => o.isClosed === false).length : null,
      overdue: closedKnown && !unknownClosed ? rows.filter((r) => r.daysOverdue !== null).length : null,
      rows,
    },
    notes,
  };
}

export function overdueOrders(orders: OrderRecord[], today: string): { report: OverdueReport; notes: string[] } {
  const notes: string[] = [];
  const undetermined = orders.filter((o) => o.isClosed === null || (o.isClosed === false && o.dueDate === null)).length;
  if (undetermined) notes.push(`${undetermined} order(s) could not be checked because the due date or open/closed state is missing.`);
  const overdue = orders
    .map((o) => toRow(o, today))
    .filter((r) => r.daysOverdue !== null)
    .sort((a, b) => (b.daysOverdue ?? 0) - (a.daysOverdue ?? 0));
  return { report: { kind: 'orders.overdue', asOf: today, overdue, undetermined }, notes };
}

/**
 * Joins finance records to orders ONLY through the verified shared order ID. Records without
 * that ID, or whose ID is not among the returned orders, are reported — never guessed.
 */
export function combine(
  range: DateRange,
  orders: OrderRecord[],
  income: FinanceRecord[],
  expenses: FinanceRecord[],
  linkVerified: boolean,
): { report: CombinedReport; notes: string[] } {
  const notes: string[] = [];
  if (!linkVerified) {
    notes.push('Orders and financial records were not linked: no shared order ID has been verified between the two systems.');
    return {
      report: {
        kind: 'combined.report',
        range,
        linking: 'unavailable',
        matched: [],
        financeWithoutOrderId: income.length + expenses.length,
        financeOrderIdNotFound: [],
        ordersWithoutFinance: orders.map((o) => o.ref),
      },
      notes,
    };
  }
  const byId = new Map(orders.map((o) => [o.orderId, o]));
  const inc = new Map<string, FinanceRecord[]>();
  const exp = new Map<string, FinanceRecord[]>();
  let withoutId = 0;
  const notFound = new Set<string>();
  for (const [list, target] of [
    [income, inc],
    [expenses, exp],
  ] as const) {
    for (const r of list) {
      if (!r.orderId) {
        withoutId++;
        continue;
      }
      if (!byId.has(r.orderId)) {
        notFound.add(r.orderId);
        continue;
      }
      target.set(r.orderId, [...(target.get(r.orderId) ?? []), r]);
    }
  }
  const matched = orders
    .filter((o) => inc.has(o.orderId) || exp.has(o.orderId))
    .map((o) => {
      const i = sumByCurrency(inc.get(o.orderId) ?? []);
      const e = sumByCurrency(exp.get(o.orderId) ?? []);
      return { orderRef: o.ref, status: o.status, income: i, expenses: e, recordedMargin: subtract(i, e), costsIncomplete: !exp.has(o.orderId) };
    });
  const ordersWithoutFinance = orders.filter((o) => !inc.has(o.orderId) && !exp.has(o.orderId)).map((o) => o.ref);
  if (withoutId) notes.push(`${withoutId} financial record(s) have no order ID and could not be linked to an order.`);
  if (notFound.size) notes.push(`${notFound.size} order ID(s) on financial records were not among the orders returned for this range.`);
  if (matched.some((m) => m.costsIncomplete))
    notes.push('Some orders have income but no recorded expenses; their "recorded margin" is not a profit figure because costs are incomplete.');
  notes.push('Recorded margin = recorded income − recorded expenses linked by order ID. Unrecorded costs (materials from stock, labour not entered) are not included.');
  return {
    report: {
      kind: 'combined.report',
      range,
      linking: 'verified-order-id',
      matched,
      financeWithoutOrderId: withoutId,
      financeOrderIdNotFound: [...notFound],
      ordersWithoutFinance,
    },
    notes,
  };
}

export interface CollectionRow {
  ref: string;
  status: string;
  dueDate: string | null;
  daysOverdue: number | null;
  stage: string | null;
  orderPrice: string;
  downpayment: string;
  balance: string;
  /** Finished but not delivered: the balance is normally collected before or at delivery. */
  readyForDelivery: boolean;
  noDownpayment: boolean;
}

export interface CollectionsReport {
  asOf: string;
  openOrders: number;
  ordersWithBalance: number;
  /** Totals in pesos, calculated here in integer centavos. */
  totalOrderValue: string;
  totalDownpayments: string;
  totalBalance: string;
  balanceReadyForDelivery: string;
  noDownpaymentCount: number;
  rows: CollectionRow[];
  /** Open orders whose price or downpayment the system did not provide. */
  missingAmounts: string[];
}

const peso = (c: number) => (c / 100).toFixed(2);

/**
 * Outstanding balances on open (not Delivered) orders, using the order system's own rule:
 * balance = max(0, order price - downpayment). Delivered orders count as paid there.
 * Sorted: ready for delivery first, then most overdue, then largest balance.
 */
export function collections(open: OrderRecord[], today: string): CollectionsReport {
  let value = 0;
  let down = 0;
  let bal = 0;
  let ready = 0;
  const rows: (CollectionRow & { c: number })[] = [];
  const missing: string[] = [];
  for (const o of open) {
    if (o.grossCentavos == null || o.downpaymentCentavos == null) {
      missing.push(o.ref);
      continue;
    }
    const b = Math.max(0, o.grossCentavos - o.downpaymentCentavos);
    value += o.grossCentavos;
    down += o.downpaymentCentavos;
    bal += b;
    if (b <= 0) continue;
    const isReady = o.status.toLowerCase() === 'finished';
    if (isReady) ready += b;
    rows.push({
      ref: o.ref,
      status: o.status,
      dueDate: o.dueDate,
      daysOverdue: toRow(o, today).daysOverdue,
      stage: o.stage,
      orderPrice: peso(o.grossCentavos),
      downpayment: peso(o.downpaymentCentavos),
      balance: peso(b),
      readyForDelivery: isReady,
      noDownpayment: o.downpaymentCentavos <= 0,
      c: b,
    });
  }
  rows.sort((a, b) => Number(b.readyForDelivery) - Number(a.readyForDelivery) || (b.daysOverdue ?? -1) - (a.daysOverdue ?? -1) || b.c - a.c);
  return {
    asOf: today,
    openOrders: open.length,
    ordersWithBalance: rows.length,
    totalOrderValue: peso(value),
    totalDownpayments: peso(down),
    totalBalance: peso(bal),
    balanceReadyForDelivery: peso(ready),
    noDownpaymentCount: rows.filter((r) => r.noDownpayment).length,
    rows: rows.map(({ c: _c, ...r }) => r),
    missingAmounts: missing,
  };
}

/**
 * The Workshop room: each carpenter with their open orders by status (an order counts once per
 * carpenter, whether as carpenter or hamba carpenter). The roster's order is kept; carpenters
 * found only on orders follow, by name. Names and counts only.
 */
export function shopCounts(open: OrderRecord[], roster: string[] | null, available: boolean, today: string, asOf: string): ShopCounts {
  const by = new Map<string, ShopCarpenter>();
  const key = (n: string) => n.toLowerCase();
  const get = (n: string) => {
    let c = by.get(key(n));
    if (!c) by.set(key(n), (c = { name: n, inProgress: 0, pending: 0, finished: 0, hamba: 0 }));
    return c;
  };
  for (const n of roster ?? []) get(n);
  let unassigned = 0;
  let ready = 0;
  for (const o of open) {
    const s = o.status.toLowerCase();
    if (s === 'finished') ready++;
    const main = o.carpenters ?? [];
    const frame = o.hambaCarpenters ?? [];
    const all = new Map<string, string>();
    for (const n of [...main, ...frame]) if (!all.has(key(n))) all.set(key(n), n);
    if (!all.size && s !== 'finished') unassigned++;
    for (const [k, n] of all) {
      const c = get(n);
      if (s === 'in progress') c.inProgress++;
      else if (s === 'finished') c.finished++;
      else c.pending++;
      if (frame.some((f) => key(f) === k) && !main.some((m) => key(m) === k)) c.hamba++;
    }
  }
  const inRoster = new Set((roster ?? []).map(key));
  const carpenters = [...by.values()].sort((a, b) => {
    const ra = inRoster.has(key(a.name));
    const rb = inRoster.has(key(b.name));
    if (ra !== rb) return ra ? -1 : 1;
    if (ra) return (roster ?? []).findIndex((n) => key(n) === key(a.name)) - (roster ?? []).findIndex((n) => key(n) === key(b.name));
    return a.name.localeCompare(b.name);
  });
  return { available, carpenters: carpenters.slice(0, 30), unassigned, ready, open: open.length, overdue: overdueOrders(open, today).report.overdue.length, asOf };
}

export interface DataCheck {
  id: string;
  label: string;
  /** false = the order system does not provide what this check needs (not "no problems"). */
  available: boolean;
  count: number;
  /** Order numbers with this problem (at most 30). */
  orders: string[];
  /** Only for possible duplicates: groups of order numbers that look like one order entered twice. */
  groups?: string[][];
}

/**
 * Data-quality checks on orders, calculated by code. Order numbers only: customer names are used
 * to spot possible duplicates but never appear in the result.
 */
export function dataChecks(
  orders: OrderRecord[],
  today: string,
  opts: { money: boolean; payments: boolean; carpenters: boolean; laborCheck: boolean; priceCheck: boolean },
): { ordersChecked: number; checks: DataCheck[]; problemOrders: number } {
  const MAX = 30;
  const make = (id: string, label: string, available: boolean, hit: (o: OrderRecord) => boolean): DataCheck => {
    const refs = available ? orders.filter(hit).map((o) => o.ref) : [];
    return { id, label, available, count: refs.length, orders: refs.slice(0, MAX) };
  };
  const st = (o: OrderRecord) => o.status.toLowerCase();
  const assigned = (o: OrderRecord) => (o.carpenters?.length ?? 0) + (o.hambaCarpenters?.length ?? 0) > 0;
  const checks: DataCheck[] = [
    make('missing_due_date', 'Open order with no due date', true, (o) => o.isClosed !== true && !o.dueDate),
    make('unknown_status', 'Status is not Pending, In Progress, Finished or Delivered', true, (o) => o.isClosed === null),
    make('missing_order_date', 'No order date', true, (o) => !o.createdDate),
    make('due_before_order', 'Due date is before the order date', true, (o) => !!o.dueDate && !!o.createdDate && o.dueDate < o.createdDate),
    make('no_carpenter_in_progress', 'In Progress but no carpenter assigned', opts.carpenters, (o) => st(o) === 'in progress' && !assigned(o)),
    make('labor_missing', 'Carpenter assigned but no labor amount entered', opts.laborCheck, (o) => (o.laborMissing ?? 0) > 0),
    make('zero_price', 'A piece has no price or a price of zero', opts.priceCheck, (o) => (o.zeroPriceItems ?? 0) > 0),
    make(
      'finished_no_downpayment',
      'Finished or Delivered with no downpayment recorded',
      opts.money && opts.payments,
      (o) => (st(o) === 'finished' || st(o) === 'delivered') && o.downpaymentCentavos === 0,
    ),
  ];
  // Possible duplicates: same customer (ignoring case and spaces) on the same order date.
  const byKey = new Map<string, string[]>();
  for (const o of orders) {
    const name = (o.customerName ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!name || !o.createdDate) continue;
    const k = `${name}|${o.createdDate}`;
    byKey.set(k, [...(byKey.get(k) ?? []), o.ref]);
  }
  const groups = [...byKey.values()].filter((g) => g.length > 1);
  checks.push({
    id: 'possible_duplicate',
    label: 'Same customer and order date as another order (maybe entered twice)',
    available: true,
    count: groups.reduce((n, g) => n + g.length, 0),
    orders: groups.flat().slice(0, MAX),
    groups: groups.slice(0, 15).map((g) => g.slice(0, 5)),
  });
  const problem = new Set(checks.flatMap((c) => c.orders));
  void today;
  return { ordersChecked: orders.length, checks, problemOrders: problem.size };
}

/** Order number -> customer name for the given orders (display only; capped). */
export function customerNames(orders: OrderRecord[], onlyRefs?: Iterable<string>, max = 500): Record<string, string> {
  const keep = onlyRefs ? new Set(onlyRefs) : null;
  const out: Record<string, string> = {};
  let n = 0;
  for (const o of orders) {
    if (n >= max) break;
    if (!o.customerName || (keep && !keep.has(o.ref)) || o.ref in out) continue;
    out[o.ref] = o.customerName;
    n++;
  }
  return out;
}

// ---------------------------------------------------------------- Data Analyst (trends)
// Everything here is counted and added up in integer centavos by code. The AI only explains it.

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((1000 * part) / whole) / 10 : 0);

/** Monday of the ISO week containing the date (YYYY-MM-DD). */
function weekStart(d: string) {
  const t = new Date(`${d}T00:00:00Z`);
  const dow = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - dow);
  return t.toISOString().slice(0, 10);
}

export interface TrendPeriod {
  period: string; // YYYY-MM, or the Monday of the week
  orders: number;
  pieces: number;
  delivered: number;
  stillOpen: number;
  orderValue?: string; // pesos, only when the user may see money
  averageOrderValue?: string;
}

/** Orders by month or week of their order date. Periods with no orders are included as zero. */
export function orderTrends(range: DateRange, orders: OrderRecord[], period: 'month' | 'week', money: boolean) {
  const key = (d: string) => (period === 'month' ? d.slice(0, 7) : weekStart(d));
  const buckets = new Map<string, { n: number; pieces: number; delivered: number; open: number; value: number; valued: number }>();
  // every period in the range, so quiet months show as 0 instead of disappearing
  for (let d = range.from; d <= range.to; ) {
    buckets.set(key(d), { n: 0, pieces: 0, delivered: 0, open: 0, value: 0, valued: 0 });
    const t = new Date(`${d}T00:00:00Z`);
    if (period === 'month') t.setUTCMonth(t.getUTCMonth() + 1, 1);
    else t.setUTCDate(t.getUTCDate() + 7);
    d = t.toISOString().slice(0, 10);
  }
  let undated = 0;
  for (const o of orders) {
    if (!o.createdDate) {
      undated++;
      continue;
    }
    const b = buckets.get(key(o.createdDate)) ?? { n: 0, pieces: 0, delivered: 0, open: 0, value: 0, valued: 0 };
    buckets.set(key(o.createdDate), b);
    b.n++;
    b.pieces += (o.products ?? []).reduce((s, p) => s + p.qty, 0);
    if (o.isClosed === true) b.delivered++;
    else b.open++;
    if (o.grossCentavos != null) {
      b.value += o.grossCentavos;
      b.valued++;
    }
  }
  const periods: TrendPeriod[] = [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([p, b]) => ({
      period: p,
      orders: b.n,
      pieces: b.pieces,
      delivered: b.delivered,
      stillOpen: b.open,
      ...(money ? { orderValue: peso(b.value), averageOrderValue: b.valued ? peso(Math.round(b.value / b.valued)) : '0.00' } : {}),
    }));
  const total = orders.length - undated;
  const totalValue = orders.reduce((s, o) => s + (o.grossCentavos ?? 0), 0);
  const busiest = periods.reduce<TrendPeriod | null>((m, p) => (!m || p.orders > m.orders ? p : m), null);
  // first half vs second half of the range: a simple, honest "going up or down"
  const half = Math.floor(periods.length / 2);
  const firstHalf = periods.slice(0, half).reduce((s, p) => s + p.orders, 0);
  const secondHalf = periods.slice(periods.length - half).reduce((s, p) => s + p.orders, 0);
  return {
    range,
    period,
    totalOrders: total,
    ...(money ? { totalOrderValue: peso(totalValue) } : {}),
    busiestPeriod: busiest && busiest.orders > 0 ? busiest.period : null,
    firstHalfOrders: firstHalf,
    secondHalfOrders: secondHalf,
    changePercent: firstHalf ? Math.round(((secondHalf - firstHalf) / firstHalf) * 1000) / 10 : null,
    periods,
    undatedOrders: undated,
  };
}

/** What customers order: pieces by category, type, wood and finish, and the top combinations. */
export function productMix(orders: OrderRecord[], money: boolean) {
  type Agg = { qty: number; c: number; orders: Set<string> };
  const groups: Record<'category' | 'type' | 'wood' | 'finish' | 'combo', Map<string, Agg>> = {
    category: new Map(),
    type: new Map(),
    wood: new Map(),
    finish: new Map(),
    combo: new Map(),
  };
  let pieces = 0;
  let without = 0;
  for (const o of orders) {
    if (!o.products?.length) {
      without++;
      continue;
    }
    for (const p of o.products) {
      pieces += p.qty;
      const keys = {
        category: p.category ?? 'Not recorded',
        type: p.type ?? 'Not recorded',
        wood: p.wood ?? 'Not recorded',
        finish: p.finish ?? 'Not recorded',
        combo: [p.category, p.type, p.wood, p.finish].filter(Boolean).join(' · ') || 'Not recorded',
      };
      for (const g of Object.keys(groups) as (keyof typeof groups)[]) {
        const a = groups[g].get(keys[g]) ?? { qty: 0, c: 0, orders: new Set<string>() };
        a.qty += p.qty;
        a.c += p.centavos ?? 0;
        a.orders.add(o.ref);
        groups[g].set(keys[g], a);
      }
    }
  }
  const list = (m: Map<string, Agg>, top: number) =>
    [...m.entries()]
      .sort((a, b) => b[1].qty - a[1].qty || b[1].c - a[1].c)
      .slice(0, top)
      .map(([name, a]) => ({ name, pieces: a.qty, sharePercent: pct(a.qty, pieces), orders: a.orders.size, ...(money ? { value: peso(a.c) } : {}) }));
  return {
    orders: orders.length,
    pieces,
    ordersWithoutProductDetails: without,
    byCategory: list(groups.category, 10),
    byType: list(groups.type, 12),
    byWood: list(groups.wood, 12),
    byFinish: list(groups.finish, 8),
    topCombinations: list(groups.combo, 12),
  };
}

const STAGE_ORDER = ['production', 'roughing', 'assembling', 'finishing', 'done'];

/** Where open orders are now: per least-advanced stage, how many, how old, and how long since they last moved. */
export function productionPipeline(open: OrderRecord[], today: string, stageDates: boolean) {
  const by = new Map<string, OrderRecord[]>();
  for (const o of open) {
    const k = o.stage ?? 'unknown';
    by.set(k, [...(by.get(k) ?? []), o]);
  }
  const avg = (xs: number[]) => (xs.length ? Math.round((10 * xs.reduce((s, x) => s + x, 0)) / xs.length) / 10 : null);
  const stages = [...by.entries()]
    .sort(([a], [b]) => (STAGE_ORDER.indexOf(a) + 1 || 99) - (STAGE_ORDER.indexOf(b) + 1 || 99))
    .map(([stage, list]) => {
      const ages = list.filter((o) => o.createdDate).map((o) => daysBetween(o.createdDate!, today));
      const still = list.filter((o) => o.lastProgressDate).map((o) => ({ ref: o.ref, days: daysBetween(o.lastProgressDate!, today) }));
      return {
        stage,
        orders: list.length,
        overdue: list.filter((o) => o.dueDate && o.dueDate < today).length,
        averageDaysSinceOrder: avg(ages),
        ...(stageDates ? { averageDaysSinceLastProgress: avg(still.map((s) => s.days)) } : {}),
        longestWaiting: stageDates
          ? still.sort((a, b) => b.days - a.days).slice(0, 5).map((s) => ({ ref: s.ref, daysSinceLastProgress: s.days }))
          : list
              .filter((o) => o.createdDate)
              .map((o) => ({ ref: o.ref, daysSinceOrder: daysBetween(o.createdDate!, today) }))
              .sort((a, b) => b.daysSinceOrder - a.daysSinceOrder)
              .slice(0, 5),
      };
    });
  const slowest = stageDates
    ? stages.filter((s) => s.stage !== 'done' && s.averageDaysSinceLastProgress != null).sort((a, b) => (b.averageDaysSinceLastProgress ?? 0) - (a.averageDaysSinceLastProgress ?? 0))[0]
    : null;
  return {
    asOf: today,
    openOrders: open.length,
    stages,
    slowestStage: slowest ? slowest.stage : null,
    stageDatesAvailable: stageDates,
  };
}

/** Income, expenses and net per month (PHP), with each month's largest expense category. */
export function financeTrends(range: DateRange, income: FinanceRecord[], expenses: FinanceRecord[]) {
  const months = new Map<string, { inc: number; exp: number; cats: Map<string, number> }>();
  for (let d = range.from.slice(0, 7); d <= range.to.slice(0, 7); ) {
    months.set(d, { inc: 0, exp: 0, cats: new Map() });
    const t = new Date(`${d}-01T00:00:00Z`);
    t.setUTCMonth(t.getUTCMonth() + 1);
    d = t.toISOString().slice(0, 7);
  }
  let otherCurrency = 0;
  for (const r of [...income, ...expenses]) {
    if (r.currency !== 'PHP') {
      otherCurrency++;
      continue;
    }
    const m = months.get(r.date.slice(0, 7));
    if (!m) continue;
    if (r.kind === 'income') m.inc += r.centavos;
    else {
      m.exp += r.centavos;
      const c = r.category ?? 'Uncategorised';
      m.cats.set(c, (m.cats.get(c) ?? 0) + r.centavos);
    }
  }
  const rows = [...months.entries()].map(([month, m]) => {
    const top = [...m.cats.entries()].sort((a, b) => b[1] - a[1])[0];
    return {
      month,
      income: peso(m.inc),
      expenses: peso(m.exp),
      net: peso(m.inc - m.exp),
      largestExpenseCategory: top ? { category: top[0], amount: peso(top[1]) } : null,
      _net: m.inc - m.exp,
      _inc: m.inc,
    };
  });
  const best = rows.reduce<(typeof rows)[number] | null>((b, r) => (!b || r._net > b._net ? r : b), null);
  const worst = rows.reduce<(typeof rows)[number] | null>((b, r) => (!b || r._net < b._net ? r : b), null);
  return {
    range,
    currency: 'PHP',
    months: rows.map(({ _net, _inc, ...r }) => r),
    bestMonthByNet: best && rows.length > 1 ? best.month : null,
    worstMonthByNet: worst && rows.length > 1 ? worst.month : null,
    recordsInOtherCurrencies: otherCurrency,
  };
}
