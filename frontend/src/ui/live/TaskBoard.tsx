// Task Board (Connected Mode, "Tasks" tab): every report and assigned task of this account, with
// its agent, title, timestamps and status, and the pieces of a task's detail view: instructions,
// actual progress, the records looked up automatically (sources, period, retrieval time), the
// conversation, and the actions (reply, mark complete, cancel). Tasks live on the server, so they
// survive a page reload (and a server restart when TASKS_FILE is set).

import { useState, useSyncExternalStore, type ReactNode } from 'react';
import type { DataLookup, Job, JobStatus, LiveAgentId } from '../../../shared/live';
import { MAX_FOLLOW_UPS, MAX_PROMPT_CHARS } from '../../../shared/live';
import { formatManila } from '../../../shared/manila';
import { AGENT_BY_ID } from '../../agents/roster';
import type { LiveStore } from '../../live/store';
import { Empty } from '../ActivityPanel';
import { IconAlert, IconSend } from '../icons';
import { Avatar } from '../shared';

const useLive = (store: LiveStore) => useSyncExternalStore(store.subscribe, store.getVersion);

export const TASK_STATUS_LABEL: Record<JobStatus, string> = {
  queued: 'Queued',
  working: 'Working',
  needs_info: 'Needs information',
  ready_for_review: 'Ready for review',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};
export const TASK_STATUS_CLASS: Record<JobStatus, string> = {
  queued: 'status-queued',
  working: 'status-running',
  needs_info: 'status-awaiting_approval',
  ready_for_review: 'status-review',
  completed: 'status-completed',
  failed: 'status-failed',
  cancelled: 'status-interrupted',
};

type Filter = 'all' | 'active' | 'you' | 'done' | 'problems';
const FILTERS: { id: Filter; label: string; match: (s: JobStatus) => boolean }[] = [
  { id: 'all', label: 'All', match: () => true },
  { id: 'active', label: 'In progress', match: (s) => s === 'queued' || s === 'working' },
  { id: 'you', label: 'Needs you', match: (s) => s === 'needs_info' || s === 'ready_for_review' },
  { id: 'done', label: 'Completed', match: (s) => s === 'completed' },
  { id: 'problems', label: 'Failed / cancelled', match: (s) => s === 'failed' || s === 'cancelled' },
];

/** The board: one row per task, newest activity first. */
export function TaskBoard({ store, onOpen }: { store: LiveStore; onOpen: (id: string) => void }) {
  useLive(store);
  const [filter, setFilter] = useState<Filter>('all');
  const jobs = [...store.jobs].sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt));
  if (!jobs.length) return <Empty title="No tasks yet" text="Assign a task to an agent or run a report below. Tasks are kept on the server, so they stay here after a reload." />;
  const shown = jobs.filter((j) => FILTERS.find((f) => f.id === filter)!.match(j.status));
  return (
    <div className="stack">
      <div className="task-filters" role="toolbar" aria-label="Filter tasks">
        {FILTERS.map((f) => {
          const n = jobs.filter((j) => f.match(j.status)).length;
          return (
            <button key={f.id} className={`chip-btn ${filter === f.id ? 'on' : ''}`} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label} <span className="muted">{n}</span>
            </button>
          );
        })}
      </div>
      {shown.length === 0 ? (
        <p className="muted small">Nothing here.</p>
      ) : (
        <ul className="task-list">
          {shown.map((j) => (
            <li key={j.id}>
              <button className="task-row" onClick={() => onOpen(j.id)}>
                <span className="avatars">
                  {[...new Set(j.steps.map((s) => s.agent))].map((a) => (
                    <Avatar key={a} id={a} size={22} />
                  ))}
                </span>
                <span className="task-row-main">
                  <span className="task-row-title">{j.title}</span>
                  <span className="task-row-sub">
                    {agentNames(j)} · {j.type === 'ai.task' ? 'Assigned' : 'Report'} {formatManila(j.createdAt)}
                    {j.updatedAt && j.updatedAt !== j.createdAt ? ` · updated ${formatManila(j.updatedAt)}` : ''}
                  </span>
                </span>
                <TaskChip status={j.status} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function TaskChip({ status }: { status: JobStatus }) {
  return <span className={`chip ${TASK_STATUS_CLASS[status]}`}>{TASK_STATUS_LABEL[status]}</span>;
}

function agentNames(j: Job) {
  return [...new Set(j.steps.map((s) => AGENT_BY_ID[s.agent].name))].join(', ');
}

/** What the task was asked to do. */
export function TaskInstructions({ job }: { job: Job }) {
  const first = job.thread?.[0]?.text ?? job.prompt;
  return (
    <section className="task-section">
      <h3>Instructions</h3>
      {job.type === 'ai.task' ? (
        <blockquote className="prompt">{first}</blockquote>
      ) : (
        <p className="small">
          {job.title} for {job.range.from} to {job.range.to} (Asia/Manila), calculated by code from live records.
        </p>
      )}
    </section>
  );
}

/** What actually happened, with times (from the server's records of the task). */
export function TaskProgress({ job }: { job: Job }) {
  const rows: { at?: string; text: string }[] = [{ at: job.createdAt, text: `Created by ${job.requestedBy}` }];
  if (job.startedAt) rows.push({ at: job.startedAt, text: 'Started' });
  for (const s of job.steps) {
    const who = AGENT_BY_ID[s.agent].name;
    if (s.startedAt) rows.push({ at: s.startedAt, text: `${who}: ${s.label}` });
    if (s.finishedAt) rows.push({ at: s.finishedAt, text: `${who}: ${s.status === 'completed' ? 'done' : s.status}${s.result?.summary ? ` — ${s.result.summary}` : s.error ? ` — ${s.error.message}` : ''}` });
  }
  const turns = (job.thread ?? []).slice(1);
  for (const t of turns) if (t.role === 'user') rows.push({ at: t.at, text: `Follow-up from ${job.requestedBy}` });
  if (job.status === 'needs_info' && job.finishedAt) rows.push({ at: job.finishedAt, text: 'Waiting for your answer' });
  if (job.status === 'ready_for_review' && job.finishedAt) rows.push({ at: job.finishedAt, text: 'Ready for your review' });
  if (job.reviewedAt) rows.push({ at: job.reviewedAt, text: `Marked complete by ${job.reviewedBy}` });
  if (job.status === 'cancelled') rows.push({ at: job.finishedAt, text: `Cancelled${job.cancelledBy ? ` by ${job.cancelledBy}` : ''}` });
  if (job.status === 'failed') rows.push({ at: job.finishedAt, text: `Failed${job.error ? `: ${job.error.message}` : ''}` });
  rows.sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
  return (
    <details className="task-section" open={job.status === 'queued' || job.status === 'working'}>
      <summary>
        <h3>Progress</h3>
      </summary>
      <ol className="task-timeline">
        {rows.map((r, i) => (
          <li key={i}>
            <time>{r.at ? formatManila(r.at) : ''}</time>
            <span>{r.text}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}

const LOOKUP_STATUS: Record<DataLookup['status'], { label: string; cls: string }> = {
  ok: { label: 'Retrieved', cls: 'status-completed' },
  empty: { label: 'No records', cls: 'status-queued' },
  unavailable: { label: 'Not available', cls: 'status-failed' },
  not_allowed: { label: 'No permission', cls: 'status-awaiting_approval' },
};

/** Records the office read by code before the AI answered: figures, period, source and time — or why not. */
export function LookupList({ lookups }: { lookups: DataLookup[] }) {
  if (!lookups.length) return null;
  return (
    <section className="task-section">
      <h3>Looked up automatically</h3>
      <div className="lookup-list">
        {lookups.map((l, i) => (
          <article key={i} className={`lookup lk-${l.status}`}>
            <header>
              <b>{l.title}</b>
              <span className={`chip ${LOOKUP_STATUS[l.status].cls}`}>{LOOKUP_STATUS[l.status].label}</span>
            </header>
            <p className="muted small">
              Period: {l.range ? `${l.range.from} to ${l.range.to}` : 'right now'} · {l.rangeLabel}
            </p>
            {l.figures.length > 0 && (
              <div className="kv">
                {l.figures.map((f) => (
                  <div key={f.label}>
                    <span>{f.label}</span>
                    <b>{f.value}</b>
                  </div>
                ))}
              </div>
            )}
            {l.message && (
              <p className={`small ${l.status === 'ok' || l.status === 'empty' ? 'muted' : 'lookup-limit'}`}>
                {l.status === 'unavailable' || l.status === 'not_allowed' ? <IconAlert size={12} /> : null} {l.message}
              </p>
            )}
            {l.source ? (
              <p className="muted small">
                Source: {l.source.systemName} ({l.source.host}) · retrieved {formatManila(l.source.retrievedAt)} · {l.source.recordCount} record(s) · totals calculated by code
              </p>
            ) : (
              (l.status === 'unavailable' || l.status === 'not_allowed') && <p className="muted small">Nothing was estimated and no demo data was used in its place.</p>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

/** Earlier messages of a task (the latest answer is shown in full below it). */
export function TaskConversation({ job, render }: { job: Job; render: (text: string) => ReactNode }) {
  const t = job.thread ?? [];
  const lastUser = t.map((x) => x.role).lastIndexOf('user');
  const earlier = t.slice(0, Math.max(0, lastUser));
  if (!earlier.length) return null;
  const agent = job.agent ? AGENT_BY_ID[job.agent].name : 'Agent';
  return (
    <section className="task-section">
      <h3>Conversation</h3>
      <ol className="thread">
        {[...earlier, t[lastUser]].map((m, i) => (
          <li key={i} className={`msg ${m.role}`}>
            <span className="msg-meta">
              <b>{m.role === 'user' ? job.requestedBy : agent}</b> <time>{formatManila(m.at)}</time>
              {m.outcome === 'needs_info' && <span className="chip status-awaiting_approval">asked a question</span>}
              {m.outcome === 'failed' && <span className="chip status-failed">failed</span>}
              {m.outcome === 'cancelled' && <span className="chip status-interrupted">cancelled</span>}
            </span>
            <div className="msg-text">{m.role === 'agent' && m.outcome !== 'failed' && m.outcome !== 'cancelled' ? render(m.text) : m.text}</div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Reply / follow up, mark complete, cancel. */
export function TaskActions({ store, job }: { store: LiveStore; job: Job }) {
  useLive(store);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const busy = store.jobBusy.has(job.id);
  const isAi = job.type === 'ai.task';
  const agent = job.agent ? AGENT_BY_ID[job.agent as LiveAgentId].name : 'the agent';
  const followUps = (job.thread ?? []).filter((t) => t.role === 'user').length - 1;
  const canReply = isAi && ['needs_info', 'ready_for_review', 'completed', 'failed'].includes(job.status) && followUps < MAX_FOLLOW_UPS;
  const canCancel = ['queued', 'working', 'needs_info', 'ready_for_review'].includes(job.status);
  const canComplete = job.status === 'ready_for_review' || job.status === 'needs_info';
  const run = async (p: Promise<string | null>) => {
    setError(null);
    const err = await p;
    if (err) setError(err);
    return !err;
  };
  return (
    <section className="task-section task-actions">
      {canReply && (
        <form
          className="reply-box"
          onSubmit={async (e) => {
            e.preventDefault();
            if (text.trim() && (await run(store.followUp(job.id, text)))) setText('');
          }}
        >
          <label htmlFor={`reply-${job.id}`} className="small">
            {job.status === 'needs_info' ? `Answer ${agent}'s question` : `Follow up with ${agent}`}
          </label>
          <textarea
            id={`reply-${job.id}`}
            value={text}
            maxLength={MAX_PROMPT_CHARS}
            rows={2}
            placeholder={job.status === 'needs_info' ? 'Type your answer…' : 'Ask a follow-up question or for a change…'}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) (e.currentTarget.form as HTMLFormElement).requestSubmit();
            }}
          />
          <div className="row between">
            <span className="muted small">{MAX_FOLLOW_UPS - followUps} follow-up(s) left · Ctrl+Enter sends</span>
            <button className="btn sm primary" disabled={busy || !text.trim()}>
              <IconSend size={14} /> Send
            </button>
          </div>
        </form>
      )}
      <div className="row wrap gap-s">
        {canComplete && (
          <button className="btn sm success" disabled={busy} onClick={() => void run(store.completeJob(job.id))} title="You checked the answer">
            Mark complete
          </button>
        )}
        {canCancel && (
          <button className="btn sm danger-ghost" disabled={busy} onClick={() => void run(store.cancelJob(job.id))}>
            Cancel task
          </button>
        )}
      </div>
      {error && <p className="form-error">{error}</p>}
    </section>
  );
}
