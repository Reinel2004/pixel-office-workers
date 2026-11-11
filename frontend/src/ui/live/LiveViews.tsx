// Connected Mode panels: report bar, sign-in card, live feed tabs, and job/result details.

import { Fragment, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { ErrorCode, Job, JobStep, LiveAgentId, Money, ReportPayload, ReportType, StepResult, SystemStatus } from '../../../shared/live';
import { CATALOG_AI_PHOTO_MAX_BYTES, CATALOG_MAX_BATCH, CATALOG_MAX_IMAGE_BYTES, IMAGE_AGENTS, MULTI_PHOTO_AGENTS, LIVE_AGENT_IDS, MAX_PROMPT_CHARS, SYSTEM_NAMES, VIDEO_AGENTS } from '../../../shared/live';
import { formatManila, isIsoDate, type RangePreset } from '../../../shared/manila';
import { AGENT_BY_ID } from '../../agents/roster';
import type { AgentId } from '../../sim/types';
import type { CatalogPhoto, LiveStore } from '../../live/store';
import { Empty } from '../ActivityPanel';
import { IconAlert, IconCamera, IconChevron, IconClose, IconRetry, IconScreen, IconSend, IconTeam } from '../icons';
import { DiscussionList } from '../Discussions';
import { Avatar } from '../shared';
import { captionFrom, scheduleFrom } from '../../live/caption';
import { CarloReadyPost, FacebookComposer, FacebookPanel } from './Facebook';
import { CatalogFromTask, CatalogPanel } from './Catalog';
import { CopyReply, CustomerReplyPanel } from './CustomerService';
import { formatDuration, isVideoFile, prepareVideo, type VideoPick } from '../../live/video';
import { ChecklistPanel } from './Checklist';
import { UiReviewList } from '../UiReview';
import { LookupList, TASK_STATUS_CLASS, TASK_STATUS_LABEL, TaskActions, TaskBoard, TaskConversation, TaskInstructions, TaskProgress } from './TaskBoard';
import { AiUsagePanel } from './AiUsage';

export function useLive(store: LiveStore) {
  return useSyncExternalStore(store.subscribe, store.getVersion);
}

export const JOB_STATUS_LABEL: Record<Job['status'], string> = TASK_STATUS_LABEL;
const STATUS_CLASS: Record<Job['status'], string> = TASK_STATUS_CLASS;
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
  AI_LIMIT: "Office AI limit reached — see AI usage in the Systems tab",
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
  carlo: 'Short caption for this door photo, schedule it Saturday 9am',
  kat: 'Add photos first (one, or up to 10 products), e.g. main door, 90 x 210cm',
  joy: 'Use the "Customer reply" box in Joy\'s panel to paste a message',
  tess: 'Use the "Inspection checklist" box in Tess\'s panel to pick an order',
  dev: 'Check the order data and give me a fix list',
  sam: 'Is everything working? Anything slow or failing today?',
  ivy: 'Any failed or suspicious sign-ins this week?',
  aya: 'How can we make the order form easier to use on a phone?',
  rey: 'How would you add a search box to the orders list?',
  kim: 'Write test steps for adding a new order with a jamb',
  chief: 'What should the team prioritise today?',
};

export function ConnectedBar({
  store,
  onOpenJob,
  agent,
  setAgent,
  focusSignal,
  onDiscuss,
  onUiReview,
}: {
  store: LiveStore;
  onOpenJob: (id: string) => void;
  agent: AgentId;
  setAgent: (id: AgentId) => void;
  focusSignal: number;
  /** Opens the Team Discussion dialog. */
  onDiscuss: () => void;
  /** Opens the UI Review dialog. */
  onUiReview: () => void;
}) {
  useLive(store);
  const [text, setText] = useState('');
  const [photo, setPhoto] = useState<string | null>(null);
  const [video, setVideo] = useState<VideoPick | null>(null);
  /** Several product photos for Kat (one catalog entry each). */
  const [photos, setPhotos] = useState<CatalogPhoto[] | null>(null);
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
  const takesVideo = VIDEO_AGENTS.includes(who);
  const usePhoto = takesPhoto ? photo : null;
  const useVideo = takesVideo ? video : null;
  const takesMany = (MULTI_PHOTO_AGENTS as readonly string[]).includes(who);
  const usePhotos = takesMany ? photos : null;
  const submitTask = async () => {
    const v = text.trim();
    if ((!v && !usePhoto && !useVideo && !usePhotos) || !assign.ok) return;
    const job = await store.submitAi(who, v, usePhoto ?? undefined, undefined, useVideo ?? undefined, usePhotos ?? undefined);
    if (job) {
      setText('');
      setPhoto(null);
      setPhotos(null);
      setVideo(null); // the store keeps it for this task (preview and posting)
      setPhotoNote(null);
      onOpenJob(job.id);
    }
  };
  const pickPhoto = async (files: FileList | null | undefined) => {
    const file = files?.[0];
    if (!file) return;
    setPhotoBusy(true);
    setPhotoNote(null);
    try {
      // Several photos (Kat): one product each. Each is shrunk twice: a catalog copy (kept here
      // until approved) and a smaller copy for the AI.
      if (files.length > 1) {
        if (!takesMany) throw new Error(`${AGENT_BY_ID[who].name} takes one ${takesVideo ? 'photo or video' : 'photo'} at a time.`);
        if (files.length > CATALOG_MAX_BATCH) throw new Error(`Choose at most ${CATALOG_MAX_BATCH} photos at a time (you chose ${files.length}).`);
        const list: CatalogPhoto[] = [];
        for (const f of Array.from(files)) {
          if (isVideoFile(f)) throw new Error(`${f.name} is a video; ${AGENT_BY_ID[who].name} takes photos only.`);
          list.push({ catalog: await shrinkPhoto(f, CATALOG_MAX_IMAGE_BYTES * 0.9), ai: await shrinkPhoto(f, CATALOG_AI_PHOTO_MAX_BYTES * 0.9, 1024) });
        }
        setPhotos(list);
        setPhoto(null);
        setVideo(null);
        return;
      }
      setPhotos(null);
      // A photo is shrunk; a video stays as it is and Carlo gets still frames of it.
      if (isVideoFile(file)) {
        if (!takesVideo) throw new Error(`${AGENT_BY_ID[who].name} takes photos only (JPEG, PNG or WebP).`);
        const v = await prepareVideo(file);
        if (video) URL.revokeObjectURL(video.url);
        setVideo(v);
        setPhoto(null);
      } else {
        // Kat's photo goes on the catalog website as it is: kept smaller so the page loads fast.
        setPhoto(await shrinkPhoto(file, who === 'kat' ? CATALOG_MAX_IMAGE_BYTES * 0.9 : undefined));
        setVideo(null);
      }
    } catch (e) {
      setPhoto(null);
      setPhotos(null);
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
            !assign.ok
              ? 'AI tasks are not set up on the server'
              : usePhotos
                ? `Optional: details, e.g. all main doors, photo 3 is a flush door`
                : usePhoto && who === 'kat'
                ? 'Optional: details, e.g. main door, 90 x 210cm, narra'
                : usePhoto || useVideo
                ? 'Optional: details and when to post, e.g. narra door, schedule Saturday 9am'
                : `e.g. ${TASK_EXAMPLES[who]}`
          }
          disabled={!assign.ok}
          autoComplete="off"
        />
        {takesPhoto && (
          <>
            <input
              ref={fileInput}
              type="file"
              accept={takesVideo ? 'image/jpeg,image/png,image/webp,video/mp4,video/quicktime,.mp4,.m4v,.mov' : 'image/jpeg,image/png,image/webp'}
              hidden
              multiple={takesMany}
              onChange={(e) => void pickPhoto(e.target.files)}
            />
            {useVideo ? (
              <span className="photo-chip video-chip" title={`This video's still frames go to Carlo; the video is posted only when you approve (${Math.round(useVideo.file.size / 1048576)} MB)`}>
                <img src={useVideo.frames[0]} alt="Selected video" />
                <i className="video-len">▶ {formatDuration(useVideo.durationSec)}</i>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Remove video"
                  onClick={() => {
                    URL.revokeObjectURL(useVideo.url);
                    setVideo(null);
                  }}
                >
                  <IconClose size={12} />
                </button>
              </span>
            ) : usePhotos ? (
              <span className="photo-chip" title={`${usePhotos.length} product photos: ${AGENT_BY_ID[who].name} drafts one catalog entry for each`}>
                <img src={usePhotos[0].catalog} alt={`${usePhotos.length} selected photos`} />
                <i className="photo-count">×{usePhotos.length}</i>
                <button type="button" className="icon-btn" aria-label="Remove photos" onClick={() => setPhotos(null)}>
                  <IconClose size={12} />
                </button>
              </span>
            ) : usePhoto ? (
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
                title={
                  takesVideo
                    ? `Add a photo (JPEG, PNG, WebP) or a video (MP4, MOV) for ${AGENT_BY_ID[who].name} to look at. A photo, or a few still frames of the video, go to Google Gemini for analysis.`
                    : `Add a product photo (JPEG, PNG, WebP), or up to ${CATALOG_MAX_BATCH} photos of different products at once, for ${AGENT_BY_ID[who].name}. Smaller copies go to Google Gemini for analysis; the photos go to the catalog only if you approve them.`
                }
              >
                <IconCamera size={16} />
                <span className="hide-narrow">{photoBusy ? 'Reading…' : takesVideo ? 'Photo / video' : 'Photo'}</span>
              </button>
            )}
          </>
        )}
        <button className="btn primary" type="submit" disabled={!assign.ok || photoBusy || (!text.trim() && !usePhoto && !useVideo && !usePhotos)} title={assign.reason}>
          <IconSend size={16} />
          <span>Assign</span>
        </button>
        <button type="button" className="btn" onClick={onDiscuss} disabled={!signedIn} title="Several agents discuss a topic with real AI; Chief summarises">
          <IconTeam size={16} />
          <span className="hide-narrow">Team discussion</span>
        </button>
        <button type="button" className="btn" onClick={onUiReview} disabled={!signedIn} title="Aya, Kim and Rey review screenshots of a website page">
          <IconScreen size={16} />
          <span className="hide-narrow">UI review</span>
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
export function LiveFeed({
  store,
  open,
  setOpen,
  onOpenJob,
  onOpenDiscussion,
  onOpenUiReview,
  mobile,
}: {
  store: LiveStore;
  open: boolean;
  setOpen: (o: boolean) => void;
  onOpenJob: (id: string) => void;
  onOpenDiscussion: (id: string) => void;
  onOpenUiReview: (id: string) => void;
  mobile: boolean;
}) {
  useLive(store);
  const [tab, setTab] = useState<'activity' | 'tasks' | 'discuss' | 'ui' | 'systems'>('activity');
  // An Attention link can ask for the Systems tab (connections, AI usage).
  const request = store.feedTabRequest?.n ?? 0;
  useEffect(() => {
    if (!request || !store.feedTabRequest) return;
    setTab(store.feedTabRequest.tab);
    setOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);
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
          {(['activity', 'tasks', 'discuss', 'ui', 'systems'] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
              {t === 'activity' ? 'Activity' : t === 'tasks' ? `Tasks${store.jobs.some((j) => j.status === 'needs_info' || j.status === 'ready_for_review') ? ` (${store.jobs.filter((j) => j.status === 'needs_info' || j.status === 'ready_for_review').length})` : ''}` : t === 'discuss' ? 'Discuss' : t === 'ui' ? 'UI' : 'Systems'}
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
        {tab === 'tasks' && <TaskBoard store={store} onOpen={onOpenJob} />}
        {tab === 'discuss' &&
          (!store.discussionsLoaded && store.server === 'signed_in' ? (
            <p className="muted small">Loading discussions…</p>
          ) : (
            <>
              {store.discussionError && <p className="photo-note small">{store.discussionError}</p>}
              <DiscussionList items={store.discussions} onOpen={onOpenDiscussion} demo={false} />
            </>
          ))}
        {tab === 'ui' && (
          <>
            {store.uiReviewError && <p className="photo-note small">{store.uiReviewError}</p>}
            <UiReviewList
              items={store.uiReviews}
              onOpen={onOpenUiReview}
              demo={false}
              note={store.user && !store.user.permissions.includes('ui:review') ? 'UI Review is for admin and manager accounts.' : null}
            />
          </>
        )}
        {tab === 'systems' && (
          <div className="stack">
            <AiUsagePanel store={store} />
            <SystemsList systems={store.systems} />
          </div>
        )}
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
  const agentName = AGENT_BY_ID[job.agent ?? job.steps[0].agent].name;
  const latest = job.steps[0]?.result;
  const names = latest?.customers ?? {};
  const employees = latest?.employees ?? {};
  const answered = job.status === 'ready_for_review' || job.status === 'completed';
  return (
    <div className="stack">
      <div>
        <span className="live-tag">{isAi ? 'Assigned task · live data' : 'Report · live data'}</span>
        <h2>{isAi ? `Task for ${agentName}` : job.title}</h2>
        <div className="row wrap gap-s">
          <JobChip status={job.status} />
          {!isAi && (
            <span className="muted small">
              {job.range.from} to {job.range.to} · Asia/Manila
            </span>
          )}
        </div>
        {job.status === 'needs_info' && <p className="note warn">{agentName} needs more information before finishing. Answer below to continue.</p>}
        {job.status === 'ready_for_review' && <p className="note">Check the answer, then mark it complete, or send a follow-up below.</p>}
        <p className="muted small">
          Requested {formatManila(job.createdAt)} by {job.requestedBy}
          {job.updatedAt && job.updatedAt !== job.createdAt ? ` · last update ${formatManila(job.updatedAt)}` : ''}
        </p>
      </div>
      <TaskInstructions job={job} />
      {isAi && job.orderRef && <p className="muted small">Order picked for this reply: {job.orderRef}</p>}
      {isAi && !!job.redacted && (
        <p className="muted small">
          {job.redacted} phone number(s) or email(s) were removed before the AI saw the message.
        </p>
      )}
      {isAi && job.photos && (
        store.catalogPhotos.get(job.id) ? (
          <div className="task-photos">
            {store.catalogPhotos.get(job.id)!.map((src, i) => (
              <figure key={i}>
                <img src={src} alt={`Photo ${i + 1} sent with this task`} />
                <figcaption>{i + 1}</figcaption>
              </figure>
            ))}
          </div>
        ) : (
          <p className="muted small">{job.photos.count} photos were sent with this task (not kept after a reload).</p>
        )
      )}
      {isAi && job.image && (
        store.images.get(job.id) ? (
          <img className="task-photo" src={store.images.get(job.id)} alt="Photo sent with this task" />
        ) : (
          <p className="muted small">A photo was sent with this task (not kept after a reload).</p>
        )
      )}
      {isAi && job.video && (
        store.videos.get(job.id) ? (
          <video className="task-photo" src={store.videos.get(job.id)!.url} controls preload="metadata" aria-label="Video sent with this task" />
        ) : (
          <p className="muted small">
            A {formatDuration(job.video.durationSec)} video was sent with this task; Carlo saw {job.video.frames} still frames of it. The video stays in the browser that sent it and is gone after a reload.
          </p>
        )
      )}
      <TaskProgress job={job} />
      <TaskConversation job={job} render={(t) => <Markdownish text={t} names={names} employees={employees} />} />
      {job.steps.map((s) => (
        <StepCard key={s.id} step={s} onOpenAgent={onOpenAgent} />
      ))}
      {isAi && job.agent === 'carlo' && answered && <PostFromTask store={store} job={job} />}
      {isAi && job.agent === 'kat' && answered && <CatalogFromTask key={`${job.id}-${job.thread?.length ?? 0}`} store={store} job={job} />}
      {isAi && job.agent === 'joy' && answered && <CopyReply job={job} />}
      <TaskActions store={store} job={job} />
      {(job.status === 'failed' || job.status === 'cancelled') && (
        <button
          className="btn"
          disabled={!can.ok}
          title={can.reason}
          onClick={() => (isAi ? store.submitAi(job.agent!, job.prompt!, store.images.get(job.id), job.orderRef) : store.submit(job.type as ReportType, job.range))}
        >
          <IconRetry size={15} /> Run again as a new task
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
  auto_lookup: 'Looked up automatically',
  get_orders: 'Orders by date',
  get_open_orders: 'Open orders',
  get_finance: 'Finance records',
  get_collections: 'Order balances',
  get_order_trends: 'Order trends',
  get_product_mix: 'Product mix',
  get_production_pipeline: 'Production pipeline',
  get_finance_trends: 'Finance trends',
  get_data_checks: 'Data checks',
  get_system_health: 'System health',
  get_security_events: 'Security events',
  selected_order: 'Selected order',
};

function AiResultView({ r }: { r: StepResult }) {
  return (
    <div className="stack result">
      <LookupList lookups={r.dataLookups ?? []} />
      <div className="ai-answer">
        <Markdownish text={r.answer ?? ''} names={r.customers ?? {}} employees={r.employees ?? {}} />
      </div>
      {Object.keys(r.employees ?? {}).length > 0 && <p className="muted small">Employee names are added by the office from WAD Furniture Management. The AI only saw EMP-codes.</p>}
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
function withNames(text: string, names: Record<string, string>, employees: Record<string, string> = {}): string {
  if (Object.keys(employees).length) text = text.replace(/\b(EMP-\d+)\b/g, (ref) => (employees[ref] ? `${employees[ref]} (${ref})` : ref));
  if (!Object.keys(names).length) return text;
  const mentioned = [...new Set([...text.matchAll(ORDER_REF)].map((m) => m[1]))].filter((r) => names[r]);
  let out = text.replace(ORDER_REF, (ref) => (names[ref] ? `${names[ref]} (${ref})` : ref));
  const only = Object.keys(names).length === 1 ? Object.keys(names)[0] : null;
  if (mentioned.length === 1) out = out.replace(/\[Customer name\]/gi, names[mentioned[0]]);
  else if (!mentioned.length && only) out = out.replace(/\[Customer name\]/gi, names[only]); // e.g. Joy's reply for the one picked order
  return out;
}

/** Renders the AI's light Markdown (paragraphs, "- " bullets, **bold**, headings) as plain React text — never as HTML. */
function Markdownish({ text: raw0, names = {}, employees = {} }: { text: string; names?: Record<string, string>; employees?: Record<string, string> }) {
  const text = withNames(raw0, names, employees);
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

/** Under Carlo's finished answer: post it to Facebook after a person checks it. */
function PostFromTask({ store, job }: { store: LiveStore; job: Job }) {
  const [open, setOpen] = useState(false);
  if (!store.user?.permissions.includes('social:post')) return null;
  const can = store.canPostFacebook();
  const answer = job.steps[0]?.result?.answer ?? '';
  if (!can.ok) return <p className="muted small">Facebook: {can.reason}</p>;
  // Carlo read a posting time from the request: the post is prepared, one click to approve.
  const when = scheduleFrom(answer);
  if (when)
    return (
      <section>
        <h3>{when.kind === 'now' ? 'Post to Facebook' : 'Scheduled post'}</h3>
        <CarloReadyPost store={store} jobId={job.id} message={captionFrom(answer)} photo={store.images.get(job.id) ?? null} video={store.videos.get(job.id) ?? null} hadVideo={!!job.video} when={when} />
      </section>
    );
  return open ? (
    <section>
      <h3>Post to Facebook</h3>
      <FacebookComposer store={store} initialMessage={captionFrom(answer)} initialPhoto={store.images.get(job.id) ?? null} initialVideo={store.videos.get(job.id) ?? null} onClose={() => setOpen(false)} />
    </section>
  ) : (
    <button className="btn primary" onClick={() => setOpen(true)}>
      Post to Facebook…
    </button>
  );
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
  kat: 'Catalog — drafts a product entry from a photo (category, name, material, size, finishes, description). You check it and click Add to catalog; the photo and entry are then saved to the catalog website on GitHub and it updates in about a minute. She never adds anything herself or changes existing products.',
  joy: 'Customer Service — drafts replies to customer messages. Reads only the one order you pick; phone numbers and emails are removed before the AI sees the message. You copy and send the reply yourself.',
  tess: 'Quality Control — builds an inspection checklist by code from the order\'s specifications in WAD Order Management (dimensions, design, wood, finish, jamb, and hardware from the notes). Anything the order does not record is marked "confirm with sales". The AI sees the checklist, never the staff notes.',
  dev: 'Data quality — checks WAD Order Management by code for missing due dates, odd statuses, In Progress orders with no carpenter, missing labor, pieces with no price, finished orders with no downpayment (finance accounts) and possible double entries, then writes a fix list. He reads only; you correct the records in the order system.',
  sam: 'Systems Monitor — reads the office server\'s own measurements: whether the order system, finance system, Gemini and Facebook answer, how fast, and which errors; plus live updates and the server. Admin accounts only. No secrets.',
  ivy: 'Security Officer — reads sign-ins (ok, failed, locked), blocked cross-site requests, permission denials and risky settings. Client addresses are never stored. Admin accounts only.',
  aya: 'UI/UX Designer — reviews screenshots of a page in a UI Review: layout, navigation, readability and mobile. She never opens the website.',
  rey: 'Developer — turns the UI Review findings into a change plan and a brief you paste into your coding tool (e.g. Claude Code in VS Code). He cannot change code or deploy.',
  kim: 'QA Tester — finds usability problems in a UI Review, then compares your "after" screenshots with the accepted changes and says whether it is ready to release.',
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
      {agent === 'carlo' && <FacebookPanel store={store} />}
      {agent === 'kat' && <CatalogPanel store={store} />}
      {agent === 'joy' && <CustomerReplyPanel store={store} onOpenJob={onOpenJob} />}
      {agent === 'tess' && <ChecklistPanel store={store} onOpenJob={onOpenJob} />}
      {(agent === 'aya' || agent === 'rey' || agent === 'kim') && (
        <p className="muted small">UI Review: click "UI review" in the bottom bar and upload screenshots of a page. Reviews are in the "UI" tab.</p>
      )}
    </section>
  );
}

/**
 * Shrinks a photo in the browser before upload: longest side at most 1600 px, re-encoded as
 * JPEG. This keeps uploads small and fast, and drops the camera's hidden data (EXIF, such as GPS
 * location) because only the pixels are redrawn.
 */
export async function shrinkPhoto(file: File, maxBytes = 2.5 * 1024 * 1024, max = 1600): Promise<string> {
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
      if (data.length * 0.75 <= maxBytes) return data;
    }
    throw new Error('That photo is still too large after shrinking. Try a smaller one.');
  } finally {
    URL.revokeObjectURL(url);
  }
}
