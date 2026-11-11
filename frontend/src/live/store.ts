// Browser side of Connected Mode. Talks only to our own server (same origin, /api/...), which
// holds all credentials. Live results are kept in memory here and never written to
// localStorage, and they are never mixed with the demo engine's mock tasks.

import type { AiLimits, AiUsageReport, AttentionItem, AttentionReport, Discussion, DiscussionInput, FacebookStatus, InspectionChecklist, OrderPick, ScheduledPost, ShopCounts, UiReview, UiReviewInput, UiVerifyInput } from '../../shared/live';
import { DISCUSSION_ACTIVE, UI_REVIEW_RUNNING } from '../../shared/live';
import type { AiStatus, DateRange, Job, JobStep, JobTypeInfo, LiveAgentId, ReportType, SessionUser, SystemStatus } from '../../shared/live';
import { LIVE_AGENT_IDS, SYSTEM_NAMES } from '../../shared/live';
import { AGENT_BY_ID } from '../agents/roster';
import { SPOTS } from '../office/layout';
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

/** A one-time key for a submission, so a resent request is not run twice. */
function newKey() {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
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

  constructor(private engine: Engine) {
    engine.shopRefresh = () => void this.loadWorkshop(true);
  }

  // ---------------------------------------------------------------- team discussions
  /** This user's discussions from the server (Connected Mode only; demo ones live in the engine). */
  discussions: Discussion[] = [];
  discussionsLoaded = false;
  discussionError: string | null = null;
  private startingDiscussion = false;
  /** The discussion currently shown at the Command Center table, and what each agent last said. */
  private officeMeeting: string | null = null;
  private officeSaid = new Map<string, string>();

  get discussionStarting() {
    return this.startingDiscussion;
  }

  async loadDiscussions() {
    try {
      const { discussions } = await api<{ discussions: Discussion[] }>('/api/discussions');
      this.discussions = discussions;
      this.discussionsLoaded = true;
      this.discussionError = null;
      // After a reload: a discussion still running on the server gathers the agents again.
      const active = discussions.find((d) => DISCUSSION_ACTIVE.includes(d.status));
      if (active) this.syncOffice(active);
    } catch (e) {
      this.discussionsLoaded = true;
      this.discussionError = `Could not load discussions: ${(e as Error).message}`;
    }
    this.emit();
  }

  /** Starts a discussion on the server. One request at a time; the key makes a resend harmless. */
  async startDiscussion(input: DiscussionInput): Promise<Discussion | null> {
    if (this.startingDiscussion) return null;
    this.startingDiscussion = true;
    this.discussionError = null;
    this.emit();
    try {
      const { discussion } = await api<{ discussion: Discussion }>('/api/discussions', { method: 'POST', body: JSON.stringify(input) });
      this.upsertDiscussion(discussion);
      this.addLog(`Team discussion started: ${discussion.topic}`, 'info', 'chief');
      return discussion;
    } catch (e) {
      this.discussionError = (e as Error).message;
      if (e instanceof HttpError && e.status === 401) this.signedOut('Your session expired. Sign in again to continue.');
      return null;
    } finally {
      this.startingDiscussion = false;
      this.emit();
    }
  }

  async cancelDiscussion(id: string) {
    try {
      const { discussion } = await api<{ discussion: Discussion }>(`/api/discussions/${id}/cancel`, { method: 'POST', body: '{}' });
      this.upsertDiscussion(discussion);
    } catch (e) {
      this.discussionError = `Could not cancel: ${(e as Error).message}`;
      this.emit();
    }
  }

  private upsertDiscussion(d: Discussion) {
    const i = this.discussions.findIndex((x) => x.id === d.id);
    const prev = i >= 0 ? this.discussions[i] : null;
    if (prev && prev.updatedAt > d.updatedAt) return; // stale (a late HTTP response)
    if (i >= 0) this.discussions[i] = d;
    else this.discussions.unshift(d);
    this.discussions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (prev && DISCUSSION_ACTIVE.includes(prev.status) && !DISCUSSION_ACTIVE.includes(d.status))
      this.addLog(
        d.status === 'completed' ? `Team discussion finished${d.partial ? ' (some contributions missing)' : ''}: ${d.topic}` : d.status === 'cancelled' ? 'Team discussion cancelled.' : `Team discussion failed: ${d.error ?? ''}`,
        d.status === 'completed' ? 'success' : d.status === 'cancelled' ? 'warn' : 'error',
        'chief',
      );
    if (prev && DISCUSSION_ACTIVE.includes(prev.status) && !DISCUSSION_ACTIVE.includes(d.status)) this.refreshAttentionSoon();
    this.syncOffice(d);
    this.emit();
  }

  /** Moves the participants to the Command Center table and shows short statuses from the real state. */
  private syncOffice(d: Discussion) {
    const e = this.engine;
    if (!e.connected) return;
    if (!DISCUSSION_ACTIVE.includes(d.status)) {
      if (this.officeMeeting === d.id) {
        e.endMeeting(d.id);
        this.officeMeeting = null;
      }
      return;
    }
    if (this.officeMeeting !== d.id || e.meeting?.id !== d.id) {
      e.startMeeting(d.id, ['chief', ...d.participants]);
      this.officeMeeting = d.id;
      this.officeSaid.clear();
    }
    const label = (agent: LiveAgentId) => {
      if (d.status === 'queued') return 'Waiting for the discussion to start';
      if (d.status === 'gathering') return 'Reviewing data';
      const m = d.messages.find((x) => x.agent === agent && x.status === 'working');
      if (m) return m.round === 'proposal' ? 'Proposing' : m.round === 'review' ? 'Reviewing ideas' : 'Writing the summary';
      return agent === 'chief' ? 'Moderating' : 'Listening';
    };
    for (const a of ['chief', ...d.participants] as LiveAgentId[]) {
      const text = label(a);
      const key = `${d.id}|${a}`;
      const changed = this.officeSaid.get(key) !== text;
      this.officeSaid.set(key, text);
      // A short bubble only when that agent starts something new.
      e.meetingStatus(d.id, a, text, changed && text !== 'Listening' && text !== 'Moderating' ? text : undefined);
    }
  }

  // ---------------------------------------------------------------- UI Review (Aya, Kim, Rey)
  /** This user's UI Reviews from the server (Connected Mode only; demo ones live in the engine). */
  uiReviews: UiReview[] = [];
  uiReviewsLoaded = false;
  uiReviewError: string | null = null;
  uiReviewBusy = false;
  /** Screenshots shown in this browser only (data URLs), per review: never stored. */
  uiShots = new Map<string, { before: string[]; after: string[][] }>();
  private officeHuddle: string | null = null;

  canUiReview(): { ok: boolean; reason?: string } {
    if (this.server !== 'signed_in' || !this.user) return { ok: false, reason: 'Sign in first.' };
    if (!this.user.permissions.includes('ui:review')) return { ok: false, reason: 'Your account cannot use UI Review (admin and manager accounts can).' };
    if (!this.ai?.ready) return { ok: false, reason: 'AI is not set up on the server (GEMINI_API_KEY).' };
    return { ok: true };
  }

  async loadUiReviews() {
    if (!this.user?.permissions.includes('ui:review')) {
      this.uiReviewsLoaded = true;
      return this.emit();
    }
    try {
      const { reviews } = await api<{ reviews: UiReview[] }>('/api/ui-reviews');
      this.uiReviews = reviews;
      this.uiReviewError = null;
      const active = reviews.find((r) => UI_REVIEW_RUNNING.includes(r.status));
      if (active) this.syncHuddle(active);
    } catch (e) {
      this.uiReviewError = `Could not load UI Reviews: ${(e as Error).message}`;
    }
    this.uiReviewsLoaded = true;
    this.emit();
  }

  private async uiCall(path: string, body: unknown): Promise<UiReview | null> {
    if (this.uiReviewBusy) return null;
    this.uiReviewBusy = true;
    this.uiReviewError = null;
    this.emit();
    try {
      const { review } = await api<{ review: UiReview }>(path, { method: 'POST', body: JSON.stringify(body) });
      this.upsertUiReview(review);
      return review;
    } catch (e) {
      this.uiReviewError = (e as Error).message;
      if (e instanceof HttpError && e.status === 401) this.signedOut('Your session expired. Sign in again to continue.');
      return null;
    } finally {
      this.uiReviewBusy = false;
      this.emit();
    }
  }

  async startUiReview(input: UiReviewInput): Promise<UiReview | null> {
    const r = await this.uiCall('/api/ui-reviews', input);
    if (r) {
      this.uiShots.set(r.id, { before: input.shots.map((x) => x.data), after: [] });
      this.addLog(`UI Review started: ${r.page}`, 'info', 'aya');
    }
    return r;
  }

  acceptUiChanges(id: string, changes: string[]) {
    return this.uiCall(`/api/ui-reviews/${id}/accept`, { changes });
  }

  async verifyUiReview(id: string, input: UiVerifyInput): Promise<UiReview | null> {
    const r = await this.uiCall(`/api/ui-reviews/${id}/verify`, input);
    if (r) {
      const shots = this.uiShots.get(id) ?? { before: [], after: [] };
      shots.after[r.verifications.length - 1] = input.shots.map((x) => x.data);
      this.uiShots.set(id, shots);
      this.addLog(`Kim is re-checking: ${r.page}`, 'info', 'kim');
    }
    return r;
  }

  cancelUiReview(id: string) {
    return this.uiCall(`/api/ui-reviews/${id}/cancel`, {});
  }

  private upsertUiReview(r: UiReview) {
    const i = this.uiReviews.findIndex((x) => x.id === r.id);
    const prev = i >= 0 ? this.uiReviews[i] : null;
    if (prev && prev.updatedAt > r.updatedAt) return; // stale (a late HTTP response)
    if (i >= 0) this.uiReviews[i] = r;
    else this.uiReviews.unshift(r);
    this.uiReviews.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const was = prev ? UI_REVIEW_RUNNING.includes(prev.status) : false;
    if (was && !UI_REVIEW_RUNNING.includes(r.status)) {
      if (r.status === 'proposed' && prev?.status !== 'verifying') this.addLog(`UI Review plan ready: ${r.page}. Open it to choose changes.`, 'success', 'rey');
      else if (r.status === 'verified') this.addLog(`Kim's re-check: ${r.verifications[r.verifications.length - 1]?.verdict === 'ready' ? 'ready to release' : 'needs fixes'} (${r.page})`, 'success', 'kim');
      else if (r.status === 'failed' || r.error) this.addLog(`UI Review problem: ${r.error ?? 'failed'}`, 'error', 'aya');
      else if (r.status === 'cancelled') this.addLog('UI Review cancelled.', 'warn', 'aya');
    }
    if (was && !UI_REVIEW_RUNNING.includes(r.status)) this.refreshAttentionSoon();
    this.syncHuddle(r);
    this.emit();
  }

  /** Aya, Kim and Rey gather at the Development Studio whiteboard while a step runs. */
  private syncHuddle(r: UiReview) {
    const e = this.engine;
    if (!e.connected) return;
    if (!UI_REVIEW_RUNNING.includes(r.status)) {
      if (this.officeHuddle === r.id) {
        e.endMeeting(r.id);
        this.officeHuddle = null;
      }
      return;
    }
    const team: LiveAgentId[] = r.status === 'verifying' ? ['kim'] : ['aya', 'kim', 'rey'];
    if (this.officeHuddle !== r.id || !e.hasMeeting(r.id)) {
      if (this.officeHuddle && this.officeHuddle !== r.id) e.endMeeting(this.officeHuddle);
      e.startMeeting(r.id, team, 'devboard');
      this.officeHuddle = r.id;
    }
    const steps = r.status === 'verifying' ? [r.verifications[r.verifications.length - 1]?.step].filter(Boolean) : r.steps;
    for (const a of team) {
      const st = steps.find((x) => x!.agent === a && x!.status === 'working');
      const label = r.status === 'queued' ? 'Waiting for the review to start' : st ? (st.kind === 'design' ? 'Reviewing the design' : st.kind === 'usability' ? 'Testing the workflow' : st.kind === 'plan' ? 'Writing the change plan' : 'Comparing before and after') : 'Listening';
      const key = `${r.id}|${a}`;
      const changed = this.officeSaid.get(key) !== label;
      this.officeSaid.set(key, label);
      e.meetingStatus(r.id, a, label, changed && label !== 'Listening' ? label : undefined);
    }
  }

  // ---------------------------------------------------------------- Attention needed
  /** Failed connections, blocked work, AI limits and overdue orders for this account (from the server). */
  attention: AttentionReport | null = null;
  attentionError: string | null = null;
  attentionLoading = false;
  /** Items this browser dismissed: id -> the version dismissed (a changed item comes back). */
  private dismissed: Record<string, string> = {};
  private attentionAt = 0;
  private attentionTimer: ReturnType<typeof setInterval> | null = null;
  private attentionSoon: ReturnType<typeof setTimeout> | null = null;
  /** Asks the live feed to open a tab (e.g. Systems from an Attention link). */
  feedTabRequest: { tab: 'systems'; n: number } | null = null;

  private dismissedKey() {
    return `wad-ai-office:attention-dismissed:v1:${this.user?.username ?? ''}`;
  }
  private loadDismissed() {
    try {
      const v = JSON.parse(window.localStorage.getItem(this.dismissedKey()) ?? '{}') as unknown;
      this.dismissed = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {};
    } catch {
      this.dismissed = {};
    }
  }
  private saveDismissed() {
    try {
      window.localStorage.setItem(this.dismissedKey(), JSON.stringify(this.dismissed));
    } catch {
      /* private window or storage off: dismissals last until reload */
    }
  }

  /** Items still to look at (not dismissed, or changed since). */
  get attentionItems(): AttentionItem[] {
    return (this.attention?.items ?? []).filter((i) => this.dismissed[i.id] !== i.version);
  }
  get attentionDismissedCount() {
    return (this.attention?.items.length ?? 0) - this.attentionItems.length;
  }

  async loadAttention(force = false) {
    if (this.server !== 'signed_in' || this.attentionLoading) return;
    if (!force && Date.now() - this.attentionAt < 10_000) return;
    this.attentionLoading = true;
    this.emit();
    try {
      this.attention = (await api<{ attention: AttentionReport }>('/api/attention')).attention;
      this.attentionAt = Date.now();
      this.attentionError = null;
      // Forget dismissals of things that are gone, so the list in storage stays small.
      const ids = new Set(this.attention.items.map((i) => i.id));
      for (const id of Object.keys(this.dismissed)) if (!ids.has(id)) delete this.dismissed[id];
      this.saveDismissed();
    } catch (e) {
      this.attentionError = `Could not check for problems: ${(e as Error).message}`;
      if (e instanceof HttpError && e.status === 401) this.signedOut('Your session expired. Sign in again to continue.');
    } finally {
      this.attentionLoading = false;
      this.emit();
    }
  }

  /** Re-checks shortly after something finished or failed (several events = one request). */
  private refreshAttentionSoon() {
    if (this.server !== 'signed_in' || this.attentionSoon) return;
    this.attentionSoon = setTimeout(() => {
      this.attentionSoon = null;
      void this.loadAttention(true);
    }, 2000);
  }

  dismissAttention(item: AttentionItem) {
    this.dismissed[item.id] = item.version;
    this.saveDismissed();
    this.emit();
  }
  restoreAttention() {
    this.dismissed = {};
    this.saveDismissed();
    this.emit();
  }
  showFeedTab(tab: 'systems') {
    this.feedTabRequest = { tab, n: (this.feedTabRequest?.n ?? 0) + 1 };
    this.emit();
  }

  // ---------------------------------------------------------------- AI usage tracker
  /** Requests, tokens and limits from the server (admin and manager accounts). */
  aiUsage: AiUsageReport | null = null;
  aiUsageError: string | null = null;
  aiUsageSaving = false;
  private loadingUsage = false;

  canSeeAiUsage() {
    return this.server === 'signed_in' && !!this.user?.permissions.includes('ai:usage');
  }

  async loadAiUsage() {
    if (!this.canSeeAiUsage() || this.loadingUsage) return;
    this.loadingUsage = true;
    try {
      this.aiUsage = (await api<{ usage: AiUsageReport }>('/api/ai/usage')).usage;
      this.aiUsageError = null;
    } catch (e) {
      this.aiUsageError = `Could not load AI usage: ${(e as Error).message}`;
      if (e instanceof HttpError && e.status === 401) this.signedOut('Your session expired. Sign in again to continue.');
    } finally {
      this.loadingUsage = false;
      this.emit();
    }
  }

  /** Saves new limits (admin only); null = back to the server's defaults. Returns an error message or null. */
  async saveAiLimits(limits: AiLimits | null): Promise<string | null> {
    if (this.aiUsageSaving) return 'Already saving.';
    this.aiUsageSaving = true;
    this.emit();
    try {
      const { usage } = await api<{ usage: AiUsageReport }>('/api/ai/usage/limits', { method: 'POST', body: JSON.stringify(limits ? { limits } : { reset: true }) });
      this.aiUsage = usage;
      this.addLog(limits ? 'AI usage limits changed.' : 'AI usage limits reset to the server defaults.', 'info', 'sam');
      this.refreshAttentionSoon();
      return null;
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) this.signedOut('Your session expired. Sign in again to continue.');
      return (e as Error).message;
    } finally {
      this.aiUsageSaving = false;
      this.emit();
    }
  }

  // ---------------------------------------------------------------- Tess (inspection checklists)
  checklists = new Map<string, InspectionChecklist>();
  checklistError: string | null = null;
  checklistLoading: string | null = null;

  /** Builds (on the server, by code) the inspection checklist for one order. */
  async loadChecklist(ref: string): Promise<InspectionChecklist | null> {
    if (this.checklistLoading) return null;
    this.checklistLoading = ref;
    this.checklistError = null;
    this.emit();
    try {
      const { checklist } = await api<{ checklist: InspectionChecklist }>(`/api/orders/checklist?order=${encodeURIComponent(ref)}`);
      this.checklists.set(ref, checklist);
      this.addLog(`Inspection checklist ready: ${ref} (${checklist.pieces} piece(s))`, 'success', 'tess');
      if (this.engine.connected) {
        this.engine.visitShop('tess');
        this.engine.leaveShop('tess');
      }
      return checklist;
    } catch (e) {
      this.checklistError = (e as Error).message;
      return null;
    } finally {
      this.checklistLoading = null;
      this.emit();
    }
  }

  // ---------------------------------------------------------------- Workshop
  private shopLoadedAt = 0;
  private shopLoading = false;

  /**
   * Reads the carpenters and their open orders, for the Workshop room: at sign-in, after Paolo's
   * tasks and order reports, or when someone clicks Refresh (automatic reads are skipped if the
   * last one was under a minute ago). Between those, the server pushes changes ("shop" events).
   */
  async loadWorkshop(force = false) {
    if (!this.user || !this.engine.connected) return;
    if (!this.user.permissions.includes('orders:read')) return this.engine.setShopLoad(null, 'no-access');
    if (this.shopLoading || (!force && Date.now() - this.shopLoadedAt < 60_000)) return;
    this.shopLoading = true;
    try {
      const { shop } = await api<{ shop: ShopCounts }>('/api/orders/workshop');
      this.shopLoadedAt = Date.now();
      this.engine.setShopLoad({ ...shop, source: 'live' });
    } catch {
      if (this.engine.workshop.load?.source !== 'live') this.engine.setShopLoad(null, 'unavailable');
    } finally {
      this.shopLoading = false;
    }
  }

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
    this.images.clear();
    this.facebook = null;
    this.scheduledPosts = null;
    this.fbError = null;
    this.orderPicks = null;
    this.discussions = [];
    this.discussionsLoaded = false;
    if (this.officeMeeting) this.engine.endMeeting(this.officeMeeting);
    this.officeMeeting = null;
    this.uiReviews = [];
    this.uiReviewsLoaded = false;
    this.uiShots.clear();
    this.checklists.clear();
    this.aiUsage = null;
    this.aiUsageError = null;
    this.attention = null;
    this.attentionError = null;
    this.dismissed = {};
    if (this.attentionTimer) clearInterval(this.attentionTimer);
    this.attentionTimer = null;
    if (this.attentionSoon) clearTimeout(this.attentionSoon);
    this.attentionSoon = null;
    if (this.officeHuddle) this.engine.endMeeting(this.officeHuddle);
    this.officeHuddle = null;
    this.orderPicksError = null;
    this.shopLoadedAt = 0;
    if (this.engine.connected) this.engine.setShopLoad(null, 'loading');
    this.engine.setPostBoard(null);
    this.engine.setEaselPhoto(null);
    this.systems = [];
    this.server = 'signed_out';
    this.ai = null;
    for (const id of LIVE_AGENT_IDS) this.engine.setLiveAgent(id, null);
    this.engine.setAiActivity('idle');
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
    void this.loadFacebook();
    void this.loadWorkshop(true);
    void this.loadDiscussions();
    void this.loadUiReviews();
    this.loadDismissed();
    void this.loadAttention(true);
    // Every 2 minutes while this tab is visible (one small request; overdue orders come from the
    // server's shared, cached read of the order system).
    if (this.attentionTimer) clearInterval(this.attentionTimer);
    this.attentionTimer = setInterval(() => {
      if (document.visibilityState === 'visible') void this.loadAttention();
    }, 120_000);
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
    // Live updates pushed by the server (it re-checks every couple of minutes while an office is
    // open, and sends only what changed): the Workshop carpenters and the scheduled Facebook posts.
    es.addEventListener('shop', (ev) => {
      const { shop } = JSON.parse((ev as MessageEvent).data) as { shop: ShopCounts };
      this.shopLoadedAt = Date.now();
      if (this.engine.connected) this.engine.setShopLoad({ ...shop, source: 'live' });
    });
    // Team discussion progress, pushed by the server as each step finishes (owner only).
    es.addEventListener('discussion', (ev) => {
      this.upsertDiscussion(JSON.parse((ev as MessageEvent).data) as Discussion);
    });
    // UI Review progress (owner only; never the screenshots).
    es.addEventListener('uireview', (ev) => {
      this.upsertUiReview(JSON.parse((ev as MessageEvent).data) as UiReview);
    });
    es.addEventListener('fb-scheduled', (ev) => {
      const { posts } = JSON.parse((ev as MessageEvent).data) as { posts: ScheduledPost[] };
      this.scheduledPosts = posts;
      this.fbError = null;
      this.updatePostBoard();
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

  // ---------------------------------------------------------------- Facebook (Carlo)
  facebook: FacebookStatus | null = null;
  scheduledPosts: ScheduledPost[] | null = null;
  /** Open orders for Joy's order picker; loaded only when asked (no polling). */
  orderPicks: OrderPick[] | null = null;
  orderPicksError: string | null = null;
  private loadingPicks = false;

  async loadOrderPicks() {
    if (this.loadingPicks) return;
    this.loadingPicks = true;
    try {
      this.orderPicks = (await api<{ orders: OrderPick[] }>('/api/orders/open')).orders;
      this.orderPicksError = null;
    } catch (e) {
      this.orderPicksError = `Could not load open orders: ${(e as Error).message}`;
    } finally {
      this.loadingPicks = false;
      this.emit();
    }
  }
  fbError: string | null = null;

  canPostFacebook(): { ok: boolean; reason?: string } {
    if (this.server !== 'signed_in' || !this.user) return { ok: false, reason: 'Sign in first.' };
    if (!this.user.permissions.includes('social:post')) return { ok: false, reason: 'Your account cannot post to Facebook.' };
    if (!this.facebook) return { ok: false, reason: 'Checking Facebook…' };
    if (!this.facebook.configured)
      return { ok: false, reason: `Facebook posting is not set up on the server. ${this.facebook.problems.join(' ')} See README, "Facebook posting".` };
    return { ok: true };
  }

  async loadFacebook() {
    if (!this.user?.permissions.includes('social:post')) return;
    try {
      this.facebook = (await api<{ facebook: FacebookStatus }>('/api/facebook/status')).facebook;
    } catch (e) {
      this.facebook = { configured: false, pageName: null, problems: [(e as Error).message] };
    }
    this.updatePostBoard();
    this.emit();
    if (this.facebook.configured) void this.loadScheduled();
  }

  async loadScheduled() {
    try {
      this.scheduledPosts = (await api<{ posts: ScheduledPost[] }>('/api/facebook/scheduled')).posts;
      this.fbError = null;
    } catch (e) {
      this.scheduledPosts = this.scheduledPosts ?? [];
      this.fbError = `Could not load pending posts: ${(e as Error).message}`;
    }
    this.updatePostBoard();
    this.emit();
  }

  /** Posts (or schedules) one approved post. `key` makes a repeated click or resend post only once. */
  async postToFacebook(p: { key: string; message: string; photo?: string; scheduleAt?: string }) {
    const image = p.photo ? { mimeType: p.photo.slice(5, p.photo.indexOf(';')), data: p.photo.slice(p.photo.indexOf(',') + 1) } : undefined;
    try {
      const { post } = await api<{ post: { postId: string; link: string | null; scheduledAt: string | null } }>('/api/facebook/posts', {
        method: 'POST',
        body: JSON.stringify({ key: p.key, message: p.message, ...(image ? { image } : {}), ...(p.scheduleAt ? { scheduleAt: p.scheduleAt } : {}) }),
      });
      this.addLog(post.scheduledAt ? `Facebook post scheduled for ${post.scheduledAt.slice(0, 16).replace('T', ' ')} UTC.` : 'Posted to Facebook.', 'success', 'carlo');
      return post;
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) this.signedOut('Your session expired. Sign in again to continue.');
      throw e;
    }
  }

  async cancelScheduled(id: string) {
    try {
      await api(`/api/facebook/scheduled/${encodeURIComponent(id)}`, { method: 'DELETE' });
      this.addLog('Scheduled Facebook post cancelled.', 'info', 'carlo');
      await this.loadScheduled();
    } catch (e) {
      this.fbError = (e as Error).message;
      this.emit();
    }
  }

  /**
   * Photos sent with tasks, kept only in this tab's memory (as data URLs) so the task can show
   * the photo and "Run again" can resend it. Never saved; gone after a reload or sign-out.
   */
  images = new Map<string, string>();

  /** Assigns a free-text task to one agent, optionally with a photo (JPEG data URL). */
  async submitAi(agent: LiveAgentId, prompt: string, photo?: string, orderRef?: string): Promise<Job | null> {
    const key = `ai|${agent}|${prompt}|${photo ? photo.length : 0}|${orderRef ?? ''}`;
    if (this.submitting.has(key)) return null;
    this.submitting.add(key);
    this.lastError = null;
    this.emit();
    try {
      const image = photo ? { mimeType: photo.slice(5, photo.indexOf(';')), data: photo.slice(photo.indexOf(',') + 1) } : undefined;
      // The key makes a resent request (double click, retry after a dropped connection) harmless.
      const { job } = await api<{ job: Job; deduplicated: boolean }>('/api/ai/tasks', { method: 'POST', body: JSON.stringify({ agent, prompt, key: newKey(), ...(image ? { image } : {}), ...(orderRef ? { orderRef } : {}) }) });
      if (photo) this.images.set(job.id, photo);
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

  // ---------------------------------------------------------------- Task Board actions
  /** Tasks with an action in flight (buttons are disabled meanwhile). */
  jobBusy = new Set<string>();

  private async jobAction(id: string, action: 'cancel' | 'complete' | 'follow-up', body: Record<string, unknown> = {}): Promise<string | null> {
    if (this.jobBusy.has(id)) return 'Already sending.';
    this.jobBusy.add(id);
    this.emit();
    try {
      const { job } = await api<{ job: Job }>(`/api/jobs/${id}/${action}`, { method: 'POST', body: JSON.stringify(body) });
      this.applyJob(job, false);
      return null;
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) this.signedOut('Your session expired. Sign in again to continue.');
      return (e as Error).message;
    } finally {
      this.jobBusy.delete(id);
      this.emit();
    }
  }

  /** Answers the agent's question or asks a follow-up: the same task runs again with the conversation. */
  followUp(id: string, text: string) {
    return this.jobAction(id, 'follow-up', { text, key: newKey() });
  }
  cancelJob(id: string) {
    return this.jobAction(id, 'cancel');
  }
  /** A person checked the answer. */
  completeJob(id: string) {
    return this.jobAction(id, 'complete');
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
        const followUp = (job.thread ?? []).filter((t) => t.role === 'user').length > 1;
        if (job.status === 'queued')
          this.addLog(
            job.type === 'ai.task' ? (followUp ? `Follow-up sent — ${job.title}` : `Task assigned — ${job.title}`) : `Report queued: ${job.title} (${job.range.from} to ${job.range.to}).`,
            'info',
            who,
            job.id,
          );
        if (job.status === 'completed') this.addLog(`${what} completed: ${job.title}.`, 'success', who, job.id);
        if (job.status === 'ready_for_review') this.addLog(`Ready for your review: ${job.title}.`, 'success', who, job.id);
        if (job.status === 'needs_info') {
          this.addLog(`${who ? AGENT_BY_ID[who].name : 'The agent'} needs more information: ${job.title}. Open the task to answer.`, 'warn', who, job.id);
          if (who) this.engine.liveSay(who, 'I need more information');
        }
        if (job.status === 'cancelled') this.addLog(`${what} cancelled: ${job.title}.`, 'warn', who, job.id);
        if (job.status === 'failed') this.addLog(`${what} failed: ${job.title} — ${job.error?.message ?? 'see details.'}`, 'error', who, job.id);
        const ended = job.status === 'ready_for_review' || job.status === 'needs_info' || job.status === 'failed' || job.status === 'cancelled';
        if (job.type === 'ai.task' && ended) this.aiFinished(job);
        if (ended || job.status === 'completed') this.refreshAttentionSoon();
      }
    }
    if (job.type === 'ai.task') this.updateAiThinking();
  }

  private isPhotoTask(job: Job) {
    return job.type === 'ai.task' && job.agent === 'carlo' && !!job.image;
  }

  /** Carlo walks back to his desk; the photo stays on the easel a little longer. */
  private leaveEasel(job: Job) {
    this.engine.stageAgent('carlo', 'seat');
    if (this.engine.easelPhoto && this.engine.easelPhoto === this.images.get(job.id)) this.engine.setEaselPhoto(this.engine.easelPhoto, 15000);
  }

  /** Keeps the Creative Studio board in step with the Page's schedule. */
  private updatePostBoard() {
    if (!this.user?.permissions.includes('social:post') || !this.facebook) return this.engine.setPostBoard(null);
    if (!this.facebook.configured) return this.engine.setPostBoard({ configured: false, count: null, next: null });
    const posts = this.scheduledPosts;
    this.engine.setPostBoard({ configured: true, count: posts ? posts.length : null, next: posts?.find((p) => p.scheduledAt)?.scheduledAt ?? null });
  }

  /** The Intelligence Lab lights up while any Gemini task is queued or running. */
  private updateAiThinking() {
    const running = this.jobs.filter((j) => j.type === 'ai.task' && (j.status === 'queued' || j.status === 'working'));
    if (running.length) {
      const names = [...new Set(running.map((j) => (j.agent ? AGENT_BY_ID[j.agent].name : 'a worker')))];
      this.engine.setAiActivity('thinking', `AI thinking · ${names.join(', ')}`);
    } else if (this.engine.aiPulse().state === 'thinking') this.engine.setAiActivity('idle');
  }

  private aiFinished(job: Job) {
    if (this.jobs.some((j) => j.type === 'ai.task' && (j.status === 'queued' || j.status === 'working'))) return;
    const who = job.agent ? AGENT_BY_ID[job.agent].name : 'worker';
    const code = job.error?.code ?? job.steps[0]?.error?.code;
    if (job.status === 'cancelled') this.engine.setAiActivity('idle');
    else if (job.status === 'needs_info') this.engine.setAiActivity('done', `Question for you · ${who}`, 5000);
    else if (job.status === 'completed' || job.status === 'ready_for_review') this.engine.setAiActivity('done', `Answer ready · ${who}`, 5000);
    else if (code === 'RATE_LIMITED') this.engine.setAiActivity('limited', 'AI usage limit reached', 30000);
    else if (code === 'AI_LIMIT') this.engine.setAiActivity('limited', 'Office AI limit reached', 30000);
    else this.engine.setAiActivity('error', 'AI request failed', 8000);
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
        else if (who === 'paolo') e.visitShop(who); // Paolo checks the shop floor while he works
        else if (this.isPhotoTask(job)) {
          // Carlo studies the photo at the Creative Studio easel; the photo shows on the canvas.
          e.stageAgentAt(who, SPOTS.photoEasel, { x: SPOTS.photoEasel.x, y: SPOTS.photoEasel.y - 1 }, 'Studying the photo in the Creative Studio');
          e.setEaselPhoto(this.images.get(job.id) ?? null);
        } else e.stageAgent(who, 'seat');
        if (step.system) e.liveSay(who, `Checking ${SYSTEM_NAMES[step.system]}`);
        else if (job.type === 'ai.task') e.liveSay(who, 'On it…');
        break;
      case 'completed':
        e.setLiveAgent(who, { state: 'completed', activity: step.result?.summary ?? 'Done', jobId: job.id });
        e.liveSay(who, job.type === 'ai.task' ? 'Done — see my answer' : step.result?.empty ? 'No records found' : 'Results ready');
        if (who === 'chief') e.stageAgent(who, 'seat');
        if (who === 'paolo') e.leaveShop(who);
        if (this.isPhotoTask(job)) this.leaveEasel(job);
        if (who === 'paolo' || job.type.startsWith('orders.') || job.type === 'combined.report') void this.loadWorkshop();
        this.addLog(`${step.label}: ${step.result?.summary ?? 'done'}`, step.result?.empty ? 'warn' : 'success', who, job.id);
        break;
      case 'cancelled':
        e.setLiveAgent(who, null);
        e.liveSay(who, 'Stopped');
        if (who === 'chief') e.stageAgent(who, 'seat');
        if (who === 'paolo') e.leaveShop(who);
        if (this.isPhotoTask(job)) this.leaveEasel(job);
        break;
      case 'failed':
        e.setLiveAgent(who, { state: 'failed', activity: step.error?.message ?? 'Failed', jobId: job.id });
        e.liveSay(who, step.error?.code === 'AWAITING_DOCUMENTATION' || step.error?.code === 'NOT_CONFIGURED' ? 'Not set up yet' : 'Request failed');
        if (who === 'chief') e.stageAgent(who, 'seat');
        if (who === 'paolo') e.leaveShop(who);
        if (this.isPhotoTask(job)) this.leaveEasel(job);
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
