// Demo Mode team discussions: clearly labelled SAMPLE content, no AI and no real data.
//
// They follow the same steps as the real ones (gathering → proposals → reviews → Chief), timed on
// the simulation clock so pause and speed work, and are kept in this browser under their own
// storage key, separate from Connected Mode's discussions (which live on the server). Nothing here
// is ever shown in Connected Mode, and a failed Connected Mode request never falls back to it.

import type { Discussion, DiscussionInput, DiscussionMessage, DiscussionRound, EvidenceRef, LiveAgentId } from '../../shared/live';
import { DISCUSSION_ACTIVE, DISCUSSION_LIMITS, LIVE_AGENT_IDS } from '../../shared/live';
import { AGENT_BY_ID } from '../agents/roster';
import type { Engine, StorageLike } from './engine';

const KEY = 'wad-ai-office:demo-discussions:v1';
const STEP_MS = 2600;
const KEEP = 20;

/** Sample points per role (illustrative only; every one is labelled as a sample). */
const SAMPLE: Partial<Record<LiveAgentId, { finding: string; action: string; concern: string }>> = {
  lia: { finding: 'Some sample inquiries reach production with the door size still unconfirmed.', action: 'Confirm size, design and finish in writing before an order is created.', concern: 'Promised dates are given before the specs are final.' },
  marco: { finding: 'Sample quotations change after approval in a few cases.', action: 'Freeze the quotation before production starts.', concern: 'Price changes after approval upset customers.' },
  paolo: { finding: 'In the sample data, orders wait longest at assembly.', action: 'Review the assembly queue every morning.', concern: 'One busy stage can hold up everything behind it.' },
  nina: { finding: 'Sample installations cluster at the end of the month.', action: 'Spread installation dates across the month.', concern: 'Crews are overbooked in the last week.' },
  bea: { finding: 'Sample expenses rise with rush work.', action: 'Track overtime and rush costs per month.', concern: 'Rush work cuts the margin.' },
  rosa: { finding: 'A few sample finished orders still have a balance.', action: 'Collect the balance before delivery.', concern: 'Delivering before payment slows cash flow.' },
  mika: { finding: 'The sample trend shows more orders in the last two months.', action: 'Compare orders per month against finishing capacity.', concern: 'Two months is too short to call it a trend.' },
  carlo: { finding: 'Sample customers ask about delivery dates on social media.', action: 'Post realistic lead times on the Page.', concern: 'Advertised dates must match the shop floor.' },
  joy: { finding: 'Sample customer messages mostly ask "kailan ma-deliver?".', action: 'Send a status update when an order changes stage.', concern: 'Silence makes customers worry more than a delay.' },
  tess: { finding: 'Some sample orders reach finishing with the jamb size still blank.', action: 'Check every order has size, finish and jamb before production starts.', concern: 'Rework costs more than checking the specs first.' },
  aya: { finding: 'Staff scroll sideways to see sample orders on a phone.', action: 'Show orders as cards on small screens.', concern: 'Hard-to-read pages lead to wrong entries.' },
  rey: { finding: 'The suggested form changes are small CSS and HTML edits.', action: 'Make one change at a time and test it on a phone.', concern: 'Big changes at once are harder to check.' },
  kim: { finding: 'The sample order form has no error message for a missing due date.', action: 'Add a clear error and test it before release.', concern: 'Untested changes can break order entry.' },
  dev: { finding: 'Some sample orders have no due date recorded.', action: 'Make the due date required in the order form.', concern: 'Missing data hides the real delays.' },
  sam: { finding: 'The sample systems answered normally.', action: 'Keep an eye on slow responses during busy hours.', concern: 'Slow tools slow down updates.' },
  ivy: { finding: 'No unusual sign-ins in the sample.', action: 'Give each staff member their own account.', concern: 'Shared accounts hide who changed what.' },
};
const fallback = { finding: 'The sample data gives a partial picture only.', action: 'Check the real data in Connected Mode.', concern: 'Sample numbers are not real.' };

const EVIDENCE = (at: string): EvidenceRef[] => [
  { id: 'E1', title: 'Sample order status (demo data)', system: null, retrievedAt: at, range: null, available: true, note: 'Demo sample, not real records.' },
  { id: 'E2', title: 'Sample production stages (demo data)', system: null, retrievedAt: at, range: null, available: true, note: 'Demo sample, not real records.' },
  { id: 'E3', title: 'Sample payments (demo data)', system: null, retrievedAt: at, range: null, available: true, note: 'Demo sample, not real records.' },
];

const isActive = (d: Discussion) => DISCUSSION_ACTIVE.includes(d.status);
const nm = (a: LiveAgentId) => AGENT_BY_ID[a].name;

export class DemoDiscussions {
  list: Discussion[] = [];
  /** Sim time of the next step, and the step number, per running discussion. */
  private clock = new Map<string, { next: number; step: number }>();

  constructor(private storage: StorageLike | null) {
    try {
      const v = JSON.parse(storage?.getItem(KEY) ?? 'null') as Discussion[] | null;
      if (Array.isArray(v)) this.list = v.filter((d) => d && d.mode === 'demo');
    } catch {
      this.list = [];
    }
    // A demo discussion cannot survive a reload: say so instead of showing it as running.
    for (const d of this.list)
      if (isActive(d)) {
        d.status = 'failed';
        d.error = 'Interrupted: the page was reloaded. (Demo sample.)';
        d.finishedAt = new Date().toISOString();
        for (const m of d.messages) if (m.status === 'working' || m.status === 'waiting') m.status = 'cancelled';
      }
    this.save();
  }

  get(id: string) {
    return this.list.find((d) => d.id === id) ?? null;
  }

  active() {
    return this.list.find(isActive) ?? null;
  }

  start(input: DiscussionInput, engine: Engine): Discussion {
    const topic = (input.topic ?? '').replace(/\s+/g, ' ').trim();
    const participants = [...new Set(input.participants ?? [])].filter((a) => LIVE_AGENT_IDS.includes(a) && a !== 'chief');
    if (topic.length < 3) throw new Error('Type a topic or goal for the discussion.');
    if (topic.length > DISCUSSION_LIMITS.topicChars) throw new Error(`Keep the topic under ${DISCUSSION_LIMITS.topicChars} characters.`);
    if (participants.length < DISCUSSION_LIMITS.minSpecialists || participants.length > DISCUSSION_LIMITS.maxSpecialists)
      throw new Error(`Choose ${DISCUSSION_LIMITS.minSpecialists} to ${DISCUSSION_LIMITS.maxSpecialists} participants besides Chief.`);
    if (this.active()) throw new Error('A demo discussion is already running.');
    const at = new Date().toISOString();
    const msg = (round: DiscussionRound, agent: LiveAgentId): DiscussionMessage => ({ id: `${round}-${agent}`, round, agent, status: 'waiting', startedAt: null, finishedAt: null, error: null, attempts: 0 });
    const d: Discussion = {
      id: `demo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      mode: 'demo',
      owner: 'demo',
      topic,
      context: (input.context ?? '').trim().slice(0, DISCUSSION_LIMITS.contextChars),
      participants,
      moderator: 'chief',
      range: input.range ?? { from: at.slice(0, 10), to: at.slice(0, 10) },
      status: 'queued',
      createdAt: at,
      updatedAt: at,
      startedAt: null,
      finishedAt: null,
      error: null,
      partial: false,
      evidence: [],
      messages: [...participants.map((a) => msg('proposal', a)), ...participants.map((a) => msg('review', a)), msg('synthesis', 'chief')],
      model: null,
      usage: null,
      aiRequests: 0,
    };
    this.list.unshift(d);
    this.list = this.list.slice(0, KEEP);
    this.clock.set(d.id, { next: engine.now + 900, step: 0 });
    engine.startMeeting(d.id, ['chief', ...participants]);
    engine.addLog(`Team discussion started (demo sample): ${topic}`, 'info', 'chief');
    this.save();
    return d;
  }

  cancel(id: string, engine: Engine) {
    const d = this.get(id);
    if (!d || !isActive(d)) return;
    this.finish(d, 'cancelled', 'Cancelled. (Demo sample.)');
    engine.endMeeting(id);
    engine.addLog('Team discussion cancelled (demo sample).', 'warn', 'chief');
  }

  stopAll(reason: string) {
    for (const d of this.list) if (isActive(d)) this.finish(d, 'cancelled', reason);
  }

  clear() {
    this.list = [];
    this.clock.clear();
    this.save();
  }

  /** Advances running demo discussions on the simulation clock; true when something changed. */
  tick(engine: Engine): boolean {
    let changed = false;
    for (const d of this.list) {
      const c = this.clock.get(d.id);
      if (!c || !isActive(d) || engine.now < c.next) continue;
      this.step(d, c.step, engine);
      c.step++;
      c.next = engine.now + STEP_MS;
      changed = true;
    }
    return changed;
  }

  private step(d: Discussion, step: number, engine: Engine) {
    const now = new Date().toISOString();
    const props = d.messages.filter((m) => m.round === 'proposal');
    const revs = d.messages.filter((m) => m.round === 'review');
    const chief = d.messages.find((m) => m.round === 'synthesis')!;
    const order = [...props, ...revs, chief];
    const finishWorking = () => {
      for (const m of d.messages)
        if (m.status === 'working') {
          this.fill(d, m);
          m.status = 'done';
          m.finishedAt = now;
        }
    };
    if (step === 0) {
      d.status = 'gathering';
      d.startedAt = now;
      d.evidence = EVIDENCE(now);
      for (const a of ['chief', ...d.participants] as LiveAgentId[]) engine.meetingStatus(d.id, a, 'Reviewing data (demo sample)');
      engine.meetingStatus(d.id, 'chief', 'Reviewing data (demo sample)', 'Tingnan muna natin ang data');
    } else if (step <= order.length) {
      finishWorking();
      const m = order[step - 1];
      d.status = m.round === 'proposal' ? 'proposals' : m.round === 'review' ? 'reviews' : 'synthesizing';
      m.status = 'working';
      m.startedAt = now;
      const label = m.round === 'proposal' ? 'Proposing' : m.round === 'review' ? 'Reviewing ideas' : 'Writing the summary';
      engine.meetingStatus(d.id, m.agent, `${label} (demo sample)`, label);
    } else {
      finishWorking();
      this.finish(d, 'completed', null);
      engine.endMeeting(d.id);
      engine.addLog('Team discussion finished (demo sample). Open it to read the summary.', 'success', 'chief');
    }
    d.updatedAt = now;
    this.save();
  }

  private fill(d: Discussion, m: DiscussionMessage) {
    const s = SAMPLE[m.agent] ?? fallback;
    if (m.round === 'proposal')
      m.proposal = {
        findings: [{ text: `Sample: ${s.finding}`, kind: 'hypothesis', evidence: ['E1'] }],
        actions: [{ text: s.action, kind: 'recommendation', evidence: [] }],
        assumptions: ['Demo sample data, not your real records.'],
        missingInfo: ['Real order, production and payment data (available in Connected Mode).'],
      };
    else if (m.round === 'review') {
      const others = d.participants.filter((a) => a !== m.agent);
      const about = others[d.participants.indexOf(m.agent) % others.length] ?? others[0];
      m.review = {
        critiques: [{ about: nm(about), text: `Sample: ${(SAMPLE[about] ?? fallback).concern} The sample data cannot confirm it.` }],
        constraints: [s.concern],
        tradeoffs: ['Faster fixes vs. checking the data first.'],
        improvements: [`Check this against real data before acting: ${s.action.toLowerCase()}`],
      };
    } else
      m.synthesis = {
        summary: `Demo sample summary for "${d.topic}". The team suggested starting with the points below; these are illustrative, not based on your data.`,
        approach: 'Start with the simplest checks, then decide with real numbers from Connected Mode.',
        reasoning: 'Sample data only, so every point is a hypothesis to confirm.',
        actions: d.participants.map((a) => ({ text: (SAMPLE[a] ?? fallback).action, owner: nm(a), evidence: [] })),
        risks: ['Acting on sample numbers would be a mistake: run the discussion in Connected Mode for real evidence.'],
        openQuestions: ['What do the real records show for this period?'],
        disagreements: [],
        limitations: ['Demo Mode: sample content, no AI and no real data.'],
      };
  }

  private finish(d: Discussion, status: Discussion['status'], error: string | null) {
    d.status = status;
    d.error = error;
    d.finishedAt = d.updatedAt = new Date().toISOString();
    for (const m of d.messages) if (m.status === 'waiting' || m.status === 'working') m.status = status === 'completed' ? 'skipped' : 'cancelled';
    this.clock.delete(d.id);
    this.save();
  }

  private save() {
    try {
      this.storage?.setItem(KEY, JSON.stringify(this.list));
    } catch {
      /* storage full or blocked: keep the in-memory copy */
    }
  }
}
