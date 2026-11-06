// Read-only adapter for WAD Furniture Management (finance, income, expenses, budgets).
//
// Source: GET {FINANCE_API_BASE_URL}ceo/records?from=YYYY-MM-DD&to=YYYY-MM-DD
//         (no ".php": that site 301-redirects .php addresses, and redirects are never followed)
//         with "Authorization: Bearer FINANCE_API_TOKEN" (api/ceo/records.php in wad-furniture).
// Response: { success, system, generated_at, data: { currency, income[], expenses[], budgets[], truncated } }
//   income[]   { id, date, amount: "1234.50", status, payment_method }   (every recorded status)
//   expenses[] { id, date, amount: "1234.50", category, payment_method } (operating expenses only)
//   budgets[]  { month: "YYYY-MM", amount: "1234.50" }                  (SUM of budget_entries)
// Amounts are exact decimal strings and are converted to integer centavos without floats.
// Income records carry no order ID, and budgets are monthly totals rather than per category,
// so order linking and budget-vs-category comparison stay off.

import type { DateRange, SystemStatus } from '../../shared/live';
import type { SystemConfig } from '../config';
import type { ApiClient } from '../http/client';
import { IntegrationError } from '../http/errors';
import type { BudgetRecord, FinanceCapabilities, FinanceRecord, FinanceSource } from './types';

interface RecordsPayload {
  income: FinanceRecord[];
  expenses: FinanceRecord[];
  budgets: BudgetRecord[];
}

export class FinanceAdapter implements FinanceSource {
  readonly id = 'finance' as const;
  capabilities: FinanceCapabilities = {
    income: true,
    expenses: true,
    budgets: true,
    sharedOrderId: false,
    budgetsByCategory: false,
  };
  authConfigured: boolean;
  /** listIncome/listExpenses/listBudgets for one report share a single request. */
  private cache = new Map<string, { at: number; promise: Promise<RecordsPayload> }>();

  constructor(
    private config: SystemConfig,
    readonly client: ApiClient,
  ) {
    this.authConfigured = !!config.token;
  }

  status(): SystemStatus {
    return systemStatus(this.config, this.authConfigured, this.capabilities as unknown as Record<string, boolean>);
  }

  async listIncome(range: DateRange): Promise<FinanceRecord[]> {
    return (await this.records(range)).income;
  }

  async listExpenses(range: DateRange): Promise<FinanceRecord[]> {
    return (await this.records(range)).expenses;
  }

  async listBudgets(range: DateRange): Promise<BudgetRecord[]> {
    return (await this.records(range)).budgets;
  }

  private records(range: DateRange): Promise<RecordsPayload> {
    ensureConfigured(this.config, this.authConfigured, this.id);
    const key = `${range.from}|${range.to}`;
    const now = Date.now();
    for (const [k, v] of this.cache) if (now - v.at > 10_000) this.cache.delete(k);
    const hit = this.cache.get(key);
    if (hit) return hit.promise;
    const promise = this.fetchRecords(range);
    this.cache.set(key, { at: now, promise });
    promise.catch(() => this.cache.delete(key));
    return promise;
  }

  private async fetchRecords(range: DateRange): Promise<RecordsPayload> {
    const name = this.config.name;
    const { data: body } = await this.client.getJson<unknown>('ceo/records', { query: { from: range.from, to: range.to } });
    const data = envelope(body, name, this.id);
    if (data.truncated === true)
      throw new IntegrationError('RESULT_TOO_LARGE', `${name} has too many records for this range. Choose a shorter date range.`, this.id);
    const currency = typeof data.currency === 'string' && data.currency ? data.currency : null;
    if (!currency) throw invalid(name, this.id, 'currency');
    const list = (k: string) => {
      const v = data[k];
      if (!Array.isArray(v)) throw invalid(name, this.id, k);
      return v as Record<string, unknown>[];
    };
    const income = list('income').map((r): FinanceRecord => ({
      ref: `INC-${idOf(r, name, this.id)}`,
      kind: 'income',
      date: dateOf(r.date, name, this.id),
      centavos: toCentavos(r.amount, name, this.id),
      currency,
      category: null,
      orderId: null,
    }));
    const expenses = list('expenses').map((r): FinanceRecord => ({
      ref: `EXP-${idOf(r, name, this.id)}`,
      kind: 'expense',
      date: dateOf(r.date, name, this.id),
      centavos: toCentavos(r.amount, name, this.id),
      currency,
      category: typeof r.category === 'string' && r.category.trim() ? r.category.trim() : null,
      orderId: null,
    }));
    const budgets = list('budgets').map((r): BudgetRecord => {
      if (typeof r.month !== 'string' || !/^\d{4}-\d{2}$/.test(r.month)) throw invalid(name, this.id, 'budgets.month');
      return { ref: `BUDGET-${r.month}`, name: `Monthly budget ${r.month}`, centavos: toCentavos(r.amount, name, this.id), currency, category: null };
    });
    return { income, expenses, budgets };
  }
}

// ---------------------------------------------------------------- shared helpers

export function ensureConfigured(config: SystemConfig, authConfigured: boolean, system: 'finance' | 'orders') {
  if (!config.baseUrl)
    throw new IntegrationError('NOT_CONFIGURED', `${config.name} is not configured on the server (missing or unapproved base URL).`, system);
  if (!authConfigured)
    throw new IntegrationError('NOT_CONFIGURED', `${config.name} has no API token configured on the server (${system === 'finance' ? 'FINANCE_API_TOKEN' : 'ORDERS_API_TOKEN'}).`, system);
}

/** Unwraps the CEO API envelope { success: true, data: {...} }. */
export function envelope(body: unknown, name: string, system: 'finance' | 'orders'): Record<string, unknown> {
  const b = body as { success?: unknown; data?: unknown; message?: unknown } | null;
  if (!b || typeof b !== 'object') throw invalid(name, system, 'body');
  if (b.success !== true) {
    const msg = typeof b.message === 'string' ? b.message.slice(0, 200) : 'unknown error';
    throw new IntegrationError('UPSTREAM_ERROR', `${name} reported an error: ${msg}`, system);
  }
  if (!b.data || typeof b.data !== 'object') throw invalid(name, system, 'data');
  return b.data as Record<string, unknown>;
}

export function invalid(name: string, system: 'finance' | 'orders', field: string) {
  return new IntegrationError('INVALID_RESPONSE', `${name} returned an unexpected response (field "${field}").`, system);
}

/** "1234.5" / "1234.50" / 1234.5 -> 123450, exactly. Rejects anything that is not a plain decimal amount. */
export function toCentavos(v: unknown, name: string, system: 'finance' | 'orders'): number {
  const s = typeof v === 'number' ? v.toFixed(2) : typeof v === 'string' ? v.trim() : '';
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw invalid(name, system, 'amount');
  const c = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(c)) throw invalid(name, system, 'amount');
  return m[1] ? -c : c;
}

export function dateOf(v: unknown, name: string, system: 'finance' | 'orders'): string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.slice(0, 10))) throw invalid(name, system, 'date');
  return v.slice(0, 10);
}

function idOf(r: Record<string, unknown>, name: string, system: 'finance' | 'orders'): string {
  if (typeof r.id !== 'number' && typeof r.id !== 'string') throw invalid(name, system, 'id');
  return String(r.id);
}

export function systemStatus(config: SystemConfig, authConfigured: boolean, capabilities: Record<string, boolean>): SystemStatus {
  const problems = [...config.problems];
  const anyCapability = Object.values(capabilities).some(Boolean);
  if (config.baseUrl && !anyCapability) problems.push('Endpoints not documented yet.');
  return {
    id: config.id,
    name: config.name,
    state: !config.baseUrl || !authConfigured ? 'not_configured' : !anyCapability ? 'awaiting_documentation' : 'ready',
    host: config.baseUrl?.host ?? null,
    problems,
    capabilities,
  };
}
