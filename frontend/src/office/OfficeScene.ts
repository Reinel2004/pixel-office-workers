// Phaser scene that renders the isometric office and the simulated agents.
// It never changes simulation state; it reads the engine every frame and reports clicks
// to React through the bus.

import Phaser from 'phaser';
import { AGENTS } from '../agents/roster';
import type { Bus, Insets } from '../bridge';
import type { Engine, AgentRT } from '../sim/engine';
import type { AgentId, AgentState, Selection } from '../sim/types';
import { drawFurniture, drawScreen, faceL, faceR, P, poly } from './furniture';
import { footprintDepth, fromIso, iso, shade } from './iso';
import { DOORS, FURNITURE, GRID_H, GRID_W, ROOMS, RUGS, isDoorTile, roomAt, type Furniture, type Room } from './layout';
import { buildAgentTextures, frameKey, SPRITE_H } from './sprites';

export const STATE_COLORS: Record<AgentState, number> = {
  idle: 0x9aa4b5,
  queued: 0xb79cff,
  working: 0x43d18a,
  walking: 0x5cb8ff,
  waiting: 0xffb547,
  completed: 0x5fe0d2,
  error: 0xff5d6c,
};

const LABEL_DEPTH = 100000;
const OVERLAY_DEPTH = 90000;
const FLOOR_DEPTH = -100000;

interface AgentView {
  id: AgentId;
  sprite: Phaser.GameObjects.Image;
  shadow: Phaser.GameObjects.Ellipse;
  ring: Phaser.GameObjects.Graphics;
  label: Phaser.GameObjects.Container;
  labelDot: Phaser.GameObjects.Arc;
  labelBg: Phaser.GameObjects.Graphics;
  bubble: Phaser.GameObjects.Container;
  bubbleText: Phaser.GameObjects.Text;
  bubbleBg: Phaser.GameObjects.Graphics;
  bubbleShown: string | null;
  lastState: AgentState | null;
  bubbleBorn: number;
}

export class OfficeScene extends Phaser.Scene {
  private engine!: Engine;
  private bus!: Bus;
  private views = new Map<AgentId, AgentView>();
  private screens: { f: Furniture; g: Phaser.GameObjects.Graphics; owner?: AgentId }[] = [];
  private rackLeds: { f: Furniture; g: Phaser.GameObjects.Graphics }[] = [];
  private bigScreen?: { f: Furniture; g: Phaser.GameObjects.Graphics };
  private holo?: { f: Furniture; g: Phaser.GameObjects.Graphics };
  private roomLabels: Phaser.GameObjects.Container[] = [];
  private highlight!: Phaser.GameObjects.Graphics;
  private insets: Insets = { top: 56, right: 12, bottom: 100, left: 12 };
  private selection: Selection = null;
  private bounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  private drag: { x: number; y: number; sx: number; sy: number; moved: boolean } | null = null;
  private pinch: { dist: number; zoom: number } | null = null;
  private ambientT = 0;
  private screenT = 0;
  private unsubs: (() => void)[] = [];
  private zoomTween?: Phaser.Tweens.Tween;

  constructor() {
    super('office');
  }

  init(data: { engine: Engine; bus: Bus; insets?: Insets }) {
    this.engine = data.engine;
    this.bus = data.bus;
    if (data.insets) this.insets = data.insets;
  }

  create() {
    const cam = this.cameras.main;
    this.input.addPointer(1);

    this.bus.emit('scene:progress', { value: 0.2 });
    this.computeBounds();
    this.drawFloors();
    this.bus.emit('scene:progress', { value: 0.45 });
    this.drawWalls();
    this.drawFurnitureAll();
    this.drawRoomLabels();
    this.bus.emit('scene:progress', { value: 0.7 });
    for (const a of AGENTS) buildAgentTextures(this, a);
    for (const a of this.engine.agents) this.createAgentView(a);
    this.highlight = this.add.graphics().setDepth(OVERLAY_DEPTH);

    this.setupInput();
    this.unsubs.push(
      this.bus.on('camera:zoom', ({ factor }) => this.zoomAt(factor, cam.width / 2, cam.height / 2, true)),
      this.bus.on('camera:reset', ({ animate, initial }) => this.fit(animate, initial ? 'initial' : 'all')),
      this.bus.on('camera:insets', (ins) => {
        this.insets = ins;
      }),
      this.bus.on('camera:focusAgent', ({ id }) => this.focusAgent(id)),
      this.bus.on('scene:selection', ({ selection }) => {
        this.selection = selection;
        this.drawHighlight();
      }),
    );
    this.scale.on('resize', this.onResize, this);
    this.events.once('shutdown', () => {
      this.unsubs.forEach((u) => u());
      this.scale.off('resize', this.onResize, this);
    });
    this.fit(false, 'initial');
    this.bus.emit('scene:progress', { value: 1 });
    this.bus.emit('scene:ready', undefined);
  }

  private lastSize = { w: 0, h: 0 };
  private onResize(size: Phaser.Structs.Size) {
    const w = size.width;
    const h = size.height;
    if (Math.abs(w - this.lastSize.w) < 2 && Math.abs(h - this.lastSize.h) < 2) return;
    // Refit only when the viewport size really changes (rotation, window resize).
    const first = this.lastSize.w === 0;
    this.lastSize = { w, h };
    if (!first) this.fit(false, 'initial');
  }

  // ------------------------------------------------------------------ static drawing
  private bakeSeq = 0;
  /**
   * Draws static art once into a texture (at 2× resolution for crisp zooming) and shows it as
   * an Image. Graphics objects are re-tessellated every frame in WebGL, so baking keeps the
   * frame rate high on phones.
   */
  private bake(draw: (g: Phaser.GameObjects.Graphics) => void, rect: { x: number; y: number; w: number; h: number }, depth: number, res = 2) {
    const g = this.make.graphics({}, false);
    draw(g);
    const key = `wad-bake-${this.bakeSeq++}`;
    if (this.textures.exists(key)) this.textures.remove(key);
    const W = Math.max(2, Math.ceil(rect.w * res));
    const H = Math.max(2, Math.ceil(rect.h * res));
    const dt = this.textures.addDynamicTexture(key, W, H);
    if (!dt) {
      g.setDepth(depth);
      this.add.existing(g);
      return g;
    }
    g.setScale(res);
    dt.draw(g, -rect.x * res, -rect.y * res);
    g.destroy();
    return this.add.image(rect.x, rect.y, key).setOrigin(0, 0).setScale(1 / res).setDepth(depth);
  }

  private footRect(x: number, y: number, w: number, d: number, up = 70, pad = 24) {
    const pts = [iso(x, y), iso(x + w, y), iso(x, y + d), iso(x + w, y + d)];
    const minX = Math.min(...pts.map((p) => p.x)) - pad;
    const maxX = Math.max(...pts.map((p) => p.x)) + pad;
    const minY = Math.min(...pts.map((p) => p.y)) - up;
    const maxY = Math.max(...pts.map((p) => p.y)) + pad;
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  private computeBounds() {
    const pts = ROOMS.flatMap((r) => [iso(r.x0, r.y0), iso(r.x1 + 1, r.y0), iso(r.x0, r.y1 + 1), iso(r.x1 + 1, r.y1 + 1)]);
    this.bounds = {
      minX: Math.min(...pts.map((p) => p.x)) - 20,
      maxX: Math.max(...pts.map((p) => p.x)) + 20,
      minY: Math.min(...pts.map((p) => p.y)) - 70,
      maxY: Math.max(...pts.map((p) => p.y)) + 20,
    };
  }

  private drawBackdrop(g: Phaser.GameObjects.Graphics) {
    // soft drop shadow under the platforms
    for (let i = 0; i < 4; i++) {
      for (const r of ROOMS) {
        const e = 0.35 + i * 0.35;
        const off = 10 + i * 3;
        poly(
          g,
          [P(r.x0 - e, r.y0 - e), P(r.x1 + 1 + e, r.y0 - e), P(r.x1 + 1 + e, r.y1 + 1 + e), P(r.x0 - e, r.y1 + 1 + e)].map((p) => ({
            x: p.x,
            y: p.y + off,
          })),
          0x05070c,
          0.09,
        );
      }
    }
  }

  private floorColor(r: Room, x: number, y: number): number {
    const c = r.floor;
    switch (r.pattern) {
      case 'check':
        return (x + y) % 2 ? shade(c, 0.95) : c;
      case 'plank':
        return Math.floor((x * 3 + (y % 2) * 2) / 2) % 3 === 0 ? shade(c, 0.94) : y % 2 ? shade(c, 0.97) : c;
      case 'carpet':
        return ((x * 7 + y * 13) % 5 === 0) ? shade(c, 0.96) : c;
      case 'dark':
        return (x + y) % 2 ? shade(c, 1.08) : c;
      case 'rubber':
        return (x + y) % 2 ? shade(c, 0.93) : c;
      case 'court':
        return c;
    }
  }

  private drawFloors() {
    const { minX, maxX, minY, maxY } = this.bounds;
    this.bake(
      (g) => {
        this.drawBackdrop(g);
        this.drawFloorArt(g);
      },
      { x: minX - 30, y: minY + 40, w: maxX - minX + 60, h: maxY - minY + 10 },
      FLOOR_DEPTH,
    );
  }

  private drawFloorArt(g: Phaser.GameObjects.Graphics) {
    const slab = 9;
    // door bridges (under rooms so platform edges overlap them nicely)
    for (const d of DOORS) {
      const ra = ROOMS.find((r) => r.id === d.a)!;
      const rb = ROOMS.find((r) => r.id === d.b)!;
      for (const [x, y] of d.tiles) {
        const c = shade(ra.pattern === 'dark' ? rb.floor : ra.floor, 0.82);
        faceL(g, y + 1, x, x + 1, -slab + 3, 0, shade(c, 0.6));
        faceR(g, x + 1, y, y + 1, -slab + 3, 0, shade(c, 0.48));
        poly(g, [P(x, y), P(x + 1, y), P(x + 1, y + 1), P(x, y + 1)], c);
      }
    }
    const sorted = ROOMS.slice().sort((a, b) => a.x0 + a.y0 - (b.x0 + b.y0));
    for (const r of sorted) {
      // platform edges
      faceL(g, r.y1 + 1, r.x0, r.x1 + 1, -slab, 0, shade(r.floor, 0.58));
      faceR(g, r.x1 + 1, r.y0, r.y1 + 1, -slab, 0, shade(r.floor, 0.44));
      faceL(g, r.y1 + 1, r.x0, r.x1 + 1, -1.5, 0, shade(r.floor, 1.12));
      // tiles
      for (let y = r.y0; y <= r.y1; y++)
        for (let x = r.x0; x <= r.x1; x++) poly(g, [P(x, y), P(x + 1, y), P(x + 1, y + 1), P(x, y + 1)], this.floorColor(r, x, y));
      // tile seams
      g.lineStyle(1, r.pattern === 'dark' ? 0x58e0f0 : shade(r.floor, 0.86), r.pattern === 'dark' ? 0.1 : 0.45);
      for (let x = r.x0 + 1; x <= r.x1; x++) {
        const a = P(x, r.y0);
        const b = P(x, r.y1 + 1);
        g.lineBetween(a.x, a.y, b.x, b.y);
      }
      for (let y = r.y0 + 1; y <= r.y1; y++) {
        const a = P(r.x0, y);
        const b = P(r.x1 + 1, y);
        g.lineBetween(a.x, a.y, b.x, b.y);
      }
      if (r.pattern === 'court') this.drawCourtLines(g, r);
      if (r.id === 'command') {
        const c = P(18.5, 18.5);
        g.lineStyle(2, 0x58e0f0, 0.25);
        g.strokeEllipse(c.x, c.y, 240, 120);
        g.lineStyle(1, 0x58e0f0, 0.15);
        g.strokeEllipse(c.x, c.y, 300, 150);
      }
    }
    for (const rug of RUGS) {
      poly(g, [P(rug.x, rug.y), P(rug.x + rug.w, rug.y), P(rug.x + rug.w, rug.y + rug.d), P(rug.x, rug.y + rug.d)], rug.color, 0.9);
      g.lineStyle(1.5, shade(rug.color, 1.25), 0.6);
      const i = 0.18;
      const pts = [P(rug.x + i, rug.y + i), P(rug.x + rug.w - i, rug.y + i), P(rug.x + rug.w - i, rug.y + rug.d - i), P(rug.x + i, rug.y + rug.d - i)];
      g.strokePoints(pts as Phaser.Types.Math.Vector2Like[], true);
    }
  }

  private drawCourtLines(g: Phaser.GameObjects.Graphics, r: Room) {
    g.lineStyle(2, 0xffffff, 0.8);
    const i = 0.6;
    const pts = [P(r.x0 + i, r.y0 + i), P(r.x1 + 1 - i, r.y0 + i), P(r.x1 + 1 - i, r.y1 + 1 - i), P(r.x0 + i, r.y1 + 1 - i)];
    g.strokePoints(pts as Phaser.Types.Math.Vector2Like[], true);
    const midY = (r.y0 + r.y1 + 1) / 2;
    const a = P(r.x0 + i, midY);
    const b = P(r.x1 + 1 - i, midY);
    g.lineBetween(a.x, a.y, b.x, b.y);
    poly(g, [P(r.x0 + 3.5, r.y0 + 0.6), P(r.x1 - 2.5, r.y0 + 0.6), P(r.x1 - 2.5, r.y0 + 2.4), P(r.x0 + 3.5, r.y0 + 2.4)], 0x3b70b0, 0.7);
  }

  private drawWalls() {
    const H = 17;
    const CH = 4; // tiles per baked wall chunk
    for (const r of ROOMS) {
      const glass = r.wall;
      const glassAlpha = r.id === 'command' ? 0.22 : 0.3;
      // back edge along gy = y0 (wall runs along +gx)
      for (let c0 = r.x0; c0 <= r.x1; c0 += CH) {
        const c1 = Math.min(r.x1, c0 + CH - 1);
        this.bake(
          (g) => {
            for (let x = c0; x <= c1; x++) {
              if (isDoorTile(x, r.y0 - 1)) continue;
              faceL(g, r.y0, x, x + 1, 0, H, glass, glassAlpha);
              g.lineStyle(2, glass, 0.95);
              const a = P(x, r.y0, H);
              const b = P(x + 1, r.y0, H);
              g.lineBetween(a.x, a.y, b.x, b.y);
              g.lineStyle(1, shade(glass, 0.8), 0.6);
              const c = P(x, r.y0, 0.5);
              const d = P(x + 1, r.y0, 0.5);
              g.lineBetween(c.x, c.y, d.x, d.y);
              if (x === r.x0 || isDoorTile(x - 1, r.y0 - 1)) this.post(g, x, r.y0, H, glass);
              if (isDoorTile(x + 1, r.y0 - 1)) this.post(g, x + 1, r.y0, H, glass);
            }
            if (c1 === r.x1) this.post(g, r.x1 + 1, r.y0, H, glass);
          },
          this.footRect(c0, r.y0, c1 - c0 + 1, 0.01, 30, 6),
          c0 + r.y0 - 0.5,
        );
      }
      // back edge along gx = x0 (wall runs along +gy)
      for (let c0 = r.y0; c0 <= r.y1; c0 += CH) {
        const c1 = Math.min(r.y1, c0 + CH - 1);
        this.bake(
          (g) => {
            for (let y = c0; y <= c1; y++) {
              if (isDoorTile(r.x0 - 1, y)) continue;
              faceR(g, r.x0, y, y + 1, 0, H, glass, glassAlpha * 0.85);
              g.lineStyle(2, glass, 0.95);
              const a = P(r.x0, y, H);
              const b = P(r.x0, y + 1, H);
              g.lineBetween(a.x, a.y, b.x, b.y);
              if (isDoorTile(r.x0 - 1, y - 1)) this.post(g, r.x0, y, H, glass);
              if (isDoorTile(r.x0 - 1, y + 1)) this.post(g, r.x0, y + 1, H, glass);
            }
            if (c1 === r.y1) this.post(g, r.x0, r.y1 + 1, H, glass);
          },
          this.footRect(r.x0, c0, 0.01, c1 - c0 + 1, 30, 6),
          r.x0 + c0 - 0.5,
        );
      }
    }
  }

  private post(g: Phaser.GameObjects.Graphics, x: number, y: number, h: number, color: number) {
    const a = P(x, y, 0);
    const b = P(x, y, h + 1);
    g.lineStyle(3, shade(color, 0.9), 1);
    g.lineBetween(a.x, a.y, b.x, b.y);
  }

  private drawFurnitureAll() {
    for (const f of FURNITURE) {
      let depth = footprintDepth(f.x, f.y, f.w, f.d);
      if (f.wall) depth = f.x + f.y - 0.4;
      if (f.kind === 'chair') depth = f.x + f.y + 0.9; // just behind the seated agent (x+y+1)
      const big = f.kind === 'meetingTable' ? 60 : 0;
      this.bake((g) => drawFurniture(g, f), this.footRect(f.x, f.y, f.w, f.d, 80, 30 + big), depth);
      if (f.kind === 'desk') {
        const s = this.add.graphics().setDepth(depth + 0.01);
        drawScreen(s, f, 0, 0, 0x5cb8ff);
        this.screens.push({ f, g: s, owner: f.owner });
      }
      if (f.kind === 'rack') this.rackLeds.push({ f, g: this.add.graphics().setDepth(depth + 0.01) });
      if (f.kind === 'bigScreen') this.bigScreen = { f, g: this.add.graphics().setDepth(depth + 0.01) };
      if (f.kind === 'holoTable') this.holo = { f, g: this.add.graphics().setDepth(depth + 0.01) };
    }
  }

  private drawRoomLabels() {
    for (const r of ROOMS) {
      // Labels float just above each room's back corner, clear of the desks below.
      const p = P(r.x0 + 0.5, r.y0 + 0.5, 24);
      const t = this.add
        .text(0, 0, r.name.toUpperCase(), {
          fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
          fontSize: '10px',
          fontStyle: '700',
          color: '#e9eef7',
          letterSpacing: 0.8,
          resolution: 3,
        } as Phaser.Types.GameObjects.Text.TextStyle)
        .setOrigin(0, 0.5);
      const w = t.width + 22;
      const bg = this.add.graphics();
      bg.fillStyle(0x0d111b, 0.88);
      bg.fillRoundedRect(-6, -9, w, 18, 5);
      bg.lineStyle(1, r.wall, 0.45);
      bg.strokeRoundedRect(-6, -9, w, 18, 5);
      bg.fillStyle(r.pattern === 'dark' ? 0x58e0f0 : r.floor, 1);
      bg.fillCircle(2, 0, 3.5);
      t.setX(10);
      const c = this.add.container(p.x - 4, p.y, [bg, t]).setDepth(LABEL_DEPTH - 1);
      c.setData('room', r.id);
      this.roomLabels.push(c);
    }
  }

  // ------------------------------------------------------------------ agents
  private createAgentView(a: AgentRT) {
    const shadow = this.add.ellipse(0, 0, 22, 9, 0x000000, 0.28);
    const ring = this.add.graphics();
    const sprite = this.add.image(0, 0, frameKey(a.id, 'back', 0)).setOrigin(0.5, 1);
    const text = this.add
      .text(0, 0, a.def.name, {
        fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        fontSize: '11px',
        fontStyle: '600',
        color: '#f1f5fb',
        resolution: 3,
      })
      .setOrigin(0, 0.5);
    const w = text.width + 20;
    const labelBg = this.add.graphics();
    labelBg.fillStyle(0x0b0f18, 0.9);
    labelBg.fillRoundedRect(-w / 2, -8, w, 16, 4);
    text.setX(-w / 2 + 14);
    const labelDot = this.add.circle(-w / 2 + 7.5, 0, 3, STATE_COLORS.idle);
    const label = this.add.container(0, 0, [labelBg, labelDot, text]).setDepth(LABEL_DEPTH);

    const bubbleBg = this.add.graphics();
    const bubbleText = this.add
      .text(0, 0, '', {
        fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        fontSize: '11px',
        fontStyle: '600',
        color: '#1b2030',
        resolution: 3,
      })
      .setOrigin(0.5, 1);
    const bubble = this.add.container(0, 0, [bubbleBg, bubbleText]).setDepth(LABEL_DEPTH + 1).setVisible(false);

    this.views.set(a.id, {
      id: a.id,
      sprite,
      shadow,
      ring,
      label,
      labelDot,
      labelBg,
      bubble,
      bubbleText,
      bubbleBg,
      bubbleShown: null,
      lastState: null,
      bubbleBorn: 0,
    });
  }

  private labelScale(): number {
    return Phaser.Math.Clamp(0.9 / this.cameras.main.zoom, 0.55, 2);
  }

  private lastWall = 0;
  update(time: number) {
    // Use real elapsed time: Phaser's smoothed delta lags behind on slow devices,
    // which would make the simulation run in slow motion.
    const wall = performance.now();
    const delta = this.lastWall ? Math.min(250, wall - this.lastWall) : 16;
    this.lastWall = wall;
    this.engine.tick(delta);
    const reduced = this.engine.settings.reducedMotion;
    const paused = this.engine.paused;
    const k = this.labelScale();
    const showLabels = this.engine.settings.labels;

    const rk = Phaser.Math.Clamp(0.8 / this.cameras.main.zoom, 0.6, 1.8);
    for (const c of this.roomLabels) c.setScale(rk);

    for (const a of this.engine.agents) {
      const v = this.views.get(a.id)!;
      const state = this.engine.agentState(a);
      const p = iso(a.x + 0.5, a.y + 0.5);
      const front = a.dir[0] === 'f';
      const flip = a.dir[1] === 'l';
      const walking = a.path.length > 0;
      let key: string;
      let lift = 0;
      if (walking) {
        const f = reduced ? 0 : Math.floor(a.stepPhase * 4) % 4;
        const frame = f === 1 ? 1 : f === 3 ? 2 : 0;
        key = frameKey(a.id, front ? 'front' : 'back', frame);
        if (!reduced && (f === 1 || f === 3)) lift = 1;
      } else if (a.posture === 'sit') {
        const typing = a.action === 'work' && !reduced && !paused;
        key = frameKey(a.id, 'sit', typing ? Math.floor(time / 180) % 2 : 0);
      } else {
        key = frameKey(a.id, front ? 'front' : 'back', 0);
      }
      if (v.sprite.texture.key !== key) v.sprite.setTexture(key);
      // Seated agents face the desk (back view); keep their flip stable.
      v.sprite.setFlipX(a.posture === 'sit' && !walking ? false : flip);

      let bob = 0;
      if (!reduced && !paused && !walking) {
        if (a.action === 'work' && a.posture !== 'sit') bob = Math.sin(time / 160) > 0.6 ? 1 : 0;
        if (a.action === 'talk') bob = Math.sin(time / 120) > 0 ? 1 : 0;
        if (a.posture === 'sit' && a.action === 'work') bob = Math.sin(time / 260) > 0.3 ? 0.5 : 0;
      }
      const footY = p.y + 3 - (a.posture === 'sit' && !walking ? 5 : 0);
      v.sprite.setPosition(Math.round(p.x), Math.round(footY - lift - bob));
      const depth = a.x + a.y + 1;
      v.sprite.setDepth(depth);
      v.shadow.setPosition(p.x, p.y + 2).setDepth(depth - 0.05);
      v.shadow.setVisible(!(a.posture === 'sit' && !walking));

      // selection ring
      v.ring.clear();
      if (this.selection?.kind === 'agent' && this.selection.id === a.id) {
        const pulse = reduced ? 0.8 : 0.55 + 0.35 * Math.sin(time / 220);
        v.ring.lineStyle(2, 0xffd166, pulse);
        v.ring.strokeEllipse(p.x, p.y + 2, 34, 15);
        v.ring.setDepth(depth - 0.04);
      }

      // label
      const top = footY - SPRITE_H + 4;
      v.label.setVisible(showLabels || (this.selection?.kind === 'agent' && this.selection.id === a.id));
      v.label.setScale(k);
      v.label.setPosition(p.x, top - 9 * k);
      if (v.lastState !== state) {
        v.labelDot.setFillStyle(STATE_COLORS[state]);
        v.lastState = state;
      }
      if (state === 'waiting' || state === 'error' || state === 'queued') v.labelDot.setAlpha(reduced ? 1 : 0.55 + 0.45 * Math.abs(Math.sin(time / 300)));
      else v.labelDot.setAlpha(1);

      // speech bubble
      const text = a.bubble?.text ?? null;
      if (text !== v.bubbleShown) {
        v.bubbleShown = text;
        v.bubbleBorn = time;
        if (text) {
          v.bubbleText.setText(text);
          const bw = v.bubbleText.width + 14;
          const bh = v.bubbleText.height + 8;
          v.bubbleBg.clear();
          v.bubbleBg.fillStyle(0x000000, 0.25);
          v.bubbleBg.fillRoundedRect(-bw / 2 + 1, -bh - 4, bw, bh, 7);
          v.bubbleBg.fillStyle(0xffffff, 1);
          v.bubbleBg.fillRoundedRect(-bw / 2, -bh - 6, bw, bh, 7);
          v.bubbleBg.fillTriangle(-4, -6.5, 4, -6.5, 0, -1);
          v.bubbleText.setPosition(0, -10);
        }
        v.bubble.setVisible(!!text);
      }
      if (text) {
        const age = time - v.bubbleBorn;
        const pop = reduced ? 1 : Math.min(1, 0.6 + age / 250);
        v.bubble.setScale(k * pop);
        v.bubble.setPosition(p.x, top - (showLabels ? 18 : 6) * k);
      }
    }

    // monitors
    this.screenT += delta;
    if (this.screenT > 260) {
      this.screenT = 0;
      for (const s of this.screens) {
        const owner = s.owner ? this.engine.agentById[s.owner] : null;
        const busy = !!owner && owner.action === 'work' && owner.posture === 'sit' && !owner.path.length;
        const seed = paused || reduced ? 3 : Math.floor(time / 260);
        const accent = owner ? Phaser.Display.Color.HexStringToColor(owner.def.look.shirt).color : 0x5cb8ff;
        drawScreen(s.g, s.f, busy ? 1 : 0, seed + (s.f.x * 3 + s.f.y), accent);
      }
    }

    // ambient decor (server LEDs, command screen, hologram) — not agent activity
    this.ambientT += delta;
    if (this.ambientT > 420 || this.ambientT === delta) {
      this.ambientT = 0;
      this.drawAmbient(time, reduced || paused);
    }
  }

  private drawAmbient(time: number, still: boolean) {
    const seed = still ? 1 : Math.floor(time / 420);
    for (const { f, g } of this.rackLeds) {
      g.clear();
      for (let i = 0; i < 6; i++)
        for (let j = 0; j < 3; j++) {
          const on = Math.sin(seed * 3.1 + f.x * 7 + i * 1.9 + j * 4.3) > -0.2;
          const col = (i + j + f.x) % 5 === 0 ? 0xffb547 : 0x5fe0d2;
          faceL(g, f.y + 0.86, f.x + 0.22 + j * 0.12, f.x + 0.28 + j * 0.12, 6 + i * 6.3, 7.4 + i * 6.3, on ? col : 0x2a3344);
        }
    }
    if (this.bigScreen) {
      const { f, g } = this.bigScreen;
      g.clear();
      const active = this.engine.tasks.filter((t) => t.status === 'running' || t.status === 'queued').length;
      const waiting = this.engine.tasks.filter((t) => t.status === 'awaiting_approval').length;
      const done = this.engine.tasks.filter((t) => t.status === 'completed').length;
      const vals = [active, waiting, Math.min(done, 6), this.engine.activeCount()];
      const cols = [0x5cb8ff, 0xffb547, 0x43d18a, 0x5fe0d2];
      vals.forEach((v, i) => {
        const a = f.x + 0.25 + i * 0.65;
        const h = 2 + Math.min(v, 6) * 3;
        faceL(g, f.y + 0.04, a, a + 0.4, 10, 10 + h, cols[i], 0.95);
      });
      const wave = still ? 0 : time / 600;
      for (let i = 0; i < 10; i++) {
        const a = f.x + 0.2 + i * 0.26;
        const z = 27 + Math.sin(wave + i * 0.8) * 2;
        faceL(g, f.y + 0.04, a, a + 0.2, z, z + 1, 0x58e0f0, 0.8);
      }
    }
    if (this.holo) {
      const { f, g } = this.holo;
      g.clear();
      const c = P(f.x + f.w / 2, f.y + f.d / 2, 14);
      const t = still ? 0 : time / 500;
      g.fillStyle(0x5fe0d2, 0.1);
      g.fillTriangle(c.x - 18, c.y, c.x + 18, c.y, c.x, c.y - 34);
      g.lineStyle(1.5, 0x8ff5ea, 0.8);
      g.strokeEllipse(c.x, c.y - 14 - Math.sin(t) * 3, 26 + Math.cos(t) * 6, 9);
      g.strokeEllipse(c.x, c.y - 24 + Math.sin(t) * 2, 16, 6);
    }
  }

  // ------------------------------------------------------------------ selection overlay
  private drawHighlight() {
    const g = this.highlight;
    g.clear();
    if (this.selection?.kind !== 'room') return;
    const r = ROOMS.find((x) => x.id === (this.selection as { id: string }).id);
    if (!r) return;
    const pts = [P(r.x0, r.y0), P(r.x1 + 1, r.y0), P(r.x1 + 1, r.y1 + 1), P(r.x0, r.y1 + 1)];
    poly(g, pts, 0xffd166, 0.08);
    g.lineStyle(2.5, 0xffd166, 0.95);
    g.strokePoints(pts as Phaser.Types.Math.Vector2Like[], true);
  }

  // ------------------------------------------------------------------ camera
  /**
   * mode 'all' fits the whole office. 'initial' does the same on wide screens, but on narrow
   * portrait phones it starts closer (the wide diamond would be tiny) — users pinch/pan from there.
   */
  private fit(animate: boolean, mode: 'all' | 'initial' = 'all') {
    const cam = this.cameras.main;
    const { minX, maxX, minY, maxY } = this.bounds;
    const ins = this.insets;
    const availW = Math.max(120, cam.width - ins.left - ins.right);
    const availH = Math.max(120, cam.height - ins.top - ins.bottom);
    let zoom = Phaser.Math.Clamp(Math.min(availW / (maxX - minX), availH / (maxY - minY)), 0.2, 3);
    if (mode === 'initial' && availW < 620 && availH > availW) zoom = Math.min(zoom * 1.9, availH / (maxY - minY));
    const cx = (minX + maxX) / 2 - (ins.left - ins.right) / 2 / zoom;
    const cy = (minY + maxY) / 2 - (ins.top - ins.bottom) / 2 / zoom;
    this.zoomTween?.stop();
    if (animate && !this.engine.settings.reducedMotion) {
      const from = { z: cam.zoom, x: cam.midPoint.x, y: cam.midPoint.y };
      this.zoomTween = this.tweens.addCounter({
        from: 0,
        to: 1,
        duration: 380,
        ease: 'Cubic.easeOut',
        onUpdate: (tw) => {
          const t = tw.getValue() ?? 1;
          cam.setZoom(from.z + (zoom - from.z) * t);
          cam.centerOn(from.x + (cx - from.x) * t, from.y + (cy - from.y) * t);
          this.bus.emit('scene:zoom', { zoom: cam.zoom });
        },
      });
    } else {
      cam.setZoom(zoom);
      cam.centerOn(cx, cy);
      this.bus.emit('scene:zoom', { zoom });
    }
  }

  private focusAgent(id: AgentId) {
    const a = this.engine.agentById[id];
    const cam = this.cameras.main;
    const p = iso(a.x + 0.5, a.y + 0.5);
    const zoom = Math.max(cam.zoom, 1.3);
    const target = { x: p.x, y: p.y - 20 };
    this.zoomTween?.stop();
    if (this.engine.settings.reducedMotion) {
      cam.setZoom(zoom);
      cam.centerOn(target.x, target.y);
    } else {
      const from = { z: cam.zoom, x: cam.midPoint.x, y: cam.midPoint.y };
      this.zoomTween = this.tweens.addCounter({
        from: 0,
        to: 1,
        duration: 420,
        ease: 'Cubic.easeOut',
        onUpdate: (tw) => {
          const t = tw.getValue() ?? 1;
          cam.setZoom(from.z + (zoom - from.z) * t);
          cam.centerOn(from.x + (target.x - from.x) * t, from.y + (target.y - from.y) * t);
        },
      });
    }
    this.bus.emit('scene:zoom', { zoom });
  }

  private zoomAt(factor: number, sx: number, sy: number, animate = false) {
    const cam = this.cameras.main;
    const z0 = cam.zoom;
    const z1 = Phaser.Math.Clamp(z0 * factor, 0.25, 4);
    const wx = cam.scrollX + cam.width / 2 + (sx - cam.width / 2) / z0;
    const wy = cam.scrollY + cam.height / 2 + (sy - cam.height / 2) / z0;
    const apply = (z: number) => {
      cam.setZoom(z);
      cam.scrollX = wx - cam.width / 2 - (sx - cam.width / 2) / z;
      cam.scrollY = wy - cam.height / 2 - (sy - cam.height / 2) / z;
      this.clampCamera();
    };
    this.zoomTween?.stop();
    if (animate && !this.engine.settings.reducedMotion) {
      this.zoomTween = this.tweens.addCounter({
        from: z0,
        to: z1,
        duration: 180,
        ease: 'Sine.easeOut',
        onUpdate: (tw) => apply(tw.getValue() ?? z1),
      });
    } else apply(z1);
    this.bus.emit('scene:zoom', { zoom: z1 });
  }

  private clampCamera() {
    const cam = this.cameras.main;
    const { minX, maxX, minY, maxY } = this.bounds;
    const mx = cam.scrollX + cam.width / 2;
    const my = cam.scrollY + cam.height / 2;
    const cx = Phaser.Math.Clamp(mx, minX, maxX);
    const cy = Phaser.Math.Clamp(my, minY, maxY);
    cam.scrollX += cx - mx;
    cam.scrollY += cy - my;
  }

  // ------------------------------------------------------------------ input
  private setupInput() {
    const cam = this.cameras.main;
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      const touching = [this.input.pointer1, this.input.pointer2].filter((q) => q && q.isDown);
      if (touching.length >= 2) {
        const [a, b] = touching;
        this.pinch = { dist: Phaser.Math.Distance.Between(a.x, a.y, b.x, b.y), zoom: cam.zoom };
        this.drag = null;
        return;
      }
      this.zoomTween?.stop();
      this.drag = { x: p.x, y: p.y, sx: cam.scrollX, sy: cam.scrollY, moved: false };
    });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (this.pinch) {
        const a = this.input.pointer1;
        const b = this.input.pointer2;
        if (a.isDown && b.isDown) {
          const d = Phaser.Math.Distance.Between(a.x, a.y, b.x, b.y);
          const target = Phaser.Math.Clamp((this.pinch.zoom * d) / Math.max(1, this.pinch.dist), 0.25, 4);
          this.zoomAt(target / cam.zoom, (a.x + b.x) / 2, (a.y + b.y) / 2);
        }
        return;
      }
      if (this.drag && p.isDown) {
        const dx = p.x - this.drag.x;
        const dy = p.y - this.drag.y;
        if (!this.drag.moved && Math.hypot(dx, dy) > 6) this.drag.moved = true;
        if (this.drag.moved) {
          cam.scrollX = this.drag.sx - dx / cam.zoom;
          cam.scrollY = this.drag.sy - dy / cam.zoom;
          this.clampCamera();
          this.input.setDefaultCursor('grabbing');
        }
        return;
      }
      if (!p.isDown) {
        const hit = this.pickAgent(p.worldX, p.worldY);
        this.input.setDefaultCursor(hit ? 'pointer' : 'grab');
      }
    });
    this.input.on('pointerup', (p: Phaser.Input.Pointer) => {
      if (this.pinch) {
        if (!this.input.pointer1.isDown || !this.input.pointer2.isDown) this.pinch = null;
        this.drag = null;
        return;
      }
      const d = this.drag;
      this.drag = null;
      this.input.setDefaultCursor('grab');
      if (d && d.moved) return;
      const w = cam.getWorldPoint(p.x, p.y);
      const agent = this.pickAgent(w.x, w.y);
      if (agent) {
        this.bus.emit('scene:pick', { kind: 'agent', id: agent });
        return;
      }
      const label = this.roomLabels.find((c) => {
        const b = c.getBounds();
        return b.contains(w.x, w.y);
      });
      if (label) {
        this.bus.emit('scene:pick', { kind: 'room', id: label.getData('room') });
        return;
      }
      const g = fromIso(w.x, w.y);
      const room = roomAt(g.gx, g.gy);
      this.bus.emit('scene:pick', room ? { kind: 'room', id: room } : { kind: 'none' });
    });
    this.input.on('wheel', (p: Phaser.Input.Pointer, _o: unknown, _dx: number, dy: number) => {
      this.zoomAt(dy > 0 ? 0.9 : 1.1, p.x, p.y);
    });
    this.input.setDefaultCursor('grab');
  }

  private pickAgent(wx: number, wy: number): AgentId | null {
    let best: { id: AgentId; depth: number } | null = null;
    const k = this.labelScale();
    for (const v of this.views.values()) {
      const s = v.sprite;
      const inSprite = wx >= s.x - 13 && wx <= s.x + 13 && wy >= s.y - s.height + 2 && wy <= s.y + 4;
      const lb = v.label.visible ? v.label.getBounds() : null;
      const inLabel = !!lb && lb.contains(wx, wy);
      if ((inSprite || inLabel) && (!best || s.depth + (inLabel ? 1000 : 0) > best.depth)) best = { id: v.id, depth: s.depth + (inLabel ? 1000 : 0) };
    }
    void k;
    return best?.id ?? null;
  }
}

export const WORLD_SIZE = { w: GRID_W, h: GRID_H };
