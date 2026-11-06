// Isometric coordinate system shared by the scene and the layout data.
// Grid coordinates (gx, gy) are tile units. +gx runs down-right on screen, +gy runs down-left.
// A tile's top corner is iso(gx, gy); its centre is iso(gx + 0.5, gy + 0.5).

export const TW = 40; // tile width in world pixels
export const TH = 20; // tile height in world pixels (2:1 isometric)

export interface Pt {
  x: number;
  y: number;
}

export function iso(gx: number, gy: number): Pt {
  return { x: ((gx - gy) * TW) / 2, y: ((gx + gy) * TH) / 2 };
}

export function fromIso(x: number, y: number): { gx: number; gy: number } {
  const a = x / (TW / 2);
  const b = y / (TH / 2);
  return { gx: (a + b) / 2, gy: (b - a) / 2 };
}

/** Depth for a footprint [x, x+w) × [y, y+d). Agents use x + y + 1 (tile centre sum). */
export function footprintDepth(x: number, y: number, w: number, d: number): number {
  return x + y + w + d - 1.5;
}

export function shade(color: number, f: number): number {
  const r = Math.max(0, Math.min(255, Math.round(((color >> 16) & 255) * f)));
  const g = Math.max(0, Math.min(255, Math.round(((color >> 8) & 255) * f)));
  const b = Math.max(0, Math.min(255, Math.round((color & 255) * f)));
  return (r << 16) | (g << 8) | b;
}

export function mix(a: number, b: number, t: number): number {
  const ch = (c: number, s: number) => (c >> s) & 255;
  const m = (s: number) => Math.round(ch(a, s) + (ch(b, s) - ch(a, s)) * t);
  return (m(16) << 16) | (m(8) << 8) | m(0);
}
