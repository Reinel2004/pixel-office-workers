import { forwardRef, useEffect, useRef, useState } from 'react';
import { AGENTS } from '../agents/roster';
import type { Engine } from '../sim/engine';
import type { AgentId } from '../sim/types';
import { IconDoor, IconFactory, IconMegaphone, IconSend } from './icons';
import { useEngine } from './shared';

interface Props {
  engine: Engine;
  agent: AgentId;
  setAgent: (id: AgentId) => void;
  focusSignal: number;
  onStarted: (taskId: string) => void;
  /** Connected Mode replaces the demo controls with live report controls. */
  connectedContent?: React.ReactNode;
}

const SUGGESTIONS: Record<AgentId, string> = {
  lia: 'Draft a reply asking for door size and design',
  marco: 'Outline a quotation for 2 flush doors',
  paolo: 'Check which jobs are in finishing',
  nina: 'Plan installations for next week',
  bea: 'Prepare a weekly sales summary',
  rosa: 'List orders with an unpaid balance',
  mika: 'Which products sell best?',
  carlo: 'Write a caption for a carved door',
  joy: 'Reply to a customer asking about their order',
  dev: 'Check the order data for mistakes',
  chief: 'Plan the team priorities for today',
};

export const BottomBar = forwardRef<HTMLDivElement, Props>(function BottomBar({ engine, agent, setAgent, focusSignal, onStarted, connectedContent }, ref) {
  useEngine(engine);
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focusSignal) input.current?.focus();
  }, [focusSignal]);

  const submit = () => {
    const v = text.trim();
    if (!v) return;
    const t = engine.assignCustom(agent, v);
    setText('');
    onStarted(t.id);
  };
  const busy = (kind: string) => engine.tasks.some((t) => t.kind === kind && (t.status === 'running' || t.status === 'queued' || t.status === 'awaiting_approval'));

  if (engine.connected)
    return (
      <div className="bottombar connected" ref={ref}>
        {connectedContent}
      </div>
    );

  return (
    <div className="bottombar" ref={ref}>
      <div className="demos" role="group" aria-label="Demo workflows">
        <span className="demos-label">Demos</span>
        <button className="demo-btn" onClick={() => onStarted(engine.startDemo('inquiry').id)} disabled={busy('inquiry')}>
          <IconDoor size={16} />
          New Door Inquiry
        </button>
        <button className="demo-btn" onClick={() => onStarted(engine.startDemo('production').id)} disabled={busy('production')}>
          <IconFactory size={16} />
          Production Review
        </button>
        <button className="demo-btn" onClick={() => onStarted(engine.startDemo('marketing').id)} disabled={busy('marketing')}>
          <IconMegaphone size={16} />
          Marketing Draft
        </button>
      </div>
      <form
        className="task-input"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="sr-only" htmlFor="agent-select">
          Agent
        </label>
        <select id="agent-select" value={agent} onChange={(e) => setAgent(e.target.value as AgentId)}>
          {AGENTS.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} — {a.role}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="task-text">
          Task
        </label>
        <input
          id="task-text"
          ref={input}
          value={text}
          maxLength={160}
          onChange={(e) => setText(e.target.value)}
          placeholder={`e.g. ${SUGGESTIONS[agent]}`}
          autoComplete="off"
        />
        <button className="btn primary" type="submit" disabled={!text.trim()}>
          <IconSend size={16} />
          <span>Assign</span>
        </button>
      </form>
    </div>
  );
});
