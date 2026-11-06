// Normalized, read-only views of the two business systems. These are OUR internal shapes;
// how each system's real fields map onto them is filled in only from its documentation.
// Customer names and contact details are deliberately not part of these types.

import type { DateRange, SystemId, SystemStatus } from '../../shared/live';

export interface FinanceRecord {
  ref: string; // the system's own record reference, shown to the user
  kind: 'income' | 'expense';
  date: string; // YYYY-MM-DD (Asia/Manila)
  centavos: number; // integer
  currency: string;
  category: string | null;
  /** Shared order ID — only set from a field the documentation confirms links to orders. */
  orderId: string | null;
}

export interface BudgetRecord {
  ref: string;
  name: string;
  centavos: number;
  currency: string;
  /** Only used for budget-vs-actual when the docs confirm budgets are tracked by expense category. */
  category: string | null;
}

export interface OrderRecord {
  ref: string; // display reference
  orderId: string; // shared order ID (same value finance records carry), when documented
  status: string; // raw status text from the system
  /** true/false only when the documented status values say so; null = unknown. */
  isClosed: boolean | null;
  dueDate: string | null; // YYYY-MM-DD
  progressPercent: number | null;
  stage: string | null;
  createdDate: string | null;
  /** Customer name, for display in the office only. Never sent to the AI provider. */
  customerName?: string | null;
  /** What the customer pays for the whole order, in centavos; null when the system doesn't say. */
  grossCentavos?: number | null;
  /** Downpayment recorded for the whole order, in centavos; null when the system doesn't say. */
  downpaymentCentavos?: number | null;
}

export interface FinanceCapabilities {
  income: boolean;
  expenses: boolean;
  budgets: boolean;
  /** A documented field on income/expense records holds the shared order ID. */
  sharedOrderId: boolean;
  budgetsByCategory: boolean;
}

export interface OrderCapabilities {
  orders: boolean;
  progress: boolean;
  dueDates: boolean;
  closedStatuses: boolean;
  sharedOrderId: boolean;
  /** Order price and downpayment are available (set from the last response). */
  payments?: boolean;
}

export interface FinanceSource {
  readonly id: Extract<SystemId, 'finance'>;
  capabilities: FinanceCapabilities;
  status(): SystemStatus;
  listIncome(range: DateRange): Promise<FinanceRecord[]>;
  listExpenses(range: DateRange): Promise<FinanceRecord[]>;
  listBudgets(range: DateRange): Promise<BudgetRecord[]>;
}

export interface OrderSource {
  readonly id: Extract<SystemId, 'orders'>;
  capabilities: OrderCapabilities;
  status(): SystemStatus;
  /** Orders relevant to the range (the documented filter decides: created, due, or updated). */
  listOrders(range: DateRange): Promise<OrderRecord[]>;
  /** Open orders regardless of range, for the overdue check. */
  listOpenOrders(): Promise<OrderRecord[]>;
}
