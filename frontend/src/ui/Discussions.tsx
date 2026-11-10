// Team Discussion: start dialog, list and detail view. The same views show Connected Mode
// discussions (from the server, real AI) and Demo Mode ones (labelled samples, in this browser).

import { useMemo, useState } from 'react';
import type { DateRange, Discussion, DiscussionMessage, DiscussionPoint, LiveAgentId } from '../../shared/live';
import { DISCUSSION_ACTIVE, DISCUSSION_LIMITS, LIVE_AGENT_IDS, SYSTEM_NAMES } from '../../shared/live';
import { formatManila, isIsoDate } from '../../shared/manila';
import { AGENT_BY_ID } from '../agents/roster';
import type { LiveStore } from '../live/store';
import type { Engine } from '../sim/engine';
import { Empty } from './ActivityPanel';
import { IconAlert, IconCheck, IconClose, IconCopy, IconTeam } from './icons';
import { Avatar } from './shared';

const EXAMPLES = [
  'Why are our orders delayed?',
  'How can we improve production scheduling?',
  'What should we improve in our order management system?',
  'How can we reduce material waste?',
];

const STATUS_LABEL: Record<Discussion['status'], string> = {
  queued: 'Queued',
  gathering: 'Gathering data',
  proposals: 'Round 1 · Proposals',
  reviews: 'Round 2 · Peer review',
  synthesizing: 'Chief is summarising',
  completed: 'Completed',
  cancelled: 'Cancelled',
  failed: 'Failed',
};
const STATUS_CLASS: Record<Discussion['status'], string> = {
  queued: 'status-queued',
  gathering: 'status-running',
  proposals: 'status-running',
  reviews: 'status-running',
  synthesizing: 'status-running',
  completed: 'status-completed',
  cancelled: 'status-interrupted',
  failed: 'status-failed',
};
const MSG_LABEL: Record<DiscussionMessage['status'], string> = {
  waiting: 'Waiting',
  working: 'Working',
  done: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
};
const MSG_CLASS: Record<DiscussionMessage['status'], string> = {
  waiting: 'status-queued',
  working: 'status-running',
  done: 'status-completed',
  failed: 'status-failed',
  skipped: 'status-interrupted',
  cancelled: 'status-interrupted',
};
const KIND_LABEL: Record<DiscussionPoint['kind'], string> = { fact: 'Fact', hypothesis: 'Hypothesis', recommendation: 'Recommendation' };

export const isActive = (d: Discussion) => DISCUSSION_ACTIVE.includes(d.status);
const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`);

// ---------------------------------------------------------------- start dialog
export function DiscussionDialog({ engine, live, onClose, onOpen }: { engine: Engine; live: LiveStore; onClose: () => void; onOpen: (id: string) => void }) {
  const connected = engine.connected;
  const [topic, setTopic] = useState('');
  const [context, setContext] = useState('');
  const [picked, setPicked] = useState<LiveAgentId[]>(['paolo', 'lia']);
  const [range, setRange] = useState<DateRange>(live.range);
  const [key] = useState(newKey);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const specialists = LIVE_AGENT_IDS.filter((a) => a !== 'chief');
  const signedIn = live.server === 'signed_in';
  const aiReady = !!live.ai?.ready;
  const running = connected ? live.discussions.find(isActive) : engine.demoTalks.active();
  const rangeOk = isIsoDate(range.from) && isIsoDate(range.to) && range.from <= range.to;
  const n = picked.length;
  const problem = !topic.trim()
    ? 'Type a topic or goal.'
    : n < DISCUSSION_LIMITS.minSpecialists || n > DISCUSSION_LIMITS.maxSpecialists
      ? `Choose ${DISCUSSION_LIMITS.minSpecialists} to ${DISCUSSION_LIMITS.maxSpecialists} participants.`
      : connected && !signedIn
        ? 'Sign in first.'
        : connected && !aiReady
          ? 'AI is not set up on the server (GEMINI_API_KEY).'
          : connected && !rangeOk
            ? 'Choose a valid date range.'
            : running
              ? 'A discussion is already running. Open it or cancel it first.'
              : null;

  const toggle = (a: LiveAgentId) => setPicked((p) => (p.includes(a) ? p.filter((x) => x !== a) : p.length >= DISCUSSION_LIMITS.maxSpecialists ? p : [...p, a]));
  const start = async () => {
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (connected) {
        const d = await live.startDiscussion({ topic: topic.trim(), context: context.trim(), participants: picked, range, key });
        if (d) {
          onOpen(d.id);
          onClose();
        } else setError(live.discussionError ?? 'The discussion could not be started.');
      } else {
        const d = engine.startDemoDiscussion({ topic: topic.trim(), context: context.trim(), participants: picked });
        onOpen(d.id);
        onClose();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gate" role="dialog" aria-modal="true" aria-labelledby="disc-title" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="gate-card disc-dialog">
        <div className="row between">
          <h2 id="disc-title">
            <IconTeam size={18} /> Team discussion
          </h2>
          <button className="icon-btn sm" onClick={onClose} aria-label="Close">
            <IconClose size={16} />
          </button>
        </div>
        <p className="muted small">
          {connected
            ? 'Each participant answers separately with real AI, then reviews the others; Chief writes the summary. Proposals only: nothing is changed, sent or carried out.'
            : 'Demo Mode: a sample discussion with no AI and no real data, to show how it works.'}
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
        >
          <label htmlFor="disc-topic">Topic or goal</label>
          <input id="disc-topic" value={topic} maxLength={DISCUSSION_LIMITS.topicChars} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. Why are our orders delayed?" autoFocus />
          <div className="disc-examples">
            {EXAMPLES.map((x) => (
              <button type="button" key={x} className="chip-btn" onClick={() => setTopic(x)}>
                {x}
              </button>
            ))}
          </div>
          <label htmlFor="disc-context">Context and constraints (optional)</label>
          <textarea
            id="disc-context"
            rows={3}
            value={context}
            maxLength={DISCUSSION_LIMITS.contextChars}
            onChange={(e) => setContext(e.target.value)}
            placeholder="e.g. Two carpenters are on leave this month. Budget for new tools is limited."
          />
          <label>
            Participants ({n}/{DISCUSSION_LIMITS.maxSpecialists}) · Chief moderates
          </label>
          <div className="disc-people" role="group" aria-label="Participants">
            {specialists.map((a) => {
              const on = picked.includes(a);
              const full = !on && n >= DISCUSSION_LIMITS.maxSpecialists;
              return (
                <label key={a} className={`disc-person ${on ? 'on' : ''} ${full ? 'off' : ''}`}>
                  <input type="checkbox" checked={on} disabled={full} onChange={() => toggle(a)} />
                  <Avatar id={a} size={22} />
                  <span>
                    <b>{AGENT_BY_ID[a].name}</b>
                    <span className="muted">{AGENT_BY_ID[a].role}</span>
                  </span>
                </label>
              );
            })}
          </div>
          {connected && (
            <>
              <label>Report period for the evidence</label>
              <div className="row gap-s disc-range">
                <input type="date" aria-label="From" value={range.from} max={range.to} onChange={(e) => setRange({ ...range, from: e.target.value })} />
                <span className="muted small">to</span>
                <input type="date" aria-label="To" value={range.to} min={range.from} onChange={(e) => setRange({ ...range, to: e.target.value })} />
                <span className="tz">Asia/Manila</span>
              </div>
              <p className="muted small">The data is read once when the discussion starts, only from what your account may see.</p>
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
            <button className="btn primary" type="submit" disabled={!!problem || busy || live.discussionStarting}>
              {busy ? 'Starting…' : 'Start discussion'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- list
export function DiscussionList({ items, onOpen, demo }: { items: Discussion[]; onOpen: (id: string) => void; demo: boolean }) {
  if (!items.length)
    return (
      <Empty
        title="No discussions yet"
        text={demo ? 'Click "Team discussion" below to watch a sample discussion.' : 'Click "Team discussion" below to have the team discuss a topic.'}
      />
    );
  return (
    <ul className="task-list">
      {items.map((d) => (
        <li key={d.id}>
          <button className="task-row" onClick={() => onOpen(d.id)}>
            <span className="avatars">
              {(['chief', ...d.participants] as LiveAgentId[]).slice(0, 4).map((a) => (
                <Avatar key={a} id={a} size={22} />
              ))}
            </span>
            <span className="task-row-main">
              <span className="task-row-title">{d.topic}</span>
              <span className="task-row-sub">
                {formatManila(d.createdAt)}
                {d.mode === 'demo' ? ' · demo sample' : ''}
                {d.partial ? ' · partial' : ''}
              </span>
            </span>
            <span className={`chip ${STATUS_CLASS[d.status]}`}>{STATUS_LABEL[d.status]}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- detail
const PHASES: Discussion['status'][] = ['gathering', 'proposals', 'reviews', 'synthesizing', 'completed'];

export function DiscussionDetail({ d, onCancel, onOpenAgent }: { d: Discussion; onCancel: () => void; onOpenAgent: (id: LiveAgentId) => void }) {
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
  const chief = d.messages.find((m) => m.round === 'synthesis');
  const s = chief?.status === 'done' ? chief.synthesis : undefined;
  const reached = PHASES.indexOf(d.status);
  const lastPhase = d.status === 'cancelled' || d.status === 'failed' ? Math.max(...d.messages.filter((m) => m.status !== 'waiting').map((m) => (m.round === 'proposal' ? 1 : m.round === 'review' ? 2 : 3)), d.evidence.length ? 0 : -1) : reached;
  const ev = useMemo(() => new Map(d.evidence.map((e) => [e.id, e])), [d.evidence]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(summaryText(d));
      setCopied('ok');
    } catch {
      setCopied('fail');
    }
  };

  return (
    <div className="stack disc">
      <div>
        <span className="live-tag">{d.mode === 'demo' ? 'Demo sample · no AI, no real data' : 'Team discussion · real AI · proposals only'}</span>
        <h2>{d.topic}</h2>
        <div className="row wrap gap-s">
          <span className={`chip ${STATUS_CLASS[d.status]}`}>{STATUS_LABEL[d.status]}</span>
          {d.partial && <span className="chip status-awaiting_approval">Partial: some contributions missing</span>}
          <span className="muted small">
            Started {formatManila(d.createdAt)}
            {d.mode === 'connected' ? ` · data ${d.range.from} to ${d.range.to}` : ''}
          </span>
        </div>
        {d.context && <blockquote className="prompt">{d.context}</blockquote>}
      </div>

      <ol className="disc-phases" aria-label="Progress">
        {PHASES.map((p, i) => (
          <li key={p} className={i < lastPhase || d.status === 'completed' ? 'done' : i === lastPhase && isActive(d) ? 'now' : ''}>
            {p === 'gathering' ? 'Data' : p === 'proposals' ? 'Proposals' : p === 'reviews' ? 'Review' : p === 'synthesizing' ? 'Summary' : 'Done'}
          </li>
        ))}
      </ol>

      <div className="disc-cast">
        {(['chief', ...d.participants] as LiveAgentId[]).map((a) => {
          const working = d.messages.find((m) => m.agent === a && m.status === 'working');
          const failed = d.messages.some((m) => m.agent === a && m.status === 'failed');
          return (
            <button key={a} className="cast" onClick={() => onOpenAgent(a)} title={`${AGENT_BY_ID[a].name} — ${AGENT_BY_ID[a].role}`}>
              <Avatar id={a} size={24} />
              <span>
                {AGENT_BY_ID[a].name}
                {a === 'chief' ? ' (moderator)' : ''}
              </span>
              {working && <span className="spinner sm" aria-label="working" />}
              {failed && <IconAlert size={13} />}
            </button>
          );
        })}
      </div>

      {isActive(d) && (
        <div className="notice live">
          <span className="spinner" aria-hidden="true" />
          <p>{STATUS_LABEL[d.status]}… This can take a few minutes. You can close this panel; it keeps running.</p>
        </div>
      )}
      {d.error && d.status !== 'completed' && (
        <div className={`notice ${d.status === 'cancelled' ? 'setup' : 'error'}`}>
          <IconAlert size={16} />
          <p>{d.error}</p>
        </div>
      )}
      {isActive(d) && (
        <button className="btn" onClick={onCancel}>
          <IconClose size={14} /> Cancel discussion
        </button>
      )}

      {s && (
        <section className="disc-summary">
          <h3>Chief's summary</h3>
          <p>{s.summary}</p>
          {s.approach && (
            <>
              <h4>Recommended approach</h4>
              <p>{s.approach}</p>
              {s.reasoning && <p className="muted small">{s.reasoning}</p>}
            </>
          )}
          {s.actions.length > 0 && (
            <>
              <h4>Action items (proposed, not carried out)</h4>
              <ul className="disc-actions">
                {s.actions.map((a, i) => (
                  <li key={i}>
                    <span>{a.text}</span>
                    <span className="muted small">
                      Owner: {a.owner}
                      <Refs ids={a.evidence} ev={ev} />
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <Bullets title="Risks" items={s.risks} />
          <Bullets title="Open questions" items={s.openQuestions} />
          <Bullets title="Remaining disagreement" items={s.disagreements} />
          <Bullets title="Limitations" items={s.limitations} warn />
          <div className="row wrap gap-s">
            <button className="btn primary sm" onClick={() => void copy()}>
              {copied === 'ok' ? <IconCheck size={14} /> : <IconCopy size={14} />} {copied === 'ok' ? 'Copied' : 'Copy summary'}
            </button>
          </div>
          {copied === 'fail' && <p className="photo-note small">The browser blocked copying. Select the text and copy it.</p>}
        </section>
      )}

      <Round title="Round 1 · Independent proposals" items={d.messages.filter((m) => m.round === 'proposal')} ev={ev} onOpenAgent={onOpenAgent} />
      <Round title="Round 2 · Peer review" items={d.messages.filter((m) => m.round === 'review')} ev={ev} onOpenAgent={onOpenAgent} />
      {chief && chief.status !== 'done' && <Round title="Chief's synthesis" items={[chief]} ev={ev} onOpenAgent={onOpenAgent} />}

      <section>
        <h3>Evidence</h3>
        {d.evidence.length === 0 ? (
          <p className="muted small">{isActive(d) ? 'Gathering…' : 'No evidence was gathered.'}</p>
        ) : (
          <ul className="mini-list disc-evidence">
            {d.evidence.map((e) => (
              <li key={e.id} className={e.available ? '' : 'warn'}>
                <b>{e.id}</b> {e.title}
                <span className="muted small">
                  {' '}
                  · {e.system ? SYSTEM_NAMES[e.system] : 'sample'}
                  {e.range ? ` · ${e.range.from} to ${e.range.to}` : ''} · read {formatManila(e.retrievedAt)}
                  {!e.available ? ' · unavailable' : ''}
                  {e.note ? ` · ${e.note}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
        {d.mode === 'connected' && <p className="muted small">Totals and counts come from the office's own calculations; the AI only interprets them.</p>}
      </section>

      <p className="muted small">
        {d.mode === 'demo'
          ? 'No AI was used.'
          : `${d.aiRequests} AI request(s)${d.model ? ` · ${d.model}` : ''} · ${d.usage ? `${d.usage.totalTokens.toLocaleString()} tokens (${d.usage.promptTokens.toLocaleString()} in, ${d.usage.outputTokens.toLocaleString()} out)` : 'token usage not reported'}`}
      </p>
    </div>
  );
}

function Round({ title, items, ev, onOpenAgent }: { title: string; items: DiscussionMessage[]; ev: Map<string, Discussion['evidence'][number]>; onOpenAgent: (id: LiveAgentId) => void }) {
  if (!items.length) return null;
  return (
    <section>
      <h3>{title}</h3>
      <div className="stack">
        {items.map((m) => (
          <article key={m.id} className="output step">
            <header>
              <button className="cast" onClick={() => onOpenAgent(m.agent)}>
                <Avatar id={m.agent} size={24} />
                <span>
                  {AGENT_BY_ID[m.agent].name} <span className="muted small">{AGENT_BY_ID[m.agent].role}</span>
                </span>
              </button>
              <span className={`chip ${MSG_CLASS[m.status]}`}>{MSG_LABEL[m.status]}</span>
            </header>
            {(m.startedAt || m.finishedAt) && (
              <p className="muted small">
                {m.finishedAt ? `Finished ${formatManila(m.finishedAt)}` : m.startedAt ? `Started ${formatManila(m.startedAt)}` : ''}
                {m.attempts > 1 ? ` · ${m.attempts} attempts` : ''}
                {m.usage ? ` · ${m.usage.totalTokens.toLocaleString()} tokens` : ''}
              </p>
            )}
            {m.status === 'working' && (
              <div className="notice live">
                <span className="spinner" aria-hidden="true" />
                <p>{m.round === 'proposal' ? 'Writing a proposal…' : m.round === 'review' ? 'Reviewing the proposals…' : 'Writing the summary…'}</p>
              </div>
            )}
            {m.error && (m.status === 'failed' || m.status === 'skipped') && (
              <p className={`small ${m.status === 'failed' ? 'photo-note' : 'muted'}`}>
                {m.status === 'failed' ? 'Missing contribution: ' : 'Skipped: '}
                {m.error}
              </p>
            )}
            {m.proposal && (
              <>
                <Points title="Findings" items={m.proposal.findings} ev={ev} />
                <Points title="Suggested actions" items={m.proposal.actions} ev={ev} />
                <Bullets title="Assumptions" items={m.proposal.assumptions} />
                <Bullets title="Missing information" items={m.proposal.missingInfo} />
              </>
            )}
            {m.review && (
              <>
                {m.review.critiques.length > 0 && (
                  <>
                    <h4>Challenges</h4>
                    <ul className="mini-list">
                      {m.review.critiques.map((c, i) => (
                        <li key={i}>
                          {c.about && <b>{c.about}: </b>}
                          {c.text}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <Bullets title="Practical constraints" items={m.review.constraints} />
                <Bullets title="Trade-offs" items={m.review.tradeoffs} />
                <Bullets title="Improvements" items={m.review.improvements} />
              </>
            )}
            {m.droppedRefs ? <p className="muted small">{m.droppedRefs} reference(s) to evidence this agent was not given were removed.</p> : null}
          </article>
        ))}
      </div>
    </section>
  );
}

function Points({ title, items, ev }: { title: string; items: DiscussionPoint[]; ev: Map<string, Discussion['evidence'][number]> }) {
  if (!items.length) return null;
  return (
    <>
      <h4>{title}</h4>
      <ul className="mini-list disc-points">
        {items.map((p, i) => (
          <li key={i}>
            <span className={`tag kind-${p.kind}`}>{KIND_LABEL[p.kind]}</span> {p.text}
            <Refs ids={p.evidence} ev={ev} />
          </li>
        ))}
      </ul>
    </>
  );
}

function Refs({ ids, ev }: { ids: string[]; ev: Map<string, Discussion['evidence'][number]> }) {
  if (!ids.length) return null;
  return (
    <span className="disc-refs">
      {ids.map((id) => (
        <code key={id} title={ev.get(id)?.title ?? ''}>
          {id}
        </code>
      ))}
    </span>
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

/** Plain-text summary for the clipboard. */
export function summaryText(d: Discussion): string {
  const s = d.messages.find((m) => m.round === 'synthesis')?.synthesis;
  const names = (['chief', ...d.participants] as LiveAgentId[]).map((a) => `${AGENT_BY_ID[a].name} (${AGENT_BY_ID[a].role})`).join(', ');
  const list = (title: string, xs: string[]) => (xs.length ? `\n${title}:\n${xs.map((x) => `- ${x}`).join('\n')}\n` : '');
  return [
    `Team discussion: ${d.topic}${d.mode === 'demo' ? ' (DEMO SAMPLE, not real data)' : ''}`,
    `Date: ${formatManila(d.createdAt)}${d.mode === 'connected' ? ` · data period ${d.range.from} to ${d.range.to}` : ''}`,
    `Participants: ${names}`,
    d.partial ? 'Note: some contributions are missing (see limitations).' : '',
    '',
    s ? `Summary:\n${s.summary}` : `Status: ${STATUS_LABEL[d.status]}${d.error ? ` — ${d.error}` : ''}`,
    s?.approach ? `\nRecommended approach:\n${s.approach}${s.reasoning ? `\nWhy: ${s.reasoning}` : ''}` : '',
    s ? list('Action items (proposed)', s.actions.map((a) => `${a.text} — owner: ${a.owner}${a.evidence.length ? ` [${a.evidence.join(', ')}]` : ''}`)) : '',
    s ? list('Risks', s.risks) : '',
    s ? list('Open questions', s.openQuestions) : '',
    s ? list('Remaining disagreement', s.disagreements) : '',
    s ? list('Limitations', s.limitations) : '',
    list('Evidence', d.evidence.map((e) => `${e.id} ${e.title}${e.available ? '' : ' (unavailable)'} — read ${formatManila(e.retrievedAt)}`)),
    'Proposals only: nothing was changed, sent or carried out.',
  ]
    .filter((x) => x !== '')
    .join('\n');
}
