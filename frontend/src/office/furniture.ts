// Programmatic isometric furniture. Everything is drawn from simple shaded prisms,
// ellipses and face-aligned quads, so there are no image assets to load.

import Phaser from 'phaser';
import { iso, shade, mix } from './iso';
import type { Furniture } from './layout';

type G = Phaser.GameObjects.Graphics;
interface V {
  x: number;
  y: number;
}

export const P = (gx: number, gy: number, z = 0): V => {
  const p = iso(gx, gy);
  return { x: p.x, y: p.y - z };
};

export function poly(g: G, pts: V[], color: number, alpha = 1) {
  g.fillStyle(color, alpha);
  g.beginPath();
  g.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
  g.closePath();
  g.fillPath();
}

export function line(g: G, a: V, b: V, color: number, width = 1, alpha = 1) {
  g.lineStyle(width, color, alpha);
  g.beginPath();
  g.moveTo(a.x, a.y);
  g.lineTo(b.x, b.y);
  g.strokePath();
}

/** Shaded prism. Visible faces: top, +gy face ("left"), +gx face ("right"). */
export function box(g: G, x: number, y: number, w: number, d: number, z: number, h: number, top: number, opts: { left?: number; right?: number; edge?: boolean } = {}) {
  const left = opts.left ?? shade(top, 0.8);
  const right = opts.right ?? shade(top, 0.64);
  poly(g, [P(x, y + d, z), P(x + w, y + d, z), P(x + w, y + d, z + h), P(x, y + d, z + h)], left);
  poly(g, [P(x + w, y, z), P(x + w, y + d, z), P(x + w, y + d, z + h), P(x + w, y, z + h)], right);
  poly(g, [P(x, y, z + h), P(x + w, y, z + h), P(x + w, y + d, z + h), P(x, y + d, z + h)], top);
  if (opts.edge !== false) {
    // crisp highlight on the front top edges
    g.lineStyle(1, shade(top, 1.15), 0.7);
    g.beginPath();
    const a = P(x, y + d, z + h);
    const b = P(x + w, y + d, z + h);
    const c = P(x + w, y, z + h);
    g.moveTo(a.x, a.y);
    g.lineTo(b.x, b.y);
    g.lineTo(c.x, c.y);
    g.strokePath();
  }
}

/** Quad on the +gy-facing plane at gy = py, spanning gx a..b and z z0..z1. */
export function faceL(g: G, py: number, a: number, b: number, z0: number, z1: number, color: number, alpha = 1) {
  poly(g, [P(a, py, z0), P(b, py, z0), P(b, py, z1), P(a, py, z1)], color, alpha);
}
/** Quad on the +gx-facing plane at gx = px, spanning gy a..b. */
export function faceR(g: G, px: number, a: number, b: number, z0: number, z1: number, color: number, alpha = 1) {
  poly(g, [P(px, a, z0), P(px, b, z0), P(px, b, z1), P(px, a, z1)], color, alpha);
}

function cylinder(g: G, cx: number, cy: number, rTiles: number, z: number, h: number, top: number) {
  const c = P(cx, cy, z);
  const rx = rTiles * 20 * Math.SQRT2;
  const ry = rTiles * 10 * Math.SQRT2;
  g.fillStyle(shade(top, 0.62), 1);
  g.fillEllipse(c.x, c.y, rx * 2, ry * 2);
  g.fillRect(c.x - rx, c.y - h, rx * 2, h);
  g.fillStyle(shade(top, 0.78), 1);
  g.fillRect(c.x - rx, c.y - h, rx, h);
  g.fillStyle(top, 1);
  g.fillEllipse(c.x, c.y - h, rx * 2, ry * 2);
}

function shadowUnder(g: G, x: number, y: number, w: number, d: number, alpha = 0.18) {
  poly(g, [P(x - 0.05, y + 0.1), P(x + w + 0.1, y + 0.1), P(x + w + 0.1, y + d + 0.12), P(x - 0.05, y + d + 0.12)], 0x000000, alpha);
}

function leaves(g: G, cx: number, cy: number, z: number, size: number) {
  const c = P(cx, cy, z);
  const greens = [0x3f8f4c, 0x4fa65b, 0x63bd6c, 0x7fd07f];
  const blobs = [
    [-0.55, 0.1, 0.75],
    [0.55, 0.15, 0.7],
    [0, -0.45, 0.8],
    [-0.25, -0.1, 0.65],
    [0.3, -0.25, 0.6],
    [0, 0.25, 0.55],
  ];
  blobs.forEach(([dx, dy, r], i) => {
    g.fillStyle(greens[i % greens.length], 1);
    g.fillCircle(c.x + dx * size, c.y + dy * size, r * size);
  });
}

const WOOD = 0xd2a86e;

export function drawFurniture(g: G, f: Furniture) {
  const { x, y, w, d } = f;
  switch (f.kind) {
    case 'desk': {
      shadowUnder(g, x + 0.08, y + 0.12, w - 0.16, d - 0.3);
      box(g, x + 0.08, y + 0.1, w - 0.16, d - 0.28, 0, 12, WOOD, { left: 0xb38755, right: 0x93693f });
      // monitor (screen glow is drawn by the scene on the +gy face)
      box(g, x + 0.42, y + 0.3, 0.16, 0.12, 12, 4, 0x3b4150, { edge: false });
      box(g, x + 0.12, y + 0.22, 0.76, 0.08, 15, 13, 0x2b303d, { edge: false });
      // keyboard
      box(g, x + 0.22, y + 0.5, 0.56, 0.16, 12, 1.5, 0xe9ecf2, { edge: false });
      // papers + mug on the right half
      box(g, x + 1.15, y + 0.3, 0.45, 0.32, 12, 1, 0xf6f4ee, { edge: false });
      cylinder(g, x + 1.72, y + 0.42, 0.06, 12, 5, 0xffffff);
      break;
    }
    case 'chair': {
      const c = P(x + 0.5, y + 0.5);
      g.fillStyle(0x000000, 0.18);
      g.fillEllipse(c.x, c.y, 26, 12);
      g.fillStyle(0x30343f, 1);
      g.fillRect(c.x - 1.5, c.y - 8, 3, 8);
      g.fillStyle(0x434a5c, 1);
      g.fillEllipse(c.x, c.y - 8, 22, 10);
      box(g, x + 0.2, y + 0.78, 0.6, 0.1, 8, 12, 0x4c5468, { edge: false });
      break;
    }
    case 'plant': {
      shadowUnder(g, x + 0.25, y + 0.25, 0.5, 0.5);
      box(g, x + 0.3, y + 0.3, 0.4, 0.4, 0, 9, 0xe6dccb);
      leaves(g, x + 0.5, y + 0.5, 15, 7);
      break;
    }
    case 'tallPlant': {
      shadowUnder(g, x + 0.2, y + 0.2, 0.6, 0.6);
      box(g, x + 0.25, y + 0.25, 0.5, 0.5, 0, 13, 0xf1ece2);
      const base = P(x + 0.5, y + 0.5, 13);
      g.lineStyle(2, 0x5a4632, 1);
      g.lineBetween(base.x, base.y, base.x, base.y - 14);
      leaves(g, x + 0.5, y + 0.5, 30, 9);
      leaves(g, x + 0.45, y + 0.5, 40, 7);
      break;
    }
    case 'sofa': {
      const col = f.color ?? 0x5d6f95;
      shadowUnder(g, x, y, w, d);
      if (w >= d) {
        box(g, x + 0.05, y + 0.05, w - 0.1, 0.3, 0, 17, shade(col, 0.95));
        box(g, x + 0.05, y + 0.35, w - 0.1, d - 0.45, 0, 8, col);
        box(g, x + 0.05, y + 0.05, 0.22, d - 0.15, 0, 12, shade(col, 0.9));
        box(g, x + w - 0.27, y + 0.05, 0.22, d - 0.15, 0, 12, shade(col, 0.9));
      } else {
        box(g, x + 0.05, y + 0.05, 0.3, d - 0.1, 0, 17, shade(col, 0.95));
        box(g, x + 0.35, y + 0.05, w - 0.45, d - 0.1, 0, 8, col);
        box(g, x + 0.05, y + 0.05, w - 0.15, 0.22, 0, 12, shade(col, 0.9));
        box(g, x + 0.05, y + d - 0.27, w - 0.15, 0.22, 0, 12, shade(col, 0.9));
      }
      break;
    }
    case 'shelf': {
      shadowUnder(g, x, y, w, d);
      box(g, x + 0.05, y + 0.1, w - 0.1, d - 0.2, 0, 36, 0x8b6a4b);
      const books = [0xe0605e, 0x4f9de0, 0xf2c14e, 0x5fbf8f, 0x9b7fd6, 0xf08a4b, 0x3f4a63];
      if (w >= d) {
        const py = y + d - 0.1;
        for (let lvl = 0; lvl < 3; lvl++) {
          const z0 = 4 + lvl * 11;
          faceL(g, py, x + 0.1, x + w - 0.1, z0 - 1, z0, 0x5b4330);
          let gx = x + 0.15;
          let i = lvl * 3;
          while (gx < x + w - 0.2) {
            const bw = 0.1 + ((i * 7) % 3) * 0.03;
            faceL(g, py, gx, gx + bw, z0, z0 + 7 + (i % 3), books[i % books.length]);
            gx += bw + 0.02;
            i++;
          }
        }
      } else {
        const px = x + w - 0.05;
        for (let lvl = 0; lvl < 3; lvl++) {
          const z0 = 4 + lvl * 11;
          let gy = y + 0.15;
          let i = lvl * 2;
          while (gy < y + d - 0.2) {
            const bw = 0.1 + ((i * 5) % 3) * 0.03;
            faceR(g, px, gy, gy + bw, z0, z0 + 7 + (i % 3), books[i % books.length]);
            gy += bw + 0.02;
            i++;
          }
        }
      }
      break;
    }
    case 'rack': {
      shadowUnder(g, x + 0.1, y + 0.15, 0.8, 0.7);
      box(g, x + 0.1, y + 0.15, 0.8, 0.7, 0, 42, 0x2d3444, { left: 0x262c3a, right: 0x1d222e });
      for (let i = 0; i < 6; i++) faceL(g, y + 0.85, x + 0.16, x + 0.84, 4 + i * 6.3, 5 + i * 6.3, 0x3d4659);
      break;
    }
    case 'holoTable': {
      const cx = x + w / 2;
      const cy = y + d / 2;
      cylinder(g, cx, cy, 0.75, 0, 10, 0x2e3a4c);
      cylinder(g, cx, cy, 0.6, 10, 2, 0x5fe0d2);
      break;
    }
    case 'meetingTable': {
      const cx = x + w / 2;
      const cy = y + d / 2;
      const c = P(cx, cy);
      g.fillStyle(0x58e0f0, 0.08);
      g.fillEllipse(c.x, c.y, 150, 75);
      g.fillStyle(0x000000, 0.25);
      g.fillEllipse(c.x, c.y + 3, 100, 48);
      cylinder(g, cx, cy, 0.35, 0, 10, 0x3a4458);
      cylinder(g, cx, cy, 1.25, 10, 4, 0xe9eef4);
      g.lineStyle(1.5, 0x58e0f0, 0.85);
      const top = P(cx, cy, 14);
      g.strokeEllipse(top.x, top.y, 1.25 * 20 * Math.SQRT2 * 2 - 6, 1.25 * 10 * Math.SQRT2 * 2 - 3);
      // laptops/papers on the table
      box(g, cx - 0.55, cy - 0.15, 0.3, 0.22, 14, 1, 0xd5dbe5, { edge: false });
      box(g, cx + 0.25, cy + 0.05, 0.25, 0.3, 14, 1, 0xffffff, { edge: false });
      break;
    }
    case 'bigScreen': {
      // wall-mounted along the back (gy = y) edge
      faceL(g, y + 0.02, x, x + w, 6, 34, 0x10151f);
      faceL(g, y + 0.03, x + 0.08, x + w - 0.08, 8, 32, 0x14324a);
      break;
    }
    case 'whiteboard': {
      if (w >= d) {
        faceL(g, y + 0.02, x + 0.05, x + w - 0.05, 10, 32, 0x9aa3b2);
        faceL(g, y + 0.03, x + 0.1, x + w - 0.1, 11.5, 30.5, 0xf8fafc);
        const strokes = [0x4f9de0, 0xe0605e, 0x43b58a, 0x2a2f3c];
        for (let i = 0; i < 5; i++) {
          const a = x + 0.25 + (i % 2) * 0.4;
          const zz = 15 + i * 3;
          faceL(g, y + 0.04, a, a + 0.6 + (i % 3) * 0.3, zz, zz + 1, strokes[i % 4]);
        }
      } else {
        faceR(g, x + 0.02, y + 0.05, y + d - 0.05, 10, 32, 0x9aa3b2);
        faceR(g, x + 0.03, y + 0.1, y + d - 0.1, 11.5, 30.5, 0xf8fafc);
        for (let i = 0; i < 5; i++) {
          const a = y + 0.25 + (i % 2) * 0.4;
          const zz = 15 + i * 3;
          faceR(g, x + 0.04, a, a + 0.6 + (i % 3) * 0.3, zz, zz + 1, [0x4f9de0, 0xe0605e, 0x43b58a][i % 3]);
        }
      }
      break;
    }
    case 'counter': {
      shadowUnder(g, x, y, w, d);
      box(g, x + 0.02, y + 0.1, w - 0.04, d - 0.2, 0, 14, 0xf4f1ea, { left: 0xa7825c, right: 0x8a6a49 });
      cylinder(g, x + 0.4, y + 0.5, 0.07, 14, 4, 0xffffff); // mugs (the coffee station is next to the vending machine)
      cylinder(g, x + 0.6, y + 0.4, 0.07, 14, 4, 0x4f9de0);
      cylinder(g, x + 1.3, y + 0.5, 0.07, 14, 4, 0xffffff);
      cylinder(g, x + 1.5, y + 0.45, 0.07, 14, 4, 0xf2c14e);
      box(g, x + 2.1, y + 0.3, 0.6, 0.4, 14, 3, 0xe8b46a); // bread board
      break;
    }
    case 'fridge': {
      shadowUnder(g, x + 0.1, y + 0.1, 0.8, 0.8);
      box(g, x + 0.1, y + 0.1, 0.8, 0.8, 0, 36, 0xe9eef3);
      faceL(g, y + 0.9, x + 0.12, x + 0.88, 22, 23, 0xb8c0cc);
      faceL(g, y + 0.91, x + 0.75, x + 0.8, 8, 20, 0x8e98a8);
      faceL(g, y + 0.91, x + 0.75, x + 0.8, 25, 33, 0x8e98a8);
      break;
    }
    case 'postBoard': {
      // Cork-style board with a Facebook-blue header; the post cards are drawn live by the scene.
      faceL(g, y + 0.02, x + 0.05, x + w - 0.05, 10, 32, 0x2a2f3c);
      faceL(g, y + 0.03, x + 0.1, x + w - 0.1, 11.5, 27.5, 0xd9c6a5);
      faceL(g, y + 0.03, x + 0.1, x + w - 0.1, 27.5, 30.5, 0x1877f2);
      faceL(g, y + 0.035, x + 0.18, x + 0.42, 28.3, 29.7, 0xffffff);
      break;
    }
    case 'coffeeMaker': {
      shadowUnder(g, x + 0.05, y + 0.1, 0.9, 0.8);
      // wooden cabinet
      box(g, x + 0.05, y + 0.1, 0.9, 0.8, 0, 14, 0xf4f1ea, { left: 0xa7825c, right: 0x8a6a49 });
      faceL(g, y + 0.9, x + 0.12, x + 0.48, 3, 11, 0x96714e);
      faceL(g, y + 0.9, x + 0.52, x + 0.88, 3, 11, 0x96714e);
      // espresso machine body, top and dark front
      box(g, x + 0.15, y + 0.2, 0.55, 0.45, 14, 16, 0x3a3f4a);
      box(g, x + 0.15, y + 0.2, 0.55, 0.45, 30, 2, 0xb8c0cc);
      faceL(g, y + 0.651, x + 0.22, x + 0.63, 18, 27, 0x23272f);
      // red power light, group head and a cup on the drip tray
      faceL(g, y + 0.652, x + 0.55, x + 0.6, 24.5, 26, 0xd8434e);
      faceL(g, y + 0.652, x + 0.32, x + 0.5, 20, 22, 0x8e98a8);
      cylinder(g, x + 0.42, y + 0.72, 0.06, 14, 3, 0xffffff);
      // coffee bean jar and two mugs
      cylinder(g, x + 0.82, y + 0.32, 0.07, 14, 7, 0x6b4a2b);
      cylinder(g, x + 0.82, y + 0.62, 0.06, 14, 4, 0xf2c14e);
      cylinder(g, x + 0.84, y + 0.8, 0.06, 14, 4, 0x5fbf8f);
      break;
    }
    case 'vending': {
      shadowUnder(g, x + 0.1, y + 0.1, 0.8, 0.8);
      box(g, x + 0.1, y + 0.1, 0.8, 0.8, 0, 36, 0xd8434e);
      faceL(g, y + 0.9, x + 0.18, x + 0.68, 12, 32, 0xbfe6ff);
      const cols = [0xf2c14e, 0x5fbf8f, 0x4f9de0, 0xe0605e];
      for (let r = 0; r < 4; r++)
        for (let c = 0; c < 3; c++) faceL(g, y + 0.91, x + 0.22 + c * 0.15, x + 0.3 + c * 0.15, 14 + r * 4.5, 16.5 + r * 4.5, cols[(r + c) % 4]);
      break;
    }
    case 'diningTable': {
      shadowUnder(g, x + 0.1, y + 0.1, w - 0.2, d - 0.2, 0.2);
      for (const [lx, ly] of [
        [x + 0.2, y + 0.2],
        [x + w - 0.3, y + 0.2],
        [x + 0.2, y + d - 0.3],
        [x + w - 0.3, y + d - 0.3],
      ])
        box(g, lx, ly, 0.1, 0.1, 0, 10, 0x8a6a49, { edge: false });
      box(g, x + 0.1, y + 0.1, w - 0.2, d - 0.2, 10, 3, 0xf3e1bf, { left: 0xc9a77a, right: 0xb08f62 });
      for (const [px, py] of [
        [x + 0.6, y + 0.7],
        [x + 1.4, y + 1.3],
      ]) {
        const c = P(px, py, 13);
        g.fillStyle(0xffffff, 1);
        g.fillEllipse(c.x, c.y, 14, 7);
        g.fillStyle(0xe08a4b, 1);
        g.fillEllipse(c.x, c.y, 7, 3.5);
      }
      break;
    }
    case 'stool':
      cylinder(g, x + 0.5, y + 0.5, 0.06, 0, 7, 0x6b5a48);
      cylinder(g, x + 0.5, y + 0.5, 0.24, 7, 2, 0xd77a4f);
      break;
    case 'treadmill': {
      shadowUnder(g, x + 0.15, y + 0.05, 0.7, d - 0.1);
      box(g, x + 0.15, y + 0.3, 0.7, d - 0.35, 0, 5, 0x3a3f4a);
      box(g, x + 0.22, y + 0.35, 0.56, d - 0.45, 5, 0.5, 0x1e222a, { edge: false });
      box(g, x + 0.15, y + 0.05, 0.08, 0.25, 0, 22, 0x5c6474, { edge: false });
      box(g, x + 0.77, y + 0.05, 0.08, 0.25, 0, 22, 0x5c6474, { edge: false });
      box(g, x + 0.15, y + 0.05, 0.7, 0.2, 22, 4, 0x2a2e38);
      faceL(g, y + 0.25, x + 0.3, x + 0.7, 23, 25.5, 0x5fe0d2);
      break;
    }
    case 'weights': {
      shadowUnder(g, x, y, w, d);
      box(g, x + 0.1, y + 0.2, w - 0.2, 0.6, 0, 10, 0x4a5160);
      for (let i = 0; i < 4; i++) {
        const cx = x + 0.35 + i * 0.42;
        cylinder(g, cx, y + 0.5, 0.1, 10, 4, i % 2 ? 0x2a2e38 : 0xd8434e);
      }
      break;
    }
    case 'bench':
      shadowUnder(g, x + 0.1, y + 0.3, w - 0.2, 0.4);
      box(g, x + 0.2, y + 0.4, 0.1, 0.2, 0, 6, 0x2a2e38, { edge: false });
      box(g, x + w - 0.3, y + 0.4, 0.1, 0.2, 0, 6, 0x2a2e38, { edge: false });
      box(g, x + 0.1, y + 0.3, w - 0.2, 0.4, 6, 3, 0xd8434e);
      break;
    case 'easel': {
      const b1 = P(x + 0.25, y + 0.7);
      const b2 = P(x + 0.75, y + 0.7);
      const b3 = P(x + 0.5, y + 0.25);
      const top = P(x + 0.5, y + 0.55, 34);
      g.lineStyle(2, 0x8b6a4b, 1);
      g.lineBetween(b1.x, b1.y, top.x, top.y);
      g.lineBetween(b2.x, b2.y, top.x, top.y);
      g.lineBetween(b3.x, b3.y, top.x, top.y);
      faceL(g, y + 0.6, x + 0.12, x + 0.88, 12, 32, 0xfdfbf5);
      faceL(g, y + 0.61, x + 0.2, x + 0.55, 16, 26, 0xf08a4b);
      faceL(g, y + 0.61, x + 0.45, x + 0.8, 20, 29, 0x4f9de0);
      faceL(g, y + 0.6, x + 0.1, x + 0.9, 11, 12, 0x8b6a4b);
      break;
    }
    case 'tripod': {
      const top = P(x + 0.5, y + 0.5, 26);
      for (const [dx, dy] of [
        [0.2, 0.75],
        [0.8, 0.75],
        [0.5, 0.2],
      ]) {
        const b = P(x + dx, y + dy);
        line(g, b, top, 0x2a2e38, 1.5);
      }
      box(g, x + 0.35, y + 0.38, 0.3, 0.24, 26, 7, 0x2a2e38);
      cylinder(g, x + 0.45, y + 0.68, 0.07, 28, 1, 0x7fb3ff);
      break;
    }
    case 'softbox': {
      const b = P(x + 0.5, y + 0.5);
      const t = P(x + 0.5, y + 0.5, 30);
      line(g, b, t, 0x3a3f4a, 2);
      box(g, x + 0.15, y + 0.3, 0.7, 0.3, 28, 14, 0xfff6e0, { left: 0xfffbf0, right: 0xd9d2c0 });
      g.fillStyle(0xfff3c4, 0.12);
      g.fillCircle(t.x, t.y + 6, 22);
      break;
    }
    case 'cabinet':
      shadowUnder(g, x + 0.1, y + 0.15, 0.8, 0.7);
      box(g, x + 0.1, y + 0.15, 0.8, 0.7, 0, 24, 0x9aa6b8);
      for (let i = 0; i < 3; i++) {
        faceL(g, y + 0.85, x + 0.14, x + 0.86, 2 + i * 7.5, 2.6 + i * 7.5, 0x6f7a8c);
        faceL(g, y + 0.86, x + 0.42, x + 0.58, 5 + i * 7.5, 6 + i * 7.5, 0x3d4659);
      }
      break;
    case 'artTable':
      shadowUnder(g, x, y, w, d);
      box(g, x + 0.1, y + 0.1, w - 0.2, d - 0.2, 0, 12, 0xe4cfa6, { left: 0xa98a5f, right: 0x8b6f48 });
      box(g, x + 0.4, y + 0.4, 0.9, 0.6, 12, 0.6, 0xffffff, { edge: false });
      box(g, x + 1.5, y + 0.7, 0.7, 0.8, 12, 0.6, 0xfdf0d8, { edge: false });
      for (const [px, py, c] of [
        [x + 2.4, y + 0.5, 0xe0605e],
        [x + 2.55, y + 0.6, 0x4f9de0],
        [x + 2.45, y + 0.8, 0xf2c14e],
      ] as const)
        cylinder(g, px, py, 0.05, 12, 3, c);
      break;
    case 'net': {
      const p1b = P(x + 0.1, y + 0.5);
      const p1t = P(x + 0.1, y + 0.5, 22);
      const p2b = P(x + w - 0.1, y + 0.5);
      const p2t = P(x + w - 0.1, y + 0.5, 22);
      faceL(g, y + 0.5, x + 0.1, x + w - 0.1, 10, 21, 0xffffff, 0.12);
      g.lineStyle(1, 0xffffff, 0.35);
      for (let i = 0; i <= 14; i++) {
        const a = P(x + 0.1 + ((w - 0.2) * i) / 14, y + 0.5, 10);
        const b = P(x + 0.1 + ((w - 0.2) * i) / 14, y + 0.5, 21);
        g.lineBetween(a.x, a.y, b.x, b.y);
      }
      line(g, P(x + 0.1, y + 0.5, 21), P(x + w - 0.1, y + 0.5, 21), 0xffffff, 2, 0.9);
      line(g, p1b, p1t, 0xd5dbe5, 3);
      line(g, p2b, p2t, 0xd5dbe5, 3);
      break;
    }
    case 'hoop': {
      const b = P(x + 0.5, y + 0.3);
      const t = P(x + 0.5, y + 0.3, 40);
      line(g, b, t, 0x9aa3b2, 3);
      faceL(g, y + 0.35, x + 0.1, x + 0.9, 32, 46, 0xffffff);
      faceL(g, y + 0.36, x + 0.35, x + 0.65, 34, 40, 0xd8434e, 0.0);
      const rim = P(x + 0.5, y + 0.6, 34);
      g.lineStyle(2, 0xf08a4b, 1);
      g.strokeEllipse(rim.x, rim.y, 16, 7);
      break;
    }
    case 'printer':
      shadowUnder(g, x + 0.15, y + 0.2, 0.7, 0.6);
      box(g, x + 0.15, y + 0.2, 0.7, 0.6, 0, 6, 0x5c6474, { edge: false });
      box(g, x + 0.15, y + 0.2, 0.7, 0.6, 6, 8, 0xe5e8ee);
      box(g, x + 0.3, y + 0.35, 0.4, 0.3, 14, 0.5, 0xffffff, { edge: false });
      faceL(g, y + 0.8, x + 0.25, x + 0.75, 8, 9.5, 0x2a2f3c);
      break;
    case 'beanbag': {
      const c = P(x + 0.5, y + 0.5);
      const col = f.color ?? (f.room === 'dev' ? 0xf2c14e : 0xe0605e);
      g.fillStyle(0x000000, 0.18);
      g.fillEllipse(c.x, c.y + 2, 30, 14);
      g.fillStyle(shade(col, 0.75), 1);
      g.fillEllipse(c.x, c.y - 4, 28, 16);
      g.fillStyle(col, 1);
      g.fillEllipse(c.x - 2, c.y - 7, 22, 12);
      break;
    }
    case 'water':
      shadowUnder(g, x + 0.25, y + 0.25, 0.5, 0.5);
      box(g, x + 0.25, y + 0.25, 0.5, 0.5, 0, 20, 0xe9eef3);
      cylinder(g, x + 0.5, y + 0.5, 0.17, 20, 10, 0x8fd0ff);
      break;
    case 'meetingChair':
      break;
    // ---------------------------------------------------------------- Workshop
    case 'sawTable': {
      shadowUnder(g, x, y, w, d);
      for (const [lx, ly] of [[x + 0.15, y + 0.15], [x + w - 0.25, y + 0.15], [x + 0.15, y + d - 0.25], [x + w - 0.25, y + d - 0.25]])
        box(g, lx, ly, 0.1, 0.1, 0, 11, 0x5c6474, { edge: false });
      box(g, x + 0.05, y + 0.1, w - 0.1, d - 0.2, 11, 2, 0xaeb6c2, { left: 0x8a929e, right: 0x707884 });
      // circular blade through the middle of the table, and its guard
      const c = P(x + w / 2, y + d / 2, 15);
      g.fillStyle(0xdfe4ea, 1);
      g.fillEllipse(c.x, c.y, 16, 9);
      g.lineStyle(1, 0x8a929e, 1);
      g.strokeEllipse(c.x, c.y, 16, 9);
      box(g, x + w / 2 - 0.12, y + 0.3, 0.24, 0.4, 15, 4, 0xe0605e, { edge: false });
      // a board waiting to be cut
      box(g, x + 0.12, y + 0.55, 0.7, 0.3, 13, 1.6, 0xd2a86e, { edge: false });
      break;
    }
    case 'planer': {
      shadowUnder(g, x, y, w, d);
      box(g, x + 0.1, y + 0.15, w - 0.2, d - 0.3, 0, 9, 0x3f6f52, { left: 0x335b43, right: 0x284836 });
      box(g, x + 0.05, y + 0.1, w - 0.1, d - 0.2, 9, 2, 0x9aa3ae);
      box(g, x + 0.55, y + 0.2, 0.9, 0.6, 11, 7, 0x4d8a63);
      cylinder(g, x + 1.55, y + 0.5, 0.08, 11, 4, 0xf2c14e);
      break;
    }
    case 'workbench': {
      shadowUnder(g, x, y, w, d);
      for (const [lx, ly] of [[x + 0.12, y + 0.15], [x + w - 0.22, y + 0.15], [x + 0.12, y + d - 0.25], [x + w - 0.22, y + d - 0.25]])
        box(g, lx, ly, 0.1, 0.1, 0, 10, 0x8b6a4b, { edge: false });
      box(g, x + 0.1, y + 0.2, w - 0.2, d - 0.4, 3, 1.5, 0x8b6a4b, { edge: false }); // lower shelf
      box(g, x + 0.05, y + 0.08, w - 0.1, d - 0.16, 10, 3, 0xc99a5e, { left: 0xa47a45, right: 0x86622f });
      // vise and two orange clamps
      box(g, x + 0.05, y + d - 0.3, 0.3, 0.25, 9, 4, 0x4a5262, { edge: false });
      box(g, x + 1.2, y + 0.25, 0.08, 0.5, 13, 3, 0xf08a4b, { edge: false });
      box(g, x + 1.55, y + 0.25, 0.08, 0.5, 13, 3, 0xf08a4b, { edge: false });
      break;
    }
    case 'varnishTable': {
      shadowUnder(g, x, y, w, d);
      box(g, x + 0.1, y + 0.15, w - 0.2, d - 0.3, 0, 10, 0x6d5a45, { left: 0x5a4a38, right: 0x463a2c });
      box(g, x + 0.05, y + 0.1, w - 0.1, d - 0.2, 10, 1.5, 0x9b8668);
      // cans of varnish and stain, and a brush
      cylinder(g, x + 1.55, y + 0.35, 0.09, 11.5, 5, 0xc0392b);
      cylinder(g, x + 1.75, y + 0.6, 0.09, 11.5, 5, 0x8a5a2b);
      box(g, x + 1.3, y + 0.62, 0.25, 0.06, 11.5, 1, 0xf2c14e, { edge: false });
      break;
    }
    case 'lumberRack': {
      shadowUnder(g, x, y, w, d);
      box(g, x + 0.1, y + 0.05, 0.12, d - 0.1, 0, 34, 0x5c4630, { edge: false }); // back frame
      const woods = [0xc8955a, 0x9b5a3c, 0xd9b27a, 0x7a4a2e, 0xe2c79a];
      for (let lvl = 0; lvl < 4; lvl++) {
        box(g, x + 0.2, y + 0.05, w - 0.3, d - 0.1, 2 + lvl * 8, 1.2, 0x5c4630, { edge: false });
        for (let j = 0; j < 2; j++) box(g, x + 0.25 + j * 0.3, y + 0.1, 0.26, d - 0.2, 3.2 + lvl * 8, 3, woods[(lvl * 2 + j) % woods.length], { edge: false });
      }
      break;
    }
    case 'doorRack': {
      // low frame along the back wall; the finished doors on it are drawn by the scene
      box(g, x + 0.05, y + 0.25, w - 0.1, 0.5, 0, 3, 0x5c4630, { edge: false });
      for (let i = 0; i <= 3; i++) box(g, x + 0.05 + i * ((w - 0.15) / 3), y + 0.2, 0.06, 0.06, 0, 26, 0x5c4630, { edge: false });
      break;
    }
  }
}

/** Order "pieces" on a shop bench: one slab per order at that stage (up to 5), stacked on the top. */
export function drawBenchPile(g: G, f: Furniture, count: number) {
  g.clear();
  const n = Math.min(count, 5);
  const top = f.kind === 'sawTable' ? 13 : f.kind === 'planer' ? 11 : f.kind === 'workbench' ? 13 : 11.5;
  const woods = [0xd2a86e, 0xb9804f, 0xe0bf8a, 0xa06a40, 0xcf9d63];
  for (let i = 0; i < n; i++) box(g, f.x + 0.25 + (i % 2) * 0.05, f.y + 0.2, 0.75, 0.55, top + i * 2, 1.8, woods[i % woods.length]);
}

/** Finished doors standing in the rack (one per order ready for delivery, up to 8). */
export function drawDoorRack(g: G, f: Furniture, count: number) {
  g.clear();
  const n = Math.min(count, 8);
  const colors = [0x9b5a3c, 0xc8955a, 0x7a4a2e, 0xb07040];
  for (let i = 0; i < n; i++) {
    const gx = f.x + 0.2 + i * ((f.w - 0.4) / 8);
    box(g, gx, f.y + 0.3, 0.09, 0.45, 3, 28, colors[i % colors.length], { edge: false });
    faceL(g, f.y + 0.75, gx + 0.02, gx + 0.07, 15, 17, 0xf2c14e); // handle
  }
}

/** Desk monitor screen on the +gy face. mode: 0 idle, 1 working (animated lines). */
export function drawScreen(g: G, f: Furniture, mode: 0 | 1, seed: number, accent: number) {
  g.clear();
  const py = f.y + 0.305;
  const a = f.x + 0.16;
  const b = f.x + 0.84;
  if (mode === 0) {
    faceL(g, py, a, b, 17, 26.5, 0x24324a);
    faceL(g, py, a + 0.05, a + 0.35, 24, 25, 0x3d5170);
    return;
  }
  faceL(g, py, a, b, 17, 26.5, 0x16263c);
  g.fillStyle(accent, 0.18);
  const c = P((a + b) / 2, py, 22);
  g.fillEllipse(c.x, c.y + 8, 34, 14);
  const cols = [mix(accent, 0xffffff, 0.35), 0x7fe3c4, 0xf2c14e, 0xbfd4ff];
  for (let i = 0; i < 5; i++) {
    const r = Math.abs(Math.sin(seed * 1.7 + i * 2.3));
    const indent = (i % 3) * 0.06;
    faceL(g, py - 0.005, a + 0.05 + indent, a + 0.1 + indent + r * 0.45, 24.5 - i * 1.6, 25.3 - i * 1.6, cols[(i + seed) % 4]);
  }
}
