// Types shared by the Connected Mode server and the browser.
// Nothing in this file is mock data; demo data lives only in src/data/mock.ts.

export type SystemId = 'finance' | 'orders';

export const SYSTEM_NAMES: Record<SystemId, string> = {
  finance: 'WAD Furniture Management',
  orders: 'WAD Order Management',
};

export type Permission = 'finance:read' | 'orders:read' | 'social:post';

/** Facebook Page posting status (never includes the token). */
export interface FacebookStatus {
  configured: boolean;
  pageName: string | null;
  problems: string[];
}

/** A post waiting in the Facebook Page's schedule. */
export interface ScheduledPost {
  id: string;
  message: string;
  scheduledAt: string | null; // ISO
  hasPicture: boolean;
  link: string | null;
}

/** Facebook allows scheduling 10 minutes to 30 days ahead; the office keeps a small margin. */
export const FB_MIN_SCHEDULE_MINUTES = 15;
export const FB_MAX_SCHEDULE_DAYS = 29;
export const MAX_POST_CHARS = 5000;

/** Fixed reports, calculated by code. */
export type ReportType = 'finance.summary' | 'orders.status' | 'orders.overdue' | 'combined.report';
/** "ai.task" is a free-text task answered by the AI provider, using read-only data tools. */
export type JobType = ReportType | 'ai.task';
export type JobStatus = 'queued' | 'working' | 'completed' | 'failed';
export type LiveAgentId = 'lia' | 'marco' | 'paolo' | 'nina' | 'bea' | 'rosa' | 'mika' | 'carlo' | 'joy' | 'dev' | 'chief';
/** Agents that accept a photo with their task (e.g. Carlo writes a caption for a door photo). */
export const IMAGE_AGENTS: LiveAgentId[] = ['carlo'];
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
/** Largest photo accepted, in bytes (the office shrinks photos before sending, so this is rarely reached). */
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
export const LIVE_AGENT_IDS: LiveAgentId[] = ['lia', 'marco', 'paolo', 'nina', 'bea', 'rosa', 'mika', 'carlo', 'joy', 'dev', 'chief'];
/** Agents that take one order picked by a staff member (e.g. Joy answers a customer about their order). */
export const ORDER_AGENTS: LiveAgentId[] = ['joy'];
/** An order number as the order system shows it (letters, digits and dashes). */
export const ORDER_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,39}$/;

/** Why a live request did not produce a result. "No records" is NOT an error — see StepResult.empty. */
export type ErrorCode =
  | 'NOT_CONFIGURED' // base URL / credentials not set on the server
  | 'AWAITING_DOCUMENTATION' // the endpoint or field mapping has not been documented yet
  | 'NOT_SUPPORTED' // the system documented that it does not offer this data
  | 'HOST_NOT_ALLOWED' // request would leave an approved base URL
  | 'AUTH_FAILED' // credentials rejected or expired (HTTP 401)
  | 'PERMISSION_DENIED' // the API refused access (HTTP 403) or the office user lacks permission
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'UPSTREAM_ERROR' // 5xx or unexpected status
  | 'INVALID_RESPONSE' // response did not match the documented shape
  | 'RESULT_TOO_LARGE' // more pages than the safety cap; narrow the date range
  | 'DEPENDENCY_FAILED' // a step this step needed did not complete
  | 'INTERNAL';

export interface LiveError {
  code: ErrorCode;
  message: string;
  system?: SystemId;
  httpStatus?: number;
  retryable: boolean;
}

export interface DateRange {
  /** Inclusive, YYYY-MM-DD, interpreted in Asia/Manila. */
  from: string;
  to: string;
}

export interface SourceInfo {
  system: SystemId;
  systemName: string;
  host: string;
  retrievedAt: string; // ISO timestamp
  recordCount: number;
}

export interface Money {
  currency: string;
  centavos: number; // integer minor units — all arithmetic is done in integers
}

export interface FinanceReport {
  kind: 'finance.summary';
  range: DateRange;
  income: Money[];
  expenses: Money[];
  net: Money[];
  expensesByCategory: { category: string; amounts: Money[] }[];
  budgets: { ref: string; name: string; amounts: Money[]; spent: Money[] | null; remaining: Money[] | null }[];
  budgetComparison: 'available' | 'unavailable';
}

export interface OrderRow {
  ref: string;
  status: string;
  dueDate: string | null;
  progressPercent: number | null;
  stage: string | null;
  daysOverdue: number | null;
}

export interface OrderStatusReport {
  kind: 'orders.status';
  range: DateRange;
  byStatus: { status: string; count: number }[];
  open: number | null;
  overdue: number | null;
  rows: OrderRow[];
}

export interface OverdueReport {
  kind: 'orders.overdue';
  asOf: string; // YYYY-MM-DD Manila
  overdue: OrderRow[];
  undetermined: number; // orders whose due date or closed state is unknown
}

export interface CombinedReport {
  kind: 'combined.report';
  range: DateRange;
  linking: 'verified-order-id' | 'unavailable';
  matched: {
    orderRef: string;
    status: string;
    income: Money[];
    expenses: Money[];
    recordedMargin: Money[];
    costsIncomplete: boolean;
  }[];
  financeWithoutOrderId: number;
  financeOrderIdNotFound: string[];
  ordersWithoutFinance: string[];
}

export type ReportPayload = FinanceReport | OrderStatusReport | OverdueReport | CombinedReport;

export interface StepResult {
  summary: string;
  empty: boolean;
  recordCount: number;
  references: string[];
  referencesTruncated: boolean;
  sources: SourceInfo[];
  notes: string[];
  /** 'code' = calculated by code; 'ai' = written by the AI provider from the data its tools returned. */
  generatedBy: 'code' | 'ai';
  report: ReportPayload | null;
  /** AI tasks only: the answer text (plain text with light Markdown), the model, and the data lookups it made. */
  answer?: string;
  model?: string;
  lookups?: { tool: string; detail: string; ok: boolean }[];
  /**
   * Order number -> customer name, for display only. Built by the server from WAD Order
   * Management; never sent to the AI provider and never written to the task log.
   */
  customers?: Record<string, string>;
}

export interface JobStep {
  id: string;
  agent: LiveAgentId;
  label: string;
  system: SystemId | null;
  status: JobStatus;
  startedAt?: string;
  finishedAt?: string;
  error?: LiveError;
  result?: StepResult;
}

export interface Job {
  id: string;
  /** Increases with every change; clients ignore snapshots older than what they have. */
  rev: number;
  type: JobType;
  title: string;
  range: DateRange;
  /** AI tasks only: the request as typed and the agent it was assigned to. */
  prompt?: string;
  agent?: LiveAgentId;
  /**
   * A photo sent with the task: type, size and a short fingerprint only. The photo itself is kept
   * in server memory just while the task runs and is never stored, logged or sent back.
   */
  image?: { mimeType: string; bytes: number; sha256: string };
  /** Customer-service tasks: the order a staff member picked for the reply. */
  orderRef?: string;
  /** How many phone numbers and email addresses were removed from the request before the AI saw it. */
  redacted?: number;
  requestedBy: string;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  steps: JobStep[];
  error?: LiveError;
}

export type SystemState = 'not_configured' | 'awaiting_documentation' | 'ready';

export interface SystemStatus {
  id: SystemId;
  name: string;
  state: SystemState;
  host: string | null;
  problems: string[];
  capabilities: Record<string, boolean>;
}

export interface JobTypeInfo {
  type: JobType;
  title: string;
  agent: LiveAgentId;
  permissions: Permission[];
  allowed: boolean;
  systems: SystemId[];
}

export interface SessionUser {
  username: string;
  role: string;
  permissions: Permission[];
}

export interface AiStatus {
  ready: boolean;
  provider: string;
  model: string | null;
  problems: string[];
}

export const MAX_PROMPT_CHARS = 600;
/** Customer-service tasks carry the customer's whole message, so they may be longer. */
export const MAX_CS_PROMPT_CHARS = 2000;

/** One carpenter in the Workshop room, with how many open orders they are assigned to. */
export interface ShopCarpenter {
  name: string;
  /** Open orders by status where this carpenter is assigned (as carpenter or hamba carpenter). */
  inProgress: number;
  pending: number;
  finished: number;
  /** Of those, how many as the hamba (door frame) carpenter. */
  hamba: number;
}

/**
 * The Workshop room: the carpenters assigned to open orders in WAD Order Management (names and
 * counts only: no customers, order numbers, prices or labor).
 */
export interface ShopCounts {
  /** false when the order system does not return carpenter assignments. */
  available: boolean;
  carpenters: ShopCarpenter[];
  /** Open, not-yet-finished orders with no carpenter assigned. */
  unassigned: number;
  /** Status Finished: waiting for delivery. */
  ready: number;
  open: number;
  overdue: number;
  asOf: string;
}

/** One open order for the customer-service order picker (names are shown only in the office). */
export interface OrderPick {
  ref: string;
  customer: string | null;
  status: string;
  dueDate: string | null;
}
export const MAX_RANGE_DAYS = 366;
