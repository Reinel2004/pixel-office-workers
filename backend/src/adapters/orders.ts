// Read-only adapter for WAD Order Management (orders, production progress, deadlines).
//
// Source: {ORDERS_API_BASE_URL}ceo/office-orders.php with "Authorization: Bearer ORDERS_API_TOKEN"
//         (api/ceo/office-orders.php in order-management).
//   ?from=YYYY-MM-DD&to=YYYY-MM-DD  orders whose order date falls in the range
//   ?open=1                         every order that is not Delivered
// Response: { success, system, generated_at, data: { orders[], count, truncated } }
//   orders[] { order_number, group_id, status, priority, order_date, due_date,
//              items, items_done, least_stage, last_progress_at, gross_price, downpayment,
//              customer_name, carpenters[], hamba_carpenters[], products?[] (with &products=1) }
//   data.carpenters_available, data.carpenter_roster (names, or null)
// customer_name is kept for display only: reports show it next to the order number, and the AI
// tools never include it (server/ai/tasks.ts builds their data from explicit fields).
// Payments: balance = max(0, gross_price - downpayment), the rule orders.php uses; a Delivered
// order counts as paid. gross_price/downpayment are decimal strings, or null when unavailable.
// Status values in the app: Pending, In Progress, Finished, Delivered. Only "Delivered" closes an
// order: a Finished order that has not reached the customer by its due date still counts as
// overdue (decided by the owner). Progress = pieces at stage "done" / all pieces.

import type { DateRange, SystemStatus } from '../../shared/live';
import type { SystemConfig } from '../config';
import type { ApiClient } from '../http/client';
import { IntegrationError } from '../http/errors';
import { dateOf, ensureConfigured, envelope, invalid, systemStatus, toCentavos } from './finance';
import type { OrderCapabilities, OrderListOptions, OrderRecord, OrderSource, ProductLine } from './types';

const OPEN_STATUSES = new Set(['pending', 'in progress', 'finished']);
const CLOSED_STATUSES = new Set(['delivered']);

export class OrdersAdapter implements OrderSource {
  readonly id = 'orders' as const;
  capabilities: OrderCapabilities = {
    orders: true,
    progress: true,
    dueDates: true,
    closedStatuses: true,
    sharedOrderId: false,
    payments: false,
  };
  authConfigured: boolean;
  carpenterRoster: string[] | null = null;

  constructor(
    private config: SystemConfig,
    readonly client: ApiClient,
  ) {
    this.authConfigured = !!config.token;
  }

  status(): SystemStatus {
    return systemStatus(this.config, this.authConfigured, this.capabilities as unknown as Record<string, boolean>);
  }

  async listOrders(range: DateRange, opts: OrderListOptions = {}): Promise<OrderRecord[]> {
    return this.fetch({ from: range.from, to: range.to, ...(opts.products ? { products: '1' } : {}) });
  }

  async listOpenOrders(opts: OrderListOptions = {}): Promise<OrderRecord[]> {
    return (await this.fetch({ open: '1', ...(opts.products ? { products: '1' } : {}) })).filter((o) => o.isClosed !== true);
  }

  private async fetch(query: Record<string, string>): Promise<OrderRecord[]> {
    ensureConfigured(this.config, this.authConfigured, this.id);
    const name = this.config.name;
    const { data: body } = await this.client.getJson<unknown>('ceo/office-orders.php', { query });
    const data = envelope(body, name, this.id);
    if (data.truncated === true)
      throw new IntegrationError('RESULT_TOO_LARGE', `${name} has too many orders for this request. Choose a shorter date range.`, this.id);
    if (!Array.isArray(data.orders)) throw invalid(name, this.id, 'orders');
    this.capabilities.payments = data.payments_available === true;
    this.capabilities.stageDates = data.stage_dates_available === true;
    if (query.products) this.capabilities.products = data.products_available === true;
    this.capabilities.carpenters = data.carpenters_available === true;
    this.capabilities.laborCheck = data.labor_check_available === true;
    this.capabilities.priceCheck = data.price_check_available === true;
    this.carpenterRoster = Array.isArray(data.carpenter_roster) ? names(data.carpenter_roster) : null;
    return (data.orders as Record<string, unknown>[]).map((r) => toOrder(r, name, this.id));
  }
}

export function toOrder(r: Record<string, unknown>, name: string, system: 'orders'): OrderRecord {
  if (typeof r.order_number !== 'string' || !r.order_number) throw invalid(name, system, 'order_number');
  const status = typeof r.status === 'string' && r.status.trim() ? r.status.trim() : 'Unknown';
  const s = status.toLowerCase();
  const isClosed = CLOSED_STATUSES.has(s) ? true : OPEN_STATUSES.has(s) ? false : null;
  const items = typeof r.items === 'number' ? r.items : 0;
  const done = typeof r.items_done === 'number' ? r.items_done : 0;
  const stage = typeof r.least_stage === 'string' && r.least_stage ? r.least_stage : null;
  return {
    ref: r.order_number,
    orderId: typeof r.group_id === 'string' ? r.group_id : r.order_number,
    status,
    isClosed,
    dueDate: r.due_date && r.due_date !== '0000-00-00' ? dateOf(r.due_date, name, system) : null,
    progressPercent: stage !== null && items > 0 ? Math.round((100 * done) / items) : null,
    stage,
    createdDate: r.order_date ? dateOf(r.order_date, name, system) : null,
    lastProgressDate: r.last_progress_at ? dateOf(r.last_progress_at, name, system) : null,
    ...(Array.isArray(r.products) ? { products: (r.products as Record<string, unknown>[]).map((p) => toProduct(p, name, system)) } : {}),
    carpenters: names(r.carpenters),
    hambaCarpenters: names(r.hamba_carpenters),
    laborMissing: count(r.labor_missing),
    zeroPriceItems: count(r.zero_price_items),
    customerName: typeof r.customer_name === 'string' && r.customer_name.trim() ? r.customer_name.trim().slice(0, 120) : null,
    grossCentavos: r.gross_price == null ? null : toCentavos(r.gross_price, name, system),
    downpaymentCentavos: r.downpayment == null ? null : toCentavos(r.downpayment, name, system),
  };
}

/** A non-negative whole number, or null. */
function count(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

/** A list of names: strings only, trimmed, at most 60 characters, no repeats (at most 50). */
function names(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((n): n is string => typeof n === 'string').map((n) => n.trim().slice(0, 60)).filter(Boolean))].slice(0, 50);
}

function toProduct(p: Record<string, unknown>, name: string, system: 'orders'): ProductLine {
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 60) : null);
  const qty = typeof p.qty === 'number' && Number.isInteger(p.qty) && p.qty > 0 ? p.qty : 0;
  return {
    category: text(p.category),
    type: text(p.type),
    wood: text(p.wood),
    finish: text(p.finish),
    qty,
    centavos: p.value == null ? null : toCentavos(p.value, name, system),
  };
}
