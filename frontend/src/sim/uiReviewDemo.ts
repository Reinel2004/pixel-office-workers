// Demo Mode UI Reviews: clearly labelled SAMPLE content, no AI, no screenshots sent anywhere.
//
// They follow the same steps as the real ones (Aya and Kim review → Rey plans → you accept →
// Kim re-checks), timed on the simulation clock so pause and speed work, and are kept in this
// browser under their own storage key. Nothing here is ever shown in Connected Mode.

import type { UiFinding, UiReview, UiReviewInput, UiStep } from '../../shared/live';
import { UI_REVIEW_LIMITS, UI_REVIEW_RUNNING } from '../../shared/live';
import type { Engine, StorageLike } from './engine';

const KEY = 'wad-ai-office:demo-ui-reviews:v1';
const STEP_MS = 2800;
const KEEP = 20;
const TEAM = ['aya', 'kim', 'rey'] as const;

const running = (r: UiReview) => UI_REVIEW_RUNNING.includes(r.status);

const DESIGN: UiFinding[] = [
  { id: 'A1', area: 'mobile', severity: 'high', problem: 'Sample: the orders table is wider than a phone screen, so staff scroll sideways.', suggestion: 'Below 640 px, show each order as a card with the order number, status and due date.', shot: 1 },
  { id: 'A2', area: 'layout', severity: 'medium', problem: 'Sample: the "Add order" button is at the bottom of a long page.', suggestion: 'Move it to the top right of the header.', shot: 1 },
  { id: 'A3', area: 'readability', severity: 'low', problem: 'Sample: the status text is small and light grey.', suggestion: 'Use coloured status chips with darker text.', shot: null },
];
const USABILITY: UiFinding[] = [
  { id: 'K1', area: 'accessibility', severity: 'medium', problem: 'Sample: the action buttons are smaller than a fingertip.', suggestion: 'Make buttons at least 44 px tall on phones.', shot: 1 },
  { id: 'K2', area: 'workflow', severity: 'medium', problem: 'Sample: saving an order gives no confirmation.', suggestion: 'Show a short "Order saved" message after saving.', shot: null },
];

export class DemoUiReviews {
  list: UiReview[] = [];
  private clock = new Map<string, { next: number; step: number }>();

  constructor(private storage: StorageLike | null) {
    try {
      const v = JSON.parse(storage?.getItem(KEY) ?? 'null') as UiReview[] | null;
      if (Array.isArray(v)) this.list = v.filter((r) => r && r.mode === 'demo');
    } catch {
      this.list = [];
    }
    for (const r of this.list)
      if (running(r)) {
        if (r.status === 'verifying') {
          const v = r.verifications[r.verifications.length - 1];
          if (v) v.step.status = 'cancelled';
          r.status = 'proposed';
        } else {
          r.status = 'failed';
          r.error = 'Interrupted: the page was reloaded. (Demo sample.)';
          for (const s of r.steps) if (s.status === 'working' || s.status === 'waiting') s.status = 'cancelled';
        }
      }
    this.save();
  }

  get(id: string) {
    return this.list.find((r) => r.id === id) ?? null;
  }

  active() {
    return this.list.find(running) ?? null;
  }

  start(input: Omit<UiReviewInput, 'shots' | 'noPrivateData'> & { shots: number }, engine: Engine): UiReview {
    const page = (input.page ?? '').replace(/\s+/g, ' ').trim();
    if (page.length < 2) throw new Error('Name the page you want reviewed (e.g. "Orders list").');
    if (page.length > UI_REVIEW_LIMITS.pageChars) throw new Error(`Keep the page name under ${UI_REVIEW_LIMITS.pageChars} characters.`);
    if (this.active()) throw new Error('A demo UI Review step is already running.');
    const at = new Date().toISOString();
    const step = (kind: UiStep['kind'], agent: UiStep['agent']): UiStep => ({ id: kind, agent, kind, status: 'waiting', startedAt: null, finishedAt: null, error: null, attempts: 0 });
    const n = Math.max(1, Math.min(UI_REVIEW_LIMITS.maxShots, input.shots || 1));
    const r: UiReview = {
      id: `demo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      mode: 'demo',
      owner: 'demo',
      site: input.site,
      page,
      address: input.address?.trim() || null,
      goal: (input.goal ?? '').trim().slice(0, UI_REVIEW_LIMITS.goalChars),
      device: input.device,
      status: 'queued',
      createdAt: at,
      updatedAt: at,
      finishedAt: null,
      error: null,
      before: Array.from({ length: n }, (_, i) => ({ label: `Sample screenshot ${i + 1}`, mimeType: 'image/jpeg', bytes: 0, sha256: 'demo' })),
      imagesKept: false,
      steps: [step('design', 'aya'), step('usability', 'kim'), step('plan', 'rey')],
      design: null,
      usability: null,
      plan: null,
      verifications: [],
      model: null,
      usage: null,
      aiRequests: 0,
    };
    this.list.unshift(r);
    this.list = this.list.slice(0, KEEP);
    this.clock.set(r.id, { next: engine.now + 900, step: 0 });
    engine.startMeeting(r.id, [...TEAM], 'devboard');
    engine.addLog(`UI Review started (demo sample): ${page}`, 'info', 'aya');
    this.save();
    return r;
  }

  accept(id: string, ids: string[]) {
    const r = this.get(id);
    if (!r?.plan || (r.status !== 'proposed' && r.status !== 'verified')) return;
    for (const c of r.plan.changes) c.accepted = ids.includes(c.id);
    this.save();
  }

  verify(id: string, engine: Engine) {
    const r = this.get(id);
    if (!r || (r.status !== 'proposed' && r.status !== 'verified') || this.active()) return;
    if (!r.plan?.changes.some((c) => c.accepted)) return;
    if (r.verifications.length >= UI_REVIEW_LIMITS.maxVerifications) return;
    const at = new Date().toISOString();
    r.verifications.push({
      round: r.verifications.length + 1,
      createdAt: at,
      note: '',
      shots: [{ label: 'Sample "after" screenshot', mimeType: 'image/jpeg', bytes: 0, sha256: 'demo' }],
      step: { id: `verify-${r.verifications.length + 1}`, agent: 'kim', kind: 'verify', status: 'working', startedAt: at, finishedAt: null, error: null, attempts: 1 },
      summary: '',
      checks: [],
      regressions: [],
      verdict: null,
    });
    r.status = 'verifying';
    r.error = null;
    this.clock.set(r.id, { next: engine.now + STEP_MS, step: 100 });
    engine.startMeeting(r.id, ['kim'], 'devboard');
    engine.meetingStatus(r.id, 'kim', 'Comparing before and after (demo sample)', 'Checking the changes');
    this.save();
  }

  cancel(id: string, engine: Engine) {
    const r = this.get(id);
    if (!r || !running(r)) return;
    if (r.status === 'verifying') {
      const v = r.verifications[r.verifications.length - 1];
      if (v) v.step.status = 'cancelled';
      r.status = r.verifications.some((x) => x.step.status === 'done') ? 'verified' : 'proposed';
    } else {
      r.status = 'cancelled';
      r.error = 'Cancelled. (Demo sample.)';
      for (const s of r.steps) if (s.status === 'working' || s.status === 'waiting') s.status = 'cancelled';
    }
    this.clock.delete(id);
    engine.endMeeting(id);
    this.save();
  }

  stopAll(reason: string) {
    for (const r of this.list)
      if (running(r)) {
        r.status = r.status === 'verifying' ? 'proposed' : 'cancelled';
        r.error = reason;
        for (const s of r.steps) if (s.status === 'working' || s.status === 'waiting') s.status = 'cancelled';
        for (const v of r.verifications) if (v.step.status === 'working') v.step.status = 'cancelled';
      }
    this.clock.clear();
    this.save();
  }

  clear() {
    this.list = [];
    this.clock.clear();
    this.save();
  }

  tick(engine: Engine): boolean {
    let changed = false;
    for (const r of this.list) {
      const c = this.clock.get(r.id);
      if (!c || !running(r) || engine.now < c.next) continue;
      this.step(r, c.step, engine);
      c.step++;
      c.next = engine.now + STEP_MS;
      changed = true;
    }
    return changed;
  }

  private step(r: UiReview, step: number, engine: Engine) {
    const now = new Date().toISOString();
    const [design, usability, plan] = r.steps;
    const work = (s: UiStep, label: string, say: string) => {
      s.status = 'working';
      s.startedAt = now;
      engine.meetingStatus(r.id, s.agent, `${label} (demo sample)`, say);
    };
    const done = (s: UiStep) => {
      s.status = 'done';
      s.finishedAt = now;
      s.attempts = 1;
    };
    if (step === 0) {
      r.status = 'reviewing';
      work(design, 'Reviewing the design', 'Tingnan natin ang layout');
      work(usability, 'Testing the workflow', 'Let me try it like a user');
      engine.meetingStatus(r.id, 'rey', 'Listening (demo sample)');
    } else if (step === 1) {
      done(design);
      done(usability);
      r.design = { summary: 'Sample: the page works on a computer, but it is hard to use on a phone.', strengths: ['Sample: clear colours for each status'], findings: DESIGN };
      r.usability = { summary: 'Sample: small buttons and no confirmation after saving.', findings: USABILITY, tests: ['Open the page on a phone: no sideways scrolling.', 'Tap every button with a thumb.', 'Save an order: a confirmation appears.'] };
      r.status = 'planning';
      work(plan, 'Writing the change plan', 'I can do this in CSS');
    } else if (step === 2) {
      done(plan);
      r.plan = {
        summary: 'Sample plan: three small changes, mostly CSS. Demo only — nothing was looked at.',
        changes: [
          { id: 'C1', title: 'Show orders as cards on phones', findings: ['A1'], kind: 'css', effort: 'M', risk: 'low', steps: ['Add a phone breakpoint (sm:) to the orders table', 'Below it, show each row as a card'], checks: ['No sideways scrolling at 375 px wide'], accepted: false },
          { id: 'C2', title: 'Move "Add order" into the header', findings: ['A2'], kind: 'html', effort: 'S', risk: 'low', steps: ['Move the button markup into the page header'], checks: ['The button is visible without scrolling'], accepted: false },
          { id: 'C3', title: 'Bigger buttons and a "saved" message', findings: ['K1', 'K2'], kind: 'php', effort: 'S', risk: 'low', steps: ['Give buttons py-3 on phones', 'Show a flash message after saving'], checks: ['Buttons at least 44 px tall', '"Order saved" appears after saving'], accepted: false },
        ],
        questions: ['Sample: should the cards also show the customer name?'],
        outOfScope: ['Sample: a full redesign of the order form.'],
      };
      this.finish(r, 'proposed', engine);
      engine.addLog('UI Review plan ready (demo sample). Open it to accept changes.', 'success', 'rey');
    } else if (step >= 100) {
      const v = r.verifications[r.verifications.length - 1];
      v.step.status = 'done';
      v.step.finishedAt = now;
      const accepted = r.plan?.changes.filter((c) => c.accepted) ?? [];
      v.checks = accepted.map((c) => ({ change: c.id, result: 'done', note: 'Sample: looks done.' }));
      v.summary = 'Sample re-check: every accepted change looks done. Demo only — no screenshots were compared.';
      v.verdict = 'ready';
      this.finish(r, 'verified', engine);
      engine.addLog('Kim finished the re-check (demo sample).', 'success', 'kim');
    }
    r.updatedAt = now;
    this.save();
  }

  private finish(r: UiReview, status: UiReview['status'], engine: Engine) {
    r.status = status;
    r.finishedAt = r.updatedAt = new Date().toISOString();
    this.clock.delete(r.id);
    engine.endMeeting(r.id);
  }

  private save() {
    try {
      this.storage?.setItem(KEY, JSON.stringify(this.list));
    } catch {
      /* storage full or blocked: keep the in-memory copy */
    }
  }
}
