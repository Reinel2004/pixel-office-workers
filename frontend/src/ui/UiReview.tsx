// UI Review (Development Studio): start dialog, list and detail view, for Connected Mode reviews
// (real AI on screenshots you upload) and Demo Mode ones (labelled samples, in this browser).
//
// The office never opens the website and never changes code: Rey's brief is copied into your own
// coding tool, and Kim re-checks "after" screenshots you upload.

import { useRef, useState } from 'react';
import type { LiveAgentId, UiChange, UiFinding, UiReview, UiReviewStatus, UiSiteId, UiStep } from '../../shared/live';
import { UI_REVIEW_LIMITS, UI_REVIEW_RUNNING, UI_SITES } from '../../shared/live';
import { formatManila } from '../../shared/manila';
import { AGENT_BY_ID } from '../agents/roster';
import type { LiveStore } from '../live/store';
import type { Engine } from '../sim/engine';
import { Empty } from './ActivityPanel';
import { IconAlert, IconCheck, IconClose, IconCopy, IconScreen } from './icons';
import { shrinkPhoto, useLive } from './live/LiveViews';
import { Avatar, useEngine } from './shared';

const STATUS_LABEL: Record<UiReviewStatus, string> = {
  queued: 'Queued',
  reviewing: 'Aya and Kim are reviewing',
  planning: 'Rey is planning',
  proposed: 'Plan ready: your turn',
  verifying: 'Kim is re-checking',
  verified: 'Re-checked',
  failed: 'Failed',
  cancelled: 'Cancelled',
};
const STATUS_CLASS: Record<UiReviewStatus, string> = {
  queued: 'status-queued',
  reviewing: 'status-running',
  planning: 'status-running',
  proposed: 'status-awaiting_approval',
  verifying: 'status-running',
  verified: 'status-completed',
  failed: 'status-failed',
  cancelled: 'status-interrupted',
};
const STEP_LABEL: Record<UiStep['status'], string> = { waiting: 'Waiting', working: 'Working', done: 'Done', failed: 'Failed', skipped: 'Skipped', cancelled: 'Cancelled' };
const STEP_CLASS: Record<UiStep['status'], string> = {
  waiting: 'status-queued',
  working: 'status-running',
  done: 'status-completed',
  failed: 'status-failed',
  skipped: 'status-interrupted',
  cancelled: 'status-interrupted',
};
const RESULT_LABEL = { done: 'Done', partial: 'Partly done', not_done: 'Not done', cannot_tell: 'Cannot tell' } as const;
const RESULT_CLASS = { done: 'status-completed', partial: 'status-awaiting_approval', not_done: 'status-failed', cannot_tell: 'status-interrupted' } as const;

export const uiRunning = (r: UiReview) => UI_REVIEW_RUNNING.includes(r.status);
const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`);

// ---------------------------------------------------------------- screenshot picker
interface Shot {
  label: string;
  data: string;
}

function ShotPicker({ shots, setShots, disabled }: { shots: Shot[]; setShots: (s: Shot[]) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setNote(null);
    const next = [...shots];
    try {
      for (const f of [...files]) {
        if (next.length >= UI_REVIEW_LIMITS.maxShots) {
          setNote(`At most ${UI_REVIEW_LIMITS.maxShots} screenshots.`);
          break;
        }
        // Shrunk in the browser (longest side 1600 px, JPEG): smaller uploads, and EXIF data is dropped.
        next.push({ label: f.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 60), data: await shrinkPhoto(f, 1.5 * 1024 * 1024) });
      }
      const total = next.reduce((n, s) => n + s.data.length * 0.75, 0);
      if (total > UI_REVIEW_LIMITS.maxTotalBytes) setNote('These screenshots are too large together. Use fewer or smaller ones.');
      else setShots(next);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  return (
    <div className="stack ui-shots">
      <div className="ui-shot-row">
        {shots.map((s, i) => (
          <figure key={i} className="ui-shot">
            <img src={s.data} alt={`Screenshot ${i + 1}`} />
            <input
              aria-label={`Label for screenshot ${i + 1}`}
              value={s.label}
              maxLength={60}
              onChange={(e) => setShots(shots.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
              placeholder={`Screenshot ${i + 1}`}
            />
            <button type="button" className="icon-btn sm" aria-label={`Remove screenshot ${i + 1}`} onClick={() => setShots(shots.filter((_, j) => j !== i))}>
              <IconClose size={12} />
            </button>
          </figure>
        ))}
      </div>
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={(e) => void add(e.target.files)} />
      {shots.length < UI_REVIEW_LIMITS.maxShots && (
        <button type="button" className="btn sm" disabled={disabled || busy} onClick={() => input.current?.click()}>
          {busy ? 'Reading…' : shots.length ? 'Add another screenshot' : 'Add screenshots'}
        </button>
      )}
      {note && <p className="photo-note small">{note}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- start dialog
export function UiReviewDialog({ engine, live, onClose, onOpen }: { engine: Engine; live: LiveStore; onClose: () => void; onOpen: (id: string) => void }) {
  useLive(live);
  const connected = engine.connected;
  const [site, setSite] = useState<UiSiteId>('order-management');
  const [page, setPage] = useState('');
  const [address, setAddress] = useState('');
  const [device, setDevice] = useState<UiReview['device']>('both');
  const [goal, setGoal] = useState('');
  const [shots, setShots] = useState<Shot[]>([]);
  const [privateOk, setPrivateOk] = useState(false);
  const [key] = useState(newKey);
  const [error, setError] = useState<string | null>(null);
  const can = connected ? live.canUiReview() : { ok: true };
  const busyRun = connected ? live.uiReviews.find(uiRunning) : engine.demoReviews.active();
  const problem = !can.ok
    ? can.reason!
    : page.trim().length < 2
      ? 'Name the page (e.g. "Orders list").'
      : connected && !shots.length
        ? 'Add at least one screenshot of the page.'
        : connected && !privateOk
          ? 'Confirm that no customer names, phone numbers or addresses are visible.'
          : busyRun
            ? 'A UI Review step is already running. Wait for it or cancel it.'
            : null;

  const start = async () => {
    if (problem) return;
    setError(null);
    try {
      if (connected) {
        const r = await live.startUiReview({
          site,
          page: page.trim(),
          address: address.trim() || undefined,
          goal: goal.trim(),
          device,
          shots: shots.map((s) => ({ label: s.label.trim() || undefined, mimeType: 'image/jpeg', data: s.data })),
          noPrivateData: privateOk,
          key,
        });
        if (!r) return setError(live.uiReviewError ?? 'The review could not be started.');
        onOpen(r.id);
      } else {
        const r = engine.startDemoUiReview({ site, page: page.trim(), address: address.trim() || undefined, goal: goal.trim(), device, shots: Math.max(1, shots.length) });
        onOpen(r.id);
      }
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="gate" role="dialog" aria-modal="true" aria-labelledby="uir-title" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="gate-card disc-dialog">
        <div className="row between">
          <h2 id="uir-title">
            <IconScreen size={18} /> UI Review
          </h2>
          <button className="icon-btn sm" onClick={onClose} aria-label="Close">
            <IconClose size={16} />
          </button>
        </div>
        <p className="muted small">
          {connected
            ? 'Aya (design) and Kim (usability) look at your screenshots separately, then Rey writes a change plan. You choose the changes, make them in your coding tool, and Kim checks the "after" screenshots. The office never opens the website or changes code.'
            : 'Demo Mode: a sample review with no AI. Screenshots are not needed and nothing is uploaded.'}
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
        >
          <label htmlFor="uir-site">Website</label>
          <select id="uir-site" value={site} onChange={(e) => setSite(e.target.value as UiSiteId)}>
            {(Object.keys(UI_SITES) as UiSiteId[]).map((k) => (
              <option key={k} value={k}>
                {UI_SITES[k]}
              </option>
            ))}
          </select>
          <label htmlFor="uir-page">Page</label>
          <input id="uir-page" value={page} maxLength={UI_REVIEW_LIMITS.pageChars} onChange={(e) => setPage(e.target.value)} placeholder="e.g. Orders list, Add order form" autoFocus />
          <label htmlFor="uir-address">Page address (optional, for reference only)</label>
          <input id="uir-address" value={address} maxLength={UI_REVIEW_LIMITS.addressChars} onChange={(e) => setAddress(e.target.value)} placeholder="e.g. orders.php" />
          <label>Device</label>
          <div className="row gap-s wrap" role="radiogroup" aria-label="Device">
            {(['desktop', 'mobile', 'both'] as const).map((d) => (
              <label key={d} className={`chip-btn ${device === d ? 'on' : ''}`}>
                <input type="radio" name="uir-device" checked={device === d} onChange={() => setDevice(d)} /> {d === 'both' ? 'Desktop and phone' : d === 'mobile' ? 'Phone' : 'Desktop'}
              </label>
            ))}
          </div>
          <label htmlFor="uir-goal">What should be better? (optional)</label>
          <textarea
            id="uir-goal"
            rows={3}
            value={goal}
            maxLength={UI_REVIEW_LIMITS.goalChars}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="e.g. Staff find it hard to add an order on a phone. Make the status easier to see."
          />
          {connected && (
            <>
              <label>Screenshots (1 to {UI_REVIEW_LIMITS.maxShots})</label>
              <ShotPicker shots={shots} setShots={setShots} disabled={!can.ok} />
              <label className="check">
                <input type="checkbox" checked={privateOk} onChange={(e) => setPrivateOk(e.target.checked)} />
                <span>No customer names, phone numbers or addresses are visible (blur them, or use test data). Screenshots are sent to Google Gemini.</span>
              </label>
            </>
          )}
          {(problem || error) && (
            <p className="photo-note small" role="alert">
              {error ?? problem}
            </p>
          )}
          <div className="row gap-s">
            <button type="button" className="btn ghost" onClick={onClose}>
              Close
            </button>
            <button className="btn primary" type="submit" disabled={!!problem || live.uiReviewBusy}>
              {live.uiReviewBusy ? 'Uploading…' : 'Start UI Review'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- list
export function UiReviewList({ items, onOpen, demo, note }: { items: UiReview[]; onOpen: (id: string) => void; demo: boolean; note?: string | null }) {
  if (!items.length)
    return <Empty title="No UI Reviews yet" text={note ?? (demo ? 'Click "UI review" below to watch a sample review.' : 'Click "UI review" below and upload screenshots of a page.')} />;
  return (
    <ul className="task-list">
      {items.map((r) => (
        <li key={r.id}>
          <button className="task-row" onClick={() => onOpen(r.id)}>
            <span className="avatars">
              {(['aya', 'kim', 'rey'] as LiveAgentId[]).map((a) => (
                <Avatar key={a} id={a} size={22} />
              ))}
            </span>
            <span className="task-row-main">
              <span className="task-row-title">{r.page}</span>
              <span className="task-row-sub">
                {UI_SITES[r.site]} · {formatManila(r.createdAt)}
                {r.mode === 'demo' ? ' · demo sample' : ''}
              </span>
            </span>
            <span className={`chip ${STATUS_CLASS[r.status]}`}>{STATUS_LABEL[r.status]}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- detail
const PHASES = ['Review', 'Plan', 'Your changes', 'Re-check'] as const;
function phaseOf(r: UiReview): number {
  if (r.status === 'queued' || r.status === 'reviewing') return 0;
  if (r.status === 'planning') return 1;
  if (r.status === 'proposed') return 2;
  if (r.status === 'verifying') return 3;
  if (r.status === 'verified') return 4;
  return r.plan ? 2 : r.design || r.usability ? 1 : 0;
}

export function UiReviewDetail({ r, engine, live, onOpenAgent }: { r: UiReview; engine: Engine; live: LiveStore; onOpenAgent: (id: LiveAgentId) => void }) {
  useLive(live);
  useEngine(engine);
  const demo = r.mode === 'demo';
  const shots = demo ? null : live.uiShots.get(r.id);
  const phase = phaseOf(r);
  const steps = [...r.steps, ...r.verifications.map((v) => v.step)];
  const cancel = () => (demo ? engine.demoUiReviewAction(r.id, 'cancel') : void live.cancelUiReview(r.id));

  return (
    <div className="stack disc">
      <div>
        <span className="live-tag">{demo ? 'Demo sample · no AI, nothing uploaded' : 'UI Review · real AI on your screenshots · proposals only'}</span>
        <h2>{r.page}</h2>
        <div className="row wrap gap-s">
          <span className={`chip ${STATUS_CLASS[r.status]}`}>{STATUS_LABEL[r.status]}</span>
          <span className="muted small">
            {UI_SITES[r.site]} · {r.device === 'both' ? 'desktop and phone' : r.device === 'mobile' ? 'phone' : 'desktop'} · started {formatManila(r.createdAt)}
          </span>
        </div>
        {r.address && <p className="muted small">Page: {r.address} (for reference only; never opened)</p>}
        {r.goal && <blockquote className="prompt">{r.goal}</blockquote>}
      </div>

      <ol className="disc-phases" aria-label="Progress">
        {PHASES.map((p, i) => (
          <li key={p} className={i < phase ? 'done' : i === phase && r.status !== 'failed' && r.status !== 'cancelled' ? 'now' : ''}>
            {p}
          </li>
        ))}
      </ol>

      <div className="disc-cast">
        {(['aya', 'kim', 'rey'] as LiveAgentId[]).map((a) => {
          const working = steps.some((s) => s.agent === a && s.status === 'working');
          const failed = steps.some((s) => s.agent === a && s.status === 'failed');
          return (
            <button key={a} className="cast" onClick={() => onOpenAgent(a)} title={`${AGENT_BY_ID[a].name} — ${AGENT_BY_ID[a].role}`}>
              <Avatar id={a} size={24} />
              <span>{AGENT_BY_ID[a].name}</span>
              {working && <span className="spinner sm" aria-label="working" />}
              {failed && <IconAlert size={13} />}
            </button>
          );
        })}
      </div>

      {uiRunning(r) && (
        <>
          <div className="notice live">
            <span className="spinner" aria-hidden="true" />
            <p>{STATUS_LABEL[r.status]}… This takes about a minute. You can close this panel; it keeps running.</p>
          </div>
          <button className="btn" onClick={cancel}>
            <IconClose size={14} /> Cancel
          </button>
        </>
      )}
      {r.error && (
        <div className={`notice ${r.status === 'cancelled' ? 'setup' : 'error'}`}>
          <IconAlert size={16} />
          <p>{r.error}</p>
        </div>
      )}
      {!demo && live.uiReviewError && <p className="photo-note small">{live.uiReviewError}</p>}

      <section>
        <h3>Screenshots</h3>
        {shots?.before.length ? (
          <div className="ui-shot-row">
            {shots.before.map((src, i) => (
              <figure key={i} className="ui-shot view">
                <img src={src} alt={r.before[i]?.label ?? `Screenshot ${i + 1}`} />
                <figcaption>
                  {i + 1}. {r.before[i]?.label}
                </figcaption>
              </figure>
            ))}
          </div>
        ) : (
          <p className="muted small">
            {demo
              ? 'Demo sample: no screenshots.'
              : `${r.before.length} screenshot(s) sent: ${r.before.map((s) => s.label).join(', ')}. Screenshots are shown only in the browser that uploaded them, until it is reloaded.`}
          </p>
        )}
        {!demo && !r.imagesKept && r.status !== 'failed' && r.status !== 'cancelled' && (
          <p className="muted small">The server no longer keeps the "before" screenshots (restart, or older than a day): Kim's re-check will compare against the findings only.</p>
        )}
      </section>

      <StepCard step={r.steps[0]} title="Aya · design review">
        {r.design && (
          <>
            <p>{r.design.summary}</p>
            <Bullets title="What works well" items={r.design.strengths} />
            <Findings items={r.design.findings} />
          </>
        )}
      </StepCard>
      <StepCard step={r.steps[1]} title="Kim · usability review">
        {r.usability && (
          <>
            <p>{r.usability.summary}</p>
            <Findings items={r.usability.findings} />
            <Bullets title="Test steps" items={r.usability.tests} />
          </>
        )}
      </StepCard>
      <StepCard step={r.steps[2]} title="Rey · change plan">
        {r.plan && <Plan r={r} engine={engine} live={live} />}
      </StepCard>

      {r.plan && r.plan.changes.some((c) => c.accepted) && <Brief r={r} />}
      {r.plan && r.plan.changes.length > 0 && <Recheck r={r} engine={engine} live={live} />}

      {r.verifications
        .slice()
        .reverse()
        .map((v) => (
          <StepCard key={v.round} step={v.step} title={`Kim · re-check ${v.round}`}>
            {live.uiShots.get(r.id)?.after[v.round - 1]?.length ? (
              <div className="ui-shot-row">
                {live.uiShots.get(r.id)!.after[v.round - 1].map((src, i) => (
                  <figure key={i} className="ui-shot view">
                    <img src={src} alt={`After ${i + 1}`} />
                  </figure>
                ))}
              </div>
            ) : null}
            {v.note && <blockquote className="prompt">{v.note}</blockquote>}
            {v.verdict && <span className={`chip ${v.verdict === 'ready' ? 'status-completed' : 'status-awaiting_approval'}`}>{v.verdict === 'ready' ? 'Ready to release' : 'Needs fixes'}</span>}
            {v.summary && <p>{v.summary}</p>}
            {v.checks.length > 0 && (
              <ul className="mini-list">
                {v.checks.map((c) => (
                  <li key={c.change}>
                    <b>{c.change}</b> {r.plan?.changes.find((x) => x.id === c.change)?.title} <span className={`chip ${RESULT_CLASS[c.result]}`}>{RESULT_LABEL[c.result]}</span>
                    {c.note && <span className="muted small"> — {c.note}</span>}
                  </li>
                ))}
              </ul>
            )}
            <Bullets title="New problems" items={v.regressions} warn />
            {v.verdict === 'ready' && <p className="muted small">"Ready" means every accepted change looks done in the screenshots and nothing new broke. Still test it yourself before uploading to the live site.</p>}
          </StepCard>
        ))}

      <p className="muted small">
        {demo
          ? 'No AI was used.'
          : `${r.aiRequests} AI request(s)${r.model ? ` · ${r.model}` : ''} · ${r.usage ? `${r.usage.totalTokens.toLocaleString()} tokens` : 'token usage not reported'} · nothing was opened, changed or deployed`}
      </p>
    </div>
  );
}

function StepCard({ step, title, children }: { step: UiStep; title: string; children?: React.ReactNode }) {
  return (
    <section>
      <article className="output step">
        <header>
          <span className="cast">
            <Avatar id={step.agent} size={24} />
            <b>{title}</b>
          </span>
          <span className={`chip ${STEP_CLASS[step.status]}`}>{STEP_LABEL[step.status]}</span>
        </header>
        {step.status === 'working' && (
          <div className="notice live">
            <span className="spinner" aria-hidden="true" />
            <p>Working…</p>
          </div>
        )}
        {step.error && (step.status === 'failed' || step.status === 'skipped' || step.status === 'cancelled') && <p className={`small ${step.status === 'failed' ? 'photo-note' : 'muted'}`}>{step.error}</p>}
        {children}
      </article>
    </section>
  );
}

function Findings({ items }: { items: UiFinding[] }) {
  if (!items.length) return <p className="muted small">No problems found.</p>;
  return (
    <ul className="mini-list ui-findings">
      {items.map((f) => (
        <li key={f.id}>
          <b>{f.id}</b> <span className={`tag sev-${f.severity}`}>{f.severity}</span> <span className="tag">{f.area}</span>
          {f.shot ? <span className="muted small"> · screenshot {f.shot}</span> : null}
          <div>{f.problem}</div>
          <div className="muted small">→ {f.suggestion}</div>
        </li>
      ))}
    </ul>
  );
}

function Plan({ r, engine, live }: { r: UiReview; engine: Engine; live: LiveStore }) {
  const plan = r.plan!;
  const editable = r.status === 'proposed' || r.status === 'verified';
  const toggle = (c: UiChange) => {
    const ids = plan.changes.filter((x) => (x.id === c.id ? !x.accepted : x.accepted)).map((x) => x.id);
    if (r.mode === 'demo') engine.demoUiReviewAction(r.id, { accept: ids });
    else void live.acceptUiChanges(r.id, ids);
  };
  return (
    <>
      <p>{plan.summary}</p>
      {plan.changes.length > 0 && (
        <>
          <h4>Changes: tick the ones you want</h4>
          <ul className="ui-changes">
            {plan.changes.map((c) => (
              <li key={c.id} className={c.accepted ? 'on' : ''}>
                <label className="check">
                  <input type="checkbox" checked={c.accepted} disabled={!editable || live.uiReviewBusy} onChange={() => toggle(c)} />
                  <span>
                    <b>
                      {c.id} · {c.title}
                    </b>
                    <span className="row wrap gap-s">
                      <span className="tag">{c.kind.toUpperCase()}</span>
                      <span className="tag">effort {c.effort}</span>
                      <span className={`tag sev-${c.risk}`}>risk {c.risk}</span>
                      {c.findings.length > 0 && <span className="muted small">solves {c.findings.join(', ')}</span>}
                    </span>
                  </span>
                </label>
                <Bullets title="Steps" items={c.steps} />
                <Bullets title="How to check it" items={c.checks} />
              </li>
            ))}
          </ul>
        </>
      )}
      <Bullets title="Questions for you" items={plan.questions} />
      <Bullets title="Left out" items={plan.outOfScope} />
    </>
  );
}

/** Rey's brief for the accepted changes, to paste into a coding assistant (built by code). */
export function developerBrief(r: UiReview): string {
  const accepted = r.plan?.changes.filter((c) => c.accepted) ?? [];
  const finding = new Map([...(r.design?.findings ?? []), ...(r.usability?.findings ?? [])].map((f) => [f.id, f]));
  const lines = [
    `UI change request — ${UI_SITES[r.site]}, page "${r.page}"${r.address ? ` (${r.address})` : ''}${r.mode === 'demo' ? ' — DEMO SAMPLE' : ''}`,
    `Device: ${r.device === 'both' ? 'desktop and phone' : r.device}`,
    r.goal ? `Goal: ${r.goal}` : '',
    '',
    'Make these changes, one at a time. Keep everything else working as it is; do not change the database or any business logic. Show me the diff before saving.',
    '',
  ];
  for (const c of accepted) {
    lines.push(`${c.id}. ${c.title} [${c.kind.toUpperCase()}, effort ${c.effort}, risk ${c.risk}]`);
    for (const id of c.findings) {
      const f = finding.get(id);
      if (f) lines.push(`   Problem (${id}): ${f.problem}`);
    }
    for (const s of c.steps) lines.push(`   - ${s}`);
    if (c.checks.length) lines.push(`   Check: ${c.checks.join('; ')}`);
    lines.push('');
  }
  lines.push('Before uploading to the live site: test on a computer and on a phone, then take "after" screenshots of the same page for the QA re-check.');
  return lines.filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
}

function Brief({ r }: { r: UiReview }) {
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
  const text = developerBrief(r);
  return (
    <section className="disc-summary">
      <h3>Developer brief</h3>
      <p className="muted small">
        Rey cannot change code. Copy this into your coding tool (for example Claude Code in VS Code, opened in the website's folder such as C:\laragon\www\order-management), check the
        changes it makes, test them on your PC, then upload the "after" screenshots below.
      </p>
      <pre className="cs-reply">{text}</pre>
      <button
        className="btn primary sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied('ok');
          } catch {
            setCopied('fail');
          }
        }}
      >
        {copied === 'ok' ? <IconCheck size={14} /> : <IconCopy size={14} />} {copied === 'ok' ? 'Copied' : 'Copy brief'}
      </button>
      {copied === 'fail' && <p className="photo-note small">The browser blocked copying. Select the text and copy it.</p>}
    </section>
  );
}

function Recheck({ r, engine, live }: { r: UiReview; engine: Engine; live: LiveStore }) {
  const [shots, setShots] = useState<Shot[]>([]);
  const [note, setNote] = useState('');
  const [privateOk, setPrivateOk] = useState(false);
  const [key, setKey] = useState(newKey);
  const demo = r.mode === 'demo';
  const accepted = r.plan?.changes.filter((c) => c.accepted).length ?? 0;
  const left = UI_REVIEW_LIMITS.maxVerifications - r.verifications.length;
  const can = demo ? { ok: true } : live.canUiReview();
  const problem = !(r.status === 'proposed' || r.status === 'verified')
    ? null
    : !accepted
      ? 'Tick at least one change above first.'
      : left <= 0
        ? `All ${UI_REVIEW_LIMITS.maxVerifications} re-checks are used. Start a new UI Review for the next round.`
        : !can.ok
          ? can.reason
          : !demo && !shots.length
            ? 'Add "after" screenshots of the same page.'
            : !demo && !privateOk
              ? 'Confirm that no customer names, phone numbers or addresses are visible.'
              : null;
  if (!(r.status === 'proposed' || r.status === 'verified')) return null;
  const go = async () => {
    if (problem) return;
    if (demo) return engine.demoUiReviewAction(r.id, 'verify');
    const ok = await live.verifyUiReview(r.id, { shots: shots.map((s) => ({ label: s.label.trim() || undefined, mimeType: 'image/jpeg', data: s.data })), note: note.trim() || undefined, noPrivateData: privateOk, key });
    if (ok) {
      setShots([]);
      setNote('');
      setPrivateOk(false);
      setKey(newKey());
    }
  };
  return (
    <section>
      <h3>QA re-check by Kim</h3>
      <p className="muted small">
        After you have made the changes: upload screenshots of the same page. Kim checks each accepted change ({accepted}) and looks for anything that broke. {left > 0 ? `${left} re-check(s) left.` : ''}
      </p>
      {!demo && (
        <>
          <ShotPicker shots={shots} setShots={setShots} disabled={!can.ok} />
          <input value={note} maxLength={UI_REVIEW_LIMITS.noteChars} onChange={(e) => setNote(e.target.value)} placeholder="Optional note for Kim, e.g. C2 was done differently" aria-label="Note for Kim" />
          <label className="check">
            <input type="checkbox" checked={privateOk} onChange={(e) => setPrivateOk(e.target.checked)} />
            <span>No customer names, phone numbers or addresses are visible.</span>
          </label>
        </>
      )}
      {problem && <p className="muted small">{problem}</p>}
      <button className="btn primary" disabled={!!problem || live.uiReviewBusy} onClick={() => void go()}>
        {live.uiReviewBusy ? 'Uploading…' : demo ? 'Run sample re-check' : 'Ask Kim to re-check'}
      </button>
    </section>
  );
}

function Bullets({ title, items, warn }: { title: string; items: string[]; warn?: boolean }) {
  if (!items.length) return null;
  return (
    <>
      <h4>{title}</h4>
      <ul className={`mini-list ${warn ? 'notes' : ''}`}>
        {items.map((x, i) => (
          <li key={i} className={warn ? 'warn' : ''}>
            {x}
          </li>
        ))}
      </ul>
    </>
  );
}
