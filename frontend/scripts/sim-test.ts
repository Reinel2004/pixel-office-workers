// Headless test of the simulation engine: runs every workflow to completion with a fake clock.
// Run with: npm run test:sim

import { TemplateBrain } from '../src/agents/brain';
import { AGENTS, seatOf } from '../src/agents/roster';
import { Engine, type StorageLike } from '../src/sim/engine';
import { FURNITURE, MEETING_SLOTS, SPOTS, buildWalkGrid, DOORS, ROOMS } from '../src/office/layout';
import { findPath } from '../src/office/pathfinding';

let failures = 0;
function check(cond: unknown, msg: string) {
  if (cond) console.log('  ok  ', msg);
  else {
    failures++;
    console.log('  FAIL', msg);
  }
}

const mem = new Map<string, string>();
const storage: StorageLike = {
  getItem: (k) => mem.get(k) ?? null,
  setItem: (k, v) => void mem.set(k, v),
  removeItem: (k) => void mem.delete(k),
};

async function runFor(e: Engine, ms: number, until?: () => boolean) {
  for (let t = 0; t < ms; t += 50) {
    e.tick(50);
    await Promise.resolve(); // let template promises resolve
    if (until?.()) return true;
  }
  return until ? until() : true;
}

async function main() {
  console.log('Layout');
  const grid = buildWalkGrid();
  for (const a of AGENTS) {
    const s = seatOf(a.id);
    check(grid[s.y][s.x], `${a.name}'s seat is walkable`);
  }
  for (const m of MEETING_SLOTS) check(grid[m.y][m.x], `meeting slot ${m.x},${m.y} walkable`);
  for (const [k, s] of Object.entries(SPOTS)) check(grid[s.y][s.x], `spot ${k} walkable`);
  // every room is reachable from the command centre
  for (const r of ROOMS) {
    let found = false;
    for (let y = r.y0; y <= r.y1 && !found; y++)
      for (let x = r.x0; x <= r.x1 && !found; x++) if (grid[y][x] && findPath(grid, { x: 18, y: 15 }, { x, y })) found = true;
    check(found, `room ${r.name} reachable`);
  }
  for (const d of DOORS) for (const [x, y] of d.tiles) check(grid[y][x], `door ${d.a}-${d.b} at ${x},${y} open`);
  check(FURNITURE.length > 60, `furniture placed (${FURNITURE.length})`);
  for (const a of AGENTS)
    for (const b of AGENTS) {
      if (a.id >= b.id) continue;
      const p = findPath(grid, seatOf(a.id), seatOf(b.id));
      if (!p) check(false, `path ${a.name} -> ${b.name}`);
    }
  check(true, 'all seat-to-seat paths exist');

  console.log('Workflow: New Door Inquiry (approve)');
  const e = new Engine(new TemplateBrain(), storage);
  const t1 = e.startDemo('inquiry');
  check(e.agentState(e.agentById.lia) !== 'idle', 'Lia becomes active');
  let sawWalking = false;
  let sawMeeting = false;
  await runFor(e, 120000, () => {
    if (e.agentState(e.agentById.marco) === 'walking') sawWalking = true;
    if (MEETING_SLOTS.some((m) => Math.round(e.agentById.chief.x) === m.x && Math.round(e.agentById.chief.y) === m.y))
      sawMeeting = true;
    return t1.status === 'awaiting_approval';
  });
  check(sawWalking, 'Marco walked');
  check(sawMeeting, 'Chief reached the meeting table');
  check(t1.status === 'awaiting_approval', 'workflow pauses for approval');
  check(e.agentState(e.agentById.chief) === 'waiting', 'Chief shows Waiting for Approval');
  check(t1.outputs.some((o) => o.quote), 'quotation draft produced');
  await runFor(e, 10000);
  check(t1.status === 'awaiting_approval', 'still paused without a decision');
  e.decide(t1.id, 'approved');
  await runFor(e, 60000, () => t1.status === 'completed');
  check(t1.status === 'completed', 'completes after approval');
  check(e.agentById.marco.completedCount === 1, 'Marco credited');

  console.log('Workflow: New Door Inquiry (reject)');
  const t2 = e.startDemo('inquiry');
  await runFor(e, 120000, () => t2.status === 'awaiting_approval');
  e.decide(t2.id, 'rejected');
  await runFor(e, 60000, () => t2.status === 'rejected');
  check(t2.status === 'rejected', 'rejected branch closes the task');

  console.log('Workflow: Production Review + Marketing in parallel');
  const t3 = e.startDemo('production');
  const t4 = e.startDemo('marketing');
  await runFor(e, 180000, () => t3.status === 'completed' && t4.status === 'completed');
  check(t3.status === 'completed', 'production review completes');
  check(t3.outputs[0]?.flags?.filter((f) => f.level === 'warn').length === 2, 'two jobs flagged');
  check(t4.status === 'completed', 'marketing draft completes');
  check(!!t4.outputs[0]?.body.includes('#WADFurniture'), 'caption produced');

  console.log('Queueing: two tasks for the same agent');
  const a = e.assignCustom('nina', 'Plan next week installs');
  const b = e.assignCustom('nina', 'Check crew availability');
  e.tick(50);
  check(b.status === 'queued', 'second task waits for Nina');
  await runFor(e, 60000, () => a.status === 'completed' && b.status === 'completed');
  check(a.status === 'completed' && b.status === 'completed', 'both finish in order');

  console.log('Error path + retry');
  const f = e.assignCustom('dev', 'Simulate an error please');
  await runFor(e, 30000, () => f.status === 'failed');
  check(f.status === 'failed', 'task fails');
  check(e.agentState(e.agentById.dev) === 'error', 'Dev shows Error');
  e.retry(f.id);
  await runFor(e, 30000, () => e.tasks[0].status === 'completed');
  check(e.tasks[0].status === 'completed', 'retry succeeds');
  check(e.agentState(e.agentById.dev) !== 'error', 'error cleared');

  console.log('Pause');
  const p = e.assignCustom('bea', 'Weekly summary');
  e.setPaused(true);
  const before = e.now;
  await runFor(e, 5000);
  check(e.now === before && p.status !== 'completed', 'nothing advances while paused');
  e.setPaused(false);
  await runFor(e, 30000, () => p.status === 'completed');
  check(p.status === 'completed', 'resumes after unpause');

  console.log('Return to desks');
  await runFor(e, 20000, () => e.agents.every((x) => x.path.length === 0));
  for (const ag of e.agents) {
    const s = seatOf(ag.id);
    check(Math.round(ag.x) === s.x && Math.round(ag.y) === s.y, `${ag.def.name} back at desk`);
  }

  console.log('Persistence & reset');
  e.saveNow();
  const e2 = new Engine(new TemplateBrain(), storage);
  check(e2.tasks.length === e.tasks.length, 'task history restored');
  check(e2.agentById.marco.completedCount === 1, 'counts restored');
  e2.resetDemo();
  e2.saveNow();
  const e3 = new Engine(new TemplateBrain(), storage);
  check(e3.tasks.length === 0, 'reset clears history');

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll simulation checks passed');
  process.exit(failures ? 1 : 0);
}

main();
