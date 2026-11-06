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
