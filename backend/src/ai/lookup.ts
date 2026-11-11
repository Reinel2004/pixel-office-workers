// Automatic data lookup: for questions about orders, expenses, payments or employee cash
// advances, the office reads the relevant records BEFORE the AI answers (the AI does not decide
// whether to look). Everything here is code:
//   1. planLookup()  — which topics the question is about (English and Tagalog keywords) and
//                      which period ("last month", "October", "2026-10-01 to 2026-10-15", …;
//                      this month when none is named).
//   2. runLookups()  — reads only what this user's permissions allow, through the same
//                      read-only adapters as the reports, and calculates totals in integer
//                      centavos. A missing permission, an unconnected system or a failed read
//                      becomes a stated limitation; nothing is ever estimated or filled in from
//                      demo data.
// The AI gets the figures and records (order numbers and EMP-codes, never customer or employee
// names); the browser gets the same lookups to show sources, period and retrieval time.

import type { DataLookup, DateRange, LookupDomain, Money, SessionUser, SourceInfo } from '../../shared/live';
import { LOOKUP_LABEL, SYSTEM_NAMES } from '../../shared/live';
import { addDays, presetRange } from '../../shared/manila';
import type { CashAdvance, FinanceRecord, FinanceSource, OrderRecord, OrderSource } from '../adapters/types';
import { IntegrationError } from '../http/errors';
import { collections, customerNames, orderStatus, overdueOrders } from '../reports/calc';

/** Agents whose questions get the automatic lookup (data roles). */
export const AUTO_LOOKUP_AGENTS = ['lia', 'paolo', 'nina', 'bea', 'rosa', 'mika', 'dev', 'chief'] as const;

const MAX_ROWS_TO_AI = 150;

const TOPICS: Record<LookupDomain, RegExp> = {
  orders: /\b(orders?|ORD-[A-Za-z0-9]+|deliver(?:y|ies|ed)?|overdue|due dates?|production|order ko|mga order|pending orders?)\b/i,
  expenses: /\b(expenses?|gastos|gastusin|gumastos|spent|spending|spend|costs?|bills?|bayarin|operating)\b/i,
  payments: /\b(payments?|paid|bayad|binayaran|nagbayad|downpayments?|balances?|collections?|collect(?:ed)?|income|received|natanggap|kita|receivables?|sales)\b/i,
  cash_advances: /\b(cash[\s-]?advances?|vale|bale ng|utang ng (?:empleyado|tauhan|staff))\b|\bCA\b/i,
};

/** Which topics a text is about. */
export function detectDomains(text: string): LookupDomain[] {
  return (Object.keys(TOPICS) as LookupDomain[]).filter((d) => TOPICS[d].test(text));
}

const MONTHS: [RegExp, number][] = [
  [/\b(january|jan|enero)\b/i, 1],
  [/\b(february|feb|pebrero|febrero)\b/i, 2],
  [/\b(march|marso|marzo)\b/i, 3],
  [/\b(april|apr|abril)\b/i, 4],
  // "may" is also an everyday word in English and Tagalog: only with a year or after in/sa/noong/last/this.
  [/\b(?:(?:in|of|sa|noong|last|this|nung)\s+may\b|may\s+20\d{2}\b|mayo)\b/i, 5],
  [/\b(june|jun|hunyo)\b/i, 6],
  [/\b(july|jul|hulyo)\b/i, 7],
  [/\b(august|aug|agosto)\b/i, 8],
  [/\b(september|sept|sep|setyembre|septiyembre)\b/i, 9],
  [/\b(october|oct|oktubre)\b/i, 10],
  [/\b(november|nov|nobyembre)\b/i, 11],
  [/\b(december|dec|disyembre)\b/i, 12],
];

export interface LookupPlan {
  domains: LookupDomain[];
  range: DateRange;
  rangeLabel: string;
  /** true = the question named the period; false = the default (this month). */
  stated: boolean;
  notes: string[];
}

const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** The period a text names, or null. Dates are Asia/Manila calendar days. */
export function detectRange(text: string, today: string): { range: DateRange; label: string } | null {
  const t = text.toLowerCase();
  const [ty, tm] = today.split('-').map(Number);
  const between = /(\d{4}-\d{2}-\d{2})\s*(?:to|until|till|-|–|—|hanggang)\s*(\d{4}-\d{2}-\d{2})/.exec(text);
  if (between) return { range: { from: between[1], to: between[2] }, label: `${between[1]} to ${between[2]}` };
  const one = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text);
  if (one) return { range: { from: one[1], to: one[1] }, label: one[1] };
  if (/\b(today|ngayong araw|ngayon)\b/.test(t)) return { range: { from: today, to: today }, label: 'today' };
  if (/\b(yesterday|kahapon)\b/.test(t)) return { range: { from: addDays(today, -1), to: addDays(today, -1) }, label: 'yesterday' };
  const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  if (/\b(this week|ngayong linggo|this wk)\b/.test(t)) return { range: { from: addDays(today, -dow), to: today }, label: 'this week' };
  if (/\b(last week|nakaraang linggo|noong isang linggo)\b/.test(t)) return { range: { from: addDays(today, -dow - 7), to: addDays(today, -dow - 1) }, label: 'last week' };
  const days = /\b(?:last|past|nakaraang)\s+(\d{1,3})\s+(?:days|araw)\b/.exec(t);
  if (days) {
    const n = Math.max(1, Math.min(366, Number(days[1])));
    return { range: { from: addDays(today, -(n - 1)), to: today }, label: `the last ${n} days` };
  }
  if (/\b(this month|ngayong buwan|this mo)\b/.test(t)) return { range: presetRange('thisMonth', today), label: 'this month' };
  if (/\b(last month|nakaraang buwan|noong isang buwan|previous month)\b/.test(t)) return { range: presetRange('lastMonth', today), label: 'last month' };
  if (/\b(this year|ngayong taon)\b/.test(t)) return { range: presetRange('thisYear', today), label: 'this year' };
  if (/\b(last year|nakaraang taon|noong isang taon)\b/.test(t)) return { range: { from: `${ty - 1}-01-01`, to: `${ty - 1}-12-31` }, label: 'last year' };
  for (const [re, m] of MONTHS) {
    const hit = re.exec(text);
    if (!hit) continue;
    const yearAfter = new RegExp(`${hit[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*,?\\s*(20\\d{2})`, 'i').exec(text);
    // Without a year, a month later than this one means last year's.
    const y = yearAfter ? Number(yearAfter[1]) : m > tm ? ty - 1 : ty;
    const name = new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
    return { range: { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(lastDay(y, m))}` }, label: `${name} ${y}` };
  }
  const year = /\b(?:in|for|noong|sa|year|taong)\s+(20\d{2})\b/i.exec(text);
  if (year) return { range: { from: `${year[1]}-01-01`, to: `${year[1]}-12-31` }, label: year[1] };
  return null;
}

/**
 * What to look up for a message. `context` (the earlier messages of the same task) supplies the
 * topic and period when a follow-up like "and last month?" names only one of them.
 */
export function planLookup(text: string, today: string, maxDays: number, context = ''): LookupPlan | null {
  let domains = detectDomains(text);
  if (!domains.length && context) domains = detectDomains(context);
  if (!domains.length) return null;
  const notes: string[] = [];
  const found = detectRange(text, today) ?? (context ? detectRange(context, today) : null);
  let range = found?.range ?? presetRange('thisMonth', today);
  let rangeLabel = found ? `${found.label} (from the question)` : 'this month (no period was named)';
  if (range.from > range.to) range = { from: range.to, to: range.from };
  if (range.to > today && range.from <= today) {
    range = { ...range, to: today };
    notes.push('The period was cut off at today.');
  }
  const span = Math.round((Date.parse(range.to) - Date.parse(range.from)) / 86_400_000) + 1;
  if (span > maxDays) {
    range = { from: addDays(range.to, -(maxDays - 1)), to: range.to };
    rangeLabel += ` — shortened to the last ${maxDays} days`;
    notes.push(`The period was longer than ${maxDays} days, so only the last ${maxDays} days were read.`);
  }
  return { domains, range, rangeLabel, stated: !!found, notes };
}

// ---------------------------------------------------------------- running the lookups

export interface LookupDeps {
  finance: FinanceSource;
  orders: OrderSource;
}

export interface LookupOutcome {
  lookups: DataLookup[];
  /** What the AI receives (no customer or employee names). */
  facts: Record<string, unknown>[];
  sources: SourceInfo[];
  references: string[];
  customers: Record<string, string>;
  employees: Record<string, string>;
}

const money = (c: number) => `₱${(c / 100).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const amount = (c: number) => (c / 100).toFixed(2);

/** Sums by currency in integer centavos. */
function sum(records: { centavos: number; currency?: string }[]): Money[] {
  const m = new Map<string, number>();
  for (const r of records) m.set(r.currency ?? 'PHP', (m.get(r.currency ?? 'PHP') ?? 0) + r.centavos);
  return [...m].map(([currency, centavos]) => ({ currency, centavos }));
}
const fmt = (list: Money[]) => (list.length ? list.map((x) => (x.currency === 'PHP' ? money(x.centavos) : `${x.currency} ${amount(x.centavos)}`)).join(' + ') : money(0));

export async function runLookups(plan: LookupPlan, user: SessionUser, text: string, deps: LookupDeps, today: string): Promise<LookupOutcome> {
  const out: LookupOutcome = { lookups: [], facts: [], sources: [], references: [], customers: {}, employees: {} };
  const can = (p: string) => user.permissions.includes(p as never);
  const refs = new Set<string>();
  const now = () => new Date().toISOString();

  /** One lookup: permission and connection checks, then the read; any failure becomes a limitation. */
  const look = async (
    domain: LookupDomain,
    title: string,
    perms: string[],
    system: 'orders' | 'finance',
    range: DateRange | null,
    rangeLabel: string,
    read: (source: (n: number) => SourceInfo) => Promise<{ figures: DataLookup['figures']; empty: boolean; facts: Record<string, unknown>; message?: string | null }>,
  ) => {
    const base = { domain, title, range, rangeLabel, retrievedAt: null, source: null, figures: [] };
    const missing = perms.filter((p) => !can(p));
    if (missing.length) {
      out.lookups.push({ ...base, status: 'not_allowed', message: `Your account cannot read this (${missing.join(', ')} is needed). Nothing was looked up.` });
      out.facts.push({ topic: title, status: 'not_allowed', note: 'This user may not see this data. Say so; do not answer this part.' });
      return;
    }
    const st = system === 'orders' ? deps.orders.status() : deps.finance.status();
    if (st.state !== 'ready') {
      const why = st.problems[0] ?? (st.state === 'awaiting_documentation' ? 'its API is not documented yet' : 'not configured on the server');
      out.lookups.push({ ...base, status: 'unavailable', message: `${SYSTEM_NAMES[system]} is not connected: ${why}` });
      out.facts.push({ topic: title, status: 'unavailable', reason: `${SYSTEM_NAMES[system]} is not connected.`, note: 'No records could be read. Say clearly that this could not be checked; do not estimate or answer from memory.' });
      return;
    }
    try {
      let src: SourceInfo | null = null;
      const r = await read((n) => (src = { system, systemName: SYSTEM_NAMES[system], host: st.host ?? '', retrievedAt: now(), recordCount: n }));
      out.lookups.push({ ...base, status: r.empty ? 'empty' : 'ok', retrievedAt: src ? (src as SourceInfo).retrievedAt : now(), source: src, figures: r.figures, message: r.message ?? null });
      if (src) out.sources.push(src);
      out.facts.push({ topic: title, status: r.empty ? 'no records' : 'ok', period: range ?? 'right now', periodChosen: rangeLabel, calculatedByCode: true, ...r.facts });
    } catch (e) {
      const msg = e instanceof IntegrationError ? e.message : 'The records could not be read.';
      out.lookups.push({ ...base, status: 'unavailable', retrievedAt: now(), message: msg });
      out.facts.push({ topic: title, status: 'unavailable', reason: msg, note: 'The read failed. Say clearly that this could not be checked; do not estimate or answer from memory.' });
    }
  };

  const { range, rangeLabel } = plan;
  const mentionedOrders = [...new Set([...text.matchAll(/\b(ORD-[A-Za-z0-9]+)\b/gi)].map((m) => m[1].toUpperCase()))];

  for (const domain of plan.domains) {
    if (domain === 'orders') {
      // A named period: orders placed in it. Otherwise: every open order right now.
      if (plan.stated)
        await look('orders', LOOKUP_LABEL.orders + ' placed in the period', ['orders:read'], 'orders', range, rangeLabel, async (source) => {
          const orders = await deps.orders.listOrders(range);
          source(orders.length);
          Object.assign(out.customers, customerNames(orders));
          orders.slice(0, 50).forEach((o) => refs.add(o.ref));
          const { report, notes } = orderStatus(range, orders, today, deps.orders.capabilities.closedStatuses);
          return {
            empty: !orders.length,
            figures: [
              { label: 'Orders placed', value: String(orders.length) },
              ...report.byStatus.slice(0, 5).map((b) => ({ label: b.status, value: String(b.count) })),
              ...(report.open !== null ? [{ label: 'Still open', value: String(report.open) }] : []),
              ...(report.overdue !== null ? [{ label: 'Overdue now', value: String(report.overdue) }] : []),
            ],
            facts: { orderCount: orders.length, byStatus: report.byStatus, open: report.open, overdue: report.overdue, orders: report.rows.slice(0, MAX_ROWS_TO_AI), ordersTruncated: report.rows.length > MAX_ROWS_TO_AI, ...mentioned(orders, mentionedOrders), notes },
          };
        });
      else
        await look('orders', 'Open orders (right now)', ['orders:read'], 'orders', null, 'all open orders right now (no period was named)', async (source) => {
          const open = await deps.orders.listOpenOrders();
          source(open.length);
          Object.assign(out.customers, customerNames(open));
          open.slice(0, 50).forEach((o) => refs.add(o.ref));
          const { report, notes } = overdueOrders(open, today);
          const finished = open.filter((o) => /^finished$/i.test(o.status)).length;
          return {
            empty: !open.length,
            figures: [
              { label: 'Open orders', value: String(open.length) },
              { label: 'Overdue', value: String(report.overdue.length) },
              { label: 'Finished, not yet delivered', value: String(finished) },
            ],
            facts: {
              openCount: open.length,
              overdueCount: report.overdue.length,
              finishedNotDelivered: finished,
              overdue: report.overdue.slice(0, MAX_ROWS_TO_AI),
              open: open.slice(0, MAX_ROWS_TO_AI).map((o) => ({ ref: o.ref, status: o.status, dueDate: o.dueDate, stage: o.stage, progressPercent: o.progressPercent, orderDate: o.createdDate })),
              openTruncated: open.length > MAX_ROWS_TO_AI,
              ...mentioned(open, mentionedOrders),
              notes: [...notes, 'Only "Delivered" closes an order.'],
            },
          };
        });
    }

    if (domain === 'expenses')
      await look('expenses', LOOKUP_LABEL.expenses, ['finance:read'], 'finance', range, rangeLabel, async (source) => {
        const list = await deps.finance.listExpenses(range);
        source(list.length);
        list.slice(0, 50).forEach((r) => refs.add(r.ref));
        const byCat = new Map<string, FinanceRecord[]>();
        for (const r of list) byCat.set(r.category ?? 'Uncategorised', [...(byCat.get(r.category ?? 'Uncategorised') ?? []), r]);
        const cats = [...byCat]
          .map(([category, rs]) => ({ category, count: rs.length, total: sum(rs) }))
          .sort((a, b) => (b.total[0]?.centavos ?? 0) - (a.total[0]?.centavos ?? 0));
        return {
          empty: !list.length,
          figures: [
            { label: 'Total expenses', value: fmt(sum(list)) },
            { label: 'Expense records', value: String(list.length) },
            ...cats.slice(0, 4).map((c) => ({ label: c.category, value: fmt(c.total) })),
          ],
          facts: {
            total: pesos(sum(list)),
            recordCount: list.length,
            byCategory: cats.map((c) => ({ category: c.category, count: c.count, total: pesos(c.total) })),
            records: list.slice(0, MAX_ROWS_TO_AI).map((r) => ({ ref: r.ref, date: r.date, amount: amount(r.centavos), category: r.category })),
            recordsTruncated: list.length > MAX_ROWS_TO_AI,
            notes: ['Operating expenses only: payroll and material purchases are separate in WAD Furniture Management and are not included.'],
          },
        };
      });

    if (domain === 'payments') {
      await look('payments', 'Payments received (income records)', ['finance:read'], 'finance', range, rangeLabel, async (source) => {
        const list = await deps.finance.listIncome(range);
        source(list.length);
        list.slice(0, 50).forEach((r) => refs.add(r.ref));
        const byStatus = new Map<string, FinanceRecord[]>();
        for (const r of list) byStatus.set(r.status ?? 'Unknown', [...(byStatus.get(r.status ?? 'Unknown') ?? []), r]);
        const statuses = [...byStatus].map(([status, rs]) => ({ status, count: rs.length, total: sum(rs) }));
        return {
          empty: !list.length,
          figures: [{ label: 'Total recorded', value: fmt(sum(list)) }, { label: 'Records', value: String(list.length) }, ...statuses.map((s) => ({ label: s.status, value: `${fmt(s.total)} (${s.count})` }))],
          facts: {
            total: pesos(sum(list)),
            recordCount: list.length,
            byStatus: statuses.map((s) => ({ status: s.status, count: s.count, total: pesos(s.total) })),
            records: list.slice(0, MAX_ROWS_TO_AI).map((r) => ({ ref: r.ref, date: r.date, amount: amount(r.centavos), status: r.status ?? null })),
            recordsTruncated: list.length > MAX_ROWS_TO_AI,
            notes: ['Income records from WAD Furniture Management, every status (Received, Pending, Partial). They carry no order number, so they cannot be matched to orders.'],
          },
        };
      });
      // Balances still due come from the order system: only for accounts that may see orders AND money.
      if (can('orders:read') || can('finance:read'))
        await look('payments', 'Balances still due on open orders (right now)', ['orders:read', 'finance:read'], 'orders', null, 'all open orders right now', async (source) => {
          const open = await deps.orders.listOpenOrders();
          source(open.length);
          if (deps.orders.capabilities.payments !== true)
            return { empty: true, figures: [], facts: { error: 'WAD Order Management did not provide order prices and downpayments.' }, message: 'WAD Order Management did not provide order prices and downpayments, so balances could not be calculated.' };
          Object.assign(out.customers, customerNames(open));
          const c = collections(open, today);
          c.rows.slice(0, 50).forEach((r) => refs.add(r.ref));
          return {
            empty: c.ordersWithBalance === 0,
            figures: [
              { label: 'Balance still due', value: money(Math.round(Number(c.totalBalance) * 100)) },
              { label: 'Orders with a balance', value: String(c.ordersWithBalance) },
              { label: 'Downpayments received', value: money(Math.round(Number(c.totalDownpayments) * 100)) },
              { label: 'Due on Finished orders', value: money(Math.round(Number(c.balanceReadyForDelivery) * 100)) },
            ],
            facts: {
              ...c,
              rows: c.rows.slice(0, MAX_ROWS_TO_AI),
              rowsTruncated: c.rows.length > MAX_ROWS_TO_AI,
              currency: 'PHP',
              notes: ['balance = order price - downpayment (the order system\'s own rule). Other payments are not recorded separately, so a balance may already be partly settled.'],
            },
          };
        });
    }

    if (domain === 'cash_advances')
      await look('cash_advances', LOOKUP_LABEL.cash_advances, ['finance:read'], 'finance', range, rangeLabel, async (source) => {
        if (!deps.finance.listCashAdvances) throw new IntegrationError('NOT_SUPPORTED', 'This server cannot read cash advances.', 'finance');
        const d = await deps.finance.listCashAdvances(range);
        source(d.issued.length + d.outstanding.length + (d.repayments?.length ?? 0));
        for (const a of [...d.issued, ...d.outstanding]) if (a.employeeName) out.employees[a.employeeRef] = a.employeeName;
        // Names typed in the question are matched here, by code, so the AI can be told which EMP-code is meant.
        const mentionedEmployees = matchEmployees(text, [...d.issued, ...d.outstanding]);
        const issuedTotal = d.issued.reduce((a, x) => a + x.centavos, 0);
        const outstandingTotal = d.outstanding.reduce((a, x) => a + x.remainingCentavos, 0);
        const repaidTotal = d.repayments?.reduce((a, x) => a + x.centavos, 0) ?? null;
        const per = new Map<string, { employee: string; position: string | null; advances: number; remaining: number }>();
        for (const a of d.outstanding) {
          const p = per.get(a.employeeRef) ?? { employee: a.employeeRef, position: a.position, advances: 0, remaining: 0 };
          p.advances++;
          p.remaining += a.remainingCentavos;
          per.set(a.employeeRef, p);
        }
        const byEmployee = [...per.values()].sort((a, b) => b.remaining - a.remaining);
        const row = (a: CashAdvance) => ({ ref: a.ref, employee: a.employeeRef, position: a.position, dateIssued: a.dateIssued, amount: amount(a.centavos), remaining: amount(a.remainingCentavos), status: a.status });
        return {
          empty: !d.issued.length && !d.outstanding.length && !(d.repayments?.length ?? 0),
          figures: [
            { label: 'Issued in the period', value: `${money(issuedTotal)} (${d.issued.length})` },
            { label: 'Repaid in the period', value: repaidTotal === null ? 'not recorded' : money(repaidTotal) },
            { label: 'Outstanding now', value: `${money(outstandingTotal)} (${d.outstanding.length})` },
            { label: 'Employees with a balance', value: String(per.size) },
          ],
          facts: {
            currency: d.currency,
            issuedInPeriod: { count: d.issued.length, total: amount(issuedTotal), advances: d.issued.slice(0, MAX_ROWS_TO_AI).map(row) },
            repaidInPeriod: repaidTotal === null ? 'Repayment records are not available in WAD Furniture Management.' : { count: d.repayments!.length, total: amount(repaidTotal) },
            outstandingNow: {
              count: d.outstanding.length,
              total: amount(outstandingTotal),
              byEmployee: byEmployee.slice(0, 60).map((p) => ({ employee: p.employee, position: p.position, advances: p.advances, remaining: amount(p.remaining) })),
              advances: d.outstanding.slice(0, MAX_ROWS_TO_AI).map(row),
            },
            ...(mentionedEmployees.length ? { employeesNamedInTheQuestion: mentionedEmployees } : {}),
            notes: [
              'Employees are identified by codes (EMP-…). Refer to them by code; the office shows their names. Never guess a name.',
              'Outstanding = remaining balance of every advance not yet Fully Paid, whatever its date (the same rule as the Cash Advances page).',
            ],
          },
        };
      });
  }
  out.references = [...refs].slice(0, 50);
  if (plan.notes.length) out.facts.push({ periodNotes: plan.notes });
  return out;
}

function pesos(list: Money[]) {
  return list.map((m) => ({ currency: m.currency, amount: amount(m.centavos) }));
}

/** Order numbers typed in the question: their rows, or a clear "not found". */
function mentioned(orders: OrderRecord[], refs: string[]) {
  if (!refs.length) return {};
  const found = orders.filter((o) => refs.includes(o.ref.toUpperCase()));
  return {
    ordersNamedInTheQuestion: refs.map((r) => {
      const o = found.find((x) => x.ref.toUpperCase() === r);
      return o ? { ref: o.ref, status: o.status, dueDate: o.dueDate, stage: o.stage, progressPercent: o.progressPercent, orderDate: o.createdDate } : { ref: r, found: false, note: 'Not among the orders read for this question.' };
    }),
  };
}

/** Employees whose full name, or a first or last name of 3+ letters, appears in the text as a word. */
export function matchEmployees(text: string, advances: CashAdvance[]): string[] {
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9ñ]+/g, ' ')} `;
  const hits = new Set<string>();
  for (const a of advances) {
    const name = a.employeeName?.toLowerCase().replace(/[^a-z0-9ñ]+/g, ' ').trim();
    if (!name) continue;
    const parts = name.split(' ').filter((p) => p.length >= 3);
    if (t.includes(` ${name} `) || parts.some((p) => t.includes(` ${p} `))) hits.add(a.employeeRef);
  }
  return [...hits];
}
