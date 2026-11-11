// Automatic data lookup against the systems configured in backend/.env (read-only GETs; no AI).
// Prints each lookup's status, period, record count and limitation — never amounts, names or tokens.
// Run from backend/:  npx tsx scripts/lookup-smoke.ts ["your question"]

import type { SessionUser } from '../shared/live';
import { manilaDate } from '../shared/manila';
import { FinanceAdapter } from '../src/adapters/finance';
import { OrdersAdapter } from '../src/adapters/orders';
import { planLookup, runLookups } from '../src/ai/lookup';
import { loadConfig } from '../src/config';
import { loadEnvFile } from '../src/env';
import { ApiClient } from '../src/http/client';

loadEnvFile();
const { config } = loadConfig();
const opts = (token: string | null | undefined) => ({
  timeoutMs: config.timeoutMs,
  maxRetries: 0,
  authHeaders: async (): Promise<Record<string, string>> => (token ? { Authorization: `Bearer ${token}` } : {}),
});
const finance = new FinanceAdapter(config.systems.finance, new ApiClient(config.systems.finance, opts(config.systems.finance.token)));
const orders = new OrdersAdapter(config.systems.orders, new ApiClient(config.systems.orders, opts(config.systems.orders.token)));
const user: SessionUser = { username: 'smoke', role: 'admin', permissions: ['finance:read', 'orders:read'] };
const today = manilaDate();
const question = process.argv[2] ?? 'How much were our expenses, payments and cash advances last month, and which orders are overdue?';
const plan = planLookup(question, today, config.maxRangeDays);
console.log('question:', question);
if (!plan) {
  console.log('no lookup topic detected');
  process.exit(0);
}
console.log('topics:', plan.domains.join(', '), '| period:', plan.range.from, 'to', plan.range.to, `(${plan.rangeLabel})`);
const out = await runLookups(plan, user, question, { finance, orders }, today);
for (const l of out.lookups)
  console.log(` - ${l.title}: ${l.status}${l.source ? ` · ${l.source.recordCount} record(s) from ${l.source.host}` : ''}${l.message ? ` · ${l.message}` : ''}`);
console.log('employee names kept out of the AI facts:', !Object.values(out.employees).some((n) => JSON.stringify(out.facts).includes(n)));
