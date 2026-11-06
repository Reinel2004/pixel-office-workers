// Connected Mode panels: report bar, sign-in card, live feed tabs, and job/result details.

import { Fragment, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { ErrorCode, Job, JobStep, LiveAgentId, Money, ReportPayload, ReportType, StepResult, SystemStatus } from '../../../shared/live';
import { IMAGE_AGENTS, LIVE_AGENT_IDS, MAX_PROMPT_CHARS, SYSTEM_NAMES } from '../../../shared/live';
import { formatManila, isIsoDate, type RangePreset } from '../../../shared/manila';
import { AGENT_BY_ID } from '../../agents/roster';
import type { AgentId } from '../../sim/types';
import type { LiveStore } from '../../live/store';
import { Empty } from '../ActivityPanel';
import { IconAlert, IconCamera, IconChevron, IconClose, IconRetry, IconSend } from '../icons';
import { Avatar } from '../shared';

export function useLive(store: LiveStore) {
  return useSyncExternalStore(store.subscribe, store.getVersion);
}

export const JOB_STATUS_LABEL: Record<Job['status'], string> = {
  queued: 'Queued',
  working: 'Working',
  completed: 'Completed',
  failed: 'Failed',
};
const STATUS_CLASS: Record<Job['status'], string> = {
  queued: 'status-queued',
  working: 'status-running',
  completed: 'status-completed',
  failed: 'status-failed',
};
export function JobChip({ status }: { status: Job['status'] }) {
  return <span className={`chip ${STATUS_CLASS[status]}`}>{JOB_STATUS_LABEL[status]}</span>;
}

/** Plain-language meaning of each failure, so "not set up" never looks like "no data". */
const ERROR_HELP: Record<ErrorCode, string> = {
  NOT_CONFIGURED: 'Not configured on the server yet',
  AWAITING_DOCUMENTATION: 'Waiting for API documentation',
  NOT_SUPPORTED: 'This system does not provide this data',
  HOST_NOT_ALLOWED: 'Blocked: outside the approved API address',
  AUTH_FAILED: 'Server credentials rejected or expired',
  PERMISSION_DENIED: 'Permission denied',
  RATE_LIMITED: 'Rate limited by the system',
  TIMEOUT: 'The system did not respond in time',
  NETWORK: 'Connection error',
  UPSTREAM_ERROR: 'The system returned an error',
  INVALID_RESPONSE: 'Unexpected response — result rejected',
  RESULT_TOO_LARGE: 'Too many records — use a shorter range',
  DEPENDENCY_FAILED: 'Could not combine — a source failed',
  INTERNAL: 'Server error',
};

export function money(list: Money[] | null | undefined): string {
  if (!list || list.length === 0) return '₱0.00';
  return list
    .map((m) => {
      const v = (m.centavos / 100).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      return m.currency === 'PHP' ? `₱${v}`.replace('₱-', '−₱') : `${m.currency} ${v}`;
    })
    .join(' + ');
}

// ---------------------------------------------------------------- report bar
const REPORTS: { type: ReportType; label: string; agent: LiveAgentId }[] = [
  { type: 'finance.summary', label: 'Finance summary', agent: 'bea' },
  { type: 'orders.status', label: 'Order status', agent: 'paolo' },
  { type: 'orders.overdue', label: 'Overdue orders', agent: 'paolo' },
  { type: 'combined.report', label: 'Combined report', agent: 'chief' },
];
const PRESETS: { id: RangePreset | 'custom'; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'last7', label: 'Last 7 days' },
  { id: 'thisMonth', label: 'This month' },
  { id: 'lastMonth', label: 'Last month' },
  { id: 'thisYear', label: 'This year' },
  { id: 'custom', label: 'Custom' },
];

const TASK_EXAMPLES: Record<LiveAgentId, string> = {
  lia: 'Draft a reply asking a customer for door size and design',
  marco: 'Outline a quotation for 2 flush doors',
  paolo: 'Which orders are still in production and due this month?',
  nina: 'Plan deliveries for open orders due in the next 2 weeks',
  bea: 'What were our biggest expense categories this month?',
  rosa: 'Which finished orders still have a balance? Draft a reminder for the biggest one',
  mika: 'What sold best in the last 6 months, and where does production slow down?',
  carlo: 'Write a Facebook caption for a finished narra main door',
  dev: 'Check open orders for missing due dates or odd statuses',
  chief: 'What should the team prioritise today?',
};

export function ConnectedBar({
  store,
  onOpenJob,
  agent,
  setAgent,
  focusSignal,
}: {
  store: LiveStore;
  onOpenJob: (id: string) => void;
  agent: AgentId;
  setAgent: (id: AgentId) => void;
  focusSignal: number;
}) {
  useLive(store);
  const [text, setText] = useState('');
  const [photo, setPhoto] = useState<string | null>(null);
  const [photoNote, setPhotoNote] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusSignal) input.current?.focus();
  }, [focusSignal]);
  const signedIn = store.server === 'signed_in';
  const r = store.range;
  const rangeOk = isIsoDate(r.from) && isIsoDate(r.to) && r.from <= r.to;
  const assign = store.canAssign();
  const who = agent as LiveAgentId;
  const takesPhoto = IMAGE_AGENTS.includes(who);
  const usePhoto = takesPhoto ? photo : null;
  const submitTask = async () => {
    const v = text.trim();
    if ((!v && !usePhoto) || !assign.ok) return;
    const job = await store.submitAi(who, v, usePhoto ?? undefined);
    if (job) {
      setText('');
      setPhoto(null);
      setPhotoNote(null);
      onOpenJob(job.id);
    }
  };
  const pickPhoto = async (file: File | undefined) => {
    if (!file) return;
    setPhotoBusy(true);
    setPhotoNote(null);
    try {
      setPhoto(await shrinkPhoto(file));
    } catch (e) {
      setPhoto(null);
      setPhotoNote((e as Error).message);
    } finally {
      setPhotoBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };
  return (
    <>
      <div className="demos" role="group" aria-label="Live reports">
        <span className="demos-label">Reports</span>
        {REPORTS.map((rep) => {
          const can = signedIn ? store.canSubmit(rep.type) : { ok: false, reason: 'Sign in first.' };
          return (
            <button
              key={rep.type}
              className="demo-btn live"
              disabled={!can.ok || !rangeOk}
              title={can.reason ?? `${AGENT_BY_ID[rep.agent].name} runs this report`}
              onClick={async () => {
                const job = await store.submit(rep.type);
                if (job) onOpenJob(job.id);
              }}
            >
              <Avatar id={rep.agent} size={20} />
              {rep.label}
            </button>
          );
        })}
      </div>
      <div className="range" role="group" aria-label="Report date range">
        <label className="sr-only" htmlFor="range-preset">
          Date range
        </label>
        <select id="range-preset" value={store.preset} onChange={(e) => store.setPreset(e.target.value as RangePreset | 'custom')}>
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="range-from">
          From
        </label>
        <input id="range-from" type="date" value={r.from} max={r.to} onChange={(e) => store.setRange({ from: e.target.value, to: r.to })} />
        <span className="muted small">to</span>
        <label className="sr-only" htmlFor="range-to">
          To
        </label>
        <input id="range-to" type="date" value={r.to} min={r.from} onChange={(e) => store.setRange({ from: r.from, to: e.target.value })} />
        <span className="tz">Asia/Manila</span>
      </div>
      <form
        className="task-input"
        onSubmit={(e) => {
          e.preventDefault();
          void submitTask();
        }}
      >
        <label className="sr-only" htmlFor="live-agent-select">
          Agent
        </label>
        <select id="live-agent-select" value={agent} onChange={(e) => setAgent(e.target.value as AgentId)}>
          {LIVE_AGENT_IDS.map((id) => (
            <option key={id} value={id}>
              {AGENT_BY_ID[id].name} — {AGENT_BY_ID[id].role}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="live-task-text">
          Task
        </label>
        <input
          id="live-task-text"
          ref={input}
          value={text}
          maxLength={MAX_PROMPT_CHARS}
          onChange={(e) => setText(e.target.value)}
          placeholder={
            !assign.ok ? 'AI tasks are not set up on the server' : usePhoto ? 'Optional: details, e.g. narra, for a Batangas client' : `e.g. ${TASK_EXAMPLES[who]}`
          }
          disabled={!assign.ok}
          autoComplete="off"
        />
        {takesPhoto && (
          <>
            <input
              ref={fileInput}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              hidden
              onChange={(e) => void pickPhoto(e.target.files?.[0])}
            />
            {usePhoto ? (
              <span className="photo-chip" title="This photo will be sent with the task">
                <img src={usePhoto} alt="Selected photo" />
                <button type="button" className="icon-btn" aria-label="Remove photo" onClick={() => setPhoto(null)}>
                  <IconClose size={12} />
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="btn"
                disabled={!assign.ok || photoBusy}
                onClick={() => fileInput.current?.click()}
                title={`Add a photo for ${AGENT_BY_ID[who].name} to look at (JPEG, PNG or WebP). It is sent to Google Gemini for analysis.`}
              >
                <IconCamera size={16} />
                <span className="hide-narrow">{photoBusy ? 'Reading…' : 'Photo'}</span>
              </button>
            )}
          </>
        )}
        <button className="btn primary" type="submit" disabled={!assign.ok || (!text.trim() && !usePhoto)} title={assign.reason}>
          <IconSend size={16} />
          <span>Assign</span>
        </button>
      </form>
      {photoNote && takesPhoto && (
        <p className="muted small photo-note" role="alert">
          {photoNote}
        </p>
      )}
      <p className="ai-note">
        {store.ai?.ready
          ? `Reports are calculated by code. Assigned tasks are answered by AI (Gemini) using read-only live data — check answers before acting on them.`
          : 'Reports are calculated by code from live records. To assign free-text tasks, add GEMINI_API_KEY to the server .env and restart it.'}
      </p>
    </>
  );
}

// ---------------------------------------------------------------- sign-in / unreachable
export function ConnectGate({ store, onDemo }: { store: LiveStore; onDemo: () => void }) {
  useLive(store);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (store.server === 'signed_in') return null;
  return (
    <div className="gate" role="dialog" aria-modal="false" aria-labelledby="gate-title">
      <div className="gate-card">
        {store.server === 'unreachable' ? (
          <>
            <h2 id="gate-title">Connected Mode server not found</h2>
            <p className="muted">
              Live data is only available when this office is served by its Connected Mode server, which holds the API credentials. This copy is running without it
              (for example, the shared preview).
            </p>
            <div className="row">
              <button className="btn" onClick={() => store.init()}>
                <IconRetry size={15} /> Check again
              </button>
              <button className="btn primary" onClick={onDemo}>
                Back to Demo Mode
              </button>
            </div>
          </>
        ) : store.server === 'checking' || store.server === 'unknown' ? (
          <>
            <h2 id="gate-title">Connecting…</h2>
            <span className="spinner" aria-hidden="true" />
          </>
        ) : (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError(await store.login(username.trim(), password));
              setPassword('');
              setBusy(false);
            }}
          >
            <h2 id="gate-title">Sign in to Connected Mode</h2>
            <p className="muted small">Read-only access to WAD Furniture Management and WAD Order Management.</p>
            <label htmlFor="gate-user">Username</label>
            <input id="gate-user" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
            <label htmlFor="gate-pass">Password</label>
            <input id="gate-pass" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <div className="row">
              <button type="button" className="btn ghost" onClick={onDemo}>
                Use Demo Mode
              </button>
              <button className="btn primary" type="submit" disabled={busy || !username || !password}>
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- feed (activity / reports / systems)
export function LiveFeed({ store, open, setOpen, onOpenJob, mobile }: { store: LiveStore; open: boolean; setOpen: (o: boolean) => void; onOpenJob: (id: string) => void; mobile: boolean }) {
  useLive(store);
  const [tab, setTab] = useState<'activity' | 'reports' | 'systems'>('activity');
  if (!open)
    return (
      <button className="feed-tab" onClick={() => setOpen(true)} aria-label="Open live activity feed">
        Live activity {store.log.length > 0 && <span className="count">{Math.min(store.log.length, 99)}</span>}
      </button>
    );
  return (
    <aside className={`panel feed ${mobile ? 'sheet' : ''}`} aria-label="Live activity">
      <div className="panel-head">
        <div className="tabs" role="tablist">
          {(['activity', 'reports', 'systems'] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
              {t === 'activity' ? 'Activity' : t === 'reports' ? 'Reports' : 'Systems'}
            </button>
          ))}
        </div>
        <button className="icon-btn sm" onClick={() => setOpen(false)} aria-label="Collapse live activity feed" title="Collapse">
          <IconChevron open={false} style={{ transform: 'rotate(-90deg)' }} />
        </button>
      </div>
      <div className="panel-body scroll">
        {tab === 'activity' &&
          (store.log.length === 0 ? (
            <Empty title="No live activity yet" text="Pick a date range and run a report below." />
          ) : (
            <ul className="log">
              {store.log.map((e) => (
                <li key={e.id} className={`k-${e.kind}`}>
                  <button className="log-item" onClick={() => e.jobId && onOpenJob(e.jobId)} disabled={!e.jobId}>
                    <span className="log-meta">
                      {e.agent ? <b style={{ color: AGENT_BY_ID[e.agent].tint }}>{AGENT_BY_ID[e.agent].name}</b> : <b>Server</b>}
                      <time>{formatManila(new Date(e.at).toISOString())}</time>
                    </span>
                    <span className="log-text">{e.text}</span>
                  </button>
                </li>
              ))}
            </ul>
          ))}
        {tab === 'reports' &&
          (store.jobs.length === 0 ? (
            <Empty title="No reports yet" text="Live reports you run appear here. They are kept on the server, not in this browser." />
          ) : (
            <ul className="task-list">
              {store.jobs.map((j) => (
                <li key={j.id}>
                  <button className="task-row" onClick={() => onOpenJob(j.id)}>
                    <span className="avatars">
                      {[...new Set(j.steps.map((s) => s.agent))].map((a) => (
                        <Avatar key={a} id={a} size={22} />
                      ))}
                    </span>
                    <span className="task-row-main">
                      <span className="task-row-title">{j.title}</span>
                      <span className="task-row-sub">
                        {j.range.from} to {j.range.to}
                      </span>
                    </span>
                    <JobChip status={j.status} />
                  </button>
                </li>
              ))}
            </ul>
          ))}
        {tab === 'systems' && <SystemsList systems={store.systems} />}
      </div>
    </aside>
  );
}

const SYS_STATE: Record<SystemStatus['state'], { label: string; cls: string }> = {
  ready: { label: 'Connected (read-only)', cls: 'status-completed' },
  awaiting_documentation: { label: 'Awaiting documentation', cls: 'status-awaiting_approval' },
  not_configured: { label: 'Not configured', cls: 'status-interrupted' },
};

export function SystemsList({ systems }: { systems: SystemStatus[] }) {
  if (!systems.length) return <Empty title="No status yet" text="Sign in to see the connection status of each system." />;
  return (
    <div className="stack">
      {systems.map((s) => (
        <article key={s.id} className="output">
          <header>
            <b>{s.name}</b>
            <span className={`chip ${SYS_STATE[s.state].cls}`}>{SYS_STATE[s.state].label}</span>
          </header>
          <p className="muted small">{s.host ? `Approved host: ${s.host}` : 'No approved base URL set.'}</p>
          {s.problems.length > 0 && (
            <ul className="mini-list">
              {s.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          <p className="muted small">Access: read-only. This office never creates or changes records.</p>
        </article>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- job detail
export function JobDetail({ store, job, onOpenAgent }: { store: LiveStore; job: Job; onOpenAgent: (id: LiveAgentId) => void }) {
  useLive(store);
  const isAi = job.type === 'ai.task';
  const can = isAi ? store.canAssign() : store.canSubmit(job.type as ReportType);
  return (
    <div className="stack">
      <div>
        <span className="live-tag">{isAi ? 'AI task · live data' : 'Live data'}</span>
        <h2>{isAi ? `Task for ${AGENT_BY_ID[job.agent ?? job.steps[0].agent].name}` : job.title}</h2>
        <div className="row wrap gap-s">
          <JobChip status={job.status} />
          {!isAi && (
            <span className="muted small">
              {job.range.from} to {job.range.to} · Asia/Manila
            </span>
          )}
        </div>
        {isAi && <blockquote className="prompt">{job.prompt}</blockquote>}
        {isAi && job.image && (
          store.images.get(job.id) ? (
            <img className="task-photo" src={store.images.get(job.id)} alt="Photo sent with this task" />
          ) : (
            <p className="muted small">A photo was sent with this task (not kept after a reload).</p>
          )
        )}
        <p className="muted small">Requested {formatManila(job.createdAt)} by {job.requestedBy}</p>
      </div>
      {job.steps.map((s) => (
        <StepCard key={s.id} step={s} onOpenAgent={onOpenAgent} />
      ))}
      {job.status === 'failed' && (
        <button
          className="btn"
          disabled={!can.ok}
          title={can.reason}
          onClick={() => (isAi ? store.submitAi(job.agent!, job.prompt!, store.images.get(job.id)) : store.submit(job.type as ReportType, job.range))}
        >
          <IconRetry size={15} /> Run again
        </button>
      )}
    </div>
  );
}

export function StepCard({ step, onOpenAgent }: { step: JobStep; onOpenAgent?: (id: LiveAgentId) => void }) {
  const a = AGENT_BY_ID[step.agent];
  return (
    <article className="output step">
      <header>
        <button className="cast" onClick={() => onOpenAgent?.(step.agent)} disabled={!onOpenAgent}>
          <Avatar id={step.agent} size={24} />
          <span>{a.name}</span>
        </button>
        <JobChip status={step.status} />
      </header>
      <p className="step-label">{step.label}</p>
      {step.system && <p className="muted small">Source system: {SYSTEM_NAMES[step.system]}</p>}
      {(step.status === 'queued' || step.status === 'working') && (
        <div className="notice live">
          <span className="spinner" aria-hidden="true" />
          <p>{step.status === 'queued' ? 'Waiting to start.' : step.system ? 'Waiting for the system to respond.' : 'Working on it — this can take up to a minute.'}</p>
        </div>
      )}
      {step.error && (
        <div className={`notice ${step.error.code === 'AWAITING_DOCUMENTATION' || step.error.code === 'NOT_CONFIGURED' ? 'setup' : 'error'}`}>
          <IconAlert size={16} />
          <div>
            <b>{ERROR_HELP[step.error.code]}</b>
            <p>{step.error.message}</p>
            <p className="muted small">
              No demo or estimated data was used in its place.{step.error.retryable ? ' This can be retried.' : ''}
            </p>
          </div>
        </div>
      )}
      {step.result && <ResultView r={step.result} />}
    </article>
  );
}

function ResultView({ r }: { r: StepResult }) {
  if (r.generatedBy === 'ai') return <AiResultView r={r} />;
  return (
    <div className="stack result">
      <p className={r.empty ? 'note warn' : 'note'}>{r.summary}</p>
      <span className="tag code-tag">Calculated by code from live records — no AI</span>
      <div className="sources">
        {r.sources.map((s, i) => (
          <div key={i} className="source">
            <b>{s.systemName}</b>
            <span>{s.host}</span>
            <span>Retrieved {formatManila(s.retrievedAt)}</span>
            <span>{s.recordCount} record(s)</span>
          </div>
        ))}
      </div>
      {r.report && <ReportView rep={r.report} names={r.customers ?? {}} />}
      {r.notes.length > 0 && (
        <ul className="mini-list notes">
          {r.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      {r.references.length > 0 && (
        <details className="refs">
          <summary>
            Record references ({r.references.length}
            {r.referencesTruncated ? '+' : ''})
          </summary>
          <div className="ref-chips">
            {r.references.map((x) => (
              <code key={x}>{r.customers?.[x] ? `${r.customers[x]} · ${x}` : x}</code>
            ))}
          </div>
          {r.referencesTruncated && <p className="muted small">Only the first {r.references.length} are listed.</p>}
        </details>
      )}
    </div>
  );
}

const TOOL_LABEL: Record<string, string> = {
  get_orders: 'Orders by date',
  get_open_orders: 'Open orders',
  get_finance: 'Finance records',
  get_collections: 'Order balances',
  get_order_trends: 'Order trends',
  get_product_mix: 'Product mix',
  get_production_pipeline: 'Production pipeline',
  get_finance_trends: 'Finance trends',
};

function AiResultView({ r }: { r: StepResult }) {
  return (
    <div className="stack result">
      <div className="ai-answer">
        <Markdownish text={r.answer ?? ''} names={r.customers ?? {}} />
      </div>
      {Object.keys(r.customers ?? {}).length > 0 && (
        <p className="muted small">Customer names are added by the office from WAD Order Management. The AI only saw order numbers.</p>
      )}
      <span className="tag ai-tag">Written by AI ({r.model ?? 'Gemini'}) — totals come from code, but check before acting</span>
      {r.lookups && r.lookups.length > 0 && (
        <ul className="mini-list notes">
          {r.lookups.map((l, i) => (
            <li key={i} className={l.ok ? '' : 'warn'}>
              {l.ok ? 'Looked up' : 'Could not look up'}: {TOOL_LABEL[l.tool] ?? l.tool} ({l.detail})
            </li>
          ))}
        </ul>
      )}
      {r.sources.length > 0 && (
        <div className="sources">
          {r.sources.map((s, i) => (
            <div key={i} className="source">
              <b>{s.systemName}</b>
              <span>{s.host}</span>
              <span>Retrieved {formatManila(s.retrievedAt)}</span>
              <span>{s.recordCount} record(s)</span>
            </div>
          ))}
        </div>
      )}
      {r.references.length > 0 && (
        <details className="refs">
          <summary>Records the AI was given ({r.references.length}{r.referencesTruncated ? '+' : ''})</summary>
          <div className="ref-chips">
            {r.references.map((x) => (
              <code key={x}>{r.customers?.[x] ? `${r.customers[x]} · ${x}` : x}</code>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

/** Order number shown with the customer's name when the order system gave one. */
function OrderName({ ref_, names }: { ref_: string; names: Record<string, string> }) {
  const name = names[ref_];
  return name ? (
    <b className="order-name" title={ref_}>
      <span className="order-customer">{name}</span>
      <span className="order-ref">{ref_}</span>
    </b>
  ) : (
    <b>{ref_}</b>
  );
}

const ORDER_REF = /\b(ORD-[A-Za-z0-9]+)\b/g;

/**
 * Puts customer names next to order numbers in the AI's text. The AI never saw the names; this
 * happens only in the browser. If the answer is about exactly one named order, a
 * "[Customer name]" placeholder in a draft is filled in too.
 */
function withNames(text: string, names: Record<string, string>): string {
  if (!Object.keys(names).length) return text;
  const mentioned = [...new Set([...text.matchAll(ORDER_REF)].map((m) => m[1]))].filter((r) => names[r]);
  let out = text.replace(ORDER_REF, (ref) => (names[ref] ? `${names[ref]} (${ref})` : ref));
  if (mentioned.length === 1) out = out.replace(/\[Customer name\]/gi, names[mentioned[0]]);
  return out;
}

/** Renders the AI's light Markdown (paragraphs, "- " bullets, **bold**, headings) as plain React text — never as HTML. */
function Markdownish({ text: raw0, names = {} }: { text: string; names?: Record<string, string> }) {
  const text = withNames(raw0, names);
  const inline = (s: string): ReactNode[] =>
    s.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (part.startsWith('**') && part.endsWith('**') && part.length > 4 ? <b key={i}>{part.slice(2, -2)}</b> : <Fragment key={i}>{part}</Fragment>));
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) blocks.push(<ul key={`l${blocks.length}`}>{list.map((li, i) => <li key={i}>{inline(li)}</li>)}</ul>);
    list = [];
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const bullet = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      list.push(bullet[1]);
      continue;
    }
    flush();
    if (!line.trim()) continue;
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    blocks.push(h ? <p key={`h${blocks.length}`} className="ai-h">{inline(h[1])}</p> : <p key={`p${blocks.length}`}>{inline(line)}</p>);
  }
  flush();
  return <>{blocks}</>;
}

function ReportView({ rep, names }: { rep: ReportPayload; names: Record<string, string> }) {
  switch (rep.kind) {
    case 'finance.summary':
      return (
        <div className="kv">
          <div>
            <span>Income</span>
            <b>{money(rep.income)}</b>
          </div>
          <div>
            <span>Expenses</span>
            <b>{money(rep.expenses)}</b>
          </div>
          <div>
            <span>Net (recorded)</span>
            <b>{money(rep.net)}</b>
          </div>
          {rep.expensesByCategory.map((c) => (
            <div key={c.category} className="sub">
              <span>{c.category}</span>
              <b>{money(c.amounts)}</b>
            </div>
          ))}
          {rep.budgets.map((b) => (
            <div key={b.ref} className="sub">
              <span>Budget: {b.name}</span>
              <b>
                {money(b.amounts)}
                {b.remaining ? ` · remaining ${money(b.remaining)}` : ''}
              </b>
            </div>
          ))}
        </div>
      );
    case 'orders.status':
      return (
        <div className="kv">
          {rep.byStatus.map((s) => (
            <div key={s.status}>
              <span>{s.status}</span>
              <b>{s.count}</b>
            </div>
          ))}
          <div>
            <span>Open</span>
            <b>{rep.open ?? 'Unknown'}</b>
          </div>
          <div>
            <span>Overdue</span>
            <b>{rep.overdue ?? 'Unknown'}</b>
          </div>
        </div>
      );
    case 'orders.overdue':
      return (
        <ul className="flags stacked">
          {rep.overdue.map((o) => (
            <li key={o.ref} className="warn">
              <OrderName ref_={o.ref} names={names} />
              <span>
                {o.daysOverdue} {o.daysOverdue === 1 ? 'day' : 'days'} overdue · due {o.dueDate} · {o.status}
                {o.progressPercent !== null ? ` · ${o.progressPercent}%` : ''}
              </span>
            </li>
          ))}
        </ul>
      );
    case 'combined.report':
      return rep.linking === 'unavailable' ? null : (
        <ul className="flags stacked">
          {rep.matched.map((m) => (
            <li key={m.orderRef} className={m.costsIncomplete ? 'warn' : ''}>
              <OrderName ref_={m.orderRef} names={names} />
              <span>
                Income {money(m.income)} · Expenses {money(m.expenses)} · Recorded margin {money(m.recordedMargin)}
                {m.costsIncomplete ? ' · costs incomplete' : ''}
              </span>
            </li>
          ))}
        </ul>
      );
  }
}

// ---------------------------------------------------------------- agent panel section
const LIVE_ROLE: Record<LiveAgentId, string> = {
  lia: 'Sales — drafts customer replies; can check order status in WAD Order Management.',
  marco: 'Quotations — drafts quotations from the prices in your business notes (no live data).',
  paolo: 'Production — reads orders, progress and deadlines from WAD Order Management.',
  nina: 'Installations — plans dates from open orders and due dates in WAD Order Management.',
  bea: 'Finance — reads income, expenses and budgets from WAD Furniture Management, and order balances.',
  rosa: 'Collections — reads order prices, downpayments and balances from WAD Order Management; drafts payment reminders (never sends them).',
  mika: 'Data Analyst — trends over time: orders by month, best-selling products, production bottlenecks, and monthly income vs. expenses. Order values only for accounts with finance access.',
  carlo: 'Marketing — writes captions and posts (no live data).',
  dev: 'Systems — checks order data for gaps and inconsistencies in WAD Order Management.',
  chief: 'Coordinator — combines both systems; reports link records only by a verified order ID.',
};

export function LiveAgentSection({ store, agent, onOpenJob }: { store: LiveStore; agent: string; onOpenJob: (id: string) => void }) {
  useLive(store);
  const role = LIVE_ROLE[agent as LiveAgentId] ?? '';
  const latest = store.latestStepFor(agent as LiveAgentId);
  return (
    <section>
      <h3>Live task</h3>
      <p className="muted small">{role}</p>
      {latest ? (
        <>
          <button className="card-link" onClick={() => onOpenJob(latest.job.id)}>
            <span className="card-link-title">{latest.job.title}</span>
            <span className="muted small">
              {latest.job.range.from} to {latest.job.range.to}
            </span>
            <JobChip status={latest.step.status} />
          </button>
          <StepCard step={latest.step} />
          {latest.step.status === 'failed' && (
            <button className="btn ghost sm" onClick={() => store.dismissAgentError(agent as LiveAgentId)}>
              Clear error from office
            </button>
          )}
        </>
      ) : (
        <p className="muted small">
          {store.ai?.ready ? 'No live task yet in this session. Use Assign Task to give one.' : 'No live task yet in this session.'}
        </p>
      )}
    </section>
  );
}

/**
 * Shrinks a photo in the browser before upload: longest side at most 1600 px, re-encoded as
 * JPEG. This keeps uploads small and fast, and drops the camera's hidden data (EXIF, such as GPS
 * location) because only the pixels are redrawn.
 */
async function shrinkPhoto(file: File): Promise<string> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('Choose a JPEG, PNG or WebP photo.');
  if (file.size > 25 * 1024 * 1024) throw new Error('That photo is too large (over 25 MB).');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('That file could not be opened as a photo.'));
      i.src = url;
    });
    const max = 1600;
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser cannot prepare the photo.');
    ctx.fillStyle = '#ffffff'; // transparent PNGs get a white background in the JPEG
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    for (const q of [0.85, 0.7, 0.55]) {
      const data = canvas.toDataURL('image/jpeg', q);
      if (data.length * 0.75 <= 2.5 * 1024 * 1024) return data;
    }
    throw new Error('That photo is still too large after shrinking. Try a smaller one.');
  } finally {
    URL.revokeObjectURL(url);
  }
}
