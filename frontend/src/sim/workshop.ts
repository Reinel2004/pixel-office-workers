// The Workshop (shop floor): one pixel carpenter for each carpenter in WAD Order Management.
//
// Decoration only. The carpenters are not AI and never call any API. The live store gives the
// shop each carpenter's open orders (assigned as carpenter or hamba carpenter), read from the
// order system at sign-in, after Paolo's tasks, on Refresh, and by the server's live check.
//  - In Progress orders: the carpenter works at their bench.
//  - Only Pending orders: they prepare (fetching wood from the rack more often).
//  - Nothing open: they sweep and tidy up.
// Each carpenter keeps the same bench spot, in the order system's own carpenter order.

import type { AgentDef, HairStyle, Look } from '../agents/roster';
import { SHOP_BENCHES, SHOP_ENTRANCE, SHOP_LUMBER, SHOP_SWEEP } from '../office/layout';
import { findPath, type Tile } from '../office/pathfinding';
import type { Dir } from './types';
import type { ShopCarpenter } from '../../shared/live';

export interface ShopLoad {
  /** false when the order system does not return carpenter assignments. */
  available: boolean;
  carpenters: ShopCarpenter[];
  unassigned: number;
  ready: number;
  open: number;
  overdue: number;
  /** 'demo' = sample numbers for Demo Mode; 'live' = WAD Order Management. */
  source: 'demo' | 'live';
  asOf: string | null;
}

/** Sample carpenters for Demo Mode (plainly not real names). */
export const DEMO_SHOP_LOAD: ShopLoad = {
  available: true,
  carpenters: [
    { name: 'Carpenter 1', inProgress: 2, pending: 1, finished: 0, hamba: 0 },
    { name: 'Carpenter 2', inProgress: 1, pending: 0, finished: 1, hamba: 1 },
    { name: 'Carpenter 3', inProgress: 0, pending: 2, finished: 0, hamba: 0 },
    { name: 'Carpenter 4', inProgress: 0, pending: 0, finished: 0, hamba: 0 },
  ],
  unassigned: 1,
  ready: 2,
  open: 8,
  overdue: 1,
  source: 'demo',
  asOf: null,
};

/** Why the shop has no carpenters to show (shown in the room label and panel). */
export type ShopNote = 'loading' | 'no-access' | 'unavailable' | null;

/** How many carpenters stand at the benches (two per bench); the room panel lists everyone. */
export const SHOP_SPOTS = SHOP_BENCHES.flatMap((b, bi) => b.spots.map((s) => ({ ...s, bench: bi })));

export interface Carpenter {
  id: string;
  def: AgentDef;
  info: ShopCarpenter;
  /** Index into SHOP_SPOTS: this carpenter's own place at a bench. */
  slot: number;
  x: number;
  y: number;
  path: Tile[];
  dir: Dir;
  face: Tile | null;
  action: 'none' | 'work';
  activity: string;
  errand: { kind: 'lumber' | 'sweep'; until: number | null } | null;
  nextErrandAt: number;
  nextLineAt: number;
  bubble: { text: string; until: number } | null;
  stepPhase: number;
}

const LINES = {
  working: ['Measure twice, cut once', 'Ang ganda ng narra', 'Konting kinis pa', 'Pass the clamps!', 'Second coat na'],
  pending: ['Ready na ang kahoy', 'Next order na', 'Sukat muna'],
  idle: ['Linis muna tayo', 'Walang order? Ayos lang', 'Sweeping up'],
};
const WALK_SPEED = 2.2; // tiles per second, a little slower than the office staff

const SKIN = ['#b97a50', '#e2b48c', '#c98e64', '#a8714a', '#d8a07c', '#8d5a3b'];
const HAIR = ['#151515', '#2a1a10', '#3b2a1a', '#8a8a8a', '#1c120c'];
const STYLE: HairStyle[] = ['short', 'spiky', 'short', 'ponytail', 'bun'];
const SHIRT = ['#6b8f3a', '#c0623a', '#3d6c9e', '#8a6f3d', '#9e3d5c', '#3a8f7d', '#b5852a', '#5a5f9e'];
const ACC: Look['accessory'][] = ['hardhat', 'none', 'glasses', 'hardhat', 'none'];

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A stable look for a carpenter's name, so the same person always looks the same. */
export function lookFor(name: string): { look: Look; tint: string } {
  const h = hash(name.toLowerCase());
  const pick = <T,>(a: T[], shift: number) => a[(h >>> shift) % a.length];
  const shirt = pick(SHIRT, 0);
  return {
    look: { skin: pick(SKIN, 3), hair: pick(HAIR, 7), hairStyle: pick(STYLE, 11), shirt, pants: '#3a3326', accessory: pick(ACC, 15), accent: '#f5c518' },
    tint: shirt,
  };
}

/** The pixel person for a carpenter's name (same name, same look and id). */
export function carpenterDef(name: string): AgentDef {
  const { look, tint } = lookFor(name);
  const id = `crew-${hash(name.toLowerCase()).toString(36)}`;
  return { id: id as AgentDef['id'], name, role: 'Carpenter', room: 'workshop', desk: SHOP_ENTRANCE, look, tint, blurb: 'Carpenter in WAD Order Management.' };
}

export const openCount = (c: ShopCarpenter) => c.inProgress + c.pending;

export class Workshop {
  crew: Carpenter[] = [];
  load: ShopLoad | null = null;
  note: ShopNote = null;
  /** Bumped whenever the numbers change, so the scene redraws the benches and name tags. */
  rev = 0;

  constructor(
    private grid: boolean[][],
    private random: () => number,
  ) {
    this.setLoad(DEMO_SHOP_LOAD);
  }

  setLoad(load: ShopLoad | null, note: ShopNote = null, now = 0) {
    this.load = load;
    this.note = load ? null : note;
    this.rev++;
    this.rebuild(now);
  }

  /** Carpenters at the benches: everyone in roster order, or the busiest eight if there are more. */
  visible(): ShopCarpenter[] {
    const all = this.load?.available ? this.load.carpenters : [];
    if (all.length <= SHOP_SPOTS.length) return all;
    const busiest = new Set([...all].sort((a, b) => openCount(b) - openCount(a)).slice(0, SHOP_SPOTS.length));
    return all.filter((c) => busiest.has(c));
  }

  private rebuild(now: number) {
    const people = this.visible();
    const old = new Map(this.crew.map((c) => [c.def.name.toLowerCase(), c]));
    this.crew = people.map((info, slot) => {
      const known = old.get(info.name.toLowerCase());
      const c: Carpenter = known ?? this.newCarpenter(info, slot);
      c.info = info;
      c.slot = slot;
      c.errand = null;
      return c;
    });
    for (const c of this.crew) this.plan(c, now);
  }

  private newCarpenter(info: ShopCarpenter, slot: number): Carpenter {
    const def = carpenterDef(info.name);
    return {
      id: def.id,
      def,
      info,
      slot,
      x: SHOP_ENTRANCE.x,
      y: SHOP_ENTRANCE.y,
      path: [],
      dir: 'fr',
      face: null,
      action: 'none',
      activity: 'Coming in',
      errand: null,
      nextErrandAt: 12_000 + slot * 5_000,
      nextLineAt: 6_000 + slot * 7_000,
      bubble: null,
      stepPhase: 0,
    };
  }

  /** Sends a carpenter to the right place for their orders. */
  private plan(c: Carpenter, now: number) {
    if (openCount(c.info) > 0) {
      const s = SHOP_SPOTS[c.slot];
      this.goTo(c, s, { x: s.x, y: s.y + 1 }, 'Going to the bench');
    } else this.startSweep(c, now);
  }

  private workLabel(c: Carpenter) {
    const i = c.info;
    if (i.inProgress > 0) return `${SHOP_BENCHES[SHOP_SPOTS[c.slot].bench].work} · ${i.inProgress} in progress${i.pending ? `, ${i.pending} pending` : ''}`;
    return `Preparing wood · ${i.pending} pending order${i.pending === 1 ? '' : 's'}`;
  }

  private startSweep(c: Carpenter, now: number) {
    const spot = SHOP_SWEEP[Math.floor(this.random() * SHOP_SWEEP.length)];
    c.errand = { kind: 'sweep', until: null };
    c.nextErrandAt = now + 8_000 + this.random() * 8_000;
    this.goTo(c, spot, null, c.info.finished ? 'Orders finished · tidying up' : 'No open orders · sweeping the floor');
  }

  private goTo(c: Carpenter, tile: Tile, face: Tile | null, activity: string) {
    c.face = face;
    c.activity = activity;
    c.path = findPath(this.grid, { x: c.x, y: c.y }, tile) ?? [];
    c.action = 'none';
    if (!c.path.length) this.arrive(c);
  }

  private arrive(c: Carpenter) {
    if (c.face) c.dir = dirTo(c.face.x - c.x, c.face.y - c.y, c.dir);
    if (c.errand) {
      c.action = 'work';
      if (c.errand.kind === 'lumber') c.activity = 'Fetching wood from the rack';
      c.errand.until = -1; // timed from the next tick, when "now" is known
    } else if (openCount(c.info) > 0) {
      c.action = 'work';
      c.activity = this.workLabel(c);
    }
  }

  tick(dt: number, now: number) {
    for (const c of this.crew) {
      if (c.bubble && c.bubble.until <= now) c.bubble = null;
      if (c.path.length) {
        this.move(c, dt / 1000);
        continue;
      }
      if (c.errand) {
        if (c.errand.until === -1) c.errand.until = now + (c.errand.kind === 'lumber' ? 2_500 : 4_000);
        if (c.errand.until !== null && now >= c.errand.until) {
          c.errand = null;
          this.plan(c, now);
        }
        continue;
      }
      // Fetch wood now and then; more often while preparing pending orders.
      if (openCount(c.info) > 0 && now >= c.nextErrandAt) {
        c.nextErrandAt = now + (c.info.inProgress ? 30_000 : 14_000) + this.random() * 20_000;
        c.errand = { kind: 'lumber', until: null };
        this.goTo(c, SHOP_LUMBER.tile, SHOP_LUMBER.face, 'Getting wood');
        continue;
      }
      if (now >= c.nextLineAt) {
        c.nextLineAt = now + 25_000 + this.random() * 30_000;
        const lines = c.info.inProgress ? LINES.working : c.info.pending ? LINES.pending : LINES.idle;
        c.bubble = { text: lines[Math.floor(this.random() * lines.length)], until: now + 2_600 };
      }
    }
  }

  private move(c: Carpenter, dt: number) {
    let step = WALK_SPEED * dt;
    while (step > 0 && c.path.length) {
      const n = c.path[0];
      const dx = n.x - c.x;
      const dy = n.y - c.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 0.0001) c.dir = dirTo(dx, dy, c.dir);
      if (dist <= step) {
        c.x = n.x;
        c.y = n.y;
        step -= dist;
        c.stepPhase += dist;
        c.path.shift();
      } else {
        c.x += (dx / dist) * step;
        c.y += (dy / dist) * step;
        c.stepPhase += step;
        step = 0;
      }
    }
    if (!c.path.length) this.arrive(c);
  }
}

function dirTo(dx: number, dy: number, prev: Dir): Dir {
  const sx = dx - dy;
  const sy = dx + dy;
  if (Math.abs(sx) < 1e-6 && Math.abs(sy) < 1e-6) return prev;
  const front = sy > 1e-6 || (Math.abs(sy) <= 1e-6 && prev[0] === 'f');
  const right = sx > 1e-6 || (Math.abs(sx) <= 1e-6 && prev[1] === 'r');
  return `${front ? 'f' : 'b'}${right ? 'r' : 'l'}` as Dir;
}
