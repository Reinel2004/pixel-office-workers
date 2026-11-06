// Browser side of Connected Mode. Talks only to our own server (same origin, /api/...), which
// holds all credentials. Live results are kept in memory here and never written to
// localStorage, and they are never mixed with the demo engine's mock tasks.

import type { AiStatus, DateRange, Job, JobStep, JobTypeInfo, LiveAgentId, ReportType, SessionUser, SystemStatus } from '../../shared/live';
import { LIVE_AGENT_IDS, SYSTEM_NAMES } from '../../shared/live';
import { presetRange, type RangePreset } from '../../shared/manila';
import type { Engine } from '../sim/engine';

export type ServerState = 'unknown' | 'checking' | 'unreachable' | 'signed_out' | 'signed_in';
export type StreamState = 'idle' | 'connecting' | 'open' | 'reconnecting';

export interface LiveLogEntry {
  id: number;
  at: number;
  text: string;
  kind: 'info' | 'success' | 'warn' | 'error';
  agent?: LiveAgentId;
  jobId?: string;
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: 'same-origin',
      ...init,
      headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}), 'X-WAD-Request': '1', ...init.headers },
    });
  } catch {
    throw new HttpError(0, 'The Connected Mode server could not be reached.');
  }
  const type = res.headers.get('content-type') ?? '';
  const body = type.includes('application/json') ? await res.json().catch(() => ({})) : null;
  if (!res.ok || body === null) throw new HttpError(body === null ? 0 : res.status, (body as { error?: string } | null)?.error ?? 'The Connected Mode server is not available here.');
  return body as T;
}

export class LiveStore {
  server: ServerState = 'unknown';
  stream: StreamState = 'idle';
  user: SessionUser | null = null;
  systems: SystemStatus[] = [];
  types: JobTypeInfo[] = [];
  /** Whether the server can run free-text AI tasks. */
  ai: AiStatus | null = null;
  maxRangeDays = 366;
  jobs: Job[] = [];
  log: LiveLogEntry[] = [];
  preset: RangePreset | 'custom' = 'thisMonth';
  range: DateRange = presetRange('thisMonth');
  submitting = new Set<string>();
  lastError: string | null = null;

  private listeners = new Set<() => void>();
  private version = 0;
  private es: EventSource | null = null;
  private logId = 1;
  private seenStep = new Map<string, string>();

  constructor(private engine: Engine) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getVersion = () => this.version;
  private emit() {
    this.version++;
    this.listeners.forEach((l) => l());
  }

  private addLog(text: string, kind: LiveLogEntry['kind'], agent?: LiveAgentId, jobId?: string) {
    this.log.unshift({ id: this.logId++, at: Date.now(), text, kind, agent, jobId });
    if (this.log.length > 150) this.log.length = 150;
  }

  setPreset(p: RangePreset | 'custom') {
    this.preset = p;
    if (p !== 'custom') this.range = presetRange(p);
    this.emit();
  }
  setRange(r: DateRange) {
    this.preset = 'custom';
    this.range = r;
    this.emit();
  }

  /** Checks for a server and an existing session. */
  async init() {
    if (this.server === 'checking') return;
    this.server = 'checking';
    this.emit();
    try {
      await api('/api/health');
    } catch {
      this.server = 'unreachable';
      this.emit();
      return;
    }
    try {
      const { user } = await api<{ user: SessionUser }>('/api/auth/me');
      await this.afterSignIn(user);
    } catch (e) {
      this.server = e instanceof HttpError && e.status === 401 ? 'signed_out' : 'unreachable';
      this.emit();
    }
  }

  async login(username: string, password: string): Promise<string | null> {
    try {
      const { user } = await api<{ user: SessionUser }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
      await this.afterSignIn(user);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }

  async logout() {
    await api('/api/auth/logout', { method: 'POST', body: '{}' }).catch(() => undefined);
    this.signedOut('You signed out.');
  }

  private signedOut(note: string) {
    this.es?.close();
    this.es = null;
    this.stream = 'idle';
    this.user = null;
    this.jobs = [];
    this.systems = [];
    this.server = 'signed_out';
    this.ai = null;
    for (const id of LIVE_AGENT_IDS) this.engine.setLiveAgent(id, null);
    this.addLog(note, 'info');
    this.emit();
  }

  private async afterSignIn(user: SessionUser) {
    this.user = user;
    this.server = 'signed_in';
    const [sys, types] = await Promise.all([
      api<{ systems: SystemStatus[] }>('/api/systems'),
      api<{ types: JobTypeInfo[]; maxRangeDays: number; ai?: AiStatus }>('/api/report-types'),
    ]);
    this.systems = sys.systems;
    this.types = types.types;
    this.maxRangeDays = types.maxRangeDays;
    this.ai = types.ai ?? null;
    this.addLog(`Signed in as ${user.username} (${user.role}).`, 'info');
    this.openStream();
    this.emit();
  }

  private openStream() {
    this.es?.close();
    this.stream = 'connecting';
    const es = new EventSource('/api/events');
    this.es = es;
    es.addEventListener('open', () => {
      this.stream = 'open';
      this.emit();
    });
    es.addEventListener('snapshot', (ev) => {
      const d = JSON.parse((ev as MessageEvent).data) as { systems: SystemStatus[]; ai?: AiStatus; jobs: Job[] };
      this.systems = d.systems;
      if (d.ai) this.ai = d.ai;
      for (const j of d.jobs) this.applyJob(j, true);
      this.emit();
    });
    es.addEventListener('job', (ev) => {
      this.applyJob(JSON.parse((ev as MessageEvent).data) as Job, false);
      this.emit();
    });
    es.addEventListener('session-expired', () => this.signedOut('Your session expired. Sign in again to continue.'));
    es.addEventListener('error', () => {
      // EventSource reconnects by itself; check whether the session is still valid.
      this.stream = 'reconnecting';
      this.emit();
      api('/api/auth/me').catch((e) => {
        if (e instanceof HttpError && e.status === 401) this.signedOut('Your session expired. Sign in again to continue.');
      });
    });
  }

  canSubmit(type: ReportType): { ok: boolean; reason?: string } {
    const info = this.types.find((t) => t.type === type);
    if (!info) return { ok: false, reason: 'Unknown report.' };
    if (!info.allowed) return { ok: false, reason: 'Your account does not have permission for this report.' };
    const key = this.key(type, this.range);
    if (this.submitting.has(key)) return { ok: false, reason: 'Already submitting.' };
    if (this.jobs.some((j) => j.type === type && j.range.from === this.range.from && j.range.to === this.range.to && (j.status === 'queued' || j.status === 'working')))
      return { ok: false, reason: 'This report is already running for the same dates.' };
    return { ok: true };
  }

  private key(type: ReportType, r: DateRange) {
    return `${type}|${r.from}|${r.to}`;
  }

  async submit(type: ReportType, range: DateRange = this.range): Promise<Job | null> {
    const key = this.key(type, range);
    if (this.submitting.has(key)) return null;
    this.submitting.add(key);
    this.lastError = null;
    this.emit();
    try {
      const { job } = await api<{ job: Job; deduplicated: boolean }>('/api/jobs', { method: 'POST', body: JSON.stringify({ type, ...range }) });
      this.applyJob(job, false);
      return job;
    } catch (e) {
      this.lastError = (e as Error).message;
      if (e instanceof HttpError && e.status === 401) this.signedOut('Your session expired. Sign in again to continue.');
      else this.addLog(`Could not start the report: ${this.lastError}`, 'error');
      return null;
    } finally {
      this.submitting.delete(key);
      this.emit();
    }
  }

  canAssign(): { ok: boolean; reason?: string } {
    if (this.server !== 'signed_in') return { ok: false, reason: 'Sign in first.' };
    if (!this.ai?.ready) return { ok: false, reason: 'AI tasks are not set up on the server (add GEMINI_API_KEY to .env and restart it).' };
    return { ok: true };
  }

  /** Assigns a free-text task to one agent. The server runs it with the AI and read-only data tools. */
  async submitAi(agent: LiveAgentId, prompt: string): Promise<Job | null> {
    const key = `ai|${agent}|${prompt}`;
    if (this.submitting.has(key)) return null;
    this.submitting.add(key);
    this.lastError = null;
    this.emit();
    try {
      const { job } = await api<{ job: Job; deduplicated: boolean }>('/api/ai/tasks', { method: 'POST', body: JSON.stringify({ agent, prompt }) });
      this.applyJob(job, false);
      return job;
    } catch (e) {
      this.lastError = (e as Error).message;
      if (e instanceof HttpError && e.status === 401) this.signedOut('Your session expired. Sign in again to continue.');
      else this.addLog(`Could not assign the task: ${this.lastError}`, 'error', agent);
      return null;
    } finally {
      this.submitting.delete(key);
      this.emit();
    }
  }

  /** Merge a server job snapshot and drive the office agents from its step statuses. */
  private applyJob(job: Job, fromSnapshot: boolean) {
    const i = this.jobs.findIndex((j) => j.id === job.id);
    if (i >= 0 && this.jobs[i].rev >= job.rev) return; // stale snapshot (e.g. a late HTTP response)
    if (i >= 0) this.jobs[i] = job;
    else this.jobs.unshift(job);
    this.jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (this.jobs.length > 100) this.jobs.length = 100;

    for (const step of job.steps) {
      const k = `${job.id}/${step.id}`;
      if (this.seenStep.get(k) === step.status) continue;
      const first = !this.seenStep.has(k);
      this.seenStep.set(k, step.status);
      if (fromSnapshot && (step.status === 'completed' || step.status === 'failed') && first) continue; // history, not news
      this.onStep(job, step);
    }
    const jk = `${job.id}/job`;
    if (this.seenStep.get(jk) !== job.status) {
      const first = !this.seenStep.has(jk);
      this.seenStep.set(jk, job.status);
      if (!(fromSnapshot && first)) {
        const what = job.type === 'ai.task' ? 'Task' : 'Report';
        const who = job.steps.at(-1)?.agent;
        if (job.status === 'queued')
          this.addLog(job.type === 'ai.task' ? `Task assigned — ${job.title}` : `Report queued: ${job.title} (${job.range.from} to ${job.range.to}).`, 'info', who, job.id);
        if (job.status === 'completed') this.addLog(`${what} completed: ${job.title}.`, 'success', who, job.id);
        if (job.status === 'failed') this.addLog(`${what} failed: ${job.title} — ${job.error?.message ?? 'see details.'}`, 'error', who, job.id);
      }
    }
  }

  private onStep(job: Job, step: JobStep) {
    const e = this.engine;
    const who = step.agent;
    switch (step.status) {
      case 'queued':
        e.setLiveAgent(who, { state: 'queued', activity: `Queued: ${step.label}`, jobId: job.id });
        break;
      case 'working':
        e.setLiveAgent(who, { state: 'working', activity: step.label, jobId: job.id });
        if (who === 'chief') e.stageAgent(who, 'meeting', 1);
        else e.stageAgent(who, 'seat');
        if (step.system) e.liveSay(who, `Checking ${SYSTEM_NAMES[step.system]}`);
        else if (job.type === 'ai.task') e.liveSay(who, 'On it…');
        break;
      case 'completed':
        e.setLiveAgent(who, { state: 'completed', activity: step.result?.summary ?? 'Done', jobId: job.id });
        e.liveSay(who, job.type === 'ai.task' ? 'Done — see my answer' : step.result?.empty ? 'No records found' : 'Results ready');
        if (who === 'chief') e.stageAgent(who, 'seat');
        this.addLog(`${step.label}: ${step.result?.summary ?? 'done'}`, step.result?.empty ? 'warn' : 'success', who, job.id);
        break;
      case 'failed':
        e.setLiveAgent(who, { state: 'failed', activity: step.error?.message ?? 'Failed', jobId: job.id });
        e.liveSay(who, step.error?.code === 'AWAITING_DOCUMENTATION' || step.error?.code === 'NOT_CONFIGURED' ? 'Not set up yet' : 'Request failed');
        if (who === 'chief') e.stageAgent(who, 'seat');
        this.addLog(`${step.label}: ${step.error?.message ?? 'failed'}`, 'error', who, job.id);
        break;
    }
  }

  latestStepFor(agent: LiveAgentId): { job: Job; step: JobStep } | null {
    for (const job of this.jobs) {
      const step = job.steps.find((s) => s.agent === agent);
      if (step) return { job, step };
    }
    return null;
  }

  dismissAgentError(agent: LiveAgentId) {
    this.engine.setLiveAgent(agent, null);
    this.emit();
  }
}
