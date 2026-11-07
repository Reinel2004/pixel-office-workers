// Headless test of the simulation engine: runs every workflow to completion with a fake clock.
// Run with: npm run test:sim

import { TemplateBrain } from '../src/agents/brain';
import { AGENTS, seatOf } from '../src/agents/roster';
import { captionFrom, replyFrom, scheduleFrom } from '../src/live/caption';
import { Engine, MAX_ON_BREAK, type Chat, type StorageLike } from '../src/sim/engine';
import { FURNITURE, MEETING_SLOTS, SPOTS, buildWalkGrid, DOORS, ROOMS, LEISURE_SPOTS, STROLL_POINTS, CHAT_SPOTS, CHAT_SCRIPTS, roomAt, SHOP_BENCHES, SHOP_ENTRANCE, SHOP_LUMBER, SHOP_SWEEP } from '../src/office/layout';
import { DEMO_SHOP_LOAD, SHOP_SPOTS, lookFor } from '../src/sim/workshop';
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
  // Breaks are tested on their own below; here they'd make "back at desk" checks random.
  const e = new Engine(new TemplateBrain(), storage, { breaks: false });
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

  console.log('Breaks when idle');
  for (const sp of LEISURE_SPOTS) {
    if (sp.approach) {
      check(!grid[sp.tile.y][sp.tile.x] && grid[sp.approach.y][sp.approach.x], `${sp.id}: belt is furniture, approach tile is walkable`);
      check(Math.abs(sp.approach.x - sp.tile.x) + Math.abs(sp.approach.y - sp.tile.y) === 1, `${sp.id}: approach is next to the belt`);
    } else check(grid[sp.tile.y][sp.tile.x], `${sp.id} spot walkable`);
    check(roomAt(sp.tile.x + 0.5, sp.tile.y + 0.5) === sp.room, `${sp.id} is in the ${sp.room}`);
    check(!!findPath(grid, seatOf('lia'), sp.approach ?? sp.tile), `${sp.id} reachable`);
  }
  check(FURNITURE.some((f) => f.kind === 'coffeeMaker' && f.room === 'pantry'), 'the pantry has a coffee maker');
  for (const c of CHAT_SPOTS)
    for (const t of [c.a, c.b]) check(grid[t.y][t.x] && roomAt(t.x + 0.5, t.y + 0.5) === c.room && !!findPath(grid, seatOf('dev'), t), `${c.id} ${t.x},${t.y} walkable and reachable`);
  check(CHAT_SCRIPTS.every((l) => l.length >= 2), 'every conversation has at least two lines');
  for (const p of STROLL_POINTS) check(grid[p.y][p.x] && !!findPath(grid, seatOf('bea'), p), `walk point ${p.x},${p.y} reachable`);

  let seed = 7;
  const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const mem2 = new Map<string, string>();
  const st2: StorageLike = { getItem: (k) => mem2.get(k) ?? null, setItem: (k, v) => void mem2.set(k, v), removeItem: (k) => void mem2.delete(k) };
  const eb = new Engine(new TemplateBrain(), st2);
  eb.random = rng;
  check(eb.settings.breaks, 'breaks are on by default');
  let maxAway = 0;
  let busyOnBreak = false;
  const rooms = new Set<string>();
  let jogged = false;
  const chats = new Set<Chat>();
  let fullChat = false;
  await runFor(eb, 240000, () => {
    const away = eb.agents.filter((x) => x.leisure && x.leisure.phase !== 'returning').length;
    maxAway = Math.max(maxAway, away);
    for (const x of eb.agents) {
      if (x.leisure && x.busyTaskId) busyOnBreak = true;
      if (x.leisure?.phase === 'doing' && x.leisure.spot) rooms.add(x.leisure.spot.room);
      if (x.action === 'jog') jogged = true;
      const c = x.leisure?.chat;
      if (c) {
        chats.add(c);
        if (c.lastLine === c.lines.length - 1) fullChat = true;
      }
    }
    return false;
  });
  check(chats.size > 0, `idle agents chat with each other (${chats.size} conversation(s))`);
  check(fullChat, 'a conversation runs through all its lines');
  check([...chats].every((c) => c.first !== c.second), 'nobody talks to themselves');
  check(maxAway > 0, 'idle agents go on breaks');
  check(maxAway <= MAX_ON_BREAK, `never more than ${MAX_ON_BREAK} away at once (saw ${maxAway})`);
  check(rooms.size >= 2, `breaks use different rooms (${[...rooms].join(', ')})`);
  check(jogged, 'someone ran on a treadmill');
  check(!busyOnBreak, 'nobody is on a break while on a task');

  // A task during a break: the agent comes back and does it.
  await runFor(eb, 120000, () => eb.agents.some((x) => x.leisure?.phase === 'doing'));
  const breaker = eb.agents.find((x) => x.leisure?.phase === 'doing');
  check(!!breaker, 'found an agent on a break');
  if (breaker) {
    const job = eb.assignCustom(breaker.id, 'Quick check please');
    eb.tick(50);
    check(breaker.leisure === null, `${breaker.def.name} leaves the break for the task`);
    await runFor(eb, 60000, () => job.status === 'completed');
    check(job.status === 'completed', 'the task completes after the break');
  }

  // One chatter gets a task: the other says "Talk later!" and goes back too.
  await runFor(eb, 300000, () => eb.agents.some((x) => x.leisure?.chat && x.leisure.phase === 'doing'));
  const talker = eb.agents.find((x) => x.leisure?.chat && x.leisure.phase === 'doing');
  check(!!talker, 'found a conversation in progress');
  if (talker) {
    const c = talker.leisure!.chat!;
    const other = c.first === talker ? c.second : c.first;
    const job2 = eb.assignCustom(talker.id, 'Need you for a second');
    eb.tick(50);
    eb.tick(50);
    check(other.leisure?.phase === 'returning' || other.leisure === null, `${other.def.name} stops chatting when ${talker.def.name} is called away`);
    await runFor(eb, 60000, () => job2.status === 'completed');
    check(job2.status === 'completed', 'the task completes');
  }

  // Turning breaks off sends everyone back to their desks, and they stay there.
  eb.updateSettings({ breaks: false });
  await runFor(eb, 40000, () => eb.agents.every((x) => !x.leisure && !x.path.length));
  await runFor(eb, 60000);
  const away = eb.agents.filter((x) => x.leisure || Math.round(x.x) !== seatOf(x.id).x || Math.round(x.y) !== seatOf(x.id).y);
  check(!away.length, `with breaks off, everyone is back at their desk${away.length ? ` (not: ${away.map((x) => `${x.def.name} at ${x.x},${x.y} "${x.activity}"`).join('; ')})` : ''}`);

  console.log('Intelligence Lab: AI activity');
  const ai = new Engine(new TemplateBrain(), null, { breaks: false });
  check(ai.aiPulse().state === 'idle', 'the Lab is idle with no tasks');
  const draft = ai.assignCustom('marco', 'Outline a quotation');
  let sawThinking = false;
  await runFor(ai, 30000, () => {
    if (ai.aiPulse().state === 'thinking') sawThinking = true;
    return draft.status === 'completed';
  });
  check(sawThinking, 'demo: the Lab shows "thinking" while a draft is prepared');
  check(ai.aiPulse().state === 'idle', 'demo: back to idle when the draft is done');
  ai.updateSettings({ mode: 'connected' });
  ai.setAiActivity('thinking', 'AI thinking · Rosa');
  check(ai.aiPulse().state === 'thinking' && ai.aiPulse().label.includes('Rosa'), 'live: thinking shows who it is for');
  ai.setAiActivity('done', 'Answer ready · Rosa', 5000);
  await runFor(ai, 3000);
  check(ai.aiPulse().state === 'done', 'live: "answer ready" shows for a few seconds');
  await runFor(ai, 3000);
  check(ai.aiPulse().state === 'idle', 'live: then the Lab goes back to idle');
  ai.setAiActivity('limited', 'AI usage limit reached', 30000);
  check(ai.aiPulse().state === 'limited', 'live: usage limit is shown');

  console.log('Creative Studio: photo easel and posts board');
  check(FURNITURE.some((f) => f.kind === 'postBoard' && f.room === 'creative' && f.wall), 'the Creative Studio has a posts board on the wall');
  check(FURNITURE.some((f) => f.kind === 'easel' && f.room === 'creative' && f.x === 27), 'the photo easel is in place');
  check(roomAt(SPOTS.photoEasel.x + 0.5, SPOTS.photoEasel.y + 0.5) === 'creative', 'the easel spot is in the Creative Studio');
  const cs = new Engine(new TemplateBrain(), null, { breaks: false });
  cs.updateSettings({ mode: 'connected' });
  cs.stageAgentAt('carlo', SPOTS.photoEasel, { x: SPOTS.photoEasel.x, y: SPOTS.photoEasel.y - 1 }, 'Studying the photo in the Creative Studio');
  cs.setEaselPhoto('data:image/jpeg;base64,AAAA');
  await runFor(cs, 30000, () => !cs.agentById.carlo.path.length);
  check(
    Math.round(cs.agentById.carlo.x) === SPOTS.photoEasel.x && Math.round(cs.agentById.carlo.y) === SPOTS.photoEasel.y,
    'Carlo walks to the easel for a photo task',
  );
  check(cs.easelPhoto !== null, 'the photo stays on the easel while he works');
  cs.setEaselPhoto(cs.easelPhoto, 15000);
  await runFor(cs, 16000);
  check(cs.easelPhoto === null, 'the photo leaves the easel 15 seconds after the task');
  cs.setPostBoard({ configured: true, count: 2, next: '2026-11-10T01:00:00.000Z' });
  check(cs.postBoard?.count === 2, 'the board holds the scheduled post count');

  console.log("Facebook caption from Carlo's answer");
  const answer = [
    '**What I see**',
    '- A two-panel door',
    '- Brown finish',
    '**Caption**',
    'A classic door, crafted with care. Message WAD for a quotation!',
    '**Short version**',
    'Classic door.',
    '**Hashtags**',
    '#WADFurniture #WoodenDoor',
  ].join('\n');
  check(
    captionFrom(answer) === 'A classic door, crafted with care. Message WAD for a quotation!\n\n#WADFurniture #WoodenDoor',
    'caption + hashtags, without "What I see" or the short version',
  );
  check(captionFrom('Just a caption.') === 'Just a caption.', 'plain answers are used as they are');
  check(!captionFrom('**What I see**\n- a door\n**Post**\nHello').includes('a door'), '"What I see" never goes into the post');

  console.log('Carlo: caption + schedule from one request');
  {
    const ans = ['**What I see**', '- A carved narra door', '**Caption**', 'Crafted with care. Message WAD!', '**Short version**', 'Carved door.', '**Hashtags**', '#WADFurniture #Narra', '', 'Ready for your approval.', '**Schedule:** 2026-11-14 09:00'].join('\n');
    const w = scheduleFrom(ans);
    check(!!w && w.kind === 'at' && w.date === '2026-11-14' && w.time === '09:00', 'the time Carlo read is picked up');
    check(captionFrom(ans) === 'Crafted with care. Message WAD!\n\n#WADFurniture #Narra', 'the schedule line never goes into the post');
    check(scheduleFrom('**Caption**\nHi\n**Schedule:** now')?.kind === 'now', '"post now" is understood');
    check(scheduleFrom('**Schedule:** 2026-02-30 09:00') === null && scheduleFrom('**Schedule:** 2026-11-14 25:00') === null, 'impossible dates and times are rejected');
    check(scheduleFrom('**Caption**\nNo time asked') === null, 'no time asked: nothing is scheduled');
    check(!captionFrom('Plain caption\n**Schedule:** 2026-11-14 9:00').includes('Schedule'), 'plain answers drop the schedule line too');
    check(scheduleFrom('**Schedule:** 2026-11-14 9:05')?.kind === 'at' && (scheduleFrom('**Schedule:** 2026-11-14 9:05') as { time: string }).time === '09:05', 'single-digit hours are accepted');
  }

  console.log('Customer Service (Joy)');
  const joy = AGENTS.find((a) => a.id === 'joy');
  check(!!joy && roomAt(joy.desk.x + 0.5, joy.desk.y + 0.5) === 'sales', 'Joy has a desk in Sales & Growth');
  check(FURNITURE.filter((f) => f.kind === 'desk' && f.x === 3 && f.y === 32).length === 1, "only one desk at Joy's spot");
  const csAnswer = ['**Reply**', 'Hi po [Customer name]! Your door is in finishing.', '', '**Notes for staff**', '- Confirm the date.'].join('\n');
  check(replyFrom(csAnswer, 'Maria Santos') === 'Hi po Maria Santos! Your door is in finishing.', 'the reply is copied without staff notes, with the name filled in');
  check(replyFrom(csAnswer) === 'Hi po [Customer name]! Your door is in finishing.', 'without a known name the placeholder stays');
  check(replyFrom('Just a reply.') === 'Just a reply.', 'answers without sections are used as they are');

  console.log('Workshop: carpenters from WAD Order Management');
  {
    const grid = buildWalkGrid();
    const inShop = (t: { x: number; y: number }) => roomAt(t.x + 0.5, t.y + 0.5) === 'workshop';
    const spots = [...SHOP_SPOTS, SHOP_LUMBER.tile, ...SHOP_SWEEP, SPOTS.shopInspect, SHOP_ENTRANCE];
    check(spots.every((t) => inShop(t) && grid[t.y][t.x]), 'every Workshop spot is inside the room and walkable');
    check(SHOP_SPOTS.length === 8, 'eight places at four benches');
    check(SHOP_BENCHES.every((b) => FURNITURE.some((f) => f.room === 'workshop' && f.kind === b.kind && f.x === b.bench.x && f.y === b.bench.y)), 'each bench is in the room');
    check(DOORS.filter((d) => d.a === 'workshop' || d.b === 'workshop').length === 2, 'the Workshop has doors to Finance and the court');
    check(!!findPath(grid, seatOf('paolo'), SPOTS.shopInspect), 'Paolo can walk from his desk to the shop floor');
    check(spots.every((t) => !!findPath(grid, SHOP_ENTRANCE, t) || (t.x === SHOP_ENTRANCE.x && t.y === SHOP_ENTRANCE.y)), 'every Workshop spot can be reached from the door');
    check(JSON.stringify(lookFor('Ramon')) === JSON.stringify(lookFor('ramon')), 'the same carpenter always looks the same');

    const ws = new Engine(new TemplateBrain(), null, { breaks: false });
    check(ws.workshop.crew.map((c) => c.def.name).join() === DEMO_SHOP_LOAD.carpenters.map((c) => c.name).join(), 'demo: sample carpenters');
    const live = (carpenters: { name: string; inProgress: number; pending: number; finished?: number }[]) =>
      ws.setShopLoad({ available: true, carpenters: carpenters.map((c) => ({ finished: 0, hamba: 0, ...c })), unassigned: 0, ready: 1, open: 5, overdue: 0, source: 'live', asOf: 'x' });
    live([
      { name: 'Ramon', inProgress: 2, pending: 0 },
      { name: 'Jun', inProgress: 0, pending: 1 },
      { name: 'Pedro', inProgress: 0, pending: 0, finished: 1 },
    ]);
    check(ws.workshop.crew.map((c) => c.def.name).join() === 'Ramon,Jun,Pedro', 'one pixel carpenter per real carpenter, in roster order');
    await runFor(ws, 30000, () => !ws.workshop.crew[0].path.length && ws.workshop.crew[0].action === 'work');
    const ramon = ws.workshop.crew[0];
    check(Math.round(ramon.x) === SHOP_SPOTS[0].x && Math.round(ramon.y) === SHOP_SPOTS[0].y && ramon.activity.includes('2 in progress'), 'a carpenter with orders in progress works at their bench');
    check(ws.workshop.crew[1].slot === 1, 'each carpenter keeps their own place');
    check(ws.workshop.crew[2].errand?.kind === 'sweep', 'a carpenter with no open orders sweeps');
    const before = ws.workshop.crew[0];
    live([
      { name: 'Ramon', inProgress: 1, pending: 0 },
      { name: 'Ana', inProgress: 1, pending: 0 },
    ]);
    check(ws.workshop.crew[0] === before && ws.workshop.crew.length === 2, 'a refresh keeps known carpenters where they are and drops ones no longer listed');
    const many = Array.from({ length: 11 }, (_, i) => ({ name: `C${i}`, inProgress: i >= 3 ? 1 : 0, pending: 0 }));
    live(many);
    check(ws.workshop.crew.length === 8 && ws.workshop.crew.every((c) => c.info.inProgress === 1), 'more than eight: the busiest eight stand at the benches');
    ws.setShopLoad({ ...DEMO_SHOP_LOAD, available: false, carpenters: [], source: 'live' });
    check(ws.workshop.crew.length === 0, 'no carpenter data: nobody is invented');
    ws.setMode('connected');
    check(ws.workshop.load === null && ws.workshop.note === 'loading' && ws.workshop.crew.length === 0, 'Connected Mode waits for the real carpenters (no demo names)');
    ws.visitShop('paolo');
    await runFor(ws, 60000, () => !ws.agentById.paolo.path.length);
    check(Math.round(ws.agentById.paolo.x) === SPOTS.shopInspect.x && Math.round(ws.agentById.paolo.y) === SPOTS.shopInspect.y, 'Paolo walks to the shop floor');
    ws.leaveShop('paolo');
    await runFor(ws, 90000, () => ws.agentById.paolo.posture === 'sit');
    check(ws.agentById.paolo.posture === 'sit', 'Paolo goes back to his desk after checking');
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
