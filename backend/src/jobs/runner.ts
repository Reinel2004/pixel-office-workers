// Job runner for Connected Mode reports and assigned tasks (the Task Board). Each job has steps
// owned by an office agent; the UI animates agents from these step events. A step is "completed"
// only after its result has been received AND validated. Nothing here waits on animations.
//
// Task Board statuses: queued -> working -> ready_for_review (an AI answer for a person to check)
// or needs_info (the agent asked a question) or completed (reports calculated by code), or failed;
// a person can cancel, reply (follow-up: the same task runs again with the conversation so far)
// and mark an answer complete. Tasks are saved to TASKS_FILE so they survive a restart; photos and
// customer/employee names never are.

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import type { DateRange, Job, JobStep, JobTypeInfo, LiveAgentId, Permission, ReportType, SessionUser, StepResult, SystemId, TaskTurn } from '../../shared/live';
import { CATALOG_AI_PHOTO_MAX_BYTES, CATALOG_MAX_BATCH, FB_VIDEO_MAX_BYTES, IMAGE_AGENTS, MULTI_PHOTO_AGENTS, IMAGE_TYPES, LIVE_AGENT_IDS, MAX_CS_PROMPT_CHARS, MAX_FOLLOW_UPS, MAX_FRAME_BYTES, MAX_IMAGE_BYTES, MAX_PROMPT_CHARS, MAX_VIDEO_FRAMES, ORDER_AGENTS, ORDER_REF_PATTERN, SYSTEM_NAMES, VIDEO_AGENTS, VIDEO_TYPES } from '../../shared/live';
import { redactContacts } from '../ai/redact';
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
  /** Where tasks are saved (survive a restart); absent or null = memory only. */
  store?: TaskStore | null;
}

/**
 * Saves the Task Board to a JSON file. Photos are never kept (only their size and fingerprint),
 * and the customer and employee names shown next to order numbers and EMP-codes are left out:
 * after a restart those tasks show the numbers only.
 */
export class TaskStore {
  constructor(private file: string | null) {}

  load(): Job[] {
    if (!this.file || !existsSync(this.file)) return [];
    try {
      const v = JSON.parse(readFileSync(this.file, 'utf8')) as { jobs?: Job[] };
      return Array.isArray(v.jobs) ? v.jobs.filter((j) => j && typeof j.id === 'string' && typeof j.requestedBy === 'string' && Array.isArray(j.steps)) : [];
    } catch {
      return [];
    }
  }

  save(jobs: Job[]) {
    if (!this.file) return;
    try {
      const clean = jobs.map((j) => ({
        ...j,
        steps: j.steps.map((st) => (st.result ? { ...st, result: { ...st.result, customers: undefined, employees: undefined } } : st)),
      }));
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(`${this.file}.tmp`, JSON.stringify({ version: 1, jobs: clean }), { encoding: 'utf8', mode: 0o600 });
      renameSync(`${this.file}.tmp`, this.file);
    } catch {
      /* a storage problem must not stop the office; the in-memory board stays correct */
    }
  }
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
  /** Running work that can be cancelled. */
  private ctrls = new Map<string, AbortController>();
  /** Submission keys from the browser (user|key -> job id), so a resent request is not run twice. */
  private keys = new Map<string, { id: string; at: number }>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private deps: RunnerDeps) {
    super();
    // Tasks still queued or working when the server stopped are marked interrupted, never resumed silently.
    const at = new Date().toISOString();
    for (const j of deps.store?.load() ?? []) {
      if (j.status === 'queued' || j.status === 'working') {
        j.status = 'failed';
        j.error = { code: 'INTERNAL', message: 'Interrupted: the server restarted while this task was running. Run it again or send a follow-up.', retryable: true };
        j.finishedAt = at;
        j.updatedAt = at;
        for (const st of j.steps) if (st.status === 'queued' || st.status === 'working') st.status = 'cancelled';
      }
      this.jobs.push(j);
    }
    if (this.jobs.length > HISTORY) this.jobs.length = HISTORY;
  }

  /** Writes the board to its file now (also called on shutdown). */
  flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.deps.store?.save(this.jobs);
  }

  private scheduleSave() {
    if (!this.deps.store || this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 500);
    this.saveTimer.unref?.();
  }

  /** A repeated submission key returns the task it already created (10 minutes). */
  private fromKey(user: SessionUser, key: string | undefined): Job | null {
    if (!key) return null;
    const now = Date.now();
    for (const [k, v] of this.keys) if (now - v.at > 600_000) this.keys.delete(k);
    const hit = this.keys.get(`${user.username}|${key}`);
    return hit ? (this.jobs.find((j) => j.id === hit.id) ?? null) : null;
  }
  private rememberKey(user: SessionUser, key: string | undefined, job: Job) {
    if (key) this.keys.set(`${user.username}|${key}`, { id: job.id, at: Date.now() });
  }

  /** For the Systems Monitor: task counts only (no prompts, users or results). */
  stats() {
    const since = Date.now() - 86_400_000;
    const recent = this.jobs.filter((j) => Date.parse(j.createdAt) >= since);
    const by = (s: Job['status']) => recent.filter((j) => j.status === s).length;
    const failedCodes: Record<string, number> = {};
    for (const j of recent.filter((x) => x.status === 'failed'))
      for (const st of j.steps) if (st.error) failedCodes[st.error.code] = (failedCodes[st.error.code] ?? 0) + 1;
    return { last24h: { total: recent.length, completed: by('completed'), failed: by('failed') }, queuedNow: by('queued'), workingNow: by('working'), failureCodes: failedCodes };
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
      updatedAt: new Date().toISOString(),
      steps: def.steps.map((s, i) => ({ id: `s${i + 1}`, agent: s.agent, label: s.label, system: s.system, status: 'queued' as const })),
    };
    this.enqueue(job);
    return { job, deduplicated: false };
  }

  /** A free-text task for one agent, answered by the AI provider with read-only data tools. */
  submitAi(
    user: SessionUser,
    agent: LiveAgentId,
    rawPrompt: string,
    rawImage?: { mimeType: string; data: string },
    rawOrderRef?: string,
    key?: string,
    rawVideo?: unknown,
    rawPhotos?: unknown,
  ): { job: Job; deduplicated: boolean } {
    if (!this.deps.ai) throw new SubmitError(503, 'AI tasks are not set up on the server (GEMINI_API_KEY is missing).');
    const again = this.fromKey(user, key);
    if (again) return { job: again, deduplicated: true };
    if (!LIVE_AGENT_IDS.includes(agent)) throw new SubmitError(400, 'Unknown agent.');
    const image = rawImage ? checkImage(agent, rawImage) : null;
    const video = rawVideo !== undefined && rawVideo !== null ? checkVideo(agent, rawVideo) : null;
    const photos = rawPhotos !== undefined && rawPhotos !== null ? checkPhotos(agent, rawPhotos) : null;
    if ([image, video, photos].filter(Boolean).length > 1) throw new SubmitError(400, 'Send one photo, several photos or a video, not a mix.');
    const orderRef = rawOrderRef?.trim() || undefined;
    if (orderRef) {
      if (!ORDER_AGENTS.includes(agent)) throw new SubmitError(400, `${AGENT_PROFILES[agent].name} does not take a selected order.`);
      if (!ORDER_REF_PATTERN.test(orderRef)) throw new SubmitError(400, 'That order number is not valid.');
      if (!user.permissions.includes('orders:read')) throw new SubmitError(403, 'Your account cannot read orders.');
    }
    // Phone numbers and emails never reach the AI (or the stored task).
    const { text: cleaned, count: redacted } = redactContacts(rawPrompt);
    let prompt = cleaned.replace(/\s+/g, ' ').trim();
    if (!prompt && photos) prompt = `Draft catalog entries for these ${photos.list.length} product photos.`;
    if (!prompt && image) prompt = agent === 'kat' ? 'Draft a catalog entry for this product photo.' : 'Write a Facebook caption for this photo.';
    if (!prompt && video) prompt = 'Write a Facebook caption for this video.';
    if (!prompt) throw new SubmitError(400, 'Type a task first.');
    const maxChars = ORDER_AGENTS.includes(agent) ? MAX_CS_PROMPT_CHARS : MAX_PROMPT_CHARS;
    if (prompt.length > maxChars) throw new SubmitError(400, `Keep the task under ${maxChars} characters.`);
    const dup = this.jobs.find(
      (j) =>
        j.requestedBy === user.username &&
        j.type === 'ai.task' &&
        j.agent === agent &&
        j.prompt === prompt &&
        j.image?.sha256 === image?.meta.sha256 &&
        j.photos?.sha256 === photos?.meta.sha256 &&
        j.video?.sha256 === video?.meta.sha256 &&
        j.orderRef === orderRef &&
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
      ...(photos ? { photos: photos.meta } : {}),
      ...(video ? { video: video.meta } : {}),
      ...(orderRef ? { orderRef } : {}),
      ...(redacted ? { redacted } : {}),
      requestedBy: user.username,
      status: 'queued',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [{ id: 's1', agent, label: prompt.length > 120 ? `${prompt.slice(0, 117)}…` : prompt, system: null, status: 'queued' }],
      thread: [{ role: 'user', text: prompt, at: new Date().toISOString() }],
    };
    this.rememberKey(user, key, job);
    this.users.set(job.id, user);
    if (image) this.images.set(job.id, { mimeType: image.meta.mimeType, data: image.data });
    if (video) this.frames.set(job.id, { durationSec: video.meta.durationSec, frames: video.frames });
    if (photos) this.photos.set(job.id, photos.list);
    this.enqueue(job);
    return { job, deduplicated: false };
  }

  /** Who submitted each pending AI task (its permissions decide which data tools the AI gets). */
  private users = new Map<string, SessionUser>();
  /** Photos for pending AI tasks, in memory only; removed as soon as the task ends. */
  private images = new Map<string, { mimeType: string; data: string }>();
  /** Still frames of a video sent with a pending task, in memory only; removed when the task ends. */
  private frames = new Map<string, { durationSec: number; frames: { mimeType: string; data: string }[] }>();
  /** Several photos sent with a pending task (Kat), in memory only; removed when the task ends. */
  private photos = new Map<string, { mimeType: string; data: string }[]>();

  /**
   * A follow-up message on an AI task (an answer to the agent's question, or a further request):
   * the same task runs again with the conversation so far. Not while it is still running.
   */
  followUp(user: SessionUser, id: string, rawText: string, key?: string): { job: Job; deduplicated: boolean } {
    const job = this.get(id, user);
    if (!job) throw new SubmitError(404, 'Task not found.');
    if (job.type !== 'ai.task' || !job.agent) throw new SubmitError(400, 'Only assigned tasks take follow-up messages. Run the report again instead.');
    if (!this.deps.ai) throw new SubmitError(503, 'AI tasks are not set up on the server (GEMINI_API_KEY is missing).');
    const again = this.fromKey(user, key);
    if (again) return { job: again, deduplicated: true };
    const { text: cleaned, count: redacted } = redactContacts(typeof rawText === 'string' ? rawText : '');
    const text = cleaned.replace(/\s+/g, ' ').trim();
    if (!text) throw new SubmitError(400, 'Type a message first.');
    const maxChars = ORDER_AGENTS.includes(job.agent) ? MAX_CS_PROMPT_CHARS : MAX_PROMPT_CHARS;
    if (text.length > maxChars) throw new SubmitError(400, `Keep the message under ${maxChars} characters.`);
    const last = [...(job.thread ?? [])].reverse().find((t) => t.role === 'user');
    if (job.status === 'queued' || job.status === 'working') {
      if (last?.text === text) return { job, deduplicated: true };
      throw new SubmitError(409, `${AGENT_PROFILES[job.agent].name} is still working on this task. Wait for the answer, or cancel it first.`);
    }
    if (job.status === 'cancelled') throw new SubmitError(409, 'This task was cancelled. Assign it again as a new task.');
    const followUps = (job.thread ?? []).filter((t) => t.role === 'user').length - 1;
    if (followUps >= MAX_FOLLOW_UPS) throw new SubmitError(409, `This task already has ${MAX_FOLLOW_UPS} follow-ups. Start a new task to continue.`);
    this.rateLimit(user);
    const at = new Date().toISOString();
    job.thread = [...(job.thread ?? [{ role: 'user', text: job.prompt ?? '', at: job.createdAt }]), { role: 'user', text, at }];
    job.status = 'queued';
    job.updatedAt = at;
    job.finishedAt = undefined;
    job.error = undefined;
    job.reviewedBy = undefined;
    job.reviewedAt = undefined;
    if (redacted) job.redacted = (job.redacted ?? 0) + redacted;
    const step = job.steps[0];
    Object.assign(step, { status: 'queued', label: text.length > 120 ? `${text.slice(0, 117)}…` : text, result: undefined, error: undefined, startedAt: undefined, finishedAt: undefined });
    this.rememberKey(user, key, job);
    this.users.set(job.id, user);
    this.queue.push(job);
    this.audit(job, 'follow-up', { messageChars: text.length });
    this.emitJob(job);
    this.pump();
    return { job, deduplicated: false };
  }

  /** Stops a task: removed from the queue, or its AI requests aborted. Finished tasks stay as they are. */
  cancel(user: SessionUser, id: string): Job {
    const job = this.get(id, user);
    if (!job) throw new SubmitError(404, 'Task not found.');
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') throw new SubmitError(409, 'This task has already finished.');
    const at = new Date().toISOString();
    const qi = this.queue.indexOf(job);
    if (qi >= 0) this.queue.splice(qi, 1);
    this.ctrls.get(job.id)?.abort();
    for (const st of job.steps) if (st.status === 'queued' || st.status === 'working') Object.assign(st, { status: 'cancelled', finishedAt: at });
    const wasRunning = job.status === 'queued' || job.status === 'working';
    job.status = 'cancelled';
    job.cancelledBy = user.username;
    job.finishedAt = at;
    job.updatedAt = at;
    if (job.type === 'ai.task' && wasRunning) job.thread = [...(job.thread ?? []), { role: 'agent', text: `Cancelled by ${user.username}.`, at, outcome: 'cancelled' }];
    this.users.delete(job.id);
    this.images.delete(job.id);
    this.frames.delete(job.id);
    this.photos.delete(job.id);
    this.audit(job, 'cancelled');
    this.emitJob(job);
    return job;
  }

  /** A person checked the answer: ready for review (or a question nobody needs to answer) -> completed. */
  complete(user: SessionUser, id: string): Job {
    const job = this.get(id, user);
    if (!job) throw new SubmitError(404, 'Task not found.');
    if (job.status !== 'ready_for_review' && job.status !== 'needs_info') throw new SubmitError(409, 'Only an answer waiting for review can be marked complete.');
    const at = new Date().toISOString();
    job.status = 'completed';
    job.reviewedBy = user.username;
    job.reviewedAt = at;
    job.updatedAt = at;
    this.audit(job, 'reviewed');
    this.emitJob(job);
    return job;
  }

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
    job.updatedAt = new Date().toISOString();
    this.emit('job', structuredClone(job));
    this.scheduleSave();
  }

  private audit(job: Job, event: string, extra: Record<string, unknown> = {}) {
    // Task log: ids, type, user, status, timing and error codes only — no amounts, no customer data,
    // and for AI tasks only the agent and the prompt's length, never its text.
    const what =
      job.type === 'ai.task'
        ? {
            agent: job.agent,
            promptChars: job.prompt?.length ?? 0,
            ...(job.image ? { imageBytes: job.image.bytes, imageType: job.image.mimeType } : {}),
            ...(job.video ? { videoBytes: job.video.bytes, videoSeconds: job.video.durationSec, videoFrames: job.video.frames } : {}),
          }
        : { range: job.range };
    this.deps.log?.({ at: new Date().toISOString(), event, jobId: job.id, type: job.type, user: job.requestedBy, ...what, status: job.status, ...extra });
  }

  private async execute(job: Job) {
    if (job.status !== 'queued') return; // cancelled while waiting
    job.status = 'working';
    job.startedAt ??= new Date().toISOString();
    const ctrl = new AbortController();
    this.ctrls.set(job.id, ctrl);
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
          await this.runStep(job, job.steps[0], () => this.aiStep(job, ctrl.signal));
          break;
      }
    } catch (e) {
      if ((job.status as Job['status']) !== 'cancelled') {
        job.status = 'failed';
        job.error = toLiveError(e);
      }
    }
    this.ctrls.delete(job.id);
    // Cancelled meanwhile: cancel() already recorded everything; a late result is dropped.
    if ((job.status as Job['status']) === 'cancelled') return;
    const failed = job.steps.find((s) => s.status === 'failed');
    const at = new Date().toISOString();
    if (failed || job.status === 'failed') {
      job.status = 'failed';
      job.error ??= failed?.error;
    } else if (job.type === 'ai.task') {
      // An AI answer is checked by a person; a question from the agent waits for a reply.
      job.status = job.steps[0].result?.needsInfo ? 'needs_info' : 'ready_for_review';
    } else job.status = 'completed';
    if (job.type === 'ai.task') {
      const r = job.steps[0].result;
      const turn: TaskTurn =
        job.status === 'failed'
          ? { role: 'agent', text: job.error?.message ?? 'The task failed.', at, outcome: 'failed' }
          : { role: 'agent', text: r?.answer ?? '', at, outcome: job.status === 'needs_info' ? 'needs_info' : 'answered' };
      job.thread = [...(job.thread ?? [{ role: 'user', text: job.prompt ?? '', at: job.createdAt }]), turn];
    }
    job.finishedAt = at;
    this.users.delete(job.id);
    this.images.delete(job.id);
    this.frames.delete(job.id);
    this.photos.delete(job.id);
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
      if (this.isCancelled(job)) throw new IntegrationError('TIMEOUT', 'Cancelled.');
      const problem = validateStepResult(result);
      if (problem) throw new IntegrationError('INVALID_RESPONSE', `The result failed validation: ${problem}`, step.system ?? undefined);
      step.result = result;
      step.status = 'completed';
      return result;
    } catch (e) {
      if (this.isCancelled(job)) {
        step.status = 'cancelled';
        step.result = undefined;
        return null;
      }
      step.status = 'failed';
      step.error = toLiveError(e, step.system ?? undefined);
      return null;
    } finally {
      step.finishedAt = new Date().toISOString();
      this.emitJob(job);
    }
  }

  private isCancelled(job: Job) {
    return job.status === 'cancelled';
  }

  // ---------------------------------------------------------------- steps
  private async aiStep(job: Job, signal: AbortSignal): Promise<StepResult> {
    const ai = this.deps.ai;
    const user = this.users.get(job.id);
    if (!ai || !user || !job.agent || !job.prompt) throw new IntegrationError('NOT_CONFIGURED', 'AI tasks are not set up on the server.');
    // The latest message is the request; earlier answered messages are the conversation so far.
    const thread = job.thread ?? [{ role: 'user' as const, text: job.prompt, at: job.createdAt }];
    const current = [...thread].reverse().find((t) => t.role === 'user')?.text ?? job.prompt;
    const history = thread.slice(0, thread.lastIndexOf(thread.filter((t) => t.role === 'user').at(-1)!)).filter((t) => t.role === 'user' || t.outcome === 'answered' || t.outcome === 'needs_info');
    const followUp = history.length > 0;
    const out = await runAiTask(
      { ...ai, finance: this.deps.finance, orders: this.deps.orders, now: this.deps.now },
      user,
      job.agent,
      followUp && (job.image || job.video || job.photos)
        ? `${current}\n(${job.photos ? `${job.photos.count} photos` : job.video ? 'A video' : 'A photo'} came with the first message; ${job.photos ? 'they are' : 'it is'} no longer available, so use what you said about ${job.photos ? 'them' : 'it'} before.)`
        : current,
      followUp ? undefined : this.images.get(job.id),
      job.orderRef,
      { signal, history, video: followUp ? undefined : this.frames.get(job.id), photos: followUp ? undefined : this.photos.get(job.id) },
    );
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
      employees: out.employees,
      dataLookups: out.dataLookups,
      needsInfo: out.needsInfo,
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
export function checkImage(agent: LiveAgentId, img: { mimeType: string; data: string }) {
  if (!IMAGE_AGENTS.includes(agent)) throw new SubmitError(400, `${AGENT_PROFILES[agent].name} does not take photos.`);
  return checkImageData(img);
}

/**
 * Checks a video sent with an AI task. Only its still frames come to the server (JPEGs the
 * browser took from the video, each checked like a photo); the type, size and length describe the
 * video that stays in the browser until a person posts it.
 */
export function checkVideo(agent: LiveAgentId, raw: unknown) {
  if (!VIDEO_AGENTS.includes(agent)) throw new SubmitError(400, `${AGENT_PROFILES[agent].name} does not take videos.`);
  const v = raw as { mimeType?: unknown; bytes?: unknown; durationSec?: unknown; frames?: unknown };
  if (!v || typeof v !== 'object') throw new SubmitError(400, 'The video could not be read.');
  if (typeof v.mimeType !== 'string' || !(VIDEO_TYPES as readonly string[]).includes(v.mimeType)) throw new SubmitError(400, 'Use an MP4 or MOV video.');
  const bytes = Number(v.bytes);
  if (!Number.isInteger(bytes) || bytes <= 0) throw new SubmitError(400, 'The video could not be read.');
  if (bytes > FB_VIDEO_MAX_BYTES) throw new SubmitError(413, `The video is too large (max ${Math.round(FB_VIDEO_MAX_BYTES / 1024 / 1024)} MB).`);
  const durationSec = Number(v.durationSec);
  if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > 4 * 3600) throw new SubmitError(400, 'The video length could not be read.');
  if (!Array.isArray(v.frames) || v.frames.length < 1 || v.frames.length > MAX_VIDEO_FRAMES) throw new SubmitError(400, `Send 1 to ${MAX_VIDEO_FRAMES} frames of the video.`);
  const hash = createHash('sha256');
  const frames = (v.frames as unknown[]).map((f) => {
    const x = f as { mimeType?: unknown; data?: unknown };
    if (!x || typeof x !== 'object' || x.mimeType !== 'image/jpeg' || typeof x.data !== 'string') throw new SubmitError(400, 'A video frame could not be read.');
    const checked = checkImageData({ mimeType: 'image/jpeg', data: x.data });
    if (checked.meta.bytes > MAX_FRAME_BYTES) throw new SubmitError(413, 'A video frame is too large.');
    hash.update(checked.meta.sha256);
    return { mimeType: 'image/jpeg', data: checked.data };
  });
  return {
    frames,
    meta: { mimeType: v.mimeType, bytes, durationSec: Math.round(durationSec * 10) / 10, frames: frames.length, sha256: hash.digest('hex').slice(0, 16) },
  };
}

/**
 * Checks several photos sent with one task (Kat: one catalog entry each): 2 to CATALOG_MAX_BATCH
 * photos, each a real JPEG/PNG/WebP of at most CATALOG_AI_PHOTO_MAX_BYTES (the browser sends
 * smaller copies for the AI; the full-size photos go to the catalog only when a person approves).
 */
export function checkPhotos(agent: LiveAgentId, raw: unknown) {
  if (!(MULTI_PHOTO_AGENTS as readonly string[]).includes(agent)) throw new SubmitError(400, `${AGENT_PROFILES[agent].name} takes one photo at a time.`);
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > CATALOG_MAX_BATCH) throw new SubmitError(400, `Send 2 to ${CATALOG_MAX_BATCH} photos.`);
  const hash = createHash('sha256');
  let bytes = 0;
  const list = raw.map((x) => {
    const p = x as { mimeType?: unknown; data?: unknown };
    if (!p || typeof p !== 'object' || typeof p.mimeType !== 'string' || typeof p.data !== 'string') throw new SubmitError(400, 'A photo could not be read.');
    const checked = checkImageData({ mimeType: p.mimeType, data: p.data });
    if (checked.meta.bytes > CATALOG_AI_PHOTO_MAX_BYTES) throw new SubmitError(413, 'A photo is too large; the office sends smaller copies, so reload the page and try again.');
    bytes += checked.meta.bytes;
    hash.update(checked.meta.sha256);
    return { mimeType: checked.meta.mimeType, data: checked.data };
  });
  return { list, meta: { count: list.length, bytes, sha256: hash.digest('hex').slice(0, 16) } };
}

/** Checks a base64 image: allowed type, size, and that its bytes really are that type. */
export function checkImageData(img: { mimeType: string; data: string }) {
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
