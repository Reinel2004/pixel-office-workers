import { useSyncExternalStore } from 'react';
import { AGENT_BY_ID } from '../agents/roster';
import { agentPortrait } from '../office/sprites';
import type { Engine } from '../sim/engine';
import type { AgentId, AgentState, TaskStatus } from '../sim/types';

/** Re-render when the engine reports a UI-relevant change. */
export function useEngine(engine: Engine) {
  return useSyncExternalStore(engine.subscribe, engine.getVersion);
}

export const STATE_LABEL: Record<AgentState, string> = {
  idle: 'Idle',
  queued: 'Queued',
  working: 'Working',
  walking: 'Walking',
  waiting: 'Waiting for Approval',
  completed: 'Completed',
  error: 'Error',
};

export const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: 'Queued',
  running: 'In progress',
  awaiting_approval: 'Needs approval',
  completed: 'Completed',
  rejected: 'Rejected',
  failed: 'Failed',
  interrupted: 'Interrupted',
};

export function StateChip({ state }: { state: AgentState }) {
  return (
    <span className={`chip state-${state}`}>
      <i className="dot" />
      {STATE_LABEL[state]}
    </span>
  );
}

export function StatusChip({ status }: { status: TaskStatus }) {
  return <span className={`chip status-${status}`}>{STATUS_LABEL[status]}</span>;
}

export function Avatar({ id, size = 28 }: { id: AgentId; size?: number }) {
  const def = AGENT_BY_ID[id];
  return (
    <span className="avatar" style={{ width: size, height: size, ['--ring' as string]: def.tint }} title={def.name}>
      <img src={agentPortrait(def)} alt="" draggable={false} />
    </span>
  );
}

export function timeAgo(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(at).toLocaleDateString();
}

export function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
