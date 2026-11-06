// Structural validation of a step result before it may be marked completed.

import type { Money, StepResult } from '../../shared/live';

function moneyOk(list: Money[] | null | undefined): boolean {
  return !list || list.every((m) => typeof m.currency === 'string' && m.currency.length > 0 && Number.isSafeInteger(m.centavos));
}

export function validateStepResult(r: StepResult): string | null {
  if (!r || typeof r !== 'object') return 'missing result';
  if (typeof r.summary !== 'string' || !r.summary) return 'missing summary';
  if (!Number.isInteger(r.recordCount) || r.recordCount < 0) return 'invalid record count';
  if (typeof r.empty !== 'boolean') return 'missing empty flag';
  if (!Array.isArray(r.references) || r.references.some((x) => typeof x !== 'string')) return 'invalid references';
  if (!Array.isArray(r.sources)) return 'missing sources';
  for (const s of r.sources) if (!s.system || !s.retrievedAt || Number.isNaN(Date.parse(s.retrievedAt))) return 'invalid source information';
  if (r.generatedBy !== 'code' && r.generatedBy !== 'ai') return 'unexpected generator';
  if (r.generatedBy === 'ai' && (typeof r.answer !== 'string' || !r.answer.trim() || r.report !== null)) return 'missing AI answer';
  if (r.generatedBy === 'code' && r.answer !== undefined) return 'unexpected answer on a calculated report';
  if (r.customers !== undefined && (typeof r.customers !== 'object' || r.customers === null || Object.values(r.customers).some((v) => typeof v !== 'string')))
    return 'invalid customer names';
  const rep = r.report;
  if (rep?.kind === 'finance.summary') {
    if (![rep.income, rep.expenses, rep.net].every(moneyOk)) return 'invalid money totals';
    if (!rep.expensesByCategory.every((c) => moneyOk(c.amounts))) return 'invalid category totals';
    if (!rep.budgets.every((b) => moneyOk(b.amounts) && moneyOk(b.spent) && moneyOk(b.remaining))) return 'invalid budget totals';
  }
  if (rep?.kind === 'combined.report' && !rep.matched.every((m) => moneyOk(m.income) && moneyOk(m.expenses) && moneyOk(m.recordedMargin)))
    return 'invalid linked totals';
  if ((rep?.kind === 'orders.status' || rep?.kind === 'orders.overdue') && !(rep.kind === 'orders.status' ? rep.rows : rep.overdue).every((o) => typeof o.ref === 'string'))
    return 'invalid order rows';
  return null;
}
