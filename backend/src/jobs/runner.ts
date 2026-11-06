// Job runner for Connected Mode reports. Each job has steps owned by an office agent; the UI
// animates agents from these step events. A step is "completed" only after its result has
// been received AND validated. Nothing here waits on animations.

import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { DateRange, Job, JobStep, JobTypeInfo, LiveAgentId, Permission, ReportType, SessionUser, StepResult, SystemId } from '../../shared/live';
import { IMAGE_AGENTS, IMAGE_TYPES, LIVE_AGENT_IDS, MAX_IMAGE_BYTES, MAX_PROMPT_CHARS, SYSTEM_NAMES } from '../../shared/live';
import { manilaDate } from '../../shared/manila';
import type { FinanceRecord, FinanceSource, OrderRecord, OrderSource } from '../adapters/types';
import { AGENT_PROFILES, runAiTask, type AiTaskDeps } from '../ai/tasks';
import { IntegrationError, toLiveError } from '../http/errors';
import { combine, financeSummary, orderStatus, overdueOrders, customerNames } from '../reports/calc';
import { validateStepResult } from './validate';

interface StepDef {
  agent: LiveAgentId;
  label: string;
  system: SystemId | null;
}

interface JobDef {
  title: string;
  permissions: Permission[];
  steps: StepDef[];
}

export const JOB_DEFS: Record<ReportType, JobDef> = {
  'finance.summary': {
    title: 'Finance summary',
    permissions: ['finance:read'],
    steps: [{ agent: 'bea', label: 'Retrieve income, expenses and budgets', system: 'finance' }],
  },
  'orders.status': {
    title: 'Order status',
    permissions: ['orders:read'],
    steps: [{ agent: 'paolo', label: 'Retrieve orders and production progress', system: 'orders' }],
  },
  'orders.overdue': {
    title: 'Overdue orders',
    permissions: ['orders:read'],
    steps: [{ agent: 'paolo', label: 'Check open orders against due dates', system: 'orders' }],
  },
  'combined.report': {
    title: 'Combined report',
    permissions: ['finance:read', 'orders:read'],
    steps: [
      { agent: 'bea', label: 'Retrieve income and expenses', system: 'finance' },
      { agent: 'paolo', label: 'Retrieve orders', system: 'orders' },
      { agent: 'chief', label: 'Link records by verified order ID', system: null },
    ],
  },
};

export function jobTypesFor(user: SessionUser): JobTypeInfo[] {
  return (Object.keys(JOB_DEFS) as ReportType[]).map((type) => {
    const d = JOB_DEFS[type];
    return {
      type,
      title: d.title,
      agent: d.steps[d.steps.length - 1].agent,
      permissions: d.permissions,
      allowed: d.permissions.every((p) => user.permissions.includes(p)),
      systems: [...new Set(d.steps.map((s) => s.system).filter((s): s is SystemId => !!s))],
    };
  });
}

export interface RunnerDeps {
  finance: FinanceSource;
  orders: OrderSource;
  maxConcurrent: number;
  log?: (entry: Record<string, unknown>) => void;
  now?: () => Date;
  /** Free-text AI tasks; absent when no AI provider is configured. */
  ai?: Omit<AiTaskDeps, 'finance' | 'orders' | 'now'> | null;
}

export class SubmitError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const MAX_REFS = 50;
const HISTORY = 200;

export class JobRunner extends EventEmitter {
  private jobs: Job[] = [];
  private queue: Job[] = [];
  private running = 0;
  private recentSubmits = new Map<string, number[]>();

  constructor(private deps: RunnerDeps) {
    super();
  }

  list(user: SessionUser): Job[] {
    return this.jobs.filter((j) => j.requestedBy === user.username);
  }

  get(id: string, user: SessionUser): Job | undefined {
    return this.jobs.find((j) => j.id === id && j.requestedBy === user.username);
  }

  /** Validates permissions, rate-limits per user, and de-duplicates identical in-flight requests. */
  submit(user: SessionUser, type: ReportType, range: DateRange): { job: Job; deduplicated: boolean } {
    const def = JOB_DEFS[type];
    if (!def) throw new SubmitError(400, 'Unknown report type.');
    const missing = def.permissions.filter((p) => !user.permissions.includes(p));
    if (missing.length) throw new SubmitError(403, `Your account does not have permission for this report (${missing.join(', ')}).`);
    const dup = this.jobs.find(
      (j) => j.requestedBy === user.username && j.type === type && j.range.from === range.from && j.range.to === range.to && (j.status === 'queued' || j.status === 'working'),
    );
    if (dup) return { job: dup, deduplicated: true };
    this.rateLimit(user);

    const job: Job = {
      id: randomUUID(),
      rev: 0,
      type,
      title: def.title,
      range,
      requestedBy: user.username,
      status: 'queued',
      createdAt: new Date().toISOString(),
      steps: def.steps.map((s, i) => ({ id: `s${i + 1}`, agent: s.agent, label: s.label, system: s.system, status: 'queued' as const })),
    };
    this.enqueue(job);
    return { job, deduplicated: false };
  }

  /** A free-text task for one agent, answered by the AI provider with read-only data tools. */
  submitAi(user: SessionUser, agent: LiveAgentId, rawPrompt: string, rawImage?: { mimeType: string; data: string }): { job: Job; deduplicated: boolean } {
    if (!this.deps.ai) throw new SubmitError(503, 'AI tasks are not set up on the server (GEMINI_API_KEY is missing).');
    if (!LIVE_AGENT_IDS.includes(agent)) throw new SubmitError(400, 'Unknown agent.');
    const image = rawImage ? checkImage(agent, rawImage) : null;
    let prompt = rawPrompt.replace(/\s+/g, ' ').trim();
    if (!prompt && image) prompt = 'Write a Facebook caption for this photo.';
    if (!prompt) throw new SubmitError(400, 'Type a task first.');
    if (prompt.length > MAX_PROMPT_CHARS) throw new SubmitError(400, `Keep the task under ${MAX_PROMPT_CHARS} characters.`);
    const dup = this.jobs.find(
      (j) =>
        j.requestedBy === user.username &&
        j.type === 'ai.task' &&
        j.agent === agent &&
        j.prompt === prompt &&
        j.image?.sha256 === image?.meta.sha256 &&
        (j.status === 'queued' || j.status === 'working'),
    );
    if (dup) return { job: dup, deduplicated: true };
    this.rateLimit(user);
    const name = AGENT_PROFILES[agent].name;
    const today = manilaDate(this.deps.now?.());
    const short = prompt.length > 60 ? `${prompt.slice(0, 57)}…` : prompt;
    const job: Job = {
      id: randomUUID(),
      rev: 0,
      type: 'ai.task',
      title: `${name}: ${short}`,
      range: { from: today, to: today },
      prompt,
      agent,
      ...(image ? { image: image.meta } : {}),
      requestedBy: user.username,
      status: 'queued',
      createdAt: new Date().toISOString(),
      steps: [{ id: 's1', agent, label: prompt.length > 120 ? `${prompt.slice(0, 117)}…` : prompt, system: null, status: 'queued' }],
    };
    this.users.set(job.id, user);
    if (image) this.images.set(job.id, { mimeType: image.meta.mimeType, data: image.data });
    this.enqueue(job);
    return { job, deduplicated: false };
  }

  /** Who submitted each pending AI task (its permissions decide which data tools the AI gets). */
  private users = new Map<string, SessionUser>();
  /** Photos for pending AI tasks, in memory only; removed as soon as the task ends. */
  private images = new Map<string, { mimeType: string; data: string }>();

  private rateLimit(user: SessionUser) {
    const now = Date.now();
    const recent = (this.recentSubmits.get(user.username) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= 10) throw new SubmitError(429, 'Too many tasks requested in the last minute. Please wait a moment.');
    this.recentSubmits.set(user.username, [...recent, now]);
  }

  private enqueue(job: Job) {
    this.jobs.unshift(job);
    if (this.jobs.length > HISTORY) this.jobs.length = HISTORY;
    this.queue.push(job);
    this.audit(job, 'queued');
    this.emitJob(job);
    this.pump();
  }

  private pump() {
    while (this.running < this.deps.maxConcurrent && this.queue.length) {
      const job = this.queue.shift()!;
      this.running++;
      this.execute(job)
        .catch(() => undefined)
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }

  private emitJob(job: Job) {
    job.rev++;
    this.emit('job', structuredClone(job));
  }

  private audit(job: Job, event: string, extra: Record<string, unknown> = {}) {
    // Task log: ids, type, user, status, timing and error codes only — no amounts, no customer data,
    // and for AI tasks only the agent and the prompt's length, never its text.
    const what =
      job.type === 'ai.task'
        ? { agent: job.agent, promptChars: job.prompt?.length ?? 0, ...(job.image ? { imageBytes: job.image.bytes, imageType: job.image.mimeType } : {}) }
        : { range: job.range };
    this.deps.log?.({ at: new Date().toISOString(), event, jobId: job.id, type: job.type, user: job.requestedBy, ...what, status: job.status, ...extra });
  }

  private async execute(job: Job) {
    job.status = 'working';
    job.startedAt = new Date().toISOString();
    this.audit(job, 'started');
    this.emitJob(job);
    try {
      switch (job.type) {
        case 'finance.summary':
          await this.runStep(job, job.steps[0], () => this.financeStep(job));
          break;
        case 'orders.status':
          await this.runStep(job, job.steps[0], () => this.orderStatusStep(job));
          break;
        case 'orders.overdue':
          await this.runStep(job, job.steps[0], () => this.overdueStep());
          break;
        case 'combined.report':
          await this.combinedJob(job);
          break;
        case 'ai.task':
          await this.runStep(job, job.steps[0], () => this.aiStep(job));
          break;
      }
      const failed = job.steps.find((s) => s.status === 'failed');
      job.status = failed ? 'failed' : 'completed';
      if (failed) job.error = failed.error;
    } catch (e) {
      job.status = 'failed';
      job.error = toLiveError(e);
    }
    job.finishedAt = new Date().toISOString();
    this.users.delete(job.id);
    this.images.delete(job.id);
    this.audit(job, 'finished', {
      durationMs: Date.parse(job.finishedAt) - Date.parse(job.startedAt!),
      errorCode: job.error?.code,
      recordCounts: job.steps.map((s) => s.result?.recordCount ?? null),
    });
    this.emitJob(job);
  }

  private async runStep(job: Job, step: JobStep, work: () => Promise<StepResult>): Promise<StepResult | null> {
    step.status = 'working';
    step.startedAt = new Date().toISOString();
    this.emitJob(job);
    try {
      const result = await work();
      const problem = validateStepResult(result);
      if (problem) throw new IntegrationError('INVALID_RESPONSE', `The result failed validation: ${problem}`, step.system ?? undefined);
      step.result = result;
      step.status = 'completed';
      return result;
    } catch (e) {
      step.status = 'failed';
      step.error = toLiveError(e, step.system ?? undefined);
      return null;
    } finally {
      step.finishedAt = new Date().toISOString();
      this.emitJob(job);
    }
  }

  // ---------------------------------------------------------------- steps
  private async aiStep(job: Job): Promise<StepResult> {
    const ai = this.deps.ai;
    const user = this.users.get(job.id);
    if (!ai || !user || !job.agent || !job.prompt) throw new IntegrationError('NOT_CONFIGURED', 'AI tasks are not set up on the server.');
    const out = await runAiTask({ ...ai, finance: this.deps.finance, orders: this.deps.orders, now: this.deps.now }, user, job.agent, job.prompt, this.images.get(job.id));
    const ok = out.lookups.filter((l) => l.ok).length;
    return {
      summary: out.lookups.length
        ? `Answered using ${ok} live data lookup(s)${ok < out.lookups.length ? '; some lookups failed' : ''}.`
        : 'Answered without live data lookups.',
      empty: false,
      recordCount: out.recordCount,
      references: out.references,
      referencesTruncated: out.references.length >= 50,
      sources: out.sources,
      notes: [],
      generatedBy: 'ai',
      report: null,
      answer: out.answer,
      model: out.model,
      lookups: out.lookups,
      customers: out.customers,
    };
  }

  private source(system: SystemId, count: number) {
    const status = system === 'finance' ? this.deps.finance.status() : this.deps.orders.status();
    return { system, systemName: SYSTEM_NAMES[system], host: status.host ?? '', retrievedAt: new Date().toISOString(), recordCount: count };
  }

  private refs(list: { ref: string }[]) {
    return { references: list.slice(0, MAX_REFS).map((r) => r.ref), referencesTruncated: list.length > MAX_REFS };
  }

  private async loadFinance(range: DateRange, withBudgets: boolean) {
    const f = this.deps.finance;
    const [income, expenses] = await Promise.all([f.listIncome(range), f.listExpenses(range)]);
    const budgets = withBudgets && f.capabilities.budgets ? await f.listBudgets(range) : null;
    return { income, expenses, budgets };
  }

  private async financeStep(job: Job): Promise<StepResult> {
    const { income, expenses, budgets } = await this.loadFinance(job.range, true);
    const { report, notes } = financeSummary(job.range, income, expenses, budgets, this.deps.finance.capabilities.budgetsByCategory);
    const all = [...income, ...expenses, ...(budgets ?? [])];
    const empty = all.length === 0;
    return {
      summary: empty
        ? 'No income, expense or budget records were found for this date range.'
        : `${income.length} income and ${expenses.length} expense record(s)${budgets ? `, ${budgets.length} budget(s)` : ''}.`,
      empty,
      recordCount: all.length,
      ...this.refs(all),
      sources: [this.source('finance', all.length)],
      notes,
      generatedBy: 'code',
      report,
    };
  }

  private async orderStatusStep(job: Job): Promise<StepResult> {
    const orders = await this.deps.orders.listOrders(job.range);
    const today = manilaDate(this.deps.now?.());
    const { report, notes } = orderStatus(job.range, orders, today, this.deps.orders.capabilities.closedStatuses);
    return {
      summary: orders.length ? `${orders.length} order(s) in this range.` : 'No orders were found for this date range.',
      empty: orders.length === 0,
      recordCount: orders.length,
      ...this.refs(orders),
      sources: [this.source('orders', orders.length)],
      notes,
      generatedBy: 'code',
      report,
      customers: customerNames(orders),
    };
  }

  private async overdueStep(): Promise<StepResult> {
    const orders = await this.deps.orders.listOpenOrders();
    const today = manilaDate(this.deps.now?.());
    const { report, notes } = overdueOrders(orders, today);
    return {
      summary: report.overdue.length ? `${report.overdue.length} overdue order(s) as of ${today} (Asia/Manila).` : `No overdue orders as of ${today} (Asia/Manila).`,
      empty: report.overdue.length === 0,
      recordCount: orders.length,
      ...this.refs(report.overdue),
      sources: [this.source('orders', orders.length)],
      notes,
      generatedBy: 'code',
      report,
      customers: customerNames(orders, report.overdue.map((r) => r.ref)),
    };
  }

  private async combinedJob(job: Job) {
    let fin: { income: FinanceRecord[]; expenses: FinanceRecord[] } | null = null;
    let orders: OrderRecord[] | null = null;
    // Both systems are queried in parallel; each step reports its own outcome.
    await Promise.all([
      this.runStep(job, job.steps[0], async () => {
        const { income, expenses } = await this.loadFinance(job.range, false);
        fin = { income, expenses };
        const all = [...income, ...expenses];
        return {
          summary: all.length ? `${income.length} income and ${expenses.length} expense record(s).` : 'No financial records for this range.',
          empty: all.length === 0,
          recordCount: all.length,
          ...this.refs(all),
          sources: [this.source('finance', all.length)],
          notes: [],
          generatedBy: 'code',
          report: null,
        };
      }),
      this.runStep(job, job.steps[1], async () => {
        orders = await this.deps.orders.listOrders(job.range);
        return {
          summary: orders.length ? `${orders.length} order(s).` : 'No orders for this range.',
          empty: orders.length === 0,
          recordCount: orders.length,
          ...this.refs(orders),
          sources: [this.source('orders', orders.length)],
          notes: [],
          generatedBy: 'code',
          report: null,
          customers: customerNames(orders),
        };
      }),
    ]);
    const chief = job.steps[2];
    if (!fin || !orders) {
      chief.status = 'failed';
      const failedNames = job.steps.slice(0, 2).filter((s) => s.status === 'failed').map((s) => SYSTEM_NAMES[s.system!]);
      chief.error = {
        code: 'DEPENDENCY_FAILED',
        message: `Could not combine: no data from ${failedNames.join(' and ')}. Nothing was estimated in its place.`,
        retryable: false,
      };
      chief.finishedAt = new Date().toISOString();
      this.emitJob(job);
      return;
    }
    const f = fin as { income: FinanceRecord[]; expenses: FinanceRecord[] };
    const o = orders as OrderRecord[];
    const linkVerified = this.deps.finance.capabilities.sharedOrderId && this.deps.orders.capabilities.sharedOrderId;
    await this.runStep(job, chief, async () => {
      const { report, notes } = combine(job.range, o, f.income, f.expenses, linkVerified);
      const n = report.matched.length;
      return {
        summary: !linkVerified
          ? 'Records could not be linked: no verified shared order ID.'
          : n
            ? `${n} order(s) linked to financial records by order ID.`
            : 'No orders could be linked to financial records in this range.',
        empty: n === 0,
        recordCount: n,
        references: report.matched.slice(0, MAX_REFS).map((m) => m.orderRef),
        referencesTruncated: n > MAX_REFS,
        sources: [...(job.steps[0].result?.sources ?? []), ...(job.steps[1].result?.sources ?? [])],
        notes,
        generatedBy: 'code',
        report,
        customers: customerNames(o, report.matched.map((m) => m.orderRef)),
      };
    });
  }
}

/**
 * Checks a photo sent with an AI task: allowed agent and type, real image bytes (the file's
 * signature must match its type), and size. Returns the base64 data and a short fingerprint.
 */
function checkImage(agent: LiveAgentId, img: { mimeType: string; data: string }) {
  if (!IMAGE_AGENTS.includes(agent)) throw new SubmitError(400, `${AGENT_PROFILES[agent].name} does not take photos.`);
  if (!(IMAGE_TYPES as readonly string[]).includes(img.mimeType)) throw new SubmitError(400, 'Use a JPEG, PNG or WebP photo.');
  const data = img.data.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new SubmitError(400, 'The photo could not be read.');
  const buf = Buffer.from(data, 'base64');
  if (buf.length > MAX_IMAGE_BYTES) throw new SubmitError(413, `The photo is too large (max ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB).`);
  const sig =
    img.mimeType === 'image/jpeg'
      ? buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
      : img.mimeType === 'image/png'
        ? buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        : buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP';
  if (!sig) throw new SubmitError(400, 'That file is not a valid photo of the type it claims to be.');
  return {
    data,
    meta: { mimeType: img.mimeType, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex').slice(0, 16) },
  };
}
