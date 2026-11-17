import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Bus, Insets } from '../bridge';
import type { Engine } from '../sim/engine';
import type { AgentId, AgentState, Dir, RoomId, Selection } from '../sim/types';
import type { Look } from '../agents/roster';
import { DOORS, FURNITURE, GRID_H, GRID_W, ROOMS, RUGS, isDoorTile, type Room } from './layout';
import { buildFurniture, mat, type FurnitureHooks } from './furniture3d';

interface Props {
  engine: Engine;
  bus: Bus;
  insets: Insets;
}

const STATE_COLORS: Record<AgentState, string> = {
  idle: '#8fa3c7',
  queued: '#f5c542',
  working: '#4ade80',
  walking: '#8fa3c7',
  waiting: '#ffb020',
  completed: '#34d399',
  error: '#ff5d5d',
};

const DIR_VEC: Record<Dir, [number, number]> = { fl: [0, 1], fr: [1, 0], bl: [-1, 0], br: [0, -1] };

/** Anything that walks around: the 18 agents and the workshop carpenters. */
interface Actor {
  id: string;
  def: { name: string; look: Look };
  x: number;
  y: number;
  dir: Dir;
  face: { x: number; y: number } | null;
  posture?: 'stand' | 'sit';
  action: 'none' | 'walk' | 'work' | 'talk' | 'jog' | 'exercise';
  path: unknown[];
  stepPhase: number;
  bubble: { text: string; until: number } | null;
}

interface ActorView {
  root: THREE.Group;
  body: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  label: THREE.Sprite;
  labelKey: string;
  bubble: THREE.Sprite;
  bubbleText: string;
  ring: THREE.Mesh;
  yaw: number;
  dumbL: THREE.Group;
  dumbR: THREE.Group;
  mug: THREE.Group;
  snack: THREE.Group;
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function textSprite(text: string, opts: { dot?: string; bg?: string; fg?: string; border?: string; font?: number; unit?: number }): THREE.Sprite {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthTest: false, depthWrite: false }));
  s.renderOrder = 20;
  setSpriteText(s, text, opts);
  return s;
}

function setSpriteText(s: THREE.Sprite, text: string, opts: { dot?: string; bg?: string; fg?: string; border?: string; font?: number; unit?: number }) {
  const font = opts.font ?? 26;
  const cv = document.createElement('canvas');
  const c = cv.getContext('2d')!;
  c.font = `600 ${font}px Inter, system-ui, sans-serif`;
  const tw = Math.ceil(c.measureText(text).width);
  const pad = 16;
  const dot = opts.dot ? font * 0.8 : 0;
  const w = tw + pad * 2 + dot;
  const h = font + 20;
  cv.width = w;
  cv.height = h;
  const c2 = cv.getContext('2d')!;
  c2.font = `600 ${font}px Inter, system-ui, sans-serif`;
  c2.textBaseline = 'middle';
  roundRect(c2, 1, 1, w - 2, h - 2, 12);
  c2.fillStyle = opts.bg ?? 'rgba(12,18,30,0.82)';
  c2.fill();
  if (opts.border) {
    c2.strokeStyle = opts.border;
    c2.lineWidth = 2;
    c2.stroke();
  }
  let tx = pad;
  if (opts.dot) {
    c2.fillStyle = opts.dot;
    c2.beginPath();
    c2.arc(pad + font * 0.25, h / 2, font * 0.28, 0, Math.PI * 2);
    c2.fill();
    tx += dot;
  }
  c2.fillStyle = opts.fg ?? '#ffffff';
  c2.fillText(text, tx, h / 2 + 1);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  const m = s.material as THREE.SpriteMaterial;
  m.map?.dispose();
  m.map = tex;
  m.needsUpdate = true;
  const unit = (opts as { unit?: number }).unit ?? 0.0125;
  s.scale.set(w * unit, h * unit, 1);
}

function floorTexture(room: Room): THREE.Texture | null {
  const w = room.x1 - room.x0 + 1;
  const h = room.y1 - room.y0 + 1;
  const size = 64;
  const cv = document.createElement('canvas');
  cv.width = size * 2;
  cv.height = size * 2;
  const c = cv.getContext('2d')!;
  const base = new THREE.Color(room.floor);
  const light = base.clone().multiplyScalar(1.08).getStyle();
  const dark = base.clone().multiplyScalar(0.94).getStyle();
  const p = room.pattern;
  if (p === 'check') {
    c.fillStyle = light;
    c.fillRect(0, 0, size * 2, size * 2);
    c.fillStyle = dark;
    c.fillRect(0, 0, size, size);
    c.fillRect(size, size, size, size);
  } else if (p === 'plank') {
    c.fillStyle = base.getStyle();
    c.fillRect(0, 0, size * 2, size * 2);
    for (let i = 0; i < 4; i++) {
      c.fillStyle = i % 2 ? light : dark;
      c.fillRect(0, i * (size / 2), size * 2, size / 2 - 2);
    }
  } else if (p === 'carpet') {
    c.fillStyle = base.getStyle();
    c.fillRect(0, 0, size * 2, size * 2);
    for (let i = 0; i < 260; i++) {
      c.fillStyle = Math.random() > 0.5 ? light : dark;
      c.fillRect(Math.random() * size * 2, Math.random() * size * 2, 3, 3);
    }
  } else if (p === 'concrete' || p === 'rubber') {
    c.fillStyle = base.getStyle();
    c.fillRect(0, 0, size * 2, size * 2);
    for (let i = 0; i < 120; i++) {
      c.fillStyle = Math.random() > 0.5 ? light : dark;
      c.fillRect(Math.random() * size * 2, Math.random() * size * 2, 2, 2);
    }
    c.strokeStyle = dark;
    c.strokeRect(0, 0, size * 2, size * 2);
  } else {
    return null;
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(w / 2, h / 2);
  tex.anisotropy = 4;
  return tex;
}

function makeActor(a: Actor): ActorView {
  const look = a.def.look;
  const skin = mat(new THREE.Color(look.skin).getHex());
  const shirt = mat(new THREE.Color(look.shirt).getHex());
  const pants = mat(new THREE.Color(look.pants).getHex());
  const hair = mat(new THREE.Color(look.hair).getHex());
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const part = (g: THREE.Object3D, geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    g.add(mesh);
    return mesh;
  };

  const mkLeg = (x: number) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.5, 0);
    part(pivot, new THREE.BoxGeometry(0.15, 0.5, 0.16), pants, 0, -0.25, 0);
    part(pivot, new THREE.BoxGeometry(0.16, 0.07, 0.24), mat(0x23262d), 0, -0.5, 0.04);
    body.add(pivot);
    return pivot;
  };
  const legL = mkLeg(-0.1);
  const legR = mkLeg(0.1);

  part(body, new THREE.BoxGeometry(0.42, 0.5, 0.24), shirt, 0, 0.78, 0);

  const mkArm = (x: number) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, 1.0, 0);
    part(pivot, new THREE.BoxGeometry(0.11, 0.42, 0.12), shirt, 0, -0.2, 0);
    part(pivot, new THREE.SphereGeometry(0.06, 10, 8), skin, 0, -0.44, 0);
    body.add(pivot);
    return pivot;
  };
  const armL = mkArm(-0.28);
  const armR = mkArm(0.28);

  const mkDumb = (arm: THREE.Group) => {
    const g = new THREE.Group();
    g.position.set(0, -0.46, 0.03);
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.3, 8), mat(0xc7ccd4, { metal: 0.8 }));
    bar.rotation.z = Math.PI / 2;
    g.add(bar);
    for (const sx of [-0.13, 0.13]) {
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.05, 14), mat(0x1b1f26));
      disc.rotation.z = Math.PI / 2;
      disc.position.x = sx;
      g.add(disc);
    }
    g.visible = false;
    arm.add(g);
    return g;
  };
  const dumbL = mkDumb(armL);
  const dumbR = mkDumb(armR);
  const mug = new THREE.Group();
  mug.position.set(0, -0.5, 0.06);
  mug.add(new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.04, 0.09, 12), mat(0xf4f4f0)));
  const coffee = new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.038, 0.01, 12), mat(0x4a2c17));
  coffee.position.y = 0.04;
  mug.add(coffee);
  const steam = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 6), mat(0xffffff, { opacity: 0.35 }));
  steam.position.y = 0.13;
  mug.add(steam);
  mug.visible = false;
  armR.add(mug);
  const snack = new THREE.Group();
  snack.position.set(0, -0.5, 0.06);
  snack.add(new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.05, 0.07), mat(0xe8b04a)));
  snack.add(new THREE.Mesh(new THREE.BoxGeometry(0.115, 0.02, 0.075), mat(0xc0563b)));
  snack.visible = false;
  armR.add(snack);

  part(body, new THREE.SphereGeometry(0.2, 18, 14), skin, 0, 1.2, 0);
  const cap = part(body, new THREE.SphereGeometry(0.215, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), hair, 0, 1.22, -0.01);
  cap.rotation.x = -0.15;
  if (look.hairStyle === 'long') part(body, new THREE.BoxGeometry(0.4, 0.4, 0.1), hair, 0, 1.06, -0.14);
  else if (look.hairStyle === 'ponytail') part(body, new THREE.CapsuleGeometry(0.06, 0.25, 4, 8), hair, 0, 1.08, -0.2);
  else if (look.hairStyle === 'bun') part(body, new THREE.SphereGeometry(0.11, 10, 8), hair, 0, 1.45, -0.05);
  else if (look.hairStyle === 'spiky') for (let i = -1; i <= 1; i++) part(body, new THREE.ConeGeometry(0.06, 0.16, 6), hair, i * 0.1, 1.46, 0);

  // eyes
  part(body, new THREE.SphereGeometry(0.025, 6, 6), mat(0x1a1a1a), -0.07, 1.22, 0.18);
  part(body, new THREE.SphereGeometry(0.025, 6, 6), mat(0x1a1a1a), 0.07, 1.22, 0.18);

  const accent = look.accent ? new THREE.Color(look.accent).getHex() : 0xf5c518;
  switch (look.accessory) {
    case 'hardhat': {
      part(body, new THREE.SphereGeometry(0.23, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.5), mat(accent), 0, 1.28, 0);
      part(body, new THREE.CylinderGeometry(0.27, 0.27, 0.025, 20), mat(accent), 0, 1.28, 0.02);
      break;
    }
    case 'glasses': {
      part(body, new THREE.BoxGeometry(0.3, 0.07, 0.02), mat(0x1c1c24), 0, 1.22, 0.2);
      break;
    }
    case 'headset': {
      part(body, new THREE.TorusGeometry(0.21, 0.015, 6, 20, Math.PI), mat(0x20242c), 0, 1.22, 0).rotation.z = 0;
      part(body, new THREE.BoxGeometry(0.06, 0.12, 0.08), mat(0x20242c), -0.21, 1.2, 0);
      part(body, new THREE.BoxGeometry(0.06, 0.12, 0.08), mat(0x20242c), 0.21, 1.2, 0);
      break;
    }
    case 'beret': {
      part(body, new THREE.CylinderGeometry(0.2, 0.22, 0.07, 18), mat(0x9b2d3a), 0.03, 1.38, 0);
      break;
    }
    case 'tie': {
      part(body, new THREE.BoxGeometry(0.07, 0.3, 0.02), mat(accent), 0, 0.78, 0.13);
      break;
    }
    case 'hood': {
      part(body, new THREE.SphereGeometry(0.235, 14, 10, 0, Math.PI * 2, Math.PI * 0.2, Math.PI * 0.6), shirt, 0, 1.2, -0.04);
      break;
    }
    default:
      break;
  }

  const label = textSprite(a.def.name, { dot: '#8fa3c7' });
  label.position.set(0, 1.95, 0);
  root.add(label);
  const bubble = textSprite(' ', { bg: '#ffffff', fg: '#10151f', font: 24 });
  bubble.position.set(0, 2.4, 0);
  bubble.visible = false;
  root.add(bubble);

  const ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.52, 36), new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.03;
  ring.visible = false;
  root.add(ring);

  const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.3, 16), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.02;
  root.add(shadow);

  root.userData.actorId = a.id;
  root.traverse((o) => {
    o.userData.actorId = a.id;
  });
  return { root, body, legL, legR, armL, armR, label, labelKey: '', bubble, bubbleText: '', ring, yaw: 0, dumbL, dumbR, mug, snack };
}

export function Office3D({ engine, bus, insets }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const insetsRef = useRef(insets);
  insetsRef.current = insets;

  useEffect(() => {
    const el = host.current;
    if (!el) return;

    bus.emit('scene:progress', { value: 0.2 });
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.5, 600);
    const center = new THREE.Vector3(GRID_W / 2, 0, GRID_H / 2);
    const homeOffset = new THREE.Vector3(34, 60, 44);
    const homeDist = homeOffset.length();
    camera.position.copy(center).add(homeOffset);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(center);
    controls.enableDamping = true;
    controls.dampingFactor = 0.09;
    controls.maxPolarAngle = Math.PI * 0.46;
    controls.minDistance = 6;
    controls.maxDistance = 140;
    controls.screenSpacePanning = false;
    controls.update();

    // ---- lights
    scene.add(new THREE.HemisphereLight(0xdfe9ff, 0x3a3f4d, 1.05));
    const sun = new THREE.DirectionalLight(0xfff1d6, 2.2);
    sun.position.set(GRID_W / 2 - 20, 55, GRID_H / 2 + 25);
    sun.target.position.copy(center);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    const sc = sun.shadow.camera;
    sc.left = -34;
    sc.right = 34;
    sc.top = 38;
    sc.bottom = -38;
    sc.near = 5;
    sc.far = 140;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.04;
    scene.add(sun, sun.target);

    // ---- floors, walls, doors
    const world = new THREE.Group();
    scene.add(world);
    const pickables: THREE.Object3D[] = [];
    const disposables: { dispose(): void }[] = [];

    for (const r of ROOMS) {
      const w = r.x1 - r.x0 + 1;
      const d = r.y1 - r.y0 + 1;
      const tex = floorTexture(r);
      if (tex) disposables.push(tex);
      const fm = new THREE.MeshStandardMaterial({ color: tex ? 0xffffff : r.floor, map: tex, roughness: r.pattern === 'court' ? 0.45 : 0.85 });
      const floor = new THREE.Mesh(new THREE.BoxGeometry(w, 0.4, d), [mat(0x2a3040), mat(0x2a3040), fm, mat(0x1c2230), mat(0x2a3040), mat(0x2a3040)]);
      floor.position.set(r.x0 + w / 2, -0.2, r.y0 + d / 2);
      floor.receiveShadow = true;
      floor.userData.room = r.id;
      world.add(floor);
      pickables.push(floor);

      // walls: back (north) and left (west) edges only, so the view stays open
      const wallM = mat(r.wall, { rough: 0.9 });
      const trimM = mat(0xffffff, { rough: 0.6 });
      const H = 1.35;
      const addRun = (x: number, z: number, len: number, alongX: boolean) => {
        const wall = new THREE.Mesh(new THREE.BoxGeometry(alongX ? len : 0.14, H, alongX ? 0.14 : len), wallM);
        wall.position.set(alongX ? x + len / 2 : x, H / 2, alongX ? z : z + len / 2);
        wall.castShadow = true;
        wall.receiveShadow = true;
        world.add(wall);
        const trim = new THREE.Mesh(new THREE.BoxGeometry(alongX ? len : 0.2, 0.06, alongX ? 0.2 : len), trimM);
        trim.position.set(wall.position.x, H + 0.03, wall.position.z);
        world.add(trim);
      };
      let run = -1;
      for (let x = r.x0; x <= r.x1 + 1; x++) {
        const open = x > r.x1 || isDoorTile(x, r.y0 - 1);
        if (!open && run < 0) run = x;
        if (open && run >= 0) {
          addRun(run, r.y0 - 0.07, x - run, true);
          run = -1;
        }
      }
      run = -1;
      for (let y = r.y0; y <= r.y1 + 1; y++) {
        const open = y > r.y1 || isDoorTile(r.x0 - 1, y);
        if (!open && run < 0) run = y;
        if (open && run >= 0) {
          addRun(r.x0 - 0.07, run, y - run, false);
          run = -1;
        }
      }

      // room name board
      const sign = textSprite(r.name.toUpperCase(), { bg: 'rgba(10,15,26,0.7)', fg: '#' + new THREE.Color(r.wall).getHexString(), font: 30, unit: 0.02, border: 'rgba(255,255,255,0.25)' });
      sign.position.set(r.x0 + w / 2, 2.2, r.y0 + 0.3);
      sign.material.opacity = 0.9;
      sign.userData.room = r.id;
      world.add(sign);
    }

    const doorM = mat(0x8c96aa, { rough: 0.7 });
    for (const dr of DOORS) {
      for (const [tx, ty] of dr.tiles) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(1, 0.4, 1), doorM);
        m.position.set(tx + 0.5, -0.2, ty + 0.5);
        m.receiveShadow = true;
        world.add(m);
      }
    }

    for (const rg of RUGS) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(rg.w, 0.03, rg.d), mat(rg.color, { rough: 1 }));
      m.position.set(rg.x + rg.w / 2, 0.015, rg.y + rg.d / 2);
      m.receiveShadow = true;
      world.add(m);
    }

    // court markings
    {
      const r = ROOMS.find((q) => q.id === 'court')!;
      const lm = mat(0xffffff, { rough: 0.5 });
      const inset = 0.6;
      const x0 = r.x0 + inset;
      const x1 = r.x1 + 1 - inset;
      const y0 = r.y0 + inset;
      const y1 = r.y1 + 1 - inset;
      const line = (x: number, z: number, w: number, d: number) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.02, d), lm);
        m.position.set(x, 0.011, z);
        world.add(m);
      };
      line((x0 + x1) / 2, y0, x1 - x0, 0.08);
      line((x0 + x1) / 2, y1, x1 - x0, 0.08);
      line(x0, (y0 + y1) / 2, 0.08, y1 - y0);
      line(x1, (y0 + y1) / 2, 0.08, y1 - y0);
    }

    // ---- furniture
    const hooks: FurnitureHooks = { monitors: [], spinners: [] };
    for (const f of FURNITURE) {
      const g = buildFurniture(f, hooks);
      g.position.set(f.x + f.w / 2, 0, f.y + f.d / 2);
      world.add(g);
    }
    bus.emit('scene:progress', { value: 0.6 });

    // ---- actors
    const views = new Map<string, ActorView>();
    const addView = (a: Actor) => {
      const v = makeActor(a);
      views.set(a.id, v);
      scene.add(v.root);
      return v;
    };
    for (const a of engine.agents) addView(a as unknown as Actor);
    bus.emit('scene:progress', { value: 0.85 });

    // ---- selection
    let selection: Selection = null;
    const offSel = bus.on('scene:selection', ({ selection: s }) => {
      selection = s;
    });

    // ---- camera control
    let anim: { t0: number; dur: number; fromT: THREE.Vector3; toT: THREE.Vector3; fromP: THREE.Vector3; toP: THREE.Vector3 } | null = null;
    const startAnim = (toT: THREE.Vector3, toP: THREE.Vector3, animate: boolean) => {
      if (!animate || engine.settings.reducedMotion) {
        controls.target.copy(toT);
        camera.position.copy(toP);
        controls.update();
        return;
      }
      anim = { t0: performance.now(), dur: 700, fromT: controls.target.clone(), toT, fromP: camera.position.clone(), toP };
    };
    const emitZoom = () => bus.emit('scene:zoom', { zoom: homeDist / camera.position.distanceTo(controls.target) });
    const offZoom = bus.on('camera:zoom', ({ factor }) => {
      const dir = camera.position.clone().sub(controls.target);
      const dist = THREE.MathUtils.clamp(dir.length() / factor, controls.minDistance, controls.maxDistance);
      startAnim(controls.target.clone(), controls.target.clone().add(dir.setLength(dist)), true);
    });
    const offReset = bus.on('camera:reset', ({ animate }) => startAnim(center.clone(), center.clone().add(homeOffset), animate));
    const offFocus = bus.on('camera:focusAgent', ({ id }) => {
      const a = engine.agentById[id as AgentId];
      if (!a) return;
      const t = new THREE.Vector3(a.x + 0.5, 0.8, a.y + 0.5);
      startAnim(t, t.clone().add(new THREE.Vector3(9, 11, 11)), true);
    });

    // ---- picking
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY };
    };
    const onUp = (e: PointerEvent) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 5) return;
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -(((e.clientY - rect.top) / rect.height) * 2 - 1));
      ray.setFromCamera(ndc, camera);
      const targets: THREE.Object3D[] = [...pickables];
      views.forEach((v) => targets.push(v.root));
      const hits = ray.intersectObjects(targets, true);
      for (const h of hits) {
        let o: THREE.Object3D | null = h.object;
        if (o instanceof THREE.Sprite && !o.userData.room && !o.userData.actorId) continue;
        while (o) {
          if (o.userData.actorId) {
            bus.emit('scene:pick', { kind: 'agent', id: o.userData.actorId as AgentId });
            return;
          }
          if (o.userData.room) {
            bus.emit('scene:pick', { kind: 'room', id: o.userData.room as RoomId });
            return;
          }
          o = o.parent;
        }
      }
      bus.emit('scene:pick', { kind: 'none' });
    };
    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('pointerup', onUp);

    // ---- resize
    const resize = () => {
      const w = Math.max(1, el.clientWidth);
      const h = Math.max(1, el.clientHeight);
      renderer.setSize(w, h);
      camera.aspect = w / h;
      const ins = insetsRef.current;
      camera.setViewOffset(w, h, -(ins.left - ins.right) / 2, -(ins.top - ins.bottom) / 2, w, h);
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    const offIns = bus.on('camera:insets', () => resize());

    // ---- animate
    const tmpDir = new THREE.Vector3();
    let raf = 0;
    let last = performance.now();
    let lastZoom = -1;
    const angleLerp = (a: number, b: number, t: number) => {
      let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
      if (d < -Math.PI) d += Math.PI * 2;
      return a + d * t;
    };

    const HOOP = new THREE.Vector3(23.5, 2.0, 38.15);
    const hoopStage = (time: number) => {
      const t = (time % 3000) / 1000;
      if (t < 1.3) return { s: 'dribble' as const, u: t / 1.3 };
      if (t < 1.9) return { s: 'aim' as const, u: (t - 1.3) / 0.6 };
      if (t < 2.6) return { s: 'flight' as const, u: (t - 1.9) / 0.7 };
      return { s: 'drop' as const, u: (t - 2.6) / 0.4 };
    };
    const volley = (time: number) => ({ from: Math.floor(time / 1500) % 2, u: (time % 1500) / 1500 });
    const basketball = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 12), mat(0xe8711a, { rough: 0.7 }));
    const volleyball = new THREE.Mesh(new THREE.SphereGeometry(0.14, 16, 12), mat(0xf6f1de, { rough: 0.6 }));
    basketball.castShadow = volleyball.castShadow = true;
    basketball.visible = volleyball.visible = false;
    scene.add(basketball, volleyball);
    const actPos: Record<string, { p: THREE.Vector3; yaw: number }> = {};

    const updateActor = (a: Actor, v: ActorView, time: number, state: AgentState | null, isCrew: boolean, act: string | null) => {
      const reduced = engine.settings.reducedMotion;
      const walking = a.path.length > 0 || a.action === 'jog';
      const sitting = a.posture === 'sit' && !walking;
      v.root.position.set(a.x + 0.5, 0, a.y + 0.5);

      let dx = DIR_VEC[a.dir][0];
      let dz = DIR_VEC[a.dir][1];
      if (sitting) {
        dx = 0;
        dz = -1;
      } else if (!walking && a.face) {
        const fx = a.face.x - a.x;
        const fy = a.face.y - a.y;
        if (Math.abs(fx) + Math.abs(fy) > 0.01) {
          dx = fx;
          dz = fy;
        }
      }
      const target = Math.atan2(dx, dz);
      v.yaw = angleLerp(v.yaw, target, reduced ? 1 : 0.2);
      v.root.rotation.y = v.yaw;

      const ph = a.stepPhase * Math.PI * 2;
      let swing = 0;
      let lift = 0;
      let bob = 0;
      v.legL.rotation.x = v.legR.rotation.x = 0;
      v.armL.rotation.x = v.armR.rotation.x = 0;
      if (walking && !reduced) {
        swing = Math.sin(ph) * (a.action === 'jog' ? 0.9 : 0.6);
        v.legL.rotation.x = swing;
        v.legR.rotation.x = -swing;
        v.armL.rotation.x = -swing * 0.8;
        v.armR.rotation.x = swing * 0.8;
        bob = Math.abs(Math.sin(ph)) * 0.05;
      }
      if (sitting) {
        v.legL.rotation.x = v.legR.rotation.x = -Math.PI / 2;
        lift = -0.2;
        const typing = a.action === 'work' && !reduced && !engine.paused;
        v.armL.rotation.x = v.armR.rotation.x = -1.1 + (typing ? Math.sin(time / 90) * 0.12 : 0);
      } else if (!walking && !reduced && !engine.paused) {
        if (a.action === 'exercise') {
          bob = Math.abs(Math.sin(time / 220)) * 0.14;
          v.armL.rotation.x = v.armR.rotation.x = -Math.PI * 0.8 + Math.sin(time / 220) * 0.4;
        } else if (a.action === 'talk') {
          bob = Math.sin(time / 120) > 0 ? 0.03 : 0;
          v.armR.rotation.x = -0.5 + Math.sin(time / 180) * 0.3;
        } else if (a.action === 'work') {
          v.armL.rotation.x = v.armR.rotation.x = -0.7 + Math.sin(time / 150) * 0.25;
        }
      }
      v.body.rotation.z = 0;
      v.dumbL.visible = v.dumbR.visible = v.mug.visible = v.snack.visible = false;
      if (act && !reduced && !engine.paused) {
        const sw = Math.sin(time / 450 + a.x);
        if (act === 'hoop') {
          const st = hoopStage(time);
          if (st.s === 'dribble') {
            v.armR.rotation.x = -0.5 - Math.abs(Math.sin(time / 230)) * 0.5;
            v.armL.rotation.x = -0.25;
            bob = 0.02 + Math.abs(Math.sin(time / 230)) * 0.03;
          } else if (st.s === 'aim') {
            v.armL.rotation.x = v.armR.rotation.x = -2.2 - st.u * 0.6;
            bob = Math.sin(st.u * Math.PI) * 0.22;
          } else if (st.s === 'flight') {
            v.armL.rotation.x = v.armR.rotation.x = -2.85 + st.u * 0.4;
          } else {
            v.armL.rotation.x = v.armR.rotation.x = -0.5;
          }
        } else if (act === 'net-1' || act === 'net-2') {
          const vs = volley(time);
          const mine = act === 'net-1' ? 0 : 1;
          const bump = (vs.from === mine && vs.u < 0.3) || (vs.from !== mine && vs.u > 0.7);
          if (bump) {
            v.armL.rotation.x = v.armR.rotation.x = -1.15;
            bob = vs.from === mine ? 0.12 * Math.sin((vs.u / 0.3) * Math.PI) : 0.03;
          } else {
            v.armL.rotation.x = v.armR.rotation.x = -0.45;
            bob = Math.abs(Math.sin(time / 260)) * 0.04;
          }
        } else if (act === 'weights-1' || act === 'weights-2') {
          const k = (Math.sin(time / 520 + (act === 'weights-2' ? 1.6 : 0)) + 1) / 2;
          v.armL.rotation.x = v.armR.rotation.x = -0.9 - k * 2.0;
          v.dumbL.visible = v.dumbR.visible = true;
          bob = k * 0.04;
        } else if (act === 'stretch') {
          const k = Math.sin(time / 800);
          v.armL.rotation.x = v.armR.rotation.x = -2.9;
          v.body.rotation.z = k * 0.35;
          bob = 0;
        } else if (act === 'coffee' || act === 'counter' || act === 'lounge' || act === 'snack') {
          const cyc = act === 'snack' ? 2600 : 4200;
          const s = ((time + a.x * 300) % cyc) / cyc;
          const raise = s < 0.3 ? Math.sin((s / 0.3) * Math.PI) : 0;
          v.armR.rotation.x = -0.55 - raise * 1.65;
          v.armL.rotation.x = -0.2;
          (act === 'snack' ? v.snack : v.mug).visible = true;
        } else if (act === 'treadmill-1' || act === 'treadmill-2') {
          v.armL.rotation.x = -swing * 1.1 - 0.5;
          v.armR.rotation.x = swing * 1.1 - 0.5;
        }
        void sw;
      }
      v.body.position.y = lift + bob;
      v.body.position.z = sitting ? -0.05 : 0;

      // label
      const showLabels = engine.settings.labels;
      const selected = selection?.kind === 'agent' && selection.id === a.id;
      v.label.visible = showLabels || selected;
      const dot = state ? STATE_COLORS[state] : isCrew ? '#f5c518' : '#8fa3c7';
      const key = `${a.def.name}|${dot}`;
      if (key !== v.labelKey) {
        v.labelKey = key;
        setSpriteText(v.label, a.def.name, { dot });
      }
      v.label.position.y = sitting ? 1.75 : 1.95;

      // bubble
      const text = a.bubble?.text ?? '';
      if (text !== v.bubbleText) {
        v.bubbleText = text;
        if (text) setSpriteText(v.bubble, text, { bg: '#ffffff', fg: '#10151f', font: 24 });
        v.bubble.visible = !!text;
      }
      v.bubble.position.y = (sitting ? 1.75 : 1.95) + (v.label.visible ? 0.55 : 0.3);

      v.ring.visible = selected;
      if (selected) (v.ring.material as THREE.MeshBasicMaterial).opacity = reduced ? 0.8 : 0.55 + 0.35 * Math.sin(time / 220);
    };

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const delta = Math.min(250, now - last);
      last = now;
      engine.tick(delta);

      if (anim) {
        const t = Math.min(1, (now - anim.t0) / anim.dur);
        const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        controls.target.lerpVectors(anim.fromT, anim.toT, e);
        camera.position.lerpVectors(anim.fromP, anim.toP, e);
        if (t >= 1) anim = null;
      }
      controls.update();

      // agents
      for (const k of Object.keys(actPos)) delete actPos[k];
      for (const a of engine.agents) {
        const v = views.get(a.id);
        if (v) {
          const l = a.leisure;
          const act = l && l.kind === 'spot' && l.phase === 'doing' && l.spot ? l.spot.id : null;
          updateActor(a as unknown as Actor, v, now, engine.agentState(a), false, act);
          if (act) actPos[act] = { p: new THREE.Vector3(a.x + 0.5, 0, a.y + 0.5), yaw: v.yaw };
        }
      }
      // workshop carpenters
      const crew = engine.workshop.crew;
      const seen = new Set<string>();
      for (const c of crew) {
        seen.add(c.id);
        let v = views.get(c.id);
        if (!v) v = addView({ id: c.id, def: c.def, x: c.x, y: c.y, dir: c.dir, face: c.face, action: c.action, path: c.path, stepPhase: c.stepPhase, bubble: c.bubble });
        updateActor(c as unknown as Actor, v, now, null, true, null);
      }
      for (const [id, v] of views) {
        if (!seen.has(id) && !engine.agentById[id as AgentId]) {
          scene.remove(v.root);
          views.delete(id);
        }
      }

      // monitors light up when their owner is busy at the desk
      for (const m of hooks.monitors) {
        const owner = m.owner ? engine.agentById[m.owner as AgentId] : null;
        const busy = !!owner && owner.action === 'work' && owner.posture === 'sit' && owner.path.length === 0;
        m.material.emissiveIntensity = busy ? 1.1 + (engine.paused ? 0 : Math.sin(now / 200) * 0.15) : 0.2;
        m.material.color.setHex(busy ? 0x1d4d7a : 0x1c2a3a);
      }
      if (!engine.paused && !engine.settings.reducedMotion) for (const s of hooks.spinners) s.rotation.y += delta * 0.0025;
      for (const s of hooks.spinners) if (s.userData.fixed) s.rotation.y = 0;

      // balls
      const shooter = actPos['hoop'];
      basketball.visible = !!shooter && !engine.settings.reducedMotion;
      if (shooter && basketball.visible) {
        const fwd = new THREE.Vector3(Math.sin(shooter.yaw), 0, Math.cos(shooter.yaw));
        const hand = shooter.p.clone().addScaledVector(fwd, 0.38);
        const st = hoopStage(now);
        if (st.s === 'dribble') basketball.position.set(hand.x, 0.14 + Math.abs(Math.sin(now / 230)) * 0.75, hand.z);
        else if (st.s === 'aim') basketball.position.set(shooter.p.x + fwd.x * 0.15, 1.2 + st.u * 0.75, shooter.p.z + fwd.z * 0.15);
        else if (st.s === 'flight') {
          const rel = new THREE.Vector3(shooter.p.x, 1.95, shooter.p.z);
          basketball.position.lerpVectors(rel, HOOP, st.u);
          basketball.position.y += Math.sin(st.u * Math.PI) * 1.1;
        } else {
          basketball.position.set(HOOP.x + (hand.x - HOOP.x) * st.u, HOOP.y - st.u * (HOOP.y - 0.14), HOOP.z + (hand.z - HOOP.z) * st.u);
        }
        basketball.rotation.x += 0.12;
      }
      const pa = actPos['net-1'];
      const pb = actPos['net-2'];
      volleyball.visible = (!!pa || !!pb) && !engine.settings.reducedMotion;
      if (volleyball.visible) {
        const vs = volley(now);
        if (pa && pb) {
          const from = vs.from === 0 ? pa.p : pb.p;
          const to = vs.from === 0 ? pb.p : pa.p;
          volleyball.position.lerpVectors(from, to, vs.u);
          volleyball.position.y = 0.95 + Math.sin(vs.u * Math.PI) * 2.3;
        } else {
          const o = (pa ?? pb)!;
          volleyball.position.set(o.p.x, 1.0 + Math.abs(Math.sin(now / 520)) * 1.5, o.p.z);
        }
        volleyball.rotation.z += 0.1;
      }

      renderer.render(scene, camera);
      const z = Math.round((homeDist / camera.position.distanceTo(controls.target)) * 100) / 100;
      if (z !== lastZoom) {
        lastZoom = z;
        emitZoom();
      }
      tmpDir.set(0, 0, 0);
    };
    raf = requestAnimationFrame(loop);
    const readyTimer = window.setTimeout(() => {
      bus.emit('scene:progress', { value: 1 });
      bus.emit('scene:ready', undefined);
    }, 60);

    return () => {
      window.clearTimeout(readyTimer);
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointerup', onUp);
      offSel();
      offZoom();
      offReset();
      offFocus();
      offIns();
      controls.dispose();
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.Sprite) {
          (o as THREE.Mesh).geometry?.dispose();
          const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[];
          const arr = Array.isArray(m) ? m : [m];
          for (const mm of arr) {
            const mp = mm as THREE.SpriteMaterial;
            if (o instanceof THREE.Sprite) mp.map?.dispose();
          }
        }
      });
      for (const d of disposables) d.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [engine, bus]);

  useEffect(() => {
    bus.emit('camera:insets', insets);
  }, [bus, insets]);

  return <div ref={host} className="office-canvas office-3d" aria-label="3D office view" role="application" />;
}




