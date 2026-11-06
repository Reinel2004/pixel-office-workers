// Programmatic pixel-art characters. Each agent gets 8 small textures:
// front 0/1/2 (stand, walk A, walk B), back 0/1/2, and sitting-from-behind 0/1 (typing).
// Front sprites face down-right; the scene flips them horizontally for down-left.

import Phaser from 'phaser';
import type { AgentDef, Look } from '../agents/roster';

const W = 12;
const H = 20;
const OY = 2; // rows reserved above the head for hats/hair
export const PIXEL = 2;
export const SPRITE_W = W * PIXEL;
export const SPRITE_H = H * PIXEL;

type Grid = (string | null)[][];

const OUTLINE = '#151826';
const EYE = '#231c2a';
const SHOE = '#22252f';

function blank(): Grid {
  return Array.from({ length: H }, () => Array<string | null>(W).fill(null));
}

function r(g: Grid, x: number, y: number, w: number, h: number, c: string) {
  for (let yy = y; yy < y + h; yy++)
    for (let xx = x; xx < x + w; xx++) {
      const Y = yy + OY;
      if (Y >= 0 && Y < H && xx >= 0 && xx < W) g[Y][xx] = c;
    }
}

function darken(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (s: number) => Math.max(0, Math.min(255, Math.round(((n >> s) & 255) * f)));
  return '#' + ((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0');
}

function outline(g: Grid) {
  const out = g.map((row) => row.slice());
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (g[y][x]) continue;
      const n = [g[y - 1]?.[x], g[y + 1]?.[x], g[y]?.[x - 1], g[y]?.[x + 1]];
      if (n.some((c) => c && c !== OUTLINE)) out[y][x] = OUTLINE;
    }
  return out;
}

function legs(g: Grid, L: Look, frame: number) {
  r(g, 3, 12, 6, 1, L.pants);
  const left = frame === 1 ? 1 : 0; // lift amount
  const right = frame === 2 ? 1 : 0;
  r(g, 3, 13, 2, 2 - left, L.pants);
  r(g, 3, 15 - left, 2, 1, SHOE);
  r(g, 7, 13, 2, 2 - right, L.pants);
  r(g, 7, 15 - right, 2, 1, SHOE);
}

function torso(g: Grid, L: Look, frame: number, seated = false, typing = 0) {
  const shirtD = darken(L.shirt, 0.82);
  r(g, 3, 7, 6, 5, L.shirt);
  r(g, 3, 11, 6, 1, shirtD);
  if (seated) {
    // elbows bent forward while typing
    r(g, 2, 7, 1, 3, L.shirt);
    r(g, 9, 7, 1, 3, L.shirt);
    r(g, typing ? 3 : 2, 10, 1, 1, shirtD);
    r(g, typing ? 9 : 8, 10, 1, 1, shirtD);
    return;
  }
  const swingL = frame === 1 ? -1 : 0;
  const swingR = frame === 2 ? -1 : 0;
  r(g, 2, 7, 1, 4 + swingL, L.shirt);
  r(g, 2, 11 + swingL, 1, 1, L.skin);
  r(g, 9, 7, 1, 4 + swingR, L.shirt);
  r(g, 9, 11 + swingR, 1, 1, L.skin);
}

function headFront(g: Grid, L: Look) {
  r(g, 2, 1, 8, 6, L.skin);
  // hair
  r(g, 2, 1, 8, 2, L.hair);
  r(g, 2, 3, 3, 1, L.hair); // fringe swept to the left (we face right)
  r(g, 2, 3, 1, 2, L.hair);
  r(g, 9, 3, 1, 1, L.hair);
  if (L.hairStyle === 'long') {
    r(g, 1, 2, 1, 7, L.hair);
    r(g, 10, 2, 1, 6, L.hair);
  }
  if (L.hairStyle === 'ponytail') r(g, 10, 3, 1, 4, L.hair);
  if (L.hairStyle === 'bun') r(g, 4, -1, 4, 2, L.hair);
  if (L.hairStyle === 'spiky') {
    r(g, 3, 0, 1, 1, L.hair);
    r(g, 5, 0, 1, 1, L.hair);
    r(g, 7, 0, 1, 1, L.hair);
  }
  // face
  r(g, 5, 4, 1, 1, EYE);
  r(g, 8, 4, 1, 1, EYE);
  r(g, 7, 6, 1, 1, darken(L.skin, 0.75));
  r(g, 4, 5, 1, 1, darken(L.skin, 0.9));
}

function headBack(g: Grid, L: Look) {
  r(g, 2, 1, 8, 6, L.hair);
  if (L.hairStyle === 'short' || L.hairStyle === 'spiky') {
    r(g, 3, 5, 6, 2, L.skin);
    r(g, 2, 4, 1, 1, L.skin);
    r(g, 9, 4, 1, 1, L.skin);
  }
  if (L.hairStyle === 'long') {
    r(g, 1, 2, 1, 7, L.hair);
    r(g, 10, 2, 1, 7, L.hair);
    r(g, 3, 7, 6, 3, L.hair);
  }
  if (L.hairStyle === 'ponytail') {
    r(g, 3, 6, 6, 1, L.skin);
    r(g, 5, 7, 2, 3, L.hair);
  }
  if (L.hairStyle === 'bun') {
    r(g, 4, -1, 4, 2, L.hair);
    r(g, 3, 6, 6, 1, L.skin);
  }
  if (L.hairStyle === 'spiky') {
    r(g, 3, 0, 1, 1, L.hair);
    r(g, 5, 0, 1, 1, L.hair);
    r(g, 7, 0, 1, 1, L.hair);
  }
}

function accessory(g: Grid, L: Look, front: boolean) {
  const acc = L.accent ?? '#ffffff';
  switch (L.accessory) {
    case 'headset':
      r(g, 2, 1, 8, 1, '#2b2f3a');
      r(g, 1, 3, 1, 3, '#2b2f3a');
      if (front) r(g, 2, 6, 2, 1, '#2b2f3a');
      break;
    case 'glasses':
      if (front) {
        r(g, 4, 4, 3, 1, '#2a2230');
        r(g, 7, 4, 3, 1, '#2a2230');
        r(g, 5, 4, 1, 1, '#bfe2ff');
        r(g, 8, 4, 1, 1, '#bfe2ff');
      }
      break;
    case 'hardhat':
      r(g, 2, -1, 8, 3, acc);
      r(g, 1, 2, 10, 1, darken(acc, 0.8));
      r(g, 4, -1, 2, 1, darken(acc, 1.15));
      break;
    case 'beret':
      r(g, 2, 0, 7, 2, acc);
      r(g, 5, -1, 1, 1, acc);
      break;
    case 'tie':
      if (front) {
        r(g, 5, 7, 2, 1, '#f2f2f2');
        r(g, 6, 8, 1, 3, acc);
      }
      break;
    case 'hood':
      r(g, 1, 2, 1, 6, L.shirt);
      r(g, 10, 2, 1, 6, L.shirt);
      if (front) {
        r(g, 5, 8, 1, 2, '#e8e8e8');
        r(g, 7, 8, 1, 2, '#e8e8e8');
      } else {
        r(g, 3, 6, 6, 3, darken(L.shirt, 0.85));
      }
      break;
    default:
      break;
  }
}

function paint(scene: Phaser.Scene, key: string, g: Grid) {
  if (scene.textures.exists(key)) scene.textures.remove(key);
  const tex = scene.textures.createCanvas(key, SPRITE_W, SPRITE_H);
  if (!tex) return;
  const ctx = tex.getContext();
  const o = outline(g);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const c = o[y][x];
      if (!c) continue;
      ctx.fillStyle = c;
      ctx.fillRect(x * PIXEL, y * PIXEL, PIXEL, PIXEL);
    }
  tex.refresh();
  tex.setFilter(Phaser.Textures.FilterMode.NEAREST);
}

export function frameKey(id: string, kind: 'front' | 'back' | 'sit', n: number) {
  return `${id}:${kind}:${n}`;
}

export function buildAgentTextures(scene: Phaser.Scene, def: AgentDef) {
  const L = def.look;
  for (let f = 0; f < 3; f++) {
    const g = blank();
    legs(g, L, f);
    torso(g, L, f);
    headFront(g, L);
    accessory(g, L, true);
    paint(scene, frameKey(def.id, 'front', f), g);

    const b = blank();
    legs(b, L, f);
    torso(b, L, f);
    headBack(b, L);
    accessory(b, L, false);
    paint(scene, frameKey(def.id, 'back', f), b);
  }
  for (let f = 0; f < 2; f++) {
    const s = blank();
    r(s, 3, 12, 6, 1, L.pants);
    torso(s, L, 0, true, f);
    headBack(s, L);
    accessory(s, L, false);
    paint(scene, frameKey(def.id, 'sit', f), s);
  }
}

/** Front-facing portrait as a data URL, for the React panels (no Phaser needed). */
const portraitCache = new Map<string, string>();
export function agentPortrait(def: AgentDef, scale = 3): string {
  const key = `${def.id}:${scale}`;
  const hit = portraitCache.get(key);
  if (hit) return hit;
  if (typeof document === 'undefined') return '';
  const g = blank();
  legs(g, def.look, 0);
  torso(g, def.look, 0);
  headFront(g, def.look);
  accessory(g, def.look, true);
  const o = outline(g);
  const c = document.createElement('canvas');
  c.width = W * scale;
  c.height = H * scale;
  const ctx = c.getContext('2d');
  if (!ctx) return '';
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const col = o[y][x];
      if (!col) continue;
      ctx.fillStyle = col;
      ctx.fillRect(x * scale, y * scale, scale, scale);
    }
  const url = c.toDataURL();
  portraitCache.set(key, url);
  return url;
}
