// The evidence snapshot for a team discussion: read ONCE at the start, through the existing
// read-only adapters and the existing report calculations, and reused for every request so all
// agents argue from the same numbers.
//
// Only data the requesting user may see is gathered (their permissions, checked here). Customer
// names, carpenter names and contact details are never included: records are referred to by
// order number. Money appears only for users with finance:read.

import type { DateRange, EvidenceRef, SessionUser, SystemId } from '../../shared/live';
import type { FinanceSource, OrderRecord, OrderSource } from '../adapters/types';
import { IntegrationError } from '../http/errors';
import { collections, dataChecks, financeSummary, orderStatus, orderTrends, overdueOrders, productionPipeline, shopCounts } from '../reports/calc';

export type EvidenceDomain = 'orders' | 'production' | 'quality' | 'finance';

export interface EvidenceItem {
  ref: EvidenceRef;
  domain: EvidenceDomain;
  /** Compact, code-calculated data handed to the AI (null when unavailable). */
  data: unknown;
}

const MAX_ITEM_CHARS = 7000;

function compact(v: unknown): unknown {
  const s = JSON.stringify(v);
  if (s.length <= MAX_ITEM_CHARS) return v;
  return { truncated: true, note: 'Shortened to fit; counts and totals above the lists are complete.', preview: s.slice(0, MAX_ITEM_CHARS) };
}

const msg = (e: unknown) => (e instanceof IntegrationError ? e.message : 'The data could not be retrieved.');

/**
 * Gathers what this user may see. Each source is read at most once; a failed source becomes an
 * "unavailable" item (never estimated). `signal` stops before the next read when cancelled.
 */
export async function buildEvidence(
  deps: { finance: FinanceSource; orders: OrderSource; today: string },
  user: SessionUser,
  range: DateRange,
  signal?: AbortSignal,
): Promise<EvidenceItem[]> {
  const items: EvidenceItem[] = [];
  const at = () => new Date().toISOString();
  const canOrders = user.permissions.includes('orders:read');
  const canMoney = user.permissions.includes('finance:read');
  let n = 0;
  const add = (domain: EvidenceDomain, title: string, system: SystemId | null, withRange: boolean, data: unknown, note: string | null = null) =>
    items.push({ ref: { id: `E${++n}`, title, system, retrievedAt: at(), range: withRange ? range : null, available: data !== null, note }, domain, data: data === null ? null : compact(data) });
  const stop = () => {
    if (signal?.aborted) throw new IntegrationError('TIMEOUT', 'The discussion was cancelled.');
  };

  if (canOrders) {
    stop();
    let open: OrderRecord[] | null = null;
    let inRange: OrderRecord[] | null = null;
    let openErr = '';
    let rangeErr = '';
    try {
      open = await deps.orders.listOpenOrders();
    } catch (e) {
      openErr = msg(e);
    }
    stop();
    try {
      inRange = await deps.orders.listOrders(range, { products: true });
    } catch (e) {
      rangeErr = msg(e);
    }
    const cap = deps.orders.capabilities;

    if (inRange) {
      const { report, notes } = orderStatus(range, inRange, deps.today, cap.closedStatuses);
      add('orders', 'Order status for the period', 'orders', true, { ordersPlaced: inRange.length, byStatus: report.byStatus, open: report.open, overdue: report.overdue, notes });
      add('orders', 'Orders per month (trend)', 'orders', true, orderTrends(range, inRange, 'month', canMoney && cap.payments === true));
    } else {
      add('orders', 'Order status for the period', 'orders', true, null, rangeErr);
    }

    if (open) {
      const { report, notes } = overdueOrders(open, deps.today);
      add('orders', 'Open and overdue orders (today)', 'orders', false, {
        openOrders: open.length,
        overdueCount: report.overdue.length,
        mostOverdue: report.overdue.slice(0, 15).map((r) => ({ ref: r.ref, daysOverdue: r.daysOverdue, dueDate: r.dueDate, status: r.status, stage: r.stage })),
        undetermined: report.undetermined,
        notes,
      });
      const pipe = productionPipeline(open, deps.today, cap.stageDates === true);
      add('production', 'Production stages of open orders', 'orders', false, pipe, pipe.stages.every((s) => s.stage === 'unknown') ? 'Production stage data is not recorded in the order system yet.' : null);
      // Carpenter workload without names (the AI never sees staff or customer names).
      const shop = shopCounts(open, deps.orders.carpenterRoster ?? null, cap.carpenters === true, deps.today, at());
      add(
        'production',
        'Carpenter workload (anonymised)',
        'orders',
        false,
        shop.available
          ? {
              carpenters: shop.carpenters.length,
              openOrdersPerCarpenter: shop.carpenters.map((c, i) => ({ carpenter: `Carpenter ${i + 1}`, inProgress: c.inProgress, pending: c.pending, finished: c.finished })),
              unassignedOpenOrders: shop.unassigned,
              readyForDelivery: shop.ready,
            }
          : null,
        shop.available ? null : 'The order system does not provide carpenter assignments.',
      );
      add(
        'quality',
        'Order data checks (missing or odd values)',
        'orders',
        false,
        dataChecks(open, deps.today, { money: canMoney, payments: cap.payments === true, carpenters: cap.carpenters === true, laborCheck: cap.laborCheck === true, priceCheck: cap.priceCheck === true }),
      );
      if (canMoney) {
        add(
          'finance',
          'Balances on open orders',
          'orders',
          false,
          cap.payments === true ? (({ rows, ...rest }) => ({ ...rest, largest: rows.slice(0, 10) }))(collections(open, deps.today)) : null,
          cap.payments === true ? null : 'The order system does not provide prices and downpayments.',
        );
      }
    } else {
      add('orders', 'Open and overdue orders (today)', 'orders', false, null, openErr);
    }
  }

  if (canMoney) {
    stop();
    try {
      const [income, expenses] = await Promise.all([deps.finance.listIncome(range), deps.finance.listExpenses(range)]);
      const budgets = deps.finance.capabilities.budgets ? await deps.finance.listBudgets(range) : null;
      const { report, notes } = financeSummary(range, income, expenses, budgets, deps.finance.capabilities.budgetsByCategory);
      const peso = (l: { centavos: number; currency: string }[]) => l.map((m) => ({ currency: m.currency, amount: (m.centavos / 100).toFixed(2) }));
      add('finance', 'Income, expenses and budgets for the period', 'finance', true, {
        income: peso(report.income),
        operatingExpenses: peso(report.expenses),
        net: peso(report.net),
        expensesByCategory: report.expensesByCategory.map((c) => ({ category: c.category, amounts: peso(c.amounts) })),
        budgets: report.budgets.map((b) => ({ month: b.ref.replace('BUDGET-', ''), amounts: peso(b.amounts) })),
        incomeRecords: income.length,
        expenseRecords: expenses.length,
        notes: [...notes, 'Payroll and material purchases are not included in expenses.'],
      });
    } catch (e) {
      add('finance', 'Income, expenses and budgets for the period', 'finance', true, null, msg(e));
    }
  }
  return items;
}
