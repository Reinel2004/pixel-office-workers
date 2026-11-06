// Read-only adapter for WAD Order Management (orders, production progress, deadlines).
//
// Source: {ORDERS_API_BASE_URL}ceo/office-orders.php with "Authorization: Bearer ORDERS_API_TOKEN"
//         (api/ceo/office-orders.php in order-management).
//   ?from=YYYY-MM-DD&to=YYYY-MM-DD  orders whose order date falls in the range
//   ?open=1                         every order that is not Delivered
// Response: { success, system, generated_at, data: { orders[], count, truncated } }
//   orders[] { order_number, group_id, status, priority, order_date, due_date,
//              items, items_done, least_stage, gross_price, downpayment, customer_name }
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
import type { OrderCapabilities, OrderRecord, OrderSource } from './types';

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

  constructor(
    private config: SystemConfig,
    readonly client: ApiClient,
  ) {
    this.authConfigured = !!config.token;
  }

  status(): SystemStatus {
    return systemStatus(this.config, this.authConfigured, this.capabilities as unknown as Record<string, boolean>);
  }

  async listOrders(range: DateRange): Promise<OrderRecord[]> {
    return this.fetch({ from: range.from, to: range.to });
  }

  async listOpenOrders(): Promise<OrderRecord[]> {
    return (await this.fetch({ open: '1' })).filter((o) => o.isClosed !== true);
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
    customerName: typeof r.customer_name === 'string' && r.customer_name.trim() ? r.customer_name.trim().slice(0, 120) : null,
    grossCentavos: r.gross_price == null ? null : toCentavos(r.gross_price, name, system),
    downpaymentCentavos: r.downpayment == null ? null : toCentavos(r.downpayment, name, system),
  };
}
