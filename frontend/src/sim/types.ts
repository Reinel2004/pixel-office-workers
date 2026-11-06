export type AgentId = 'lia' | 'marco' | 'paolo' | 'nina' | 'bea' | 'rosa' | 'mika' | 'carlo' | 'dev' | 'chief';

export type RoomId =
  | 'intel'
  | 'ops'
  | 'dev'
  | 'creative'
  | 'command'
  | 'sales'
  | 'pantry'
  | 'content'
  | 'finance'
  | 'gym'
  | 'court';

export type AgentState = 'idle' | 'queued' | 'working' | 'walking' | 'waiting' | 'completed' | 'error';

export type AppMode = 'demo' | 'connected';

/** Facing on screen: front-left, front-right, back-left, back-right. */
export type Dir = 'fl' | 'fr' | 'bl' | 'br';

export type TaskKind = 'inquiry' | 'production' | 'marketing' | 'custom';

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'rejected'
  | 'failed'
  | 'interrupted';

export interface QuoteLine {
  item: string;
  qty: number;
  unit: number;
}

export interface TaskOutput {
  title: string;
  body: string;
  /** 'template' = predefined demo text. 'ai' is reserved for a future real model. */
  source: 'template' | 'ai';
  quote?: { lines: QuoteLine[]; note: string };
  checklist?: { label: string; value?: string }[];
  flags?: { ref: string; issue: string; level: 'warn' | 'ok' }[];
}

export type LogKind = 'info' | 'success' | 'warn' | 'error' | 'approval';

export interface LogEntry {
  id: number;
  at: number; // wall-clock ms
  text: string;
  kind: LogKind;
  agent?: AgentId;
  taskId?: string;
}

export interface Settings {
  sound: boolean;
  reducedMotion: boolean;
  speed: 1 | 2;
  labels: boolean;
  /** Idle agents take breaks: gym, court, pantry or a walk. Off with reduced motion. */
  breaks: boolean;
  feedOpen: boolean;
  mode: AppMode;
}

export type Selection =
  | { kind: 'agent'; id: AgentId }
  | { kind: 'room'; id: RoomId }
  | { kind: 'task'; id: string }
  | { kind: 'job'; id: string }
  | null;
