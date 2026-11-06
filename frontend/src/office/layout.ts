import { AGENTS } from '../agents/roster';
import type { AgentId, RoomId } from '../sim/types';

// The office is a 3×3 arrangement of 12-tile blocks (11×11 room + 1-tile gap), plus a
// fourth front row holding the gym and the recreation court. Gaps show the dark background
// so each room reads as a raised platform; doors are 2-tile bridges across the gaps.

export const GRID_W = 37;
export const GRID_H = 46;

export interface Room {
  id: RoomId;
  name: string;
  short: string;
  x0: number;
  y0: number;
  x1: number; // inclusive
  y1: number; // inclusive
  floor: number;
  wall: number;
  pattern: 'check' | 'plank' | 'carpet' | 'dark' | 'court' | 'rubber';
}

function block(bx: number, by: number, h = 11) {
  return { x0: bx * 12 + 1, x1: bx * 12 + 11, y0: by * 12 + 1, y1: by * 12 + h };
}

export const ROOMS: Room[] = [
  { id: 'intel', name: 'Intelligence Lab', short: 'Intel Lab', ...block(0, 0), floor: 0x6cc2b6, wall: 0xb9efe6, pattern: 'check' },
  { id: 'ops', name: 'Operations Hub', short: 'Operations', ...block(0, 1), floor: 0x8dcb86, wall: 0xd2f2c8, pattern: 'check' },
  { id: 'dev', name: 'Development Studio', short: 'Dev Studio', ...block(1, 0), floor: 0x7ea6dc, wall: 0xcfe0f7, pattern: 'carpet' },
  { id: 'creative', name: 'Creative Studio', short: 'Creative', ...block(2, 0), floor: 0xb8a2e0, wall: 0xe6dcf7, pattern: 'plank' },
  { id: 'command', name: 'Command Center', short: 'Command', ...block(1, 1), floor: 0x2c3344, wall: 0x7ad7e6, pattern: 'dark' },
  { id: 'sales', name: 'Sales & Growth', short: 'Sales', ...block(0, 2), floor: 0x9ccbea, wall: 0xdcefff, pattern: 'check' },
  { id: 'pantry', name: 'Pantry & Staff Lounge', short: 'Pantry', ...block(1, 2), floor: 0xead7ae, wall: 0xfff2d6, pattern: 'plank' },
  { id: 'content', name: 'Content Studio', short: 'Content', ...block(2, 1), floor: 0xe5a3c0, wall: 0xf8dbe8, pattern: 'carpet' },
  { id: 'finance', name: 'Finance & Reports', short: 'Finance', ...block(2, 2), floor: 0xc8b8e6, wall: 0xece4fa, pattern: 'check' },
  { id: 'gym', name: 'Gym', short: 'Gym', ...block(0, 3, 8), floor: 0x8e97a3, wall: 0xd5dbe2, pattern: 'rubber' },
  { id: 'court', name: 'Recreation Court', short: 'Court', ...block(1, 3, 8), floor: 0x4c84c8, wall: 0xc5dcf5, pattern: 'court' },
];

export const ROOM_BY_ID: Record<RoomId, Room> = Object.fromEntries(ROOMS.map((r) => [r.id, r])) as Record<RoomId, Room>;

/** Door bridges: gap tiles that become walkable floor. */
export const DOORS: { a: RoomId; b: RoomId; tiles: [number, number][] }[] = [
  { a: 'command', b: 'ops', tiles: [[12, 17], [12, 18]] },
  { a: 'command', b: 'dev', tiles: [[17, 12], [18, 12]] },
  { a: 'command', b: 'content', tiles: [[24, 17], [24, 18]] },
  { a: 'command', b: 'pantry', tiles: [[17, 24], [18, 24]] },
  { a: 'intel', b: 'ops', tiles: [[5, 12], [6, 12]] },
  { a: 'intel', b: 'dev', tiles: [[12, 5], [12, 6]] },
  { a: 'dev', b: 'creative', tiles: [[24, 5], [24, 6]] },
  { a: 'creative', b: 'content', tiles: [[29, 12], [30, 12]] },
  { a: 'ops', b: 'sales', tiles: [[5, 24], [6, 24]] },
  { a: 'sales', b: 'pantry', tiles: [[12, 29], [12, 30]] },
  { a: 'pantry', b: 'finance', tiles: [[24, 29], [24, 30]] },
  { a: 'content', b: 'finance', tiles: [[29, 24], [30, 24]] },
  { a: 'sales', b: 'gym', tiles: [[5, 36], [6, 36]] },
  { a: 'pantry', b: 'court', tiles: [[17, 36], [18, 36]] },
  { a: 'gym', b: 'court', tiles: [[12, 40], [12, 41]] },
];

export type FurnitureKind =
  | 'desk'
  | 'chair'
  | 'plant'
  | 'tallPlant'
  | 'sofa'
  | 'shelf'
  | 'rack'
  | 'meetingTable'
  | 'meetingChair'
  | 'bigScreen'
  | 'whiteboard'
  | 'counter'
  | 'fridge'
  | 'diningTable'
  | 'stool'
  | 'treadmill'
  | 'weights'
  | 'bench'
  | 'easel'
  | 'tripod'
  | 'softbox'
  | 'cabinet'
  | 'holoTable'
  | 'artTable'
  | 'vending'
  | 'net'
  | 'hoop'
  | 'printer'
  | 'beanbag'
  | 'water'
  | 'coffeeMaker';

export interface Furniture {
  id: string;
  kind: FurnitureKind;
  x: number;
  y: number;
  w: number;
  d: number;
  room: RoomId;
  blocks: boolean;
  owner?: AgentId;
  color?: number;
  /** Wall-mounted items are drawn against the room's back wall. */
  wall?: boolean;
}

export interface Rug {
  room: RoomId;
  x: number;
  y: number;
  w: number;
  d: number;
  color: number;
}

const F: Furniture[] = [];
let fid = 0;
function add(kind: FurnitureKind, room: RoomId, x: number, y: number, w = 1, d = 1, opts: Partial<Furniture> = {}) {
  F.push({ id: `f${fid++}`, kind, room, x, y, w, d, blocks: true, ...opts });
}
function desk(room: RoomId, x: number, y: number, owner?: AgentId) {
  add('desk', room, x, y, 2, 1, { owner });
  add('chair', room, x, y + 1, 1, 1, { blocks: false, owner });
}

// --- Agent desks (from the roster) ---
for (const a of AGENTS) desk(a.room, a.desk.x, a.desk.y, a.id);

// --- Intelligence Lab (teal, rear) ---
for (let i = 0; i < 4; i++) add('rack', 'intel', 2 + i, 1);
for (let i = 0; i < 3; i++) add('rack', 'intel', 8 + i, 1);
add('holoTable', 'intel', 5, 6, 2, 2);
desk('intel', 8, 9);
add('tallPlant', 'intel', 1, 4);
add('plant', 'intel', 11, 3);
add('whiteboard', 'intel', 1, 6, 1, 3, { wall: true, blocks: false });

// --- Operations Hub (green, upper-left) ---
add('whiteboard', 'ops', 3, 13, 3, 1, { wall: true, blocks: false });
desk('ops', 3, 20);
desk('ops', 7, 20);
add('shelf', 'ops', 8, 13, 2, 1);
add('printer', 'ops', 10, 13);
add('plant', 'ops', 1, 13);
add('tallPlant', 'ops', 11, 23);
add('cabinet', 'ops', 1, 22);

// --- Development Studio (blue, upper-right) ---
desk('dev', 20, 4);
desk('dev', 16, 8);
desk('dev', 20, 8);
add('whiteboard', 'dev', 15, 1, 3, 1, { wall: true, blocks: false });
add('shelf', 'dev', 20, 1, 2, 1);
add('beanbag', 'dev', 22, 10);
add('tallPlant', 'dev', 13, 1);
add('plant', 'dev', 23, 1);

// --- Creative Studio (lavender, far right) ---
add('easel', 'creative', 27, 3);
add('easel', 'creative', 31, 3);
add('artTable', 'creative', 28, 7, 3, 2);
add('shelf', 'creative', 33, 1, 2, 1);
add('sofa', 'creative', 34, 7, 1, 2);
add('tallPlant', 'creative', 35, 1);
add('plant', 'creative', 25, 10);
add('plant', 'creative', 35, 11);

// --- Command Center (dark, centre) ---
add('meetingTable', 'command', 17, 17, 3, 3);
add('bigScreen', 'command', 14, 13, 3, 1, { wall: true, blocks: false });
add('shelf', 'command', 13, 20, 1, 2);
add('tallPlant', 'command', 13, 23);
add('tallPlant', 'command', 23, 23);
add('plant', 'command', 23, 13);
add('water', 'command', 13, 13);

// --- Sales & Growth (light blue, left) ---
desk('sales', 3, 32);
desk('sales', 7, 32);
add('shelf', 'sales', 1, 25, 2, 1);
add('whiteboard', 'sales', 6, 25, 3, 1, { wall: true, blocks: false });
add('plant', 'sales', 10, 25);
add('tallPlant', 'sales', 1, 35);
add('sofa', 'sales', 10, 33, 1, 2);

// --- Pantry & Staff Lounge (cream, front-centre-left) ---
add('counter', 'pantry', 19, 25, 3, 1);
add('fridge', 'pantry', 22, 25);
add('vending', 'pantry', 13, 25);
add('coffeeMaker', 'pantry', 15, 25); // coffee station: cabinet, espresso machine, mugs
add('diningTable', 'pantry', 15, 30, 2, 2);
add('stool', 'pantry', 14, 30, 1, 1, { blocks: false });
add('stool', 'pantry', 14, 31, 1, 1, { blocks: false });
add('stool', 'pantry', 17, 30, 1, 1, { blocks: false });
add('stool', 'pantry', 17, 31, 1, 1, { blocks: false });
add('sofa', 'pantry', 20, 33, 2, 1);
add('beanbag', 'pantry', 22, 31);
add('plant', 'pantry', 13, 35);
add('tallPlant', 'pantry', 23, 35);

// --- Content Studio (pink, lower-right) ---
add('tripod', 'content', 32, 19);
add('softbox', 'content', 34, 17);
add('softbox', 'content', 31, 21);
add('sofa', 'content', 33, 22, 2, 1);
add('shelf', 'content', 32, 13, 2, 1);
add('plant', 'content', 35, 13);
add('tallPlant', 'content', 25, 23);

// --- Finance & Reports (pale violet, front-centre-right) ---
desk('finance', 28, 32);
add('cabinet', 'finance', 32, 25);
add('cabinet', 'finance', 33, 25);
add('cabinet', 'finance', 34, 25);
add('printer', 'finance', 35, 28);
add('tallPlant', 'finance', 35, 35);
add('plant', 'finance', 25, 35);

// --- Gym (front-left) ---
add('treadmill', 'gym', 2, 38, 1, 2);
add('treadmill', 'gym', 4, 38, 1, 2);
add('weights', 'gym', 8, 37, 2, 1);
add('bench', 'gym', 8, 40, 2, 1);
add('tallPlant', 'gym', 1, 44);

// --- Recreation court (front edge) ---
add('net', 'court', 15, 40, 7, 1);
add('hoop', 'court', 23, 37);

export const FURNITURE = F;

export const RUGS: Rug[] = [
  { room: 'command', x: 15, y: 15, w: 7, d: 7, color: 0x22384a },
  { room: 'pantry', x: 19, y: 32, w: 4, d: 3, color: 0xd9b88a },
  { room: 'creative', x: 27, y: 6, w: 5, d: 4, color: 0xa58fd2 },
  { room: 'gym', x: 6, y: 41, w: 4, d: 3, color: 0x5b6672 },
  { room: 'sales', x: 2, y: 30, w: 8, d: 1, color: 0x8bbadb },
];

/** Standing spots around the round meeting table (tile coords). */
export const MEETING_SLOTS: { x: number; y: number }[] = [
  { x: 16, y: 18 },
  { x: 18, y: 16 },
  { x: 20, y: 18 },
  { x: 18, y: 20 },
  { x: 16, y: 16 },
  { x: 20, y: 20 },
  { x: 16, y: 20 },
  { x: 20, y: 16 },
];
export const MEETING_CENTER = { x: 18, y: 18 };

/** Named points of interest used by workflows. */
export const SPOTS = {
  creativeEasel: { x: 29, y: 5 },
  opsBoard: { x: 4, y: 14 },
  pantryCounter: { x: 20, y: 26 },
};

/**
 * Where idle agents go on a break. `tile` is where they stand; `face` is what they look at.
 * Treadmill belts are furniture (not walkable), so those spots also have an `approach` tile:
 * the agent walks there, then steps onto the belt.
 */
export interface LeisureSpot {
  id: string;
  room: RoomId;
  tile: { x: number; y: number };
  face: { x: number; y: number };
  approach?: { x: number; y: number };
  /** jog = running in place; exercise = bouncing; none = standing (coffee, snacks). */
  action: 'jog' | 'exercise' | 'none';
  label: string;
  says: string[];
}

export const LEISURE_SPOTS: LeisureSpot[] = [
  { id: 'treadmill-1', room: 'gym', tile: { x: 2, y: 39 }, approach: { x: 1, y: 39 }, face: { x: 2, y: 37 }, action: 'jog', label: 'Running on the treadmill', says: ['Cardio time!', 'Just 10 more minutes', 'Kaya pa!'] },
  { id: 'treadmill-2', room: 'gym', tile: { x: 4, y: 39 }, approach: { x: 5, y: 39 }, face: { x: 4, y: 37 }, action: 'jog', label: 'Running on the treadmill', says: ['Cardio time!', 'Burning the merienda', 'One more km'] },
  { id: 'weights-1', room: 'gym', tile: { x: 8, y: 38 }, face: { x: 8, y: 37 }, action: 'exercise', label: 'Lifting weights', says: ['Lifting!', 'Feel the burn', 'Leg day? Arm day!'] },
  { id: 'weights-2', room: 'gym', tile: { x: 9, y: 38 }, face: { x: 9, y: 37 }, action: 'exercise', label: 'Lifting weights', says: ['Spot me?', 'Strong like narra'] },
  { id: 'stretch', room: 'gym', tile: { x: 7, y: 42 }, face: { x: 7, y: 44 }, action: 'exercise', label: 'Stretching', says: ['Stretch break', 'Ahh, much better'] },
  { id: 'hoop', room: 'court', tile: { x: 22, y: 39 }, face: { x: 23, y: 37 }, action: 'exercise', label: 'Shooting hoops', says: ['Nothing but net!', 'Swish!', 'Three points!'] },
  { id: 'net-1', room: 'court', tile: { x: 18, y: 39 }, face: { x: 18, y: 41 }, action: 'exercise', label: 'Playing volleyball', says: ['Serve!', 'Mine!'] },
  { id: 'net-2', room: 'court', tile: { x: 18, y: 41 }, face: { x: 18, y: 39 }, action: 'exercise', label: 'Playing volleyball', says: ['Spike!', 'Nice one!'] },
  { id: 'coffee', room: 'pantry', tile: { x: 15, y: 26 }, face: { x: 15, y: 25 }, action: 'none', label: 'Making coffee', says: ['Coffee break', 'Kape muna', 'Barako, please'] },
  { id: 'counter', room: 'pantry', tile: { x: 20, y: 26 }, face: { x: 20, y: 25 }, action: 'none', label: 'Having coffee at the counter', says: ['Ahh, coffee', 'Needed this'] },
  { id: 'snack', room: 'pantry', tile: { x: 13, y: 26 }, face: { x: 13, y: 25 }, action: 'none', label: 'Getting a snack', says: ['Snack time', 'Merienda!'] },
  { id: 'lounge', room: 'pantry', tile: { x: 20, y: 32 }, face: { x: 20, y: 34 }, action: 'none', label: 'Relaxing in the lounge', says: ['Quick rest', 'Five minutes lang'] },
];

/** Places where two agents on a break stand and talk, facing each other. */
export interface ChatSpot {
  id: string;
  room: RoomId;
  a: { x: number; y: number };
  b: { x: number; y: number };
}

export const CHAT_SPOTS: ChatSpot[] = [
  { id: 'coffee-chat', room: 'pantry', a: { x: 15, y: 27 }, b: { x: 16, y: 27 } },
  { id: 'table-chat', room: 'pantry', a: { x: 14, y: 31 }, b: { x: 17, y: 31 } },
  { id: 'water-chat', room: 'command', a: { x: 13, y: 14 }, b: { x: 14, y: 14 } },
  { id: 'court-chat', room: 'court', a: { x: 14, y: 38 }, b: { x: 15, y: 38 } },
  { id: 'sofa-chat', room: 'sales', a: { x: 9, y: 33 }, b: { x: 9, y: 34 } },
];

/** Short break-time conversations: lines alternate between the two agents, first speaker first. */
export const CHAT_SCRIPTS: string[][] = [
  ['Kumain ka na?', 'Oo, adobo!', 'Sana all', 'May natira pa, kuha ka'],
  ['Busy day?', 'Orders keep coming!', 'Good problem to have', 'Totoo!'],
  ['Nice work on that narra door', 'Salamat! Took a while', 'The carving is beautiful', 'The customer will love it'],
  ['Coffee later?', 'Sure, after lunch', "I'll bring pandesal", 'Deal!'],
  ['Traffic was crazy today', 'EDSA as usual', 'Should have left earlier', 'Carpool next time?'],
  ['Weekend plans?', 'Beach with the family', 'Nice! Where?', 'Batangas lang'],
  ['Did you see the new design?', 'The V-cut one?', 'Yes! Ang ganda', 'Customers keep asking for it'],
  ['How was the gym?', 'My legs are sore', 'Leg day ba?', 'Every day is leg day'],
  ['Is it merienda time yet?', 'Almost!', 'Turon or banana cue?', 'Both, obviously'],
  ['That coffee maker is new?', 'Yes, finally!', 'Espresso na tayo', 'Fancy!'],
];

/** Waypoints for a short walk around the office (two or three are picked at random). */
export const STROLL_POINTS: { x: number; y: number }[] = [
  { x: 16, y: 38 },
  { x: 20, y: 43 },
  { x: 14, y: 43 },
  { x: 6, y: 43 },
  { x: 3, y: 42 },
  { x: 18, y: 28 },
  { x: 16, y: 34 },
  { x: 4, y: 33 },
  { x: 30, y: 30 },
  { x: 30, y: 18 },
  { x: 4, y: 7 },
  { x: 28, y: 9 },
];

export function roomAt(gx: number, gy: number): RoomId | null {
  const x = Math.floor(gx);
  const y = Math.floor(gy);
  for (const r of ROOMS) if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) return r.id;
  return null;
}

/** Walkability grid: true = walkable. */
export function buildWalkGrid(): boolean[][] {
  const g: boolean[][] = Array.from({ length: GRID_H }, () => Array(GRID_W).fill(false));
  for (const r of ROOMS) for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) g[y][x] = true;
  for (const d of DOORS) for (const [x, y] of d.tiles) g[y][x] = true;
  for (const f of FURNITURE) {
    if (!f.blocks || f.wall) continue;
    for (let y = f.y; y < f.y + f.d; y++) for (let x = f.x; x < f.x + f.w; x++) if (g[y]) g[y][x] = false;
  }
  return g;
}

export function isDoorTile(x: number, y: number): boolean {
  return DOORS.some((d) => d.tiles.some(([tx, ty]) => tx === x && ty === y));
}
