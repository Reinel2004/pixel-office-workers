import { useState } from 'react';
import { AGENT_BY_ID } from '../agents/roster';
import type { Engine } from '../sim/engine';
import type { LogKind } from '../sim/types';
import { IconChevron, IconList } from './icons';
import { Avatar, StatusChip, clock, timeAgo, useEngine } from './shared';

interface Props {
  engine: Engine;
  open: boolean;
  setOpen: (o: boolean) => void;
  onOpenTask: (id: string) => void;
  mobile: boolean;
}

const KIND_CLASS: Record<LogKind, string> = {
  info: 'k-info',
  success: 'k-success',
  warn: 'k-warn',
  error: 'k-error',
  approval: 'k-approval',
};

export function ActivityPanel({ engine, open, setOpen, onOpenTask, mobile }: Props) {
  useEngine(engine);
  const [tab, setTab] = useState<'activity' | 'tasks'>('activity');
  const unread = engine.log.length;

  if (!open) {
    return (
      <button className="feed-tab" onClick={() => setOpen(true)} aria-label="Open activity feed">
        <IconList size={16} />
        Activity
        {unread > 0 && <span className="count">{Math.min(unread, 99)}</span>}
      </button>
    );
  }

  return (
    <aside className={`panel feed ${mobile ? 'sheet' : ''}`} aria-label="Activity feed">
      <div className="panel-head">
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'activity'} className={tab === 'activity' ? 'on' : ''} onClick={() => setTab('activity')}>
            Activity
          </button>
          <button role="tab" aria-selected={tab === 'tasks'} className={tab === 'tasks' ? 'on' : ''} onClick={() => setTab('tasks')}>
            Tasks <span className="muted">{engine.tasks.length}</span>
          </button>
        </div>
        <button className="icon-btn sm" onClick={() => setOpen(false)} aria-label="Collapse activity feed" title="Collapse">
          <IconChevron open={false} style={{ transform: 'rotate(-90deg)' }} />
        </button>
      </div>
      <div className="panel-body scroll">
        {tab === 'activity' ? (
          engine.log.length === 0 ? (
            <Empty title="No activity yet" text="Start a demo workflow below, or assign a task to any agent." />
          ) : (
            <ul className="log">
              {engine.log.map((e) => (
                <li key={e.id} className={KIND_CLASS[e.kind]}>
                  <button className="log-item" onClick={() => e.taskId && onOpenTask(e.taskId)} disabled={!e.taskId}>
                    <span className="log-meta">
                      {e.agent ? <b style={{ color: AGENT_BY_ID[e.agent].tint }}>{AGENT_BY_ID[e.agent].name}</b> : <b>System</b>}
                      <time title={new Date(e.at).toLocaleString()}>{clock(e.at)}</time>
                    </span>
                    <span className="log-text">{e.text}</span>
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : engine.tasks.length === 0 ? (
          <Empty title="No tasks yet" text="Tasks you start appear here with their results and history." />
        ) : (
          <ul className="task-list">
            {engine.tasks.map((t) => (
              <li key={t.id}>
                <button className="task-row" onClick={() => onOpenTask(t.id)}>
                  <span className="avatars">
                    {t.cast.slice(0, 3).map((id) => (
                      <Avatar key={id} id={id} size={22} />
                    ))}
                  </span>
                  <span className="task-row-main">
                    <span className="task-row-title">{t.title}</span>
                    <span className="task-row-sub">{timeAgo(t.createdAt)}</span>
                  </span>
                  <StatusChip status={t.status} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

export function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty">
      <svg width="44" height="34" viewBox="0 0 44 34" aria-hidden="true">
        <path d="M22 3l19 10-19 10L3 13z" fill="#2a3346" />
        <path d="M3 13v8l19 10v-8z" fill="#202838" />
        <path d="M41 13v8L22 31v-8z" fill="#1a2130" />
        <path d="M22 9l7 3.7-7 3.7-7-3.7z" fill="#5fe0d2" opacity=".5" />
      </svg>
      <b>{title}</b>
      <p>{text}</p>
    </div>
  );
}
