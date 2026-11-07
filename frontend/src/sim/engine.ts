// Simulation engine: owns agents, tasks, approvals and the activity log.
// It has no dependency on Phaser or React — the scene reads agent positions every frame,
// and the UI subscribes to change notifications. Time only advances through tick(), so
// pausing freezes everything and tests can run it headless.

import type { AgentBrain } from '../agents/brain';
import { AGENTS, AGENT_BY_ID, seatOf, type AgentDef } from '../agents/roster';
import {
  CHAT_SCRIPTS,
  CHAT_SPOTS,
  LEISURE_SPOTS,
  MEETING_CENTER,
  MEETING_SLOTS,
  SPOTS,
  STROLL_POINTS,
  buildWalkGrid,
  roomAt,
  type ChatSpot,
  type LeisureSpot,
} from '../office/layout';
import { findPath, type Tile } from '../office/pathfinding';
import { DEMO_SHOP_LOAD, Workshop, type ShopLoad, type ShopNote } from './workshop';
import type {
  AgentId,
  AgentState,
  Dir,
  LogEntry,
  LogKind,
  RoomId,
  Settings,
  TaskKind,
  TaskOutput,
  TaskStatus,
} from './types';
import {
  customWorkflow,
  inquiryWorkflow,
  marketingWorkflow,
  productionWorkflow,
  type Step,
  type Target,
  type TaskTemplate,
} from './workflows';

export interface AgentRT {
  id: AgentId;
  def: AgentDef;
  x: number;
  y: number;
  path: Tile[];
  dest: Tile | null;
  face: Tile | null;
  dir: Dir;
  posture: 'stand' | 'sit';
  action: 'none' | 'walk' | 'work' | 'talk' | 'jog' | 'exercise';
  activity: string;
  busyTaskId: string | null;
  errorTaskId: string | null;
  bubble: { text: string; until: number } | null;
  completedUntil: number;
  completedCount: number;
  recent: { at: number; text: string }[];
  stepPhase: number;
  waitT: number;
  /** A break the agent is on (decoration only; any task cancels it). */
  leisure: Leisure | null;
  /** Sim time at which this agent may start its next break, once idle at the desk. */
  nextBreakAt: number;
}

export interface Leisure {
  kind: 'spot' | 'stroll' | 'chat';
  spot?: LeisureSpot;
  phase: 'going' | 'doing' | 'returning';
  until: number;
  label: string;
  /** Remaining stroll waypoints. */
  waypoints: Tile[];
  /** Chats: the shared conversation, and where this agent stands. */
  chat?: Chat;
  target?: Tile;
  arrived?: boolean;
}

/** Two agents talking on a break. Both agents' Leisure point at the same object. */
export interface Chat {
  first: AgentRT;
  second: AgentRT;
  spot: ChatSpot;
  lines: string[];
  /** Sim time the conversation started (both arrived), or null while they walk over. */
  startedAt: number | null;
  lastLine: number;
  /** Give up if they haven't both arrived by then. */
  giveUpAt: number;
}

/** How long each chat line is shown, in sim ms. */
const CHAT_LINE_MS = 2600;

/** Break timing in sim ms: idle time before a break, and how long it lasts. */
const BREAK_IDLE_MIN = 20_000;
const BREAK_IDLE_MAX = 60_000;
const BREAK_LEN_MIN = 10_000;
const BREAK_LEN_MAX = 20_000;
/** At most this many agents are away on a break at once, so the office never looks empty. */
export const MAX_ON_BREAK = 4;
/** Chance that a break is a chat with a colleague (when someone else is free too). */
const CHAT_CHANCE = 0.4;

export interface Task {
  id: string;
  kind: TaskKind;
  title: string;
  description: string;
  cast: AgentId[];
  primary: AgentId;
  status: TaskStatus;
  steps: Step[];
  cursor: number;
  stepStarted: boolean;
  stepT: number;
  holding: boolean;
  pending: Promise<TaskOutput> | null;
  pendingResult: TaskOutput | null;
  outputs: TaskOutput[];
  createdAt: number;
  finishedAt?: number;
  approval?: { agent: AgentId; title: string; decision?: 'approved' | 'rejected'; at: number };
  waitingFor?: string;
  note?: string;
  error?: string;
  prompt?: string;
  reviewed?: boolean;
  currentActivity?: string;
}

export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

const STORE_KEY = 'wad-ai-office:v1';
const WALK_SPEED = 2.6; // tiles per second

export const DEFAULT_SETTINGS: Settings = {
  sound: false,
  reducedMotion: false,
  speed: 1,
  labels: true,
  breaks: true,
  feedOpen: true,
  mode: 'demo',
};

/**
 * Connected Mode: an agent's visible state comes from the server's job events. Movement is only
 * decoration — it never decides when a live task is done.
 */
export interface LiveAgentState {
  state: 'queued' | 'working' | 'completed' | 'failed';
  activity: string;
  jobId: string;
  until?: number; // sim time when a "completed" flash ends
}

type Listener = () => void;

/**
 * What the Intelligence Lab shows. Connected Mode: set by the live store from Gemini tasks.
 * Demo Mode: "thinking" while a template draft is being prepared (no real AI is involved).
 */
export type AiActivity = 'idle' | 'thinking' | 'done' | 'limited' | 'error';
export interface AiPulse {
  state: AiActivity;
  label: string;
}

export class Engine {
  agents: AgentRT[];
  agentById: Record<AgentId, AgentRT>;
  tasks: Task[] = [];
  log: LogEntry[] = [];
  settings: Settings;
  paused = false;
  /** Simulation clock in ms; only advances while not paused. */
  now = 0;
  /** Connected Mode AI status from the live store; `until` (sim ms) ends a done/limited/error flash. */
  private aiLive: { state: AiActivity; label: string; until: number } = { state: 'idle', label: '', until: 0 };

  // ---------------------------------------------------------------- Creative Studio
  /** The photo Carlo is studying (a data URL kept in this browser only), shown on the easel. */
  easelPhoto: string | null = null;
  private easelUntil = 0;
  /** Scheduled Facebook posts board: null = hidden (demo, or no posting permission). */
  postBoard: { configured: boolean; count: number | null; next: string | null } | null = null;

  /** Shows a photo on the easel; `ms` > 0 removes it after that long (sim time). */
  setEaselPhoto(photo: string | null, ms = 0) {
    this.easelPhoto = photo;
    this.easelUntil = photo && ms ? this.now + ms : 0;
    this.emitNow();
  }

  setPostBoard(b: { configured: boolean; count: number | null; next: string | null } | null) {
    this.postBoard = b;
    this.emitNow();
  }

  /** Cosmetic: walk an agent to a tile (e.g. the Creative Studio easel) while a live step runs. */
  stageAgentAt(id: AgentId, tile: { x: number; y: number }, face: { x: number; y: number }, activity: string) {
    const a = this.agentById[id];
    if (a.busyTaskId) return;
    a.leisure = null;
    this.sendTo(a, { tile, face }, activity, null);
  }

  /** Called by the live store whenever Gemini task states change. */
  setAiActivity(state: AiActivity, label = '', ms = 0) {
    this.aiLive = { state, label, until: ms ? this.now + ms : 0 };
    this.emitNow();
  }

  /** The current AI activity for the Intelligence Lab. */
  aiPulse(): AiPulse {
    if (this.connected) {
      const l = this.aiLive;
      if (l.state === 'thinking') return { state: 'thinking', label: l.label };
      if (l.state !== 'idle' && l.until > this.now) return { state: l.state, label: l.label };
      return { state: 'idle', label: '' };
    }
    const drafting = this.tasks.find((t) => t.status === 'running' && t.pending);
    return drafting ? { state: 'thinking', label: `Drafting (template) · ${AGENT_BY_ID[drafting.primary].name}` } : { state: 'idle', label: '' };
  }

  /** Random source for breaks (tests replace it with a seeded one). */
  random: () => number = Math.random;

  private grid = buildWalkGrid();

  // ---------------------------------------------------------------- Workshop
  /** The shop floor: carpenters that follow the orders per production stage (decoration only). */
  workshop = new Workshop(this.grid, () => this.random());
  /** Set by the live store: re-reads the shop numbers from WAD Order Management (Refresh button). */
  shopRefresh: (() => void) | null = null;
  /** Paolo (or another agent) checking the shop floor during a live step. */
  private shopVisit: { id: AgentId; done: boolean; leaveAt: number | null } | null = null;

  setShopLoad(load: ShopLoad | null, note: ShopNote = null) {
    this.workshop.setLoad(load, note, this.now);
    this.emitNow();
  }

  /** Cosmetic: an agent walks to the shop floor while a live step runs. */
  visitShop(id: AgentId) {
    const a = this.agentById[id];
    if (a.busyTaskId) return;
    a.leisure = null;
    const t = SPOTS.shopInspect;
    this.sendTo(a, { tile: t, face: { x: t.x + 1, y: t.y + 1 } }, 'Checking the shop floor', null);
    this.shopVisit = { id, done: false, leaveAt: null };
  }

  /** The step finished: look around a few more seconds after arriving, then go back to the desk. */
  leaveShop(id: AgentId) {
    if (this.shopVisit?.id === id) this.shopVisit.done = true;
  }

  private shopVisitTick() {
    const v = this.shopVisit;
    if (!v || !v.done) return;
    const a = this.agentById[v.id];
    if (a.path.length) return;
    if (v.leaveAt === null) v.leaveAt = this.now + 6000;
    else if (this.now >= v.leaveAt) {
      this.shopVisit = null;
      this.stageAgent(v.id, 'seat');
    }
  }
  private listeners = new Set<Listener>();
  private version = 0;
  private dirty = false;
  private lastEmit = 0;
  private logId = 1;
  private taskSeq = 1;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Hook for sound effects; set by the UI. */
  onCue: ((cue: 'approval' | 'complete' | 'error' | 'blip') => void) | null = null;

  constructor(
    public brain: AgentBrain,
    private storage: StorageLike | null,
    defaults: Partial<Settings> = {},
  ) {
    this.settings = { ...DEFAULT_SETTINGS, ...defaults };
    this.agents = AGENTS.map((def) => {
      const s = seatOf(def.id);
      return {
        id: def.id,
        def,
        x: s.x,
        y: s.y,
        path: [],
        dest: null,
        face: null,
        dir: 'br' as Dir,
        posture: 'sit' as const,
        action: 'none' as const,
        activity: 'At desk',
        busyTaskId: null,
        errorTaskId: null,
        bubble: null,
        completedUntil: 0,
        completedCount: 0,
        recent: [],
        stepPhase: 0,
        waitT: 0,
        leisure: null,
        nextBreakAt: 0,
      };
    });
    this.agentById = Object.fromEntries(this.agents.map((a) => [a.id, a])) as Record<AgentId, AgentRT>;
    this.load();
    if (this.connected) this.workshop.setLoad(null, 'loading');
    for (const a of this.agents) a.nextBreakAt = this.breakDelay();
  }

  // ---------------------------------------------------------------- subscription
  subscribe = (fn: Listener) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getVersion = () => this.version;

  private touch() {
    this.dirty = true;
  }
  private flush(force = false) {
    if (!this.dirty) return;
    const t = performanceNow();
    if (!force && t - this.lastEmit < 120) return;
    this.dirty = false;
    this.lastEmit = t;
    this.version++;
    this.listeners.forEach((l) => l());
  }
  /** Immediately notify (for user-initiated changes). */
  private emitNow() {
    this.dirty = true;
    this.flush(true);
  }

  // ---------------------------------------------------------------- Connected Mode (live) layer
  live = new Map<AgentId, LiveAgentState>();

  get connected() {
    return this.settings.mode === 'connected';
  }

  /** Called by the live store when a server job event changes an agent's step. */
  setLiveAgent(id: AgentId, s: LiveAgentState | null) {
    const a = this.agentById[id];
    const prev = this.live.get(id);
    if (!s) this.live.delete(id);
    else this.live.set(id, s.state === 'completed' ? { ...s, until: this.now + 6000 } : s);
    if (s && (s.state === 'queued' || s.state === 'working') && a.leisure) this.endBreak(a, 'Back to desk for a task');
    if (s) {
      a.activity = s.activity;
      this.pushRecent(a, s.activity);
    }
    if (s?.state !== 'working' && a.action === 'work' && !a.busyTaskId) a.action = 'none';
    if (s && prev?.state !== s.state && s.state === 'working') this.onCue?.('blip');
    this.emitNow();
  }

  /** Cosmetic: walk an agent to its desk or the meeting table while a live step runs. */
  stageAgent(id: AgentId, where: 'seat' | 'meeting', slot = 0) {
    const a = this.agentById[id];
    if (a.busyTaskId) return; // a demo workflow currently owns this agent
    a.leisure = null;
    this.sendTo(a, where === 'seat' ? { seat: true } : { meeting: slot }, where === 'seat' ? 'Heading to desk' : 'Going to the meeting table', null);
  }

  liveSay(id: AgentId, text: string, ms = 2600) {
    this.say(this.agentById[id], text, ms);
  }

  /** Switching to Connected Mode stops any running demo workflow so the two never mix. */
  setMode(mode: 'demo' | 'connected') {
    if (mode === this.settings.mode) return;
    if (mode === 'connected') {
      for (const t of this.tasks) {
        if (t.status === 'running' || t.status === 'queued' || t.status === 'awaiting_approval') {
          t.status = 'interrupted';
          t.note = 'Stopped when Connected Mode was turned on. Demo results are never mixed with live data.';
          t.finishedAt = Date.now();
          this.release(t);
        }
      }
      for (const a of this.agents) {
        a.errorTaskId = null;
        a.bubble = null;
        a.leisure = null;
        const seat = seatOf(a.id);
        if (Math.round(a.x) !== seat.x || Math.round(a.y) !== seat.y) this.sendTo(a, { seat: true }, 'Returning to desk', null);
      }
    }
    // Demo Mode shows sample shop numbers; Connected Mode waits for the real ones.
    this.shopVisit = null;
    this.workshop.setLoad(mode === 'connected' ? null : DEMO_SHOP_LOAD, 'loading', this.now);
    this.updateSettings({ mode });
    this.addLog(mode === 'connected' ? 'Switched to Connected Mode (read-only live data).' : 'Switched to Demo Mode (simulated data).', 'info');
  }

  private liveTick() {
    for (const [id, s] of this.live) {
      const a = this.agentById[id];
      if (s.state === 'completed' && s.until !== undefined && s.until <= this.now) {
        this.live.delete(id);
        this.touch();
        continue;
      }
      if (s.state === 'working' && !a.path.length && !a.busyTaskId && a.action !== 'work') {
        a.action = 'work';
        const seat = seatOf(id);
        if (Math.round(a.x) === seat.x && Math.round(a.y) === seat.y) {
          a.posture = 'sit';
          a.dir = 'br';
        }
      }
    }
  }

  // ---------------------------------------------------------------- public API
  agentState(a: AgentRT): AgentState {
    const l = this.connected ? this.live.get(a.id) : undefined;
    if (l && !a.busyTaskId) {
      if (l.state === 'queued') return 'queued';
      if (l.state === 'failed') return 'error';
      if (l.state === 'completed') return 'completed';
      return a.path.length ? 'walking' : 'working';
    }
    if (a.busyTaskId) {
      if (a.action === 'walk') return 'walking';
      return 'working';
    }
    if (a.errorTaskId) return 'error';
    if (this.tasks.some((t) => t.status === 'awaiting_approval' && t.approval?.agent === a.id)) return 'waiting';
    if (a.path.length) return 'walking';
    if (a.completedUntil > this.now) return 'completed';
    return 'idle';
  }

  activeCount(): number {
    return this.agents.filter((a) => a.busyTaskId || (this.connected && ['queued', 'working'].includes(this.live.get(a.id)?.state ?? ''))).length;
  }

  currentTask(a: AgentRT): Task | undefined {
    const id = a.busyTaskId ?? a.errorTaskId;
    if (id) return this.tasks.find((t) => t.id === id);
    return this.tasks.find((t) => t.status === 'awaiting_approval' && t.approval?.agent === a.id);
  }

  agentRoom(a: AgentRT): RoomId | null {
    return roomAt(a.x + 0.5, a.y + 0.5);
  }

  startDemo(kind: 'inquiry' | 'production' | 'marketing'): Task {
    const tpl = kind === 'inquiry' ? inquiryWorkflow() : kind === 'production' ? productionWorkflow() : marketingWorkflow();
    return this.enqueue(tpl);
  }

  assignCustom(agent: AgentId, prompt: string): Task {
    return this.enqueue(customWorkflow(agent, prompt.trim()));
  }

  retry(taskId: string) {
    const t = this.tasks.find((x) => x.id === taskId);
    if (!t) return;
    for (const a of this.agents) if (a.errorTaskId === taskId) a.errorTaskId = null;
    if (t.kind === 'custom') this.enqueue(customWorkflow(t.primary, t.prompt ?? t.title, false));
    else this.startDemo(t.kind as 'inquiry' | 'production' | 'marketing');
  }

  dismissError(agent: AgentId) {
    this.agentById[agent].errorTaskId = null;
    this.emitNow();
  }

  decide(taskId: string, decision: 'approved' | 'rejected') {
    const t = this.tasks.find((x) => x.id === taskId);
    if (!t || t.status !== 'awaiting_approval' || !t.approval) return;
    t.approval.decision = decision;
    t.status = 'running';
    this.addLog(
      decision === 'approved' ? `You approved: ${t.approval.title}` : `You rejected: ${t.approval.title}`,
      decision === 'approved' ? 'success' : 'warn',
      t.approval.agent,
      t.id,
    );
    this.emitNow();
  }

  markReviewed(taskId: string) {
    const t = this.tasks.find((x) => x.id === taskId);
    if (!t) return;
    t.reviewed = true;
    this.addLog(`Marked as reviewed: ${t.title}`, 'info', t.primary, t.id);
    this.save();
    this.emitNow();
  }

  setPaused(p: boolean) {
    this.paused = p;
    this.emitNow();
  }

  updateSettings(patch: Partial<Settings>) {
    this.settings = { ...this.settings, ...patch };
    this.save();
    this.emitNow();
  }

  resetDemo() {
    for (const a of this.agents) {
      const s = seatOf(a.id);
      Object.assign(a, {
        x: s.x,
        y: s.y,
        path: [],
        dest: null,
        face: null,
        dir: 'br',
        posture: 'sit',
        action: 'none',
        activity: 'At desk',
        busyTaskId: null,
        errorTaskId: null,
        bubble: null,
        completedUntil: 0,
        completedCount: 0,
        recent: [],
        leisure: null,
        nextBreakAt: this.now + this.breakDelay(),
      });
    }
    this.tasks = [];
    this.log = [];
    this.paused = false;
    this.storage?.removeItem(STORE_KEY);
    this.addLog('Demo reset. All agents are back at their desks.', 'info');
    this.save();
    this.emitNow();
  }

  // ---------------------------------------------------------------- tick
  tick(dtMs: number) {
    if (this.paused) return;
    const dt = Math.min(dtMs, 250) * this.settings.speed;
    this.now += dt;
    for (const a of this.agents) this.moveAgent(a, dt / 1000);
    for (const a of this.agents) if (a.bubble && a.bubble.until <= this.now) a.bubble = null;
    this.liveTick();
    if (this.easelUntil && this.now >= this.easelUntil) {
      this.easelPhoto = null;
      this.easelUntil = 0;
      this.touch();
    }
    for (const t of this.tasks) if (t.status === 'running' || t.status === 'queued') this.runTask(t, dt);
    this.breakTick(dt);
    this.workshop.tick(dt, this.now);
    this.shopVisitTick();
    this.flush();
  }

  // ---------------------------------------------------------------- breaks (decoration)
  /** An agent with nothing to do: not on a task, no error, no approval or live step pending. */
  isFree(a: AgentRT): boolean {
    if (a.busyTaskId || a.errorTaskId) return false;
    if (this.connected && this.live.has(a.id)) return false;
    return !this.tasks.some((t) => (t.status === 'awaiting_approval' && t.approval?.agent === a.id) || (t.status === 'queued' && t.cast.includes(a.id)));
  }

  onBreak(a: AgentRT): boolean {
    return a.leisure !== null;
  }

  private breakDelay() {
    return this.now + BREAK_IDLE_MIN + this.random() * (BREAK_IDLE_MAX - BREAK_IDLE_MIN);
  }

  private breakTick(dt: number) {
    const breaksOn = this.settings.breaks && !this.settings.reducedMotion;
    let away = this.agents.filter((a) => a.leisure && a.leisure.phase !== 'returning').length;
    for (const a of this.agents) {
      const l = a.leisure;
      if (l) {
        if (!breaksOn && l.phase !== 'returning') {
          this.endBreak(a, 'Returning to desk');
          continue;
        }
        if (l.kind === 'chat' && l.phase !== 'returning') {
          this.chatTick(a, l);
          continue;
        }
        if (l.phase === 'going' && !a.path.length) {
          if (l.kind === 'stroll' && l.waypoints.length) {
            const next = l.waypoints.shift()!;
            this.walk(a, findPath(this.grid, a, next) ?? [], l.label);
          } else if (l.spot?.approach && (Math.round(a.x) !== l.spot.tile.x || Math.round(a.y) !== l.spot.tile.y)) {
            a.path = [l.spot.tile]; // step onto the treadmill belt
            a.action = 'walk';
          } else {
            l.phase = 'doing';
            l.until = this.now + BREAK_LEN_MIN + this.random() * (BREAK_LEN_MAX - BREAK_LEN_MIN);
            if (l.spot) {
              a.dir = dirFromDelta(l.spot.face.x - a.x, l.spot.face.y - a.y, a.dir);
              a.action = l.spot.action;
              this.say(a, l.spot.says[Math.floor(this.random() * l.spot.says.length)], 2600);
            } else l.until = this.now; // a stroll ends once the last waypoint is reached
            this.touch();
          }
        } else if (l.phase === 'doing') {
          if (a.action === 'jog') a.stepPhase += 2.4 * (dt / 1000); // legs keep moving on the belt
          if (this.now >= l.until) this.endBreak(a, 'Back to desk');
        } else if (l.phase === 'returning' && !a.path.length) {
          a.leisure = null;
          a.nextBreakAt = this.breakDelay();
          this.touch();
        }
        continue;
      }
      if (!breaksOn || !this.isFree(a) || a.path.length || a.completedUntil > this.now) {
        if (a.nextBreakAt < this.now + BREAK_IDLE_MIN) a.nextBreakAt = this.now + BREAK_IDLE_MIN;
        continue;
      }
      const s = seatOf(a.id);
      if (Math.round(a.x) !== s.x || Math.round(a.y) !== s.y) continue;
      if (this.now < a.nextBreakAt || away >= MAX_ON_BREAK) continue;
      if (away + 2 <= MAX_ON_BREAK && this.random() < CHAT_CHANCE && this.startChat(a)) {
        away += 2;
        continue;
      }
      if (this.startBreak(a)) away++;
      else a.nextBreakAt = this.breakDelay();
    }
  }

  /** Free, idle at the desk and not on a break: can be invited to chat. */
  private canChat(o: AgentRT) {
    const s = seatOf(o.id);
    return !o.leisure && !o.path.length && this.isFree(o) && o.completedUntil <= this.now && Math.round(o.x) === s.x && Math.round(o.y) === s.y;
  }

  private startChat(a: AgentRT): boolean {
    const partners = this.agents.filter((o) => o !== a && this.canChat(o));
    const used = new Set(this.agents.map((o) => o.leisure?.chat?.spot.id).filter(Boolean));
    const spots = CHAT_SPOTS.filter((sp) => !used.has(sp.id) && !this.isReserved(sp.a, a) && !this.isReserved(sp.b, a));
    if (!partners.length || !spots.length) return false;
    const b = partners[Math.floor(this.random() * partners.length)];
    const spot = spots[Math.floor(this.random() * spots.length)];
    const pa = findPath(this.grid, a, spot.a);
    const pb = findPath(this.grid, b, spot.b);
    if (!pa || !pb) return false;
    const chat: Chat = {
      first: a,
      second: b,
      spot,
      lines: CHAT_SCRIPTS[Math.floor(this.random() * CHAT_SCRIPTS.length)],
      startedAt: null,
      lastLine: -1,
      giveUpAt: this.now + 30_000,
    };
    for (const [me, other, tile, path] of [
      [a, b, spot.a, pa],
      [b, a, spot.b, pb],
    ] as const) {
      me.leisure = { kind: 'chat', phase: 'going', until: 0, label: `On a break: chatting with ${other.def.name}`, waypoints: [], chat, target: tile, arrived: false };
      me.dest = tile;
      this.walk(me, path.slice(), me.leisure.label);
    }
    this.say(a, `${b.def.name}, got a minute?`, 2000);
    return true;
  }

  private chatTick(a: AgentRT, l: Leisure) {
    const c = l.chat!;
    const other = c.first === a ? c.second : c.first;
    // The other one was called away (a task, a live report, or breaks switched off).
    if (other.leisure?.chat !== c || other.leisure.phase === 'returning') {
      this.say(a, 'Talk later!', 1800);
      this.endBreak(a, 'Back to desk');
      return;
    }
    if (l.phase === 'going') {
      if (!a.path.length && !l.arrived) {
        l.arrived = true;
        const ot = other.leisure.target!;
        a.dir = dirFromDelta(ot.x - a.x, ot.y - a.y, a.dir);
        this.touch();
      }
      if (l.arrived && other.leisure.arrived && c.startedAt === null) {
        c.startedAt = this.now;
        l.phase = 'doing';
        other.leisure.phase = 'doing';
      } else if (c.startedAt === null && this.now > c.giveUpAt) {
        this.endBreak(a, 'Back to desk');
        this.endBreak(other, 'Back to desk');
      }
      return;
    }
    // doing: lines alternate, one every CHAT_LINE_MS
    const line = Math.floor((this.now - c.startedAt!) / CHAT_LINE_MS);
    if (line >= c.lines.length) {
      this.endBreak(c.first, 'Back to desk');
      this.endBreak(c.second, 'Back to desk');
      return;
    }
    if (line !== c.lastLine) {
      c.lastLine = line;
      const speaker = line % 2 === 0 ? c.first : c.second;
      const listener = speaker === c.first ? c.second : c.first;
      this.say(speaker, c.lines[line], CHAT_LINE_MS - 300);
      speaker.action = 'talk';
      listener.action = 'none';
      this.touch();
    }
  }

  private startBreak(a: AgentRT): boolean {
    const taken = new Set(this.agents.filter((o) => o !== a && o.leisure?.spot).map((o) => o.leisure!.spot!.id));
    const free = LEISURE_SPOTS.filter((sp) => !taken.has(sp.id) && !this.isReserved(sp.tile, a) && !this.isReserved(sp.approach ?? sp.tile, a));
    const stroll = this.random() < 0.25 || !free.length;
    if (stroll) {
      const pts = STROLL_POINTS.slice().sort(() => this.random() - 0.5).slice(0, 2 + Math.floor(this.random() * 2));
      const first = pts.shift()!;
      const path = findPath(this.grid, a, first);
      if (!path) return false;
      a.leisure = { kind: 'stroll', phase: 'going', until: 0, label: 'On a break: taking a walk', waypoints: pts };
      this.walk(a, path, a.leisure.label);
      this.say(a, ['Stretching my legs', 'Quick walk', 'Lakad muna'][Math.floor(this.random() * 3)], 2200);
      return true;
    }
    const spot = free[Math.floor(this.random() * free.length)];
    const path = findPath(this.grid, a, spot.approach ?? spot.tile);
    if (!path) return false;
    a.leisure = { kind: 'spot', spot, phase: 'going', until: 0, label: `On a break: ${spot.label.toLowerCase()}`, waypoints: [] };
    this.walk(a, path, a.leisure.label);
    return true;
  }

  /** Ends a break and walks back to the desk. Off a treadmill, step down first. */
  private endBreak(a: AgentRT, activity: string) {
    const l = a.leisure;
    if (!l) return;
    const seat = seatOf(a.id);
    const start = l.spot?.approach && Math.round(a.x) === l.spot.tile.x && Math.round(a.y) === l.spot.tile.y ? l.spot.approach : null;
    let rest = findPath(this.grid, start ?? a, seat) ?? [seat];
    if (!rest.length && (a.x !== seat.x || a.y !== seat.y)) rest = [seat]; // finish the last part-tile
    l.phase = 'returning';
    a.face = { x: seat.x, y: seat.y - 1 };
    a.dest = seat;
    this.walk(a, start ? [start, ...rest] : rest, activity);
  }

  private walk(a: AgentRT, path: Tile[], activity: string) {
    a.path = path;
    a.posture = 'stand';
    a.action = path.length ? 'walk' : 'none';
    a.activity = activity;
    this.pushRecent(a, activity);
    if (!path.length) this.arriveAt(a);
    this.touch();
  }

  // ---------------------------------------------------------------- tasks
  private enqueue(tpl: TaskTemplate): Task {
    const t: Task = {
      id: `T${Date.now().toString(36)}-${this.taskSeq++}`,
      kind: tpl.kind,
      title: tpl.title,
      description: tpl.description,
      cast: tpl.cast,
      primary: tpl.primary,
      status: 'queued',
      steps: tpl.steps.slice(),
      cursor: 0,
      stepStarted: false,
      stepT: 0,
      holding: false,
      pending: null,
      pendingResult: null,
      outputs: [],
      createdAt: Date.now(),
      prompt: tpl.prompt,
    };
    this.tasks.unshift(t);
    this.addLog(`Task started: ${t.title}`, 'info', t.primary, t.id);
    this.runTask(t, 0);
    this.emitNow();
    return t;
  }

  private tryAcquire(t: Task): boolean {
    const blocked = t.cast.filter((id) => {
      const b = this.agentById[id].busyTaskId;
      return b !== null && b !== t.id;
    });
    if (blocked.length) {
      const names = blocked.map((id) => AGENT_BY_ID[id].name).join(', ');
      if (t.waitingFor !== names) {
        t.waitingFor = names;
        this.addLog(`${t.title} is queued — waiting for ${names}`, 'info', t.primary, t.id);
      }
      t.status = 'queued';
      return false;
    }
    for (const id of t.cast) {
      const a = this.agentById[id];
      a.busyTaskId = t.id;
      a.errorTaskId = null;
      if (a.leisure) {
        // The task's own first step walks them where they are needed (every workflow starts with a move).
        const back = a.leisure.spot?.approach && Math.round(a.x) === a.leisure.spot.tile.x && Math.round(a.y) === a.leisure.spot.tile.y ? a.leisure.spot.approach : null;
        a.leisure = null;
        if (back) {
          a.x = back.x; // step off the treadmill
          a.y = back.y;
        }
        this.say(a, 'Coming!', 1500);
      }
    }
    t.waitingFor = undefined;
    t.holding = true;
    t.status = 'running';
    this.touch();
    return true;
  }

  private release(t: Task, keepActivity = false) {
    for (const id of t.cast) {
      const a = this.agentById[id];
      if (a.busyTaskId === t.id) {
        a.busyTaskId = null;
        if (a.action !== 'walk') a.action = 'none';
        if (!keepActivity) a.activity = a.posture === 'sit' ? 'At desk' : 'Standing by';
      }
    }
    t.holding = false;
    this.touch();
  }

  private runTask(t: Task, dt: number) {
    // Loop so instant steps (logs, etc.) chain within one tick.
    for (let guard = 0; guard < 50; guard++) {
      const step = t.steps[t.cursor];
      if (!step) {
        this.finish(t, 'completed');
        return;
      }
      if (!t.holding && step.t !== 'log') {
        if (!this.tryAcquire(t)) return;
      }
      if (!t.stepStarted) {
        t.stepStarted = true;
        t.stepT = 0;
        this.startStep(t, step);
        dt = 0;
        if (t.status !== 'running' && t.status !== 'queued' && t.status !== 'awaiting_approval') return;
      } else {
        t.stepT += dt;
      }
      const done = this.stepDone(t, step);
      if (!done) return;
      if (t.status === 'failed' || t.status === 'completed' || t.status === 'rejected') return;
      t.cursor++;
      t.stepStarted = false;
    }
  }

  private startStep(t: Task, s: Step) {
    if (t.status === 'queued') t.status = 'running';
    switch (s.t) {
      case 'log':
        this.addLog(s.text, s.kind ?? 'info', s.agent, t.id);
        break;
      case 'move':
        this.sendTo(this.agentById[s.agent], s.to, s.activity ?? 'Walking', t);
        break;
      case 'moveAll':
        for (const m of s.moves) this.sendTo(this.agentById[m.agent], m.to, s.activity ?? 'Walking', t);
        break;
      case 'work': {
        const a = this.agentById[s.agent];
        this.beginWork(a, s.activity, t);
        if (s.say) this.say(a, s.say, 2200);
        break;
      }
      case 'compose': {
        const a = this.agentById[s.agent];
        this.beginWork(a, s.activity, t);
        t.pendingResult = null;
        t.pending = this.brain.compose(s.req);
        t.pending.then(
          (r) => {
            t.pendingResult = r;
          },
          (err) => {
            t.pendingResult = {
              title: 'Error',
              body: String(err?.message ?? err),
              source: 'template',
            };
          },
        );
        break;
      }
      case 'say': {
        const a = this.agentById[s.agent];
        a.action = 'talk';
        a.activity = 'Talking';
        this.faceMeetingIfThere(a);
        this.say(a, s.text, s.ms ?? 1800);
        break;
      }
      case 'approval': {
        const a = this.agentById[s.agent];
        t.approval = { agent: s.agent, title: s.title, at: Date.now() };
        t.status = 'awaiting_approval';
        this.release(t);
        a.activity = 'Waiting for your approval';
        this.say(a, 'Needs your approval', 3500);
        this.addLog(`Approval needed: ${s.title}`, 'approval', s.agent, t.id);
        this.onCue?.('approval');
        this.save();
        break;
      }
      case 'fail': {
        const a = this.agentById[s.agent];
        t.error = s.reason;
        this.addLog(`${a.def.name}: ${s.reason}`, 'error', s.agent, t.id);
        this.say(a, 'Something went wrong', 3000);
        this.finish(t, 'failed');
        a.errorTaskId = t.id;
        a.activity = 'Error — see task';
        this.onCue?.('error');
        break;
      }
      case 'complete': {
        for (const id of s.credit) {
          const a = this.agentById[id];
          a.completedCount++;
          a.completedUntil = this.now + 5000;
          this.pushRecent(a, `Completed: ${t.title}`);
        }
        t.note = s.note;
        this.finish(t, 'completed');
        break;
      }
      case 'reject':
        t.note = s.note;
        this.finish(t, 'rejected');
        break;
    }
    this.touch();
  }

  private stepDone(t: Task, s: Step): boolean {
    switch (s.t) {
      case 'log':
      case 'fail':
      case 'complete':
      case 'reject':
        return true;
      case 'move':
        return this.arrived(this.agentById[s.agent]);
      case 'moveAll':
        return s.moves.every((m) => this.arrived(this.agentById[m.agent]));
      case 'work':
        if (t.stepT >= s.ms) {
          this.endWork(this.agentById[s.agent], t, s.activity);
          return true;
        }
        return false;
      case 'compose':
        if (t.stepT >= s.ms && t.pendingResult) {
          const a = this.agentById[s.agent];
          t.outputs.push(t.pendingResult);
          this.addLog(`${a.def.name} produced: ${t.pendingResult.title} (template)`, 'success', s.agent, t.id);
          t.pending = null;
          t.pendingResult = null;
          if (s.say) this.say(a, s.say, 2000);
          this.endWork(a, t, s.activity);
          this.onCue?.('blip');
          return true;
        }
        return false;
      case 'say':
        if (t.stepT >= (s.ms ?? 1800)) {
          this.agentById[s.agent].action = 'none';
          return true;
        }
        return false;
      case 'approval': {
        const d = t.approval?.decision;
        if (!d) return false;
        // Splice the chosen branch in right after this step.
        t.steps.splice(t.cursor + 1, 0, ...(d === 'approved' ? s.onApprove : s.onReject));
        return true;
      }
    }
  }

  private finish(t: Task, status: TaskStatus) {
    t.status = status;
    t.finishedAt = Date.now();
    t.currentActivity = undefined;
    this.release(t);
    if (status === 'completed') {
      this.addLog(`Completed: ${t.title}`, 'success', t.primary, t.id);
      this.onCue?.('complete');
    } else if (status === 'rejected') {
      this.addLog(`Closed as rejected: ${t.title}`, 'warn', t.primary, t.id);
    }
    // Anyone not at their seat walks back (not part of any task, so it doesn't hold them).
    for (const id of t.cast) {
      const a = this.agentById[id];
      if (a.busyTaskId) continue;
      const s = seatOf(id);
      if (Math.round(a.x) !== s.x || Math.round(a.y) !== s.y) this.sendTo(a, { seat: true }, 'Returning to desk', null);
    }
    this.save();
    this.emitNow();
  }

  // ---------------------------------------------------------------- agents
  private beginWork(a: AgentRT, activity: string, t: Task) {
    a.action = 'work';
    a.activity = activity;
    t.currentActivity = `${a.def.name}: ${activity}`;
    this.faceMeetingIfThere(a);
    const s = seatOf(a.id);
    if (Math.round(a.x) === s.x && Math.round(a.y) === s.y) {
      a.posture = 'sit';
      a.dir = 'br';
    }
    this.pushRecent(a, activity);
    this.touch();
  }

  private endWork(a: AgentRT, _t: Task, _activity: string) {
    a.action = 'none';
    this.touch();
  }

  private say(a: AgentRT, text: string, ms: number) {
    a.bubble = { text, until: this.now + ms };
    this.touch();
  }

  private pushRecent(a: AgentRT, text: string) {
    if (a.recent[0]?.text === text) return;
    a.recent.unshift({ at: Date.now(), text });
    if (a.recent.length > 8) a.recent.length = 8;
  }

  private faceMeetingIfThere(a: AgentRT) {
    const slot = MEETING_SLOTS.find((m) => m.x === Math.round(a.x) && m.y === Math.round(a.y));
    if (slot) a.dir = dirFromDelta(MEETING_CENTER.x - slot.x, MEETING_CENTER.y - slot.y, a.dir);
  }

  private resolveTarget(a: AgentRT, to: Target): { tile: Tile; face: Tile | null } {
    if ('seat' in to) {
      const s = seatOf(a.id);
      return { tile: s, face: { x: s.x, y: s.y - 1 } };
    }
    if ('meeting' in to) {
      const slot = MEETING_SLOTS[to.meeting % MEETING_SLOTS.length];
      return { tile: slot, face: MEETING_CENTER };
    }
    if ('tile' in to) return { tile: to.tile, face: to.face ?? null };
    // near another agent's seat: pick a free walkable neighbour
    const s = seatOf(to.near);
    const cands = [
      { x: s.x + 1, y: s.y },
      { x: s.x - 1, y: s.y },
      { x: s.x, y: s.y + 1 },
      { x: s.x + 1, y: s.y + 1 },
      { x: s.x - 1, y: s.y + 1 },
    ];
    for (const c of cands) if (this.grid[c.y]?.[c.x] && !this.isReserved(c, a)) return { tile: c, face: s };
    return { tile: cands[2], face: s };
  }

  private isReserved(tile: Tile, except: AgentRT): boolean {
    return this.agents.some((o) => {
      if (o === except) return false;
      const d = o.dest ?? { x: Math.round(o.x), y: Math.round(o.y) };
      return d.x === tile.x && d.y === tile.y;
    });
  }

  private sendTo(a: AgentRT, to: Target, activity: string, t: Task | null) {
    if (t) a.leisure = null;
    const { tile, face } = this.resolveTarget(a, to);
    const path = findPath(this.grid, { x: a.x, y: a.y }, tile) ?? [tile];
    a.path = path;
    a.dest = tile;
    a.face = face;
    a.posture = 'stand';
    a.action = path.length ? 'walk' : 'none';
    a.activity = activity;
    if (t) t.currentActivity = `${a.def.name}: ${activity}`;
    if (!path.length) this.arriveAt(a);
    this.pushRecent(a, activity);
    this.touch();
  }

  private arrived(a: AgentRT) {
    return a.path.length === 0;
  }

  private arriveAt(a: AgentRT) {
    a.action = a.busyTaskId ? 'none' : 'none';
    if (a.face) a.dir = dirFromDelta(a.face.x - a.x, a.face.y - a.y, a.dir);
    const s = seatOf(a.id);
    const breakingAway = a.leisure && a.leisure.phase !== 'returning';
    if (Math.round(a.x) === s.x && Math.round(a.y) === s.y && !breakingAway) {
      a.posture = 'sit';
      a.dir = 'br';
      if (!a.busyTaskId) a.activity = 'At desk';
    }
    a.dest = null;
    this.touch();
  }

  private moveAgent(a: AgentRT, dt: number) {
    if (!a.path.length) return;
    const next = a.path[0];
    // Simple courtesy: wait briefly if another agent is standing on the next tile.
    const occupied = this.agents.some(
      (o) => o !== a && Math.round(o.x) === next.x && Math.round(o.y) === next.y && !(o.x === a.x && o.y === a.y),
    );
    if (occupied && a.waitT < 0.6 && a.path.length > 0) {
      a.waitT += dt;
      return;
    }
    a.waitT = occupied ? a.waitT : 0;
    let step = WALK_SPEED * dt;
    while (step > 0 && a.path.length) {
      const n = a.path[0];
      const dx = n.x - a.x;
      const dy = n.y - a.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 0.0001) a.dir = dirFromDelta(dx, dy, a.dir);
      if (dist <= step) {
        a.x = n.x;
        a.y = n.y;
        step -= dist;
        a.stepPhase += dist;
        a.path.shift();
        a.waitT = 0;
      } else {
        a.x += (dx / dist) * step;
        a.y += (dy / dist) * step;
        a.stepPhase += step;
        step = 0;
      }
    }
    if (!a.path.length) this.arriveAt(a);
  }

  // ---------------------------------------------------------------- log & persistence
  addLog(text: string, kind: LogKind = 'info', agent?: AgentId, taskId?: string) {
    this.log.unshift({ id: this.logId++, at: Date.now(), text, kind, agent, taskId });
    if (this.log.length > 150) this.log.length = 150;
    if (agent) this.pushRecent(this.agentById[agent], text);
    this.touch();
    this.save();
  }

  private save() {
    if (!this.storage) return;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 400);
  }

  saveNow() {
    if (!this.storage) return;
    try {
      const data = {
        settings: this.settings,
        log: this.log.slice(0, 120),
        logId: this.logId,
        counts: Object.fromEntries(this.agents.map((a) => [a.id, a.completedCount])),
        tasks: this.tasks.slice(0, 60).map((t) => ({
          id: t.id,
          kind: t.kind,
          title: t.title,
          description: t.description,
          cast: t.cast,
          primary: t.primary,
          status: t.status,
          outputs: t.outputs,
          createdAt: t.createdAt,
          finishedAt: t.finishedAt,
          approval: t.approval,
          note: t.note,
          error: t.error,
          prompt: t.prompt,
          reviewed: t.reviewed,
        })),
      };
      this.storage.setItem(STORE_KEY, JSON.stringify(data));
    } catch {
      /* storage may be unavailable (private mode, quota) — the demo still works */
    }
  }

  private load() {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(STORE_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d.settings) this.settings = { ...this.settings, ...d.settings };
      if (Array.isArray(d.log)) this.log = d.log;
      if (typeof d.logId === 'number') this.logId = d.logId;
      if (d.counts) for (const a of this.agents) a.completedCount = Number(d.counts[a.id]) || 0;
      if (Array.isArray(d.tasks)) {
        this.tasks = d.tasks.map((t: Partial<Task>) => {
          const live = t.status === 'running' || t.status === 'queued' || t.status === 'awaiting_approval';
          return {
            ...t,
            status: live ? 'interrupted' : t.status,
            note: live ? 'Interrupted by a page reload. Start it again from the demo buttons.' : t.note,
            steps: [],
            cursor: 0,
            stepStarted: false,
            stepT: 0,
            holding: false,
            pending: null,
            pendingResult: null,
            outputs: t.outputs ?? [],
          } as Task;
        });
      }
    } catch {
      /* corrupt storage: start fresh */
    }
  }
}

export function dirFromDelta(dx: number, dy: number, prev: Dir): Dir {
  const sx = dx - dy; // screen x
  const sy = dx + dy; // screen y
  if (Math.abs(sx) < 1e-6 && Math.abs(sy) < 1e-6) return prev;
  const front = sy > 1e-6 || (Math.abs(sy) <= 1e-6 && prev[0] === 'f');
  const right = sx > 1e-6 || (Math.abs(sx) <= 1e-6 && prev[1] === 'r');
  return `${front ? 'f' : 'b'}${right ? 'r' : 'l'}` as Dir;
}

function performanceNow() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
