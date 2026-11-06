// Workflow scripts. Each task is a list of steps the engine plays in order; every movement,
// state change, speech bubble and log line on screen comes from one of these steps.

import type { ComposeRequest } from '../agents/brain';
import { MOCK_ORDERS, SAMPLE_INQUIRY, reviewOrder } from '../data/mock';
import { SPOTS } from '../office/layout';
import type { AgentId, LogKind, TaskKind } from './types';

export type Target =
  | { seat: true }
  | { meeting: number }
  | { tile: { x: number; y: number }; face?: { x: number; y: number } }
  | { near: AgentId };

export type Step =
  | { t: 'move'; agent: AgentId; to: Target; activity?: string }
  | { t: 'moveAll'; moves: { agent: AgentId; to: Target }[]; activity?: string }
  | { t: 'work'; agent: AgentId; ms: number; activity: string; say?: string }
  | { t: 'compose'; agent: AgentId; ms: number; activity: string; req: ComposeRequest; say?: string }
  | { t: 'say'; agent: AgentId; text: string; ms?: number }
  | { t: 'log'; text: string; kind?: LogKind; agent?: AgentId }
  | {
      t: 'approval';
      agent: AgentId;
      title: string;
      onApprove: Step[];
      onReject: Step[];
    }
  | { t: 'fail'; agent: AgentId; reason: string }
  | { t: 'complete'; credit: AgentId[]; note?: string }
  | { t: 'reject'; note: string };

export interface TaskTemplate {
  kind: TaskKind;
  title: string;
  description: string;
  cast: AgentId[];
  primary: AgentId;
  steps: Step[];
  prompt?: string;
}

const seat = { seat: true } as const;

export function inquiryWorkflow(): TaskTemplate {
  return {
    kind: 'inquiry',
    title: 'New Door Inquiry',
    description: `${SAMPLE_INQUIRY.customer} asks about a ${SAMPLE_INQUIRY.size} ${SAMPLE_INQUIRY.material.toLowerCase()} door.`,
    cast: ['lia', 'marco', 'chief'],
    primary: 'lia',
    steps: [
      { t: 'log', text: `Sample inquiry received (simulated): ${SAMPLE_INQUIRY.size} mahogany door`, kind: 'info', agent: 'lia' },
      { t: 'move', agent: 'lia', to: seat, activity: 'Heading to desk' },
      { t: 'work', agent: 'lia', ms: 2600, activity: 'Reading the customer inquiry', say: 'New inquiry!' },
      {
        t: 'compose',
        agent: 'lia',
        ms: 3200,
        activity: 'Listing missing requirements',
        req: { kind: 'inquiry-requirements', agentId: 'lia' },
        say: 'Need a few details',
      },
      { t: 'work', agent: 'lia', ms: 2800, activity: 'Collecting details (simulated customer reply)' },
      { t: 'log', text: 'Simulated customer reply recorded. No real message was sent.', kind: 'info', agent: 'lia' },
      {
        t: 'moveAll',
        activity: 'Meeting at the Command Center',
        moves: [
          { agent: 'lia', to: { meeting: 0 } },
          { agent: 'marco', to: { meeting: 3 } },
          { agent: 'chief', to: { meeting: 2 } },
        ],
      },
      { t: 'say', agent: 'lia', text: 'Specs are complete', ms: 1800 },
      { t: 'say', agent: 'marco', text: "I'll draft the quote", ms: 1800 },
      { t: 'say', agent: 'chief', text: 'Send it for approval', ms: 1800 },
      {
        t: 'moveAll',
        activity: 'Back to desk',
        moves: [
          { agent: 'lia', to: seat },
          { agent: 'marco', to: seat },
          { agent: 'chief', to: seat },
        ],
      },
      {
        t: 'compose',
        agent: 'marco',
        ms: 4200,
        activity: 'Preparing quotation draft (demo prices)',
        req: { kind: 'quotation', agentId: 'marco' },
        say: 'Draft ready',
      },
      { t: 'move', agent: 'marco', to: { near: 'chief' }, activity: 'Bringing draft to Chief' },
      { t: 'say', agent: 'marco', text: 'Quote for approval', ms: 1600 },
      { t: 'work', agent: 'chief', ms: 1800, activity: 'Reviewing the quotation draft' },
      { t: 'move', agent: 'marco', to: seat, activity: 'Back to desk' },
      {
        t: 'approval',
        agent: 'chief',
        title: 'Quotation draft — 90 × 210 cm mahogany door',
        onApprove: [
          { t: 'say', agent: 'chief', text: 'Approved', ms: 1600 },
          { t: 'log', text: 'Quotation approved (demo). Nothing was sent to the customer.', kind: 'success', agent: 'chief' },
          { t: 'work', agent: 'lia', ms: 2200, activity: 'Filing the approved draft (not sent)', say: 'Saved, not sent' },
          { t: 'complete', credit: ['lia', 'marco', 'chief'], note: 'Approved draft saved. No message sent.' },
        ],
        onReject: [
          { t: 'say', agent: 'chief', text: 'Please revise', ms: 1600 },
          { t: 'log', text: 'Quotation rejected — returned to Marco for revision (demo).', kind: 'warn', agent: 'chief' },
          { t: 'work', agent: 'marco', ms: 2000, activity: 'Noting the revision request', say: 'Will revise' },
          { t: 'reject', note: 'Returned to Marco for revision. Nothing was sent.' },
        ],
      },
    ],
  };
}

export function productionWorkflow(): TaskTemplate {
  const checks: Step[] = [];
  for (const o of MOCK_ORDERS) {
    const r = reviewOrder(o);
    checks.push({
      t: 'work',
      agent: 'paolo',
      ms: 1300,
      activity: `Checking ${o.ref} — ${o.item}`,
      say: r.level === 'warn' ? (o.dueInDays < 0 ? 'Overdue!' : 'No update?') : undefined,
    });
    checks.push({
      t: 'log',
      text: `${o.ref}: ${r.issue}`,
      kind: r.level === 'warn' ? 'warn' : 'info',
      agent: 'paolo',
    });
  }
  return {
    kind: 'production',
    title: 'Production Review',
    description: `Paolo checks ${MOCK_ORDERS.length} mock orders and reports issues to Chief.`,
    cast: ['paolo', 'chief'],
    primary: 'paolo',
    steps: [
      { t: 'log', text: 'Production review started (mock orders).', kind: 'info', agent: 'paolo' },
      { t: 'move', agent: 'paolo', to: { tile: SPOTS.opsBoard, face: { x: 4, y: 12 } }, activity: 'Going to the production board' },
      { t: 'work', agent: 'paolo', ms: 2200, activity: 'Reading the production board', say: 'Pulling the order list' },
      { t: 'move', agent: 'paolo', to: seat, activity: 'Back to desk' },
      ...checks,
      {
        t: 'compose',
        agent: 'paolo',
        ms: 2400,
        activity: 'Writing the review summary',
        req: { kind: 'production-summary', agentId: 'paolo' },
      },
      {
        t: 'moveAll',
        activity: 'Briefing Chief',
        moves: [
          { agent: 'paolo', to: { meeting: 0 } },
          { agent: 'chief', to: { meeting: 1 } },
        ],
      },
      { t: 'say', agent: 'paolo', text: '2 jobs need attention', ms: 2000 },
      { t: 'work', agent: 'chief', ms: 2200, activity: 'Reviewing the production summary', say: "Noted, I'll follow up" },
      { t: 'log', text: 'Chief received the production summary (2 flagged jobs).', kind: 'success', agent: 'chief' },
      {
        t: 'moveAll',
        activity: 'Back to desk',
        moves: [
          { agent: 'paolo', to: seat },
          { agent: 'chief', to: seat },
        ],
      },
      { t: 'complete', credit: ['paolo', 'chief'] },
    ],
  };
}

export function marketingWorkflow(): TaskTemplate {
  return {
    kind: 'marketing',
    title: 'Marketing Draft',
    description: 'Carlo drafts a Facebook caption for a completed wooden door. Nothing is published.',
    cast: ['carlo'],
    primary: 'carlo',
    steps: [
      { t: 'log', text: 'Marketing draft requested: completed mahogany door.', kind: 'info', agent: 'carlo' },
      { t: 'move', agent: 'carlo', to: seat, activity: 'Heading to desk' },
      { t: 'work', agent: 'carlo', ms: 2000, activity: 'Reading the job brief', say: 'Nice wood grain' },
      {
        t: 'move',
        agent: 'carlo',
        to: { tile: SPOTS.creativeEasel, face: { x: 29, y: 3 } },
        activity: 'Checking product photos in the Creative Studio',
      },
      { t: 'work', agent: 'carlo', ms: 2600, activity: 'Picking the best mock photo', say: 'This angle works' },
      { t: 'move', agent: 'carlo', to: seat, activity: 'Back to desk' },
      {
        t: 'compose',
        agent: 'carlo',
        ms: 3600,
        activity: 'Writing the caption',
        req: { kind: 'caption', agentId: 'carlo' },
        say: 'Caption ready',
      },
      { t: 'log', text: 'Caption ready for review. Nothing was published.', kind: 'success', agent: 'carlo' },
      { t: 'complete', credit: ['carlo'], note: 'Ready for your review. Not published.' },
    ],
  };
}

export function customWorkflow(agent: AgentId, prompt: string, allowFail = true): TaskTemplate {
  const wantsFail = allowFail && /\b(fail|error)\b/i.test(prompt);
  const steps: Step[] = [
    { t: 'log', text: `Custom task assigned: "${prompt}"`, kind: 'info', agent },
  ];
  if (agent === 'chief') {
    steps.push({ t: 'move', agent, to: { meeting: 1 }, activity: 'Going to the meeting table' });
  } else {
    steps.push({ t: 'move', agent, to: seat, activity: 'Heading to desk' });
  }
  steps.push({ t: 'work', agent, ms: 2200, activity: 'Reading the request', say: 'On it' });
  if (wantsFail) {
    steps.push({ t: 'work', agent, ms: 1800, activity: 'Looking for required data' });
    steps.push({ t: 'fail', agent, reason: 'Simulated failure: the requested data source is not available in demo mode.' });
  } else {
    steps.push({
      t: 'compose',
      agent,
      ms: 3200,
      activity: 'Preparing a template response',
      req: { kind: 'custom', agentId: agent, prompt },
      say: 'Done',
    });
    if (agent === 'chief') steps.push({ t: 'move', agent, to: seat, activity: 'Back to desk' });
    steps.push({ t: 'complete', credit: [agent] });
  }
  return {
    kind: 'custom',
    title: prompt.length > 48 ? prompt.slice(0, 46) + '…' : prompt,
    description: prompt,
    cast: [agent],
    primary: agent,
    steps,
    prompt,
  };
}
