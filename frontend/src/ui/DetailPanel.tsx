import { useState } from 'react';
import { AGENTS, AGENT_BY_ID } from '../agents/roster';
import { TEMPLATE_LABEL } from '../agents/brain';
import { peso } from '../data/mock';
import { ROOM_BY_ID } from '../office/layout';
import { carpenterDef } from '../sim/workshop';
import { agentPortrait } from '../office/sprites';
import type { Engine, Task } from '../sim/engine';
import type { AgentId, RoomId, Selection, TaskOutput } from '../sim/types';
import type { LiveStore } from '../live/store';
import { Empty } from './ActivityPanel';
import { JobDetail, LiveAgentSection } from './live/LiveViews';
import { IconAlert, IconCheck, IconClose, IconCopy, IconRetry, IconSend, IconTarget } from './icons';
import { Avatar, StateChip, StatusChip, clock, timeAgo, useEngine } from './shared';

interface Props {
  engine: Engine;
  selection: Selection;
  setSelection: (s: Selection) => void;
  onAssign: (id: AgentId) => void;
  onLocate: (id: AgentId) => void;
  mobile: boolean;
  live: LiveStore;
}

export function DetailPanel({ engine, selection, setSelection, onAssign, onLocate, mobile, live }: Props) {
  useEngine(engine);
  if (!selection) return null;
  let body: React.ReactNode = null;
  let title = '';
  if (selection.kind === 'agent') {
    title = 'Agent';
    body = <AgentDetail engine={engine} id={selection.id} onAssign={onAssign} onLocate={onLocate} open={setSelection} live={live} />;
  } else if (selection.kind === 'room') {
    title = 'Room';
    body = <RoomDetail engine={engine} id={selection.id} open={setSelection} />;
  } else if (selection.kind === 'job') {
    title = 'Live report';
    const j = live.jobs.find((x) => x.id === selection.id);
    body = j ? (
      <JobDetail store={live} job={j} onOpenAgent={(id) => setSelection({ kind: 'agent', id })} />
    ) : (
      <Empty title="Report not found" text="Live reports are kept on the server for the current session only." />
    );
  } else {
    const t = engine.tasks.find((x) => x.id === selection.id);
    title = 'Task';
    body = t ? <TaskDetail engine={engine} task={t} open={setSelection} /> : <Empty title="Task not found" text="It may have been cleared by a demo reset." />;
  }
  return (
    <aside className={`panel detail ${mobile ? 'sheet' : ''}`} aria-label={`${title} details`}>
      <div className="panel-head">
        <span className="panel-kicker">{title}</span>
        <button className="icon-btn sm" onClick={() => setSelection(null)} aria-label="Close panel">
          <IconClose size={16} />
        </button>
      </div>
      <div className="panel-body scroll">{body}</div>
    </aside>
  );
}

// ---------------------------------------------------------------- agent
function AgentDetail({
  engine,
  id,
  onAssign,
  onLocate,
  open,
  live,
}: {
  engine: Engine;
  id: AgentId;
  onAssign: (id: AgentId) => void;
  onLocate: (id: AgentId) => void;
  open: (s: Selection) => void;
  live: LiveStore;
}) {
  const a = engine.agentById[id];
  const state = engine.agentState(a);
  const task = engine.currentTask(a);
  const room = engine.agentRoom(a);
  const queued = engine.tasks.filter((t) => t.status === 'queued' && t.cast.includes(id));
  return (
    <div className="stack">
      <div className="agent-head">
        <Avatar id={id} size={56} />
        <div>
          <h2>{a.def.name}</h2>
          <p className="muted">{a.def.role}</p>
          <StateChip state={state} />
        </div>
      </div>
      <p className="blurb">{a.def.blurb}</p>
      <div className="facts">
        <div>
          <span>Location</span>
          <b>{room ? ROOM_BY_ID[room].name : 'Hallway'}</b>
        </div>
        <div>
          <span>Desk</span>
          <b>{ROOM_BY_ID[a.def.room].name}</b>
        </div>
        <div>
          <span>{engine.connected ? 'Live done' : 'Completed'}</span>
          <b>{engine.connected ? live.jobs.filter((j) => j.steps.some((st) => st.agent === id && st.status === 'completed')).length : a.completedCount}</b>
        </div>
      </div>

      {engine.connected ? (
        <LiveAgentSection store={live} agent={id} onOpenJob={(jid) => open({ kind: 'job', id: jid })} />
      ) : (
      <section>
        <h3>Current task</h3>
        {task ? (
          <button className="card-link" onClick={() => open({ kind: 'task', id: task.id })}>
            <span className="card-link-title">{task.title}</span>
            <span className="muted small">{state === 'waiting' ? 'Waiting for your approval' : state === 'error' ? task.error : a.activity}</span>
            <StatusChip status={task.status} />
          </button>
        ) : (
          <p className="muted small">No active task. {a.def.name} is {state === 'walking' ? 'walking back to the desk' : 'at the desk'}.</p>
        )}
        {queued.length > 0 && <p className="muted small">{queued.length} queued task{queued.length > 1 ? 's' : ''} waiting for this agent.</p>}
      </section>
      )}

      {!engine.connected && state === 'error' && task && (
        <div className="notice error">
          <IconAlert size={16} />
          <div>
            <b>Task failed</b>
            <p>{task.error}</p>
            <div className="row">
              <button className="btn sm" onClick={() => engine.retry(task.id)}>
                <IconRetry size={14} /> Retry
              </button>
              <button className="btn ghost sm" onClick={() => engine.dismissError(id)}>
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}

      <section>
        <h3>Recent activity</h3>
        {a.recent.length === 0 ? (
          <p className="muted small">Nothing yet.</p>
        ) : (
          <ul className="mini-log">
            {a.recent.map((r, i) => (
              <li key={i}>
                <span>{r.text}</span>
                <time>{timeAgo(r.at)}</time>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="row actions">
        <button
          className="btn primary"
          onClick={() => onAssign(id)}
          disabled={engine.connected && !live.canAssign().ok}
          title={engine.connected ? live.canAssign().reason : undefined}
        >
          <IconSend size={15} /> Assign Task
        </button>
        <button className="btn ghost" onClick={() => onLocate(id)}>
          <IconTarget size={15} /> Locate
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- room
function RoomDetail({ engine, id, open }: { engine: Engine; id: RoomId; open: (s: Selection) => void }) {
  const r = ROOM_BY_ID[id];
  const assigned = AGENTS.filter((a) => a.room === id);
  const present = engine.agents.filter((a) => engine.agentRoom(a) === id);
  const visitors = present.filter((a) => a.def.room !== id);
  const ids = new Set<AgentId>([...assigned.map((a) => a.id), ...present.map((a) => a.id)]);
  const tasks = engine.tasks.filter((t) => t.cast.some((c) => ids.has(c))).slice(0, 8);
  const color = '#' + r.floor.toString(16).padStart(6, '0');
  return (
    <div className="stack">
      <div className="room-head">
        <span className="swatch" style={{ background: color }} />
        <h2>{r.name}</h2>
      </div>
      {id === 'workshop' && <WorkshopSection engine={engine} />}
      <section>
        <h3>Agents</h3>
        {assigned.length === 0 && visitors.length === 0 ? (
          <Empty title="No agents here" text="No one is assigned to this room right now. Agents may pass through during tasks." />
        ) : (
          <ul className="agent-list">
            {[...assigned, ...visitors.map((v) => v.def)].map((d) => {
              const a = engine.agentById[d.id];
              const here = engine.agentRoom(a) === id;
              return (
                <li key={d.id}>
                  <button className="agent-row" onClick={() => open({ kind: 'agent', id: d.id })}>
                    <Avatar id={d.id} size={30} />
                    <span>
                      <b>{d.name}</b>
                      <span className="muted small">
                        {d.role}
                        {d.room !== id ? ' · visiting' : here ? '' : ' · away'}
                      </span>
                    </span>
                    <StateChip state={engine.agentState(a)} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section>
        <h3>Tasks</h3>
        {tasks.length === 0 ? (
          <p className="muted small">No tasks for this room yet.</p>
        ) : (
          <ul className="task-list">
            {tasks.map((t) => (
              <li key={t.id}>
                <button className="task-row" onClick={() => open({ kind: 'task', id: t.id })}>
                  <span className="task-row-main">
                    <span className="task-row-title">{t.title}</span>
                    <span className="task-row-sub">{t.cast.map((c) => AGENT_BY_ID[c].name).join(', ')}</span>
                  </span>
                  <StatusChip status={t.status} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** The shop floor: each carpenter from WAD Order Management and their open orders. */
function WorkshopSection({ engine }: { engine: Engine }) {
  const shop = engine.workshop;
  const load = shop.load;
  const shown = new Map(shop.crew.map((c) => [c.def.name.toLowerCase(), c]));
  return (
    <section>
      <h3>Carpenters</h3>
      {!load ? (
        <p className="muted small">
          {shop.note === 'no-access'
            ? 'Your account cannot read orders, so the carpenters are not shown.'
            : shop.note === 'unavailable'
              ? 'The carpenters could not be read from WAD Order Management.'
              : 'Reading the carpenters…'}
        </p>
      ) : !load.available ? (
        <p className="muted small">
          WAD Order Management did not return carpenter assignments. Upload the latest <code>api/ceo/office-orders.php</code> to the server.
        </p>
      ) : load.carpenters.length === 0 ? (
        <p className="muted small">No carpenters are listed in WAD Order Management.</p>
      ) : (
        <ul className="agent-list">
          {load.carpenters.map((info) => {
            const c = shown.get(info.name.toLowerCase());
            const def = c?.def ?? carpenterDef(info.name);
            const parts = [
              info.inProgress ? `${info.inProgress} in progress` : '',
              info.pending ? `${info.pending} pending` : '',
              info.finished ? `${info.finished} finished` : '',
            ].filter(Boolean);
            return (
              <li key={info.name}>
                <div className="agent-row">
                  <span className="avatar" style={{ width: 30, height: 30, ['--ring' as string]: def.tint }}>
                    <img src={agentPortrait(def)} alt="" draggable={false} />
                  </span>
                  <span>
                    <b>{info.name}</b>
                    <span className="muted small">
                      {parts.length ? parts.join(' · ') : 'No open orders'}
                      {info.hamba ? ` (${info.hamba} as hamba carpenter)` : ''}
                      {c ? '' : ' · not at a bench (only 8 fit)'}
                    </span>
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {load && (
        <div className="kv">
          <div>
            <span>Ready for delivery</span>
            <b>{load.ready}</b>
          </div>
          <div>
            <span>Not yet assigned to a carpenter</span>
            <b>{load.unassigned}</b>
          </div>
          <div className="sub">
            <span>Open orders · overdue</span>
            <b>
              {load.open} · {load.overdue}
            </b>
          </div>
        </div>
      )}
      {load && (
        <p className="muted small">
          {load.source === 'demo'
            ? 'Demo Mode: sample carpenters and numbers.'
            : `From WAD Order Management${load.asOf ? `, read ${clock(Date.parse(load.asOf))}` : ''}. An order counts for each carpenter assigned to it, as carpenter or hamba carpenter. Names and counts only: no customers, prices or labor.`}
        </p>
      )}
      {engine.connected && engine.shopRefresh && shop.note !== 'no-access' && (
        <button className="btn sm" onClick={() => engine.shopRefresh?.()}>
          <IconRetry size={13} /> Refresh
        </button>
      )}
      <p className="muted small">The pixel carpenters are animation only: they work at a bench while they have orders in progress, prepare wood for pending ones, and sweep when they have none. They are not AI.</p>
    </section>
  );
}

// ---------------------------------------------------------------- task
function TaskDetail({ engine, task, open }: { engine: Engine; task: Task; open: (s: Selection) => void }) {
  const live = task.status === 'running' || task.status === 'queued';
  return (
    <div className="stack">
      <div>
        <h2>{task.title}</h2>
        <div className="row wrap gap-s">
          <StatusChip status={task.status} />
          <span className="muted small">Started {clock(task.createdAt)}</span>
        </div>
      </div>
      <p className="blurb">{task.description}</p>
      <div className="row gap-s">
        {task.cast.map((id) => (
          <button key={id} className="cast" onClick={() => open({ kind: 'agent', id })} title={`${AGENT_BY_ID[id].name} — ${AGENT_BY_ID[id].role}`}>
            <Avatar id={id} size={26} />
            <span>{AGENT_BY_ID[id].name}</span>
          </button>
        ))}
      </div>

      {live && (
        <div className="notice live">
          <span className="spinner" aria-hidden="true" />
          <div>
            <b>{task.status === 'queued' ? `Waiting for ${task.waitingFor ?? 'agents'}` : 'In progress'}</b>
            <p>{task.currentActivity ?? 'Starting…'}</p>
          </div>
        </div>
      )}

      {task.status === 'awaiting_approval' && task.approval && (
        <div className="approval">
          <div className="approval-head">
            <IconAlert size={16} />
            <b>Approval needed</b>
          </div>
          <p>
            {AGENT_BY_ID[task.approval.agent].name} is waiting for your decision on <b>{task.approval.title}</b>. Approving only saves the draft — no message is sent to anyone.
          </p>
          <div className="row">
            <button className="btn success" onClick={() => engine.decide(task.id, 'approved')}>
              <IconCheck size={15} /> Approve
            </button>
            <button className="btn danger-ghost" onClick={() => engine.decide(task.id, 'rejected')}>
              <IconClose size={15} /> Reject
            </button>
          </div>
        </div>
      )}

      {task.status === 'failed' && (
        <div className="notice error">
          <IconAlert size={16} />
          <div>
            <b>Task failed</b>
            <p>{task.error}</p>
            <button className="btn sm" onClick={() => engine.retry(task.id)}>
              <IconRetry size={14} /> Retry
            </button>
          </div>
        </div>
      )}

      {task.note && <p className={`note ${task.status === 'rejected' ? 'warn' : ''}`}>{task.note}</p>}

      {task.outputs.length > 0 && (
        <section>
          <h3>Results</h3>
          <div className="stack">
            {task.outputs.map((o, i) => (
              <OutputCard key={i} o={o} />
            ))}
          </div>
        </section>
      )}

      {task.kind === 'marketing' && task.status === 'completed' && (
        <div className="row">
          {task.reviewed ? (
            <span className="chip status-completed">
              <IconCheck size={13} /> Reviewed
            </span>
          ) : (
            <button className="btn" onClick={() => engine.markReviewed(task.id)}>
              <IconCheck size={15} /> Mark as reviewed
            </button>
          )}
          <span className="muted small">Not published anywhere.</span>
        </div>
      )}

      {task.status === 'interrupted' && (
        <button className="btn" onClick={() => engine.retry(task.id)}>
          <IconRetry size={15} /> Run again
        </button>
      )}
    </div>
  );
}

function OutputCard({ o }: { o: TaskOutput }) {
  const [copied, setCopied] = useState(false);
  const total = o.quote?.lines.reduce((s, l) => s + l.qty * l.unit, 0) ?? 0;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(o.body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard not available */
    }
  };
  return (
    <article className="output">
      <header>
        <b>{o.title}</b>
        <button className="icon-btn sm" onClick={copy} aria-label="Copy text" title={copied ? 'Copied' : 'Copy text'}>
          {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
        </button>
      </header>
      <span className="tag">{TEMPLATE_LABEL}</span>
      <p className="pre">{o.body}</p>
      {o.checklist && (
        <ul className="checklist">
          {o.checklist.map((c) => (
            <li key={c.label}>
              <span>{c.label}</span>
              <b>{c.value}</b>
            </li>
          ))}
        </ul>
      )}
      {o.quote && (
        <div className="quote">
          <div className="watermark" aria-hidden="true">
            DEMO
          </div>
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>Qty</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {o.quote.lines.map((l) => (
                <tr key={l.item}>
                  <td>{l.item}</td>
                  <td>{l.qty}</td>
                  <td>{peso(l.qty * l.unit)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2}>Total (demo)</td>
                <td>{peso(total)}</td>
              </tr>
            </tfoot>
          </table>
          <p className="demo-note">
            <IconAlert size={13} /> {o.quote.note}
          </p>
        </div>
      )}
      {o.flags && (
        <ul className="flags">
          {o.flags.map((f) => (
            <li key={f.ref} className={f.level}>
              <b>{f.ref}</b>
              <span>{f.issue}</span>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
