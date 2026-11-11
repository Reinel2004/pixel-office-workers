// Types shared by the Connected Mode server and the browser.
// Nothing in this file is mock data; demo data lives only in src/data/mock.ts.

export type SystemId = 'finance' | 'orders';

export const SYSTEM_NAMES: Record<SystemId, string> = {
  finance: 'WAD Furniture Management',
  orders: 'WAD Order Management',
};

/** ui:review = UI Review in the Development Studio (Aya, Rey and Kim look at website screenshots). */
/** ai:usage = see the AI usage tracker; ai:limits = change its limits and prices. */
export type Permission = 'finance:read' | 'orders:read' | 'social:post' | 'system:read' | 'ui:review' | 'ai:usage' | 'ai:limits';

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
/**
 * Task Board statuses. AI tasks end in "ready_for_review" (a person checks the answer and marks it
 * complete) or "needs_info" (the agent asked a question; reply to continue). Reports calculated by
 * code end in "completed".
 */
export type JobStatus = 'queued' | 'working' | 'needs_info' | 'ready_for_review' | 'completed' | 'failed' | 'cancelled';
/** A step inside a task (one agent's part of the work). */
export type StepStatus = 'queued' | 'working' | 'completed' | 'failed' | 'cancelled';
export const JOB_ACTIVE: JobStatus[] = ['queued', 'working'];
/** Most follow-up messages one task can take. */
export const MAX_FOLLOW_UPS = 10;
export type LiveAgentId = 'lia' | 'marco' | 'paolo' | 'nina' | 'bea' | 'rosa' | 'mika' | 'carlo' | 'joy' | 'tess' | 'dev' | 'sam' | 'ivy' | 'aya' | 'rey' | 'kim' | 'chief';
/** Agents that accept a photo with their task (e.g. Carlo writes a caption for a door photo). */
export const IMAGE_AGENTS: LiveAgentId[] = ['carlo'];
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
/** Largest photo accepted, in bytes (the office shrinks photos before sending, so this is rarely reached). */
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
export const LIVE_AGENT_IDS: LiveAgentId[] = ['lia', 'marco', 'paolo', 'nina', 'bea', 'rosa', 'mika', 'carlo', 'joy', 'tess', 'dev', 'sam', 'ivy', 'aya', 'rey', 'kim', 'chief'];
/** Agents that take one order picked by a staff member (Joy answers a customer about it; Tess checks it). */
export const ORDER_AGENTS: LiveAgentId[] = ['joy', 'tess'];
/** The UI Review team in the Development Studio. */
export const UI_TEAM = ['aya', 'kim', 'rey'] as const;
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
  | 'AI_LIMIT' // the office's own AI usage limit was reached; the request was not sent
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
  /**
   * AI tasks: records the office retrieved by code BEFORE the AI answered (orders, expenses,
   * payments, cash advances), with totals, date range, source and retrieval time, or why not.
   */
  dataLookups?: DataLookup[];
  /** AI tasks: the agent asked for more information instead of answering. */
  needsInfo?: boolean;
  /** Employee code (EMP-…) -> name, for display only; never sent to the AI provider or saved to disk. */
  employees?: Record<string, string>;
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
  status: StepStatus;
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
  /** Last change of any kind (status, progress, a follow-up). */
  updatedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  steps: JobStep[];
  error?: LiveError;
  /** AI tasks: the conversation so far (the first message is the original request). */
  thread?: TaskTurn[];
  /** Who marked it complete, and when. */
  reviewedBy?: string;
  reviewedAt?: string;
  cancelledBy?: string;
}

export interface TaskTurn {
  role: 'user' | 'agent';
  text: string;
  at: string;
  /** Agent turns: how that answer ended. */
  outcome?: 'answered' | 'needs_info' | 'failed' | 'cancelled';
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

// ---------------------------------------------------------------- team discussions
/**
 * A bounded team discussion: round 1 independent proposals, round 2 peer review, then Chief's
 * synthesis. Each contribution is a separate AI request; nothing is ever executed or sent.
 */
export type DiscussionStatus = 'queued' | 'gathering' | 'proposals' | 'reviews' | 'synthesizing' | 'completed' | 'cancelled' | 'failed';
export const DISCUSSION_ACTIVE: DiscussionStatus[] = ['queued', 'gathering', 'proposals', 'reviews', 'synthesizing'];
export const DISCUSSION_LIMITS = { minSpecialists: 2, maxSpecialists: 4, topicChars: 200, contextChars: 1500 } as const;

/** One piece of evidence captured at the start of the discussion (calculated by code). */
export interface EvidenceRef {
  id: string; // E1, E2…
  title: string;
  system: SystemId | null;
  retrievedAt: string;
  range: DateRange | null;
  available: boolean;
  /** Why it is unavailable, or a short caveat. */
  note: string | null;
}

export interface DiscussionPoint {
  text: string;
  kind: 'fact' | 'hypothesis' | 'recommendation';
  /** Evidence ids, checked by code against what this agent was given. */
  evidence: string[];
}

export interface DiscussionUsage {
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export type DiscussionRound = 'proposal' | 'review' | 'synthesis';

export interface DiscussionMessage {
  id: string;
  round: DiscussionRound;
  agent: LiveAgentId;
  status: 'waiting' | 'working' | 'done' | 'failed' | 'skipped' | 'cancelled';
  startedAt: string | null;
  finishedAt: string | null;
  /** Why it failed or was skipped (shown to the user). */
  error: string | null;
  attempts: number;
  proposal?: { findings: DiscussionPoint[]; actions: DiscussionPoint[]; assumptions: string[]; missingInfo: string[] };
  review?: { critiques: { about: string; text: string }[]; constraints: string[]; tradeoffs: string[]; improvements: string[] };
  synthesis?: {
    summary: string;
    approach: string;
    reasoning: string;
    actions: { text: string; owner: string; evidence: string[] }[];
    risks: string[];
    openQuestions: string[];
    disagreements: string[];
    limitations: string[];
  };
  /** Evidence ids the agent cited that it was not given (removed). */
  droppedRefs?: number;
  usage?: DiscussionUsage | null;
}

export interface Discussion {
  id: string;
  /** 'demo' = sample discussion made in the browser (never stored on the server). */
  mode: 'connected' | 'demo';
  owner: string;
  topic: string;
  context: string;
  participants: LiveAgentId[];
  moderator: 'chief';
  range: DateRange;
  status: DiscussionStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  /** true when a contribution is missing (failed or skipped) but Chief still summarised. */
  partial: boolean;
  evidence: EvidenceRef[];
  messages: DiscussionMessage[];
  /** Model used, and token totals when the provider reported them. */
  model: string | null;
  usage: DiscussionUsage | null;
  aiRequests: number;
}

export interface DiscussionInput {
  topic: string;
  context?: string;
  participants: LiveAgentId[];
  range?: DateRange;
  /** Client key so a double click starts only one discussion. */
  key?: string;
}

// ---------------------------------------------------------------- quality control (Tess)
/**
 * One piece of an order as WAD Order Management records it (api/ceo/office-order-spec.php).
 * No customer name, contact, address, price or labor.
 */
export interface PieceSpec {
  category: string | null;
  /** The design, e.g. "Panel Door", "V-cut". */
  type: string | null;
  size: string | null;
  thickness: string | null;
  wood: string | null;
  /** Varnish / finish, e.g. "With Varnish", "Without Varnish". */
  finish: string | null;
  /** "With Hamba" / "Without Hamba" (hamba = door jamb / frame). */
  jamb: string | null;
  jambWood: string | null;
  jambSize: string | null;
  cnc: boolean | null;
  tableShape: string | null;
  length: string | null;
  width: string | null;
  height: string | null;
  /** Staff notes on the piece (shown in the office; never sent to the AI). */
  notes: string | null;
  hasDesignPhoto: boolean;
  hasColorSample: boolean;
  stage: string | null;
}

export interface OrderSpec {
  ref: string;
  status: string | null;
  dueDate: string | null;
  pieces: PieceSpec[];
  truncated: boolean;
}

export type CheckArea = 'dimensions' | 'design' | 'finish' | 'jamb' | 'hardware' | 'general';
export const CHECK_AREAS: CheckArea[] = ['dimensions', 'design', 'finish', 'jamb', 'hardware', 'general'];

export interface ChecklistItem {
  id: string;
  area: CheckArea;
  /** What to check, in plain words. */
  text: string;
  /** The value from the order to compare against, or null. */
  expected: string | null;
  /** The order does not record this: confirm it before inspecting. */
  missing?: boolean;
}

/** Identical pieces are checked together ("2 × Door · Panel Door · Narra"). */
export interface ChecklistGroup {
  label: string;
  qty: number;
  stages: string[];
  items: ChecklistItem[];
  notes: string[];
}

/** Built by code from the order's specifications (no AI): nothing is guessed. */
export interface InspectionChecklist {
  ref: string;
  status: string | null;
  dueDate: string | null;
  pieces: number;
  groups: ChecklistGroup[];
  /** Things the order does not record (e.g. hardware), to confirm with sales first. */
  warnings: string[];
  builtAt: string;
  source: 'live' | 'demo';
}

// ---------------------------------------------------------------- UI Review (Aya, Kim, Rey)
/**
 * A UI Review of one page of a website, from screenshots a staff member uploads:
 *   queued → reviewing (Aya: design, Kim: usability, separately) → planning (Rey: change plan)
 *   → proposed (you accept changes, make them in your coding tool, upload "after" screenshots)
 *   → verifying (Kim compares before and after) → verified   …or failed / cancelled.
 * The office never opens the website, never changes code and never deploys anything.
 */
export type UiReviewStatus = 'queued' | 'reviewing' | 'planning' | 'proposed' | 'verifying' | 'verified' | 'failed' | 'cancelled';
/** A step is running on the server ("proposed" and "verified" are waiting for you). */
export const UI_REVIEW_RUNNING: UiReviewStatus[] = ['queued', 'reviewing', 'planning', 'verifying'];

export type UiSiteId = 'order-management' | 'furniture-management' | 'ai-office' | 'other';
export const UI_SITES: Record<UiSiteId, string> = {
  'order-management': 'WAD Order Management',
  'furniture-management': 'WAD Furniture Management',
  'ai-office': 'WAD AI Office',
  other: 'Another page',
};
export const UI_REVIEW_LIMITS = {
  maxShots: 3,
  pageChars: 80,
  goalChars: 600,
  addressChars: 200,
  noteChars: 400,
  maxVerifications: 3,
  maxShotBytes: 2 * 1024 * 1024,
  maxTotalBytes: 5 * 1024 * 1024,
} as const;

/** A screenshot's description; the image itself stays in server memory only (never stored or logged). */
export interface UiShot {
  label: string;
  mimeType: string;
  bytes: number;
  sha256: string;
}

export type UiArea = 'layout' | 'navigation' | 'mobile' | 'readability' | 'accessibility' | 'workflow' | 'consistency' | 'other';
export const UI_AREAS: UiArea[] = ['layout', 'navigation', 'mobile', 'readability', 'accessibility', 'workflow', 'consistency', 'other'];

export interface UiFinding {
  /** A1, A2… (Aya) or K1, K2… (Kim). */
  id: string;
  area: UiArea;
  severity: 'high' | 'medium' | 'low';
  problem: string;
  suggestion: string;
  /** Which screenshot it is about (1-based), or null. */
  shot: number | null;
}

export interface UiChange {
  /** C1, C2… */
  id: string;
  title: string;
  /** Finding ids it solves. */
  findings: string[];
  kind: 'css' | 'html' | 'php' | 'javascript' | 'content' | 'other';
  effort: 'S' | 'M' | 'L';
  risk: 'low' | 'medium' | 'high';
  steps: string[];
  /** How to check it works (Kim re-checks these). */
  checks: string[];
  /** Chosen by a staff member; only accepted changes go into the developer brief and the re-check. */
  accepted: boolean;
}

export interface UiCheck {
  change: string;
  result: 'done' | 'partial' | 'not_done' | 'cannot_tell';
  note: string;
}

export type UiStepStatus = 'waiting' | 'working' | 'done' | 'failed' | 'skipped' | 'cancelled';
export interface UiStep {
  id: string;
  agent: LiveAgentId;
  kind: 'design' | 'usability' | 'plan' | 'verify';
  status: UiStepStatus;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  attempts: number;
  usage?: DiscussionUsage | null;
}

export interface UiVerification {
  round: number;
  createdAt: string;
  note: string;
  shots: UiShot[];
  step: UiStep;
  summary: string;
  checks: UiCheck[];
  regressions: string[];
  verdict: 'ready' | 'needs_fixes' | null;
}

export interface UiReview {
  id: string;
  /** 'demo' = sample review made in the browser (no AI, never stored on the server). */
  mode: 'connected' | 'demo';
  owner: string;
  site: UiSiteId;
  page: string;
  /** Shown for reference only: the office never opens this address. */
  address: string | null;
  goal: string;
  device: 'desktop' | 'mobile' | 'both';
  status: UiReviewStatus;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  error: string | null;
  before: UiShot[];
  /** false once the server no longer holds the "before" screenshots (restart, or older than a day). */
  imagesKept: boolean;
  steps: UiStep[];
  design: { summary: string; strengths: string[]; findings: UiFinding[] } | null;
  usability: { summary: string; findings: UiFinding[]; tests: string[] } | null;
  plan: { summary: string; changes: UiChange[]; questions: string[]; outOfScope: string[] } | null;
  verifications: UiVerification[];
  model: string | null;
  usage: DiscussionUsage | null;
  aiRequests: number;
}

export interface UiShotUpload {
  label?: string;
  mimeType: string;
  /** Base64 (a data: URL prefix is accepted). */
  data: string;
}

export interface UiReviewInput {
  site: UiSiteId;
  page: string;
  address?: string;
  goal: string;
  device: UiReview['device'];
  shots: UiShotUpload[];
  /** The person confirms no customer names, phone numbers or addresses are visible. */
  noPrivateData: boolean;
  key?: string;
}

export interface UiVerifyInput {
  shots: UiShotUpload[];
  note?: string;
  noPrivateData: boolean;
  key?: string;
}

// ---------------------------------------------------------------- AI usage tracker
/** What a Gemini request was for. */
export type AiFeature = 'task' | 'discussion' | 'ui-review' | 'other';
export const AI_FEATURE_LABEL: Record<AiFeature, string> = { task: 'Assigned tasks', discussion: 'Team discussions', 'ui-review': 'UI Review', other: 'Other' };

/** Limits checked BEFORE each request is sent. null = no limit. Prices are US dollars per 1 million tokens. */
export interface AiLimits {
  dailyRequests: number | null;
  /** Per signed-in account, per day. */
  userDailyRequests: number | null;
  dailyTokens: number | null;
  monthlyBudgetUsd: number | null;
  inputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
  /** A warning shows from this share of any limit (percent). */
  warnPercent: number;
}

export const AI_LIMIT_BOUNDS = {
  dailyRequests: 100_000,
  userDailyRequests: 100_000,
  dailyTokens: 1_000_000_000,
  monthlyBudgetUsd: 100_000,
  pricePerMillion: 1_000,
} as const;

export interface AiUsageTotals {
  /** Requests actually sent to Gemini (including failed ones). */
  requests: number;
  ok: number;
  failed: number;
  /** Stopped by a limit before sending (not sent, not billed). */
  blocked: number;
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Answered requests for which Gemini reported no token counts. */
  noUsage: number;
  /** Estimated cost in US dollars, from the prices set when each request ran; null = no prices set. */
  costUsd: number | null;
}

export interface AiUsageDay extends AiUsageTotals {
  date: string;
}

export interface AiUsageGroup {
  key: string;
  requests: number;
  totalTokens: number;
  costUsd: number | null;
}

export interface AiUsageRow {
  at: string;
  feature: AiFeature;
  agent: string | null;
  user: string | null;
  model: string;
  /** 'ok', an error code, or 'blocked'. */
  outcome: string;
  promptTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  ms: number | null;
}

export interface AiLimitState {
  id: 'dailyRequests' | 'userDailyRequests' | 'dailyTokens' | 'monthlyBudgetUsd';
  label: string;
  used: number;
  limit: number | null;
  /** 0–100+, null when there is no limit. */
  percent: number | null;
  level: 'ok' | 'warning' | 'reached';
}

export interface AiUsageReport {
  asOf: string;
  model: string | null;
  /** Manila calendar day and month the totals belong to. */
  today: string;
  month: string;
  todayTotals: AiUsageTotals;
  monthTotals: AiUsageTotals;
  /** The last 30 days, oldest first (days without requests included as zeros). */
  days: AiUsageDay[];
  /** This month, largest first. */
  byFeature: AiUsageGroup[];
  byAgent: AiUsageGroup[];
  byUser: AiUsageGroup[];
  /** Most recent first; counts only, never prompts or answers. */
  recent: AiUsageRow[];
  limits: AiLimits;
  /** The server's defaults (from its environment), for "Reset". */
  defaults: AiLimits;
  /** true when an admin changed the limits in the office. */
  customized: boolean;
  limitStates: AiLimitState[];
  /** The signed-in user's requests today (for their own limit). */
  yourRequestsToday: number;
  /** Whether totals survive a restart (saved to a file). */
  saved: boolean;
  canEdit: boolean;
  notes: string[];
}

// ---------------------------------------------------------------- Attention needed (notifications)
export type AttentionKind = 'connection' | 'blocked' | 'overdue' | 'limit';
export type AttentionSeverity = 'critical' | 'warning' | 'info';
export const ATTENTION_KIND_LABEL: Record<AttentionKind, string> = {
  connection: 'Connections',
  limit: 'AI limits',
  blocked: 'Blocked or failed work',
  overdue: 'Overdue orders',
};

/** Where an item leads: a record in the office, the Systems tab, or a page in a business system. */
export type AttentionLink =
  | { kind: 'job' | 'discussion' | 'uireview'; id: string; label: string }
  | { kind: 'systems'; label: string }
  | { kind: 'external'; url: string; label: string };

export interface AttentionItem {
  /** Stable per thing (e.g. "overdue:ORD-12"). */
  id: string;
  /** Changes when the thing changes, so a dismissed item comes back if it gets worse or new. */
  version: string;
  kind: AttentionKind;
  severity: AttentionSeverity;
  title: string;
  detail: string;
  /** When it happened or became due (ISO date or time), when known. */
  at: string | null;
  link: AttentionLink | null;
}

export interface AttentionReport {
  asOf: string;
  items: AttentionItem[];
  /** Overdue orders in total (the list shows the most overdue first, up to a limit); null = not checked. */
  overdueTotal: number | null;
  notes: string[];
}

// ---------------------------------------------------------------- Automatic data lookup
export type LookupDomain = 'orders' | 'expenses' | 'payments' | 'cash_advances';
export const LOOKUP_LABEL: Record<LookupDomain, string> = { orders: 'Orders', expenses: 'Expenses', payments: 'Payments', cash_advances: 'Employee cash advances' };

/** One automatic lookup: what was retrieved for the question, or exactly why it could not be. */
export interface DataLookup {
  domain: LookupDomain;
  /** What was looked up, e.g. "Payments received (income records)". */
  title: string;
  status: 'ok' | 'empty' | 'unavailable' | 'not_allowed';
  /** The period used, or null for "right now" data (e.g. all open orders). */
  range: DateRange | null;
  /** How the period was chosen, e.g. "last month (from your question)" or "this month (default)". */
  rangeLabel: string;
  retrievedAt: string | null;
  source: SourceInfo | null;
  /** Totals and counts calculated by code (display strings). */
  figures: { label: string; value: string }[];
  /** Limitation or note, e.g. "WAD Furniture Management is not connected: …". */
  message: string | null;
}
