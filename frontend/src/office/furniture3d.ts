import * as THREE from 'three';
import type { Furniture } from './layout';

// 3D furniture built from simple primitives. Local frame: origin at the footprint centre, floor at y = 0,
// +x right, +z toward the front of the screen. One tile = one world unit.

const matCache = new Map<string, THREE.MeshStandardMaterial>();
export function mat(color: number, o: { rough?: number; metal?: number; emissive?: number; ei?: number; opacity?: number } = {}): THREE.MeshStandardMaterial {
  const key = `${color}|${o.rough ?? 0.8}|${o.metal ?? 0}|${o.emissive ?? -1}|${o.ei ?? 0}|${o.opacity ?? 1}`;
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: o.rough ?? 0.8, metalness: o.metal ?? 0 });
    if (o.emissive !== undefined) {
      m.emissive = new THREE.Color(o.emissive);
      m.emissiveIntensity = o.ei ?? 1;
    }
    if (o.opacity !== undefined && o.opacity < 1) {
      m.transparent = true;
      m.opacity = o.opacity;
      m.depthWrite = false;
    }
    matCache.set(key, m);
  }
  return m;
}

function box(g: THREE.Object3D, w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y + h / 2, z);
  g.add(mesh);
  return mesh;
}
function cyl(g: THREE.Object3D, rt: number, rb: number, h: number, m: THREE.Material, x: number, y: number, z: number, seg = 20): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m);
  mesh.position.set(x, y + h / 2, z);
  g.add(mesh);
  return mesh;
}
function ball(g: THREE.Object3D, r: number, m: THREE.Material, x: number, y: number, z: number, sy = 1): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 18, 14), m);
  mesh.position.set(x, y, z);
  mesh.scale.y = sy;
  g.add(mesh);
  return mesh;
}

export interface FurnitureHooks {
  /** Monitors, keyed by desk owner, so the scene can light them when the owner is busy. */
  monitors: { owner: string | undefined; material: THREE.MeshStandardMaterial }[];
  spinners: THREE.Object3D[];
}

const WOOD = 0xb98a5a;
const DARK_WOOD = 0x7a5636;
const DARKMETAL = 0x2c3240;
const WHITE = 0xf2f4f8;
const SCREEN_OFF = 0x1c2a3a;

export function buildFurniture(f: Furniture, hooks: FurnitureHooks): THREE.Group {
  const g = new THREE.Group();
  const W = f.w;
  const D = f.d;
  const col = f.color;
  switch (f.kind) {
    case 'desk': {
      box(g, 1.9, 0.06, 0.9, mat(WOOD), 0, 0.62, 0);
      for (const sx of [-0.88, 0.88]) for (const sz of [-0.38, 0.38]) box(g, 0.06, 0.62, 0.06, mat(DARKMETAL, { metal: 0.4 }), sx, 0, sz);
      box(g, 0.5, 0.03, 0.03, mat(DARKMETAL), 0, 0.68, -0.2);
      const sm = mat(SCREEN_OFF, { emissive: 0x3aa8ff, ei: 0.25 }).clone();
      box(g, 0.62, 0.38, 0.04, mat(DARKMETAL), 0, 0.82, -0.28);
      const scr = box(g, 0.56, 0.32, 0.02, sm, 0, 0.85, -0.255);
      scr.castShadow = false;
      hooks.monitors.push({ owner: f.owner, material: sm });
      box(g, 0.1, 0.16, 0.06, mat(DARKMETAL), 0, 0.68, -0.28);
      box(g, 0.5, 0.02, 0.16, mat(0x3a4150), 0, 0.68, 0.12);
      box(g, 0.14, 0.2, 0.1, mat(0xf2f2f2), 0.7, 0.68, -0.2);
      break;
    }
    case 'chair':
    case 'meetingChair': {
      const c = mat(col ?? 0x3b4a6b);
      cyl(g, 0.05, 0.05, 0.3, mat(DARKMETAL, { metal: 0.5 }), 0, 0, 0, 10);
      cyl(g, 0.24, 0.24, 0.04, mat(DARKMETAL), 0, 0, 0, 5);
      box(g, 0.46, 0.08, 0.46, c, 0, 0.3, 0);
      box(g, 0.46, 0.5, 0.07, c, 0, 0.38, 0.21);
      break;
    }
    case 'plant': {
      cyl(g, 0.17, 0.12, 0.26, mat(0xc87b4f), 0, 0, 0, 14);
      ball(g, 0.26, mat(0x3f9d57), 0, 0.5, 0, 0.9);
      ball(g, 0.17, mat(0x57b86b), 0.1, 0.68, 0.05);
      break;
    }
    case 'tallPlant': {
      cyl(g, 0.22, 0.16, 0.34, mat(0xe9e2d3), 0, 0, 0, 14);
      cyl(g, 0.04, 0.05, 0.7, mat(0x6a4a2e), 0, 0.3, 0, 8);
      ball(g, 0.36, mat(0x2f8f4e), 0, 1.15, 0, 0.9);
      ball(g, 0.27, mat(0x46b068), 0.18, 1.4, 0.06);
      ball(g, 0.25, mat(0x3a9e5b), -0.16, 1.3, -0.1);
      break;
    }
    case 'sofa': {
      const c = mat(col ?? 0x6a7fb5);
      const alongX = W >= D;
      const len = alongX ? W : D;
      const g2 = new THREE.Group();
      box(g2, len - 0.05, 0.4, 0.8, c, 0, 0, 0);
      box(g2, len - 0.05, 0.5, 0.2, c, 0, 0.3, -0.3);
      box(g2, 0.18, 0.55, 0.8, c, -(len / 2 - 0.12), 0, 0);
      box(g2, 0.18, 0.55, 0.8, c, len / 2 - 0.12, 0, 0);
      for (let i = 0; i < Math.round(len); i++) box(g2, 0.7, 0.14, 0.55, mat(0x8196c8), -len / 2 + 0.5 + i, 0.4, 0.05);
      if (!alongX) g2.rotation.y = Math.PI / 2; // back toward +x
      g.add(g2);
      break;
    }
    case 'shelf': {
      const alongX = W >= D;
      const g2 = new THREE.Group();
      const len = alongX ? W : D;
      const sm = mat(0xc9a06c);
      box(g2, len - 0.06, 1.55, 0.04, sm, 0, 0, -0.17);
      box(g2, 0.05, 1.55, 0.38, sm, -(len / 2 - 0.05), 0, 0);
      box(g2, 0.05, 1.55, 0.38, sm, len / 2 - 0.05, 0, 0);
      const bookCols = [0xd9534f, 0x4a90d9, 0x5cb85c, 0xf0ad4e, 0x9b59b6];
      for (let s = 0; s < 4; s++) {
        box(g2, len - 0.06, 0.04, 0.38, sm, 0, 0.02 + s * 0.45, 0);
        for (let i = 0; i < Math.round(len * 3); i++) box(g2, 0.1, 0.26, 0.22, mat(bookCols[(i + s) % 5]), -len / 2 + 0.2 + i * 0.3, 0.06 + s * 0.45, 0);
      }
      if (!alongX) g2.rotation.y = -Math.PI / 2;
      g.add(g2);
      break;
    }
    case 'rack': {
      box(g, 0.9, 1.8, 0.8, mat(DARKMETAL, { metal: 0.5, rough: 0.5 }), 0, 0, 0);
      for (let i = 0; i < 7; i++) {
        box(g, 0.76, 0.12, 0.02, mat(0x141922), 0, 0.15 + i * 0.23, 0.4);
        box(g, 0.05, 0.05, 0.02, mat(0x2fff9a, { emissive: 0x2fff9a, ei: 1.5 }), 0.28, 0.18 + i * 0.23, 0.41);
        box(g, 0.05, 0.05, 0.02, mat(0x3aa8ff, { emissive: 0x3aa8ff, ei: 1.5 }), 0.18, 0.18 + i * 0.23, 0.41);
      }
      break;
    }
    case 'meetingTable': {
      const r = Math.min(W, D) / 2 - 0.2;
      cyl(g, r, r, 0.08, mat(0xcfa97a, { rough: 0.5 }), 0, 0.62, 0, 40);
      cyl(g, 0.25, 0.4, 0.62, mat(DARKMETAL), 0, 0, 0, 16);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 0.45, 0.02, 8, 40), mat(0x7ad7e6, { emissive: 0x7ad7e6, ei: 1.2 }));
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.71;
      g.add(ring);
      break;
    }
    case 'bigScreen': {
      const alongX = W >= D;
      const len = alongX ? W : D;
      const g2 = new THREE.Group();
      box(g2, len, 1.0, 0.1, mat(0x10161f), 0, 0.9, -0.4);
      box(g2, len - 0.15, 0.85, 0.02, mat(0x143b57, { emissive: 0x3aa8ff, ei: 0.8 }), 0, 0.97, -0.34);
      for (let i = 0; i < 5; i++) box(g2, 0.18, 0.15 + (i % 3) * 0.12, 0.02, mat(0x7ad7e6, { emissive: 0x7ad7e6, ei: 1 }), -len / 2 + 0.5 + i * (len - 1) / 4, 1.0, -0.325);
      if (!alongX) g2.rotation.y = -Math.PI / 2;
      g.add(g2);
      break;
    }
    case 'whiteboard':
    case 'postBoard': {
      const alongX = W >= D;
      const len = alongX ? W : D;
      const g2 = new THREE.Group();
      box(g2, len - 0.1, 0.95, 0.06, mat(0xcfd6e0, { metal: 0.3 }), 0, 0.75, -0.42);
      box(g2, len - 0.22, 0.8, 0.02, mat(f.kind === 'postBoard' ? 0xf5deb3 : WHITE, { rough: 0.3 }), 0, 0.82, -0.38);
      const cs = [0xd9534f, 0x4a90d9, 0x5cb85c, 0xf0ad4e];
      for (let i = 0; i < Math.round(len * 1.5); i++) box(g2, 0.2, 0.2, 0.01, mat(cs[i % 4]), -len / 2 + 0.4 + i * 0.5, 0.9 + (i % 2) * -0.25, -0.365);
      if (!alongX) g2.rotation.y = -Math.PI / 2;
      g.add(g2);
      break;
    }
    case 'counter': {
      box(g, W - 0.04, 0.85, 0.8, mat(0x6b5a4a), 0, 0, 0);
      box(g, W, 0.06, 0.9, mat(0xe9e5de, { rough: 0.3 }), 0, 0.85, 0);
      cyl(g, 0.12, 0.12, 0.02, mat(0xffffff), 0.2, 0.91, 0, 12);
      break;
    }
    case 'fridge': {
      box(g, 0.85, 1.75, 0.8, mat(0xdfe4ea, { metal: 0.3, rough: 0.4 }), 0, 0, 0);
      box(g, 0.84, 0.02, 0.01, mat(0x6a7280), 0, 1.15, 0.405);
      box(g, 0.04, 0.4, 0.04, mat(0x6a7280), 0.32, 1.25, 0.42);
      box(g, 0.04, 0.5, 0.04, mat(0x6a7280), 0.32, 0.45, 0.42);
      break;
    }
    case 'diningTable': {
      box(g, W - 0.1, 0.07, D - 0.1, mat(0xd1a878), 0, 0.68, 0);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(g, 0.08, 0.68, 0.08, mat(DARK_WOOD), sx * (W / 2 - 0.2), 0, sz * (D / 2 - 0.2));
      cyl(g, 0.1, 0.08, 0.1, mat(0xffffff), 0, 0.75, 0, 12);
      break;
    }
    case 'stool': {
      cyl(g, 0.18, 0.18, 0.06, mat(0xc0563b), 0, 0.46, 0, 14);
      cyl(g, 0.04, 0.04, 0.46, mat(DARKMETAL), 0, 0, 0, 8);
      cyl(g, 0.16, 0.16, 0.03, mat(DARKMETAL), 0, 0, 0, 14);
      break;
    }
    case 'treadmill': {
      box(g, 0.8, 0.18, 1.8, mat(0x2b3039), 0, 0.05, 0);
      box(g, 0.66, 0.02, 1.6, mat(0x15181d), 0, 0.23, 0);
      box(g, 0.06, 1.0, 0.06, mat(DARKMETAL, { metal: 0.5 }), -0.34, 0.2, -0.75);
      box(g, 0.06, 1.0, 0.06, mat(DARKMETAL, { metal: 0.5 }), 0.34, 0.2, -0.75);
      box(g, 0.7, 0.24, 0.12, mat(0x10161f), 0, 1.1, -0.78);
      box(g, 0.5, 0.12, 0.02, mat(0x2fff9a, { emissive: 0x2fff9a, ei: 0.8 }), 0, 1.16, -0.71);
      break;
    }
    case 'weights': {
      box(g, W - 0.1, 0.06, 0.7, mat(0x2b3039), 0, 0, 0);
      for (const sx of [-0.6, 0.6]) box(g, 0.06, 1.2, 0.06, mat(DARKMETAL, { metal: 0.6 }), sx, 0, -0.2);
      const bar = cyl(g, 0.03, 0.03, 1.5, mat(0xc7ccd4, { metal: 0.8, rough: 0.3 }), 0, 1.0, -0.2, 10);
      bar.rotation.z = Math.PI / 2;
      for (const sx of [-0.62, 0.62]) {
        const p = cyl(g, 0.22, 0.22, 0.08, mat(0x1b1f26), sx, 0.78, -0.2, 18);
        p.rotation.z = Math.PI / 2;
        p.position.y = 1.0;
      }
      break;
    }
    case 'bench': {
      box(g, W - 0.2, 0.12, 0.5, mat(0x2a2f38), 0, 0.4, 0);
      for (const sx of [-1, 1]) box(g, 0.08, 0.4, 0.4, mat(DARKMETAL), sx * (W / 2 - 0.25), 0, 0);
      break;
    }
    case 'easel': {
      const wd = mat(DARK_WOOD);
      for (const sx of [-0.28, 0.28]) {
        const leg = box(g, 0.05, 1.6, 0.05, wd, sx, 0, 0);
        leg.rotation.z = sx > 0 ? -0.08 : 0.08;
      }
      const back = box(g, 0.05, 1.5, 0.05, wd, 0, 0, -0.3);
      back.rotation.x = -0.25;
      box(g, 0.75, 0.9, 0.04, mat(0xfaf6ea), 0, 0.55, 0.05);
      box(g, 0.6, 0.45, 0.01, mat(0x7fb7e6), 0, 0.82, 0.075);
      box(g, 0.6, 0.2, 0.01, mat(0x6bbf6a), 0, 0.62, 0.076);
      break;
    }
    case 'tripod': {
      for (const a of [0, 2.1, 4.2]) {
        const l = cyl(g, 0.02, 0.02, 1.3, mat(DARKMETAL), Math.cos(a) * 0.18, 0, Math.sin(a) * 0.18, 6);
        l.rotation.z = Math.cos(a) * 0.15;
        l.rotation.x = Math.sin(a) * -0.15;
      }
      box(g, 0.3, 0.2, 0.22, mat(0x15181d), 0, 1.3, 0);
      cyl(g, 0.08, 0.08, 0.14, mat(0x0d1015), 0, 1.33, 0.2, 14).rotation.x = Math.PI / 2;
      break;
    }
    case 'softbox': {
      cyl(g, 0.03, 0.03, 1.5, mat(DARKMETAL), 0, 0, 0, 6);
      cyl(g, 0.22, 0.22, 0.03, mat(DARKMETAL), 0, 0, 0, 10);
      box(g, 0.55, 0.65, 0.3, mat(0x15181d), 0, 1.35, 0);
      box(g, 0.5, 0.6, 0.02, mat(0xfff4d6, { emissive: 0xfff0c0, ei: 1.4 }), 0, 1.37, 0.16);
      break;
    }
    case 'cabinet': {
      box(g, 0.9, 1.25, 0.75, mat(0x8895a8, { metal: 0.3 }), 0, 0, 0);
      for (let i = 0; i < 4; i++) {
        box(g, 0.8, 0.01, 0.01, mat(0x39414f), 0, 0.28 + i * 0.3, 0.38);
        box(g, 0.2, 0.03, 0.03, mat(0xd4d9e0), 0, 0.15 + i * 0.3, 0.395);
      }
      break;
    }
    case 'holoTable': {
      cyl(g, 0.9, 1.0, 0.7, mat(0x1b2a3a, { metal: 0.5, rough: 0.4 }), 0, 0, 0, 32);
      cyl(g, 0.8, 0.8, 0.03, mat(0x7ad7e6, { emissive: 0x7ad7e6, ei: 1.4 }), 0, 0.7, 0, 32);
      const holo = new THREE.Mesh(new THREE.OctahedronGeometry(0.4), mat(0x7ad7e6, { emissive: 0x7ad7e6, ei: 1.2, opacity: 0.55 }));
      holo.position.y = 1.35;
      g.add(holo);
      hooks.spinners.push(holo);
      const cone = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.8, 0.6, 28, 1, true), mat(0x7ad7e6, { emissive: 0x7ad7e6, ei: 0.5, opacity: 0.12 }));
      cone.position.y = 1.0;
      g.add(cone);
      break;
    }
    case 'artTable': {
      box(g, W - 0.1, 0.07, D - 0.2, mat(0xe7d9bd), 0, 0.72, 0);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(g, 0.08, 0.72, 0.08, mat(DARK_WOOD), sx * (W / 2 - 0.2), 0, sz * (D / 2 - 0.25));
      const cs = [0xe85d75, 0x4a90d9, 0xf0c64a, 0x5cb85c];
      cs.forEach((c, i) => cyl(g, 0.07, 0.06, 0.14, mat(c), -0.8 + i * 0.5, 0.79, 0.1, 10));
      box(g, 0.6, 0.02, 0.45, mat(0xffffff), 0.3, 0.79, -0.15);
      break;
    }
    case 'vending': {
      box(g, 0.95, 1.85, 0.85, mat(0xc7463c, { rough: 0.4 }), 0, 0, 0);
      box(g, 0.65, 1.2, 0.02, mat(0x1d3342, { emissive: 0x6ecbff, ei: 0.7 }), -0.12, 0.45, 0.43);
      box(g, 0.2, 0.5, 0.02, mat(0x222831), 0.32, 0.9, 0.43);
      box(g, 0.5, 0.14, 0.02, mat(0x222831), 0, 0.12, 0.43);
      break;
    }
    case 'net': {
      for (const sx of [-1, 1]) cyl(g, 0.04, 0.04, 1.8, mat(0xd7dce4, { metal: 0.5 }), sx * (W / 2 - 0.1), 0, 0, 8);
      box(g, W - 0.2, 0.7, 0.02, mat(0xffffff, { opacity: 0.35 }), 0, 1.0, 0);
      box(g, W - 0.2, 0.08, 0.03, mat(0xffffff), 0, 1.65, 0);
      break;
    }
    case 'hoop': {
      cyl(g, 0.05, 0.06, 2.5, mat(DARKMETAL, { metal: 0.5 }), 0, 0, 0, 10);
      box(g, 1.1, 0.75, 0.05, mat(0xf4f6fa, { opacity: 0.85 }), 0, 2.0, 0.35);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.02, 8, 24), mat(0xf26b21));
      ring.rotation.x = Math.PI / 2;
      ring.position.set(0, 2.0, 0.65);
      g.add(ring);
      break;
    }
    case 'printer': {
      box(g, 0.8, 0.7, 0.6, mat(0x7c8594), 0, 0, 0);
      box(g, 0.78, 0.28, 0.58, mat(WHITE), 0, 0.7, 0);
      box(g, 0.5, 0.02, 0.3, mat(0xffffff), 0, 0.99, 0.05);
      box(g, 0.1, 0.04, 0.02, mat(0x2fff9a, { emissive: 0x2fff9a, ei: 1.2 }), 0.28, 0.85, 0.3);
      break;
    }
    case 'beanbag': {
      ball(g, 0.42, mat(col ?? 0xe8825a), 0, 0.3, 0, 0.7);
      ball(g, 0.3, mat(col ?? 0xf29b74), 0, 0.5, -0.15, 0.8);
      break;
    }
    case 'water': {
      box(g, 0.45, 0.9, 0.45, mat(0xe3e8ee), 0, 0, 0);
      cyl(g, 0.17, 0.17, 0.4, mat(0x8fd3f4, { opacity: 0.7 }), 0, 0.9, 0, 16);
      box(g, 0.1, 0.06, 0.04, mat(0x2d7fd0), 0, 0.6, 0.24);
      break;
    }
    case 'coffeeMaker': {
      box(g, 0.9, 0.85, 0.7, mat(0x6b5a4a), 0, 0, 0);
      box(g, 0.94, 0.05, 0.74, mat(0xe9e5de), 0, 0.85, 0);
      box(g, 0.5, 0.45, 0.4, mat(0x2b3039, { metal: 0.5 }), 0, 0.9, -0.05);
      box(g, 0.2, 0.04, 0.02, mat(0xff8a3a, { emissive: 0xff8a3a, ei: 1.2 }), 0, 1.2, 0.17);
      cyl(g, 0.06, 0.05, 0.1, mat(0xffffff), 0.25, 0.9, 0.2, 10);
      break;
    }
    case 'sawTable': {
      box(g, W - 0.1, 0.1, 0.9, mat(0x9aa3b0, { metal: 0.6, rough: 0.4 }), 0, 0.8, 0);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(g, 0.08, 0.8, 0.08, mat(DARKMETAL), sx * (W / 2 - 0.2), 0, sz * 0.35);
      const blade = cyl(g, 0.3, 0.3, 0.02, mat(0xd7dce4, { metal: 0.9, rough: 0.2 }), 0, 0.92, 0, 30);
      blade.rotation.x = Math.PI / 2;
      blade.position.y = 1.05;
      blade.scale.set(1, 1, 1);
      hooks.spinners.push(blade);
      box(g, 0.5, 0.08, 0.3, mat(0xc79a68), 0.5, 0.9, 0.1);
      break;
    }
    case 'planer': {
      box(g, W - 0.1, 0.85, 0.8, mat(0x3f6f4a, { metal: 0.3 }), 0, 0, 0);
      box(g, W - 0.3, 0.18, 0.7, mat(0x2b3039, { metal: 0.5 }), 0, 0.85, 0);
      box(g, 0.5, 0.06, 0.4, mat(0xc79a68), 0.3, 1.03, 0);
      break;
    }
    case 'workbench': {
      box(g, W - 0.1, 0.1, 0.9, mat(0xcfa36d), 0, 0.82, 0);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(g, 0.1, 0.82, 0.1, mat(DARK_WOOD), sx * (W / 2 - 0.2), 0, sz * 0.35);
      box(g, 0.2, 0.15, 0.15, mat(0xb43a2f), -0.6, 0.92, 0.25);
      box(g, 0.6, 0.05, 0.3, mat(0xe0b782), 0.2, 0.92, 0);
      break;
    }
    case 'varnishTable': {
      box(g, W - 0.1, 0.1, 0.9, mat(0xd5c3a0), 0, 0.82, 0);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(g, 0.1, 0.82, 0.1, mat(DARK_WOOD), sx * (W / 2 - 0.2), 0, sz * 0.35);
      cyl(g, 0.12, 0.12, 0.2, mat(0x8a5a2b), -0.55, 0.92, 0.2, 14);
      box(g, 0.7, 0.05, 0.4, mat(0x8a5a2b, { rough: 0.2 }), 0.2, 0.92, 0);
      break;
    }
    case 'lumberRack': {
      const along = D;
      for (const sz of [-1, 1]) for (const sx of [-1, 1]) box(g, 0.07, 1.8, 0.07, mat(DARKMETAL), sx * 0.4, 0, sz * (along / 2 - 0.1));
      const woods = [0xb98a5a, 0x8a4b2e, 0xd9c08f];
      for (let s = 0; s < 3; s++) {
        box(g, 0.9, 0.05, along - 0.1, mat(DARKMETAL), 0, 0.3 + s * 0.6, 0);
        for (let i = 0; i < 4; i++) box(g, 0.2, 0.1, along - 0.2, mat(woods[(i + s) % 3]), -0.3 + i * 0.2, 0.36 + s * 0.6, 0);
      }
      break;
    }
    case 'doorRack': {
      box(g, W - 0.1, 0.08, 0.8, mat(DARKMETAL), 0, 0, 0);
      const woods = [0xb98a5a, 0x8a4b2e, 0xd9c08f, 0xa06a3d];
      for (let i = 0; i < Math.round(W * 2.2); i++) {
        const d = box(g, 0.12, 1.8, 0.6, mat(woods[i % 4]), -W / 2 + 0.3 + i * 0.4, 0.08, 0);
        d.rotation.z = 0.04;
      }
      break;
    }
    default: {
      box(g, W - 0.1, 0.8, D - 0.1, mat(col ?? 0x9aa3b5), 0, 0, 0);
    }
  }
  g.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      const m = o.material as THREE.Material;
      o.castShadow = !(m.transparent);
      o.receiveShadow = true;
    }
  });
  return g;
}

