/**
 * AssetManager — centralised model library with caching (GDD §7 AssetManager).
 *
 * The GDD specifies glTF assets. This build ships *procedural* low-poly models
 * instead (GDD §7 "Fallback to primitives if model fails to load"): the repo
 * stays tiny, there is no asset pipeline to break, and every model is a single
 * merged vertex-coloured geometry = one draw call. `loadModel()` still supports
 * real .glb files and will prefer them when present in assets/models/.
 *
 * Vehicle convention: origin at railhead level, nose toward +Z, width on X.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Builder, MATERIALS, rng } from '../utils/geo.js';
import { CAR_TYPES, LOCOMOTIVES, GAUGE } from '../constants.js';

const C = {
  steel: 0x5a5f66, darkSteel: 0x33383d, wheel: 0x2b2f33, rust: 0x7a4a30,
  wood: 0x7a5a3a, darkWood: 0x54391f, brick: 0x8c4a3a, roof: 0x4a4f55,
  glass: 0x9fc4d8, black: 0x1b1d20, white: 0xe8e6df, cream: 0xd9cdae,
  yellow: 0xe0b23c, red: 0xb03a2e, green: 0x3f6b45, concrete: 0x9a968c,
  ballast: 0x6d6659, rail: 0x8f8b84, tie: 0x4a382a, grass: 0x6d8f4a,
};

export class AssetManager {
  constructor() {
    this.cache = new Map();
    this.materials = {
      paint: MATERIALS.paint(),
      metal: MATERIALS.metal(),
      matte: MATERIALS.matte(),
      glass: MATERIALS.glass(),
    };
    this.loader = new GLTFLoader();
    this.stats = { built: 0, gltf: 0, failed: 0 };
  }

  /** Geometry by key, built once and cached. */
  geometry(key) {
    if (this.cache.has(key)) return this.cache.get(key);
    const build = BUILDERS[key];
    if (!build) {
      console.warn(`[assets] unknown model "${key}" — using a placeholder box`);
      const b = new Builder();
      b.box(1, 1, 1, 0xff00ff);
      const geo = b.build();
      this.cache.set(key, geo);
      return geo;
    }
    const geo = build(key);
    geo.name = key;
    this.cache.set(key, geo);
    this.stats.built++;
    return geo;
  }

  has(key) { return !!BUILDERS[key]; }
  keys() { return Object.keys(BUILDERS); }

  /** A ready-to-add mesh. `material` defaults to the shared painted material. */
  mesh(key, material = this.materials.paint, castShadow = true) {
    const m = new THREE.Mesh(this.geometry(key), material);
    m.castShadow = castShadow;
    m.receiveShadow = true;
    m.name = key;
    return m;
  }

  /**
   * Optional real glTF override: if `assets/models/<key>.glb` exists it wins.
   * Returns a promise that always resolves (procedural fallback on error).
   */
  async loadModel(key, path = `assets/models/${key}.glb`) {
    return new Promise((resolve) => {
      this.loader.load(path, (gltf) => {
        this.stats.gltf++;
        resolve(gltf.scene);
      }, undefined, () => {
        this.stats.failed++;
        resolve(this.mesh(key));
      });
    });
  }

  dispose() {
    for (const g of this.cache.values()) g.dispose();
    this.cache.clear();
    for (const m of Object.values(this.materials)) m.dispose();
  }
}

/* ============================================================ MODEL LIBRARY */
const BUILDERS = {};
const reg = (key, fn) => { BUILDERS[key] = fn; };

/** Wheel bogie centred at z = 0, railhead at y = 0. */
function bogie(b, wheelR, spacing, color = C.darkSteel, wheels = 4) {
  const half = spacing / 2;
  b.box(2.3, 0.34, wheels * wheelR * 2 + 0.9, color, [0, wheelR + 0.24, 0]);
  for (let i = 0; i < wheels; i++) {
    const z = -half + (spacing * i) / Math.max(1, wheels - 1);
    for (const side of [-1, 1]) {
      b.cyl(wheelR, wheelR, 0.16, C.wheel, [side * (GAUGE / 2 + 0.08), wheelR, z], [0, 0, Math.PI / 2], 12);
      b.cyl(wheelR * 0.45, wheelR * 0.45, 0.2, C.steel, [side * (GAUGE / 2 + 0.08), wheelR, z], [0, 0, Math.PI / 2], 8);
    }
  }
  b.box(0.5, 0.5, 1.2, C.steel, [0, wheelR + 0.55, 0]);
}

function coupler(b, z, color = C.darkSteel) {
  b.box(0.3, 0.22, 0.9, color, [0, 0.78, z]);
  b.box(0.5, 0.42, 0.34, color, [0, 0.8, z + Math.sign(z) * 0.5]);
}

function dieselShell(b, o) {
  const { length, width = 3.0, deckH = 1.35, hoodH, cabZ, cabH, color, accent, roof } = o;
  const L = length;
  // main frame / sill
  b.box(width + 0.16, 0.34, L, C.darkSteel, [0, deckH - 0.17, 0]);
  // hood
  b.box(width, hoodH, L * o.hoodLen, color, [0, deckH + hoodH / 2, o.hoodZ ?? 0], [0, 0, 0], 0.02);
  // cab
  b.box(width + 0.06, cabH, o.cabLen, color, [0, deckH + cabH / 2, cabZ]);
  b.box(width + 0.14, 0.16, o.cabLen + 0.2, roof ?? C.roof, [0, deckH + cabH + 0.06, cabZ]);
  // cab windows (front + sides)
  const gl = C.glass;
  b.box(width - 0.5, cabH * 0.42, 0.09, gl, [0, deckH + cabH * 0.62, cabZ + o.cabLen / 2 + 0.02]);
  for (const side of [-1, 1]) {
    b.box(0.08, cabH * 0.4, o.cabLen * 0.72, gl, [side * (width / 2 + 0.04), deckH + cabH * 0.62, cabZ]);
  }
  // nose / radiator grilles
  for (const side of [-1, 1]) {
    b.box(0.07, hoodH * 0.55, L * o.hoodLen * 0.62, C.darkSteel, [side * (width / 2 + 0.03), deckH + hoodH * 0.52, o.hoodZ ?? 0]);
  }
  // livery stripe
  b.box(width + 0.2, 0.22, L * 0.92, accent, [0, deckH + hoodH * 0.86, o.hoodZ ?? 0]);
  // walkway + handrails
  for (const side of [-1, 1]) {
    b.box(0.42, 0.07, L * 0.98, C.darkSteel, [side * (width / 2 + 0.28), deckH + 0.06, 0]);
    b.box(0.05, 0.5, L * 0.9, C.yellow, [side * (width / 2 + 0.44), deckH + 0.36, 0]);
    for (let i = 0; i < 6; i++) {
      const z = -L * 0.42 + (L * 0.84 * i) / 5;
      b.box(0.05, 0.55, 0.05, C.yellow, [side * (width / 2 + 0.44), deckH + 0.34, z]);
    }
  }
  // exhaust stack, horn, headlights
  b.cyl(0.24, 0.3, 0.42, C.darkSteel, [0, deckH + hoodH + 0.2, (o.hoodZ ?? 0) - L * 0.08], [0, 0, 0], 10);
  b.cyl(0.13, 0.17, 0.5, C.steel, [-0.34, deckH + cabH + 0.28, cabZ + o.cabLen * 0.3], [Math.PI / 2, 0, 0], 8);
  b.box(0.44, 0.4, 0.14, C.white, [0.62, deckH + hoodH * 0.62, L / 2 - 0.05]);
  b.box(0.44, 0.4, 0.14, C.red, [-0.62, deckH + hoodH * 0.62, L / 2 - 0.05]);
  b.box(0.5, 0.3, 0.12, C.red, [0, deckH + hoodH * 0.7, -L / 2 + 0.05]);
  // fuel tank + air reservoirs under the frame
  b.box(1.5, 0.85, L * 0.3, C.darkSteel, [0, deckH - 0.72, -L * 0.05]);
  for (const side of [-1, 1]) b.cyl(0.22, 0.22, L * 0.24, C.steel, [side * 0.95, deckH - 0.62, L * 0.16], [Math.PI / 2, 0, 0], 8);
  // steps at each end
  for (const end of [-1, 1]) {
    b.box(0.9, 0.06, 0.4, C.darkSteel, [width / 2 + 0.28, deckH - 0.5, end * (L / 2 - 0.5)]);
    b.box(0.9, 0.06, 0.4, C.darkSteel, [width / 2 + 0.28, deckH - 0.95, end * (L / 2 - 0.3)]);
  }
}

/** Four locomotives (GDD §3.5), each with a distinct silhouette. */
function buildLoco(id) {
  const spec = LOCOMOTIVES[id];
  const b = new Builder();
  const L = spec.bodyLength;
  const base = {
    color: spec.color, accent: spec.accent, width: 3.0, deckH: 1.32,
    roof: 0x3a3f45,
  };
  if (id === 'gp7') {
    dieselShell(b, { ...base, length: L, hoodH: 1.55, hoodLen: 0.74, hoodZ: -L * 0.1, cabZ: L * 0.28, cabH: 1.5, cabLen: 2.9 });
  } else if (id === 'sd40') {
    dieselShell(b, { ...base, length: L, width: 3.1, hoodH: 1.75, hoodLen: 0.72, hoodZ: -L * 0.12, cabZ: L * 0.3, cabH: 1.55, cabLen: 3.1 });
    b.box(3.2, 0.5, 1.6, C.darkSteel, [0, base.deckH + 2.0, L * 0.3]); // dynamic brake hatch
  } else if (id === 'funit') {
    // streamlined passenger unit: rounded nose, full-width carbody
    const deckH = 1.3, h = 2.5;
    b.box(3.15, 0.34, L, C.darkSteel, [0, deckH - 0.17, 0]);
    b.box(3.05, h, L * 0.94, base.color, [0, deckH + h / 2, 0], [0, 0, 0], 0.02);
    b.cyl(1.55, 1.55, 3.05, base.color, [0, deckH + h - 0.02, 0], [0, 0, Math.PI / 2], 14);
    b.box(3.1, 0.9, 1.2, base.color, [0, deckH + h * 0.55, L / 2 - 0.4], [-0.35, 0, 0]); // sloped nose
    b.box(3.2, 0.14, L * 0.96, base.accent, [0, deckH + h + 0.5, 0]);
    b.box(2.4, 0.85, 0.1, C.glass, [0, deckH + h * 0.72, L / 2 - 0.62], [-0.32, 0, 0]);
    for (const side of [-1, 1]) {
      for (let i = 0; i < 7; i++) b.box(0.08, 0.6, 1.1, C.glass, [side * 1.56, deckH + h * 0.66, -L * 0.36 + i * (L * 0.72 / 6)]);
    }
    b.box(3.1, 0.24, L * 0.9, base.accent, [0, deckH + 0.3, 0]);
    b.cyl(0.2, 0.26, 0.5, C.darkSteel, [0, deckH + h + 0.7, -L * 0.1], [0, 0, 0], 10);
    b.box(0.5, 0.4, 0.16, C.white, [0.7, deckH + h * 0.5, L / 2 - 0.1]);
    b.box(0.5, 0.4, 0.16, C.white, [-0.7, deckH + h * 0.5, L / 2 - 0.1]);
    for (const end of [-1, 1]) {
      b.box(0.4, 0.5, 0.5, C.darkSteel, [end * 1.2, deckH - 0.45, 0]);
    }
  } else {
    // AC-9 articulated mountain king: two hoods, shared centre bogie
    dieselShell(b, { ...base, length: L, width: 3.2, hoodH: 1.9, hoodLen: 0.4, hoodZ: L * 0.24, cabZ: L * 0.02, cabH: 1.6, cabLen: 3.4 });
    b.box(3.2, 1.9, L * 0.34, base.color, [0, base.deckH + 0.95, -L * 0.3], [0, 0, 0], 0.02);
    b.box(3.3, 0.16, L * 0.34, C.roof, [0, base.deckH + 1.95, -L * 0.3]);
    b.box(3.26, 0.22, L * 0.34, base.accent, [0, base.deckH + 1.6, -L * 0.3]);
    b.cyl(0.3, 0.36, 0.5, C.darkSteel, [0, base.deckH + 2.2, -L * 0.3], [0, 0, 0], 10);
    b.box(0.46, 0.42, 0.14, C.white, [0.7, base.deckH + 1.2, -L / 2 + 0.06]);
  }
  coupler(b, L / 2 + 0.3);
  coupler(b, -L / 2 - 0.3);
  return b.build();
}

/* The bogie helper draws at z=0; wrap it so each loco gets them at the right spots. */
function buildLocoWithBogies(id) {
  const spec = LOCOMOTIVES[id];
  const L = spec.bodyLength;
  const b = new Builder();
  const parts = buildLoco(id);
  // merge body
  b.parts.push(parts.clone());
  const span = id === 'ac9' ? [L * 0.35, 0, -L * 0.35] : id === 'sd40' ? [L * 0.33, -L * 0.33] : [L * 0.31, -L * 0.31];
  for (const z of span) {
    const bb = new Builder();
    bogie(bb, 0.56, 2.5, C.darkSteel, id === 'gp7' || id === 'funit' ? 4 : 6);
    const g = bb.build();
    g.translate(0, 0, z);
    b.parts.push(g);
  }
  return b.build();
}

for (const id of Object.keys(LOCOMOTIVES)) reg(`loco_${id}`, () => buildLocoWithBogies(id));

/* ------------------------------------------------------------- freight cars */
function carFrame(b, L, deckH, color = C.darkSteel) {
  b.box(2.7, 0.3, L, color, [0, deckH - 0.15, 0]);
  b.box(0.34, 0.5, L * 0.9, color, [0, deckH - 0.45, 0]);
  const half = L * 0.33;
  for (const z of [-half, half]) {
    const bb = new Builder();
    bogie(bb, 0.5, 2.2, C.darkSteel, 4);
    const g = bb.build(); g.translate(0, 0, z);
    b.parts.push(g);
  }
  coupler(b, L / 2 + 0.3);
  coupler(b, -L / 2 - 0.3);
}

function buildBoxcar() {
  const t = CAR_TYPES.boxcar, L = t.length, b = new Builder(), deckH = 1.15, h = 3.1;
  carFrame(b, L, deckH);
  b.box(3.0, h, L * 0.94, t.color, [0, deckH + h / 2, 0], [0, 0, 0], 0.03);
  b.box(3.08, 0.16, L * 0.96, C.roof, [0, deckH + h + 0.08, 0]);
  for (let i = 0; i < 8; i++) b.box(3.06, 0.09, 0.12, C.darkWood, [0, deckH + h * 0.5, -L * 0.44 + i * (L * 0.88 / 7)]);
  // sliding door on each side
  for (const side of [-1, 1]) {
    b.box(0.1, h * 0.86, 2.6, C.darkWood, [side * 1.53, deckH + h * 0.48, 0]);
    b.box(0.14, 0.14, 3.0, C.steel, [side * 1.56, deckH + h * 0.92, 0]);
  }
  b.box(0.06, 0.5, 0.5, C.white, [1.56, deckH + h * 0.62, 1.8]); // reporting mark placard
  return b.build();
}

function buildHopper() {
  const t = CAR_TYPES.hopper, L = t.length, b = new Builder(), deckH = 1.5, h = 1.7;
  carFrame(b, L, deckH);
  b.box(2.9, h, L * 0.92, t.color, [0, deckH + h / 2, 0], [0, 0, 0], 0.03);
  // sloped hoppers underneath
  for (let i = 0; i < 3; i++) {
    const z = -L * 0.3 + i * L * 0.3;
    b.prism(2.9, 0.75, 1.7, C.darkSteel, [0, deckH - 0.05, z], [Math.PI, 0, 0]);
  }
  for (const side of [-1, 1]) {
    for (let i = 0; i < 6; i++) b.box(0.1, h, 0.12, C.darkSteel, [side * 1.48, deckH + h / 2, -L * 0.4 + i * (L * 0.8 / 5)]);
    b.box(0.12, 0.16, L * 0.94, C.steel, [side * 1.5, deckH + h + 0.06, 0]);
  }
  return b.build();
}

function buildGondola() {
  const t = CAR_TYPES.gondola, L = t.length, b = new Builder(), deckH = 1.3, h = 1.5;
  carFrame(b, L, deckH);
  b.box(3.0, h, L * 0.94, t.color, [0, deckH + h / 2, 0], [0, 0, 0], 0.03);
  b.box(2.7, 0.12, L * 0.92, C.darkSteel, [0, deckH + 0.06, 0]);
  for (const side of [-1, 1]) for (let i = 0; i < 7; i++) b.box(0.12, h, 0.14, C.darkSteel, [side * 1.52, deckH + h / 2, -L * 0.42 + i * (L * 0.84 / 6)]);
  return b.build();
}

function buildTanker() {
  const t = CAR_TYPES.tanker, L = t.length, b = new Builder(), deckH = 1.35;
  carFrame(b, L, deckH);
  b.cyl(1.32, 1.32, L * 0.88, t.color, [0, deckH + 1.4, 0], [Math.PI / 2, 0, 0], 18);
  for (const end of [-1, 1]) b.sphere(1.32, C.darkSteel, [0, deckH + 1.4, end * L * 0.44], 12, 8);
  b.box(0.9, 0.12, L * 0.7, C.steel, [0, deckH + 2.72, 0]); // walkway
  b.cyl(0.34, 0.34, 0.5, C.steel, [0, deckH + 2.9, L * 0.16], [0, 0, 0], 10); // dome
  for (const side of [-1, 1]) b.box(0.1, 0.4, L * 0.7, C.yellow, [side * 0.42, deckH + 2.9, 0]);
  b.box(2.2, 0.6, 0.5, C.darkSteel, [0, deckH + 0.6, L * 0.3]);
  return b.build();
}

function buildFlatbed() {
  const t = CAR_TYPES.flatbed, L = t.length, b = new Builder(), deckH = 1.1;
  carFrame(b, L, deckH);
  b.box(3.0, 0.24, L * 0.96, C.darkWood, [0, deckH + 0.12, 0]);
  for (let i = 0; i < 12; i++) b.box(3.02, 0.06, 0.1, C.wood, [0, deckH + 0.25, -L * 0.46 + i * (L * 0.92 / 11)]);
  for (const end of [-1, 1]) b.box(3.0, 0.5, 0.16, C.steel, [0, deckH + 0.4, end * L * 0.47]);
  for (const side of [-1, 1]) for (let i = 0; i < 6; i++) b.box(0.12, 0.42, 0.12, C.steel, [side * 1.44, deckH + 0.42, -L * 0.36 + i * (L * 0.72 / 5)]);
  return b.build();
}

function buildCoach() {
  const t = CAR_TYPES.coach, L = t.length, b = new Builder(), deckH = 1.25, h = 2.7;
  carFrame(b, L, deckH);
  b.box(3.1, h, L * 0.97, t.color, [0, deckH + h / 2, 0], [0, 0, 0], 0.02);
  b.cyl(1.55, 1.55, 3.1, t.color, [0, deckH + h, 0], [0, 0, Math.PI / 2], 12);
  b.box(3.2, 0.12, L * 0.97, C.roof, [0, deckH + h + 1.3, 0]);
  for (const side of [-1, 1]) {
    for (let i = 0; i < 10; i++) b.box(0.08, 0.95, 1.3, C.glass, [side * 1.58, deckH + h * 0.62, -L * 0.42 + i * (L * 0.84 / 9)]);
  }
  for (const end of [-1, 1]) {
    b.box(3.0, 1.0, 0.1, C.glass, [0, deckH + h * 0.62, end * L * 0.485]);
    b.box(3.14, 0.3, 0.5, C.darkSteel, [0, deckH + 0.1, end * L * 0.47]);
  }
  b.box(1.2, 0.4, 1.2, C.steel, [0, deckH + h + 1.5, L * 0.2]);
  return b.build();
}

function buildCaboose() {
  const t = CAR_TYPES.caboose, L = t.length, b = new Builder(), deckH = 1.2, h = 2.3;
  carFrame(b, L, deckH);
  b.box(2.9, h, L * 0.9, t.color, [0, deckH + h / 2, 0], [0, 0, 0], 0.03);
  b.box(3.0, 0.14, L * 0.94, C.roof, [0, deckH + h + 0.07, 0]);
  b.box(2.2, 1.1, 2.2, t.color, [0, deckH + h + 0.6, -L * 0.1]); // cupola
  b.box(2.3, 0.12, 2.3, C.roof, [0, deckH + h + 1.2, -L * 0.1]);
  for (const side of [-1, 1]) {
    b.box(0.08, 0.6, 0.9, C.glass, [side * 1.14, deckH + h + 0.65, -L * 0.1]);
    b.box(0.08, 0.85, 1.1, C.glass, [side * 1.48, deckH + h * 0.6, L * 0.2]);
    b.box(0.08, 0.85, 1.1, C.glass, [side * 1.48, deckH + h * 0.6, -L * 0.3]);
  }
  b.box(2.9, 0.16, 0.9, C.white, [0, deckH + h * 0.45, L * 0.46]);
  return b.build();
}

const CAR_BUILDERS = {
  boxcar: buildBoxcar, hopper: buildHopper, gondola: buildGondola,
  tanker: buildTanker, flatbed: buildFlatbed, coach: buildCoach, caboose: buildCaboose,
};
for (const [k, fn] of Object.entries(CAR_BUILDERS)) reg(`car_${k}`, fn);

/** Visible cargo pile/placard added to a car when it is loaded. */
reg('cargo_pile', () => {
  const b = new Builder(); const r = rng(7);
  for (let i = 0; i < 26; i++) {
    const z = (r() - 0.5) * 11, x = (r() - 0.5) * 2.2;
    const s = 0.4 + r() * 0.7;
    b.box(s, s * 0.7, s * (0.7 + r()), 0xffffff, [x, 0.1 + r() * 0.6, z], [r(), r(), r()], 0.25);
  }
  return b.build();
});
reg('cargo_bulk', () => {
  const b = new Builder();
  b.trapezoid(2.2, 2.7, 1.15, 11.5, 0xffffff, [0, 0.58, 0]);
  const r = rng(11);
  for (let i = 0; i < 40; i++) {
    b.box(0.3, 0.24, 0.3, 0xffffff, [(r() - 0.5) * 2.2, 1.05 + r() * 0.14, (r() - 0.5) * 11], [r(), r(), r()], 0.3);
  }
  return b.build();
});
reg('cargo_timber', () => {
  const b = new Builder(); const r = rng(3);
  for (let layer = 0; layer < 3; layer++) {
    for (let i = 0; i < 5 - layer; i++) {
      b.cyl(0.26, 0.26, 12.4, 0xffffff, [-1.0 + i * 0.52 + layer * 0.26, 0.3 + layer * 0.5, 0], [Math.PI / 2, 0, 0], 8, 0.12);
    }
  }
  return b.build();
});
reg('cargo_coils', () => {
  const b = new Builder();
  for (let i = 0; i < 3; i++) {
    b.cyl(1.05, 1.05, 0.9, 0xffffff, [0, 1.1, -3.6 + i * 3.6], [0, 0, Math.PI / 2], 16);
    b.cyl(0.45, 0.45, 0.94, C.darkSteel, [0, 1.1, -3.6 + i * 3.6], [0, 0, Math.PI / 2], 12);
  }
  return b.build();
});
reg('cargo_crates', () => {
  const b = new Builder(); const r = rng(19);
  for (let i = 0; i < 9; i++) {
    const s = 1.1 + r() * 0.5;
    b.box(s, s, s, 0xffffff, [(r() - 0.5) * 1.6, s / 2 + (i > 5 ? 1.2 : 0), -4.5 + (i % 6) * 1.8], [0, r() * 0.4, 0], 0.1);
  }
  return b.build();
});

/* ------------------------------------------------------------- vegetation */
function conifer(seed, scale = 1) {
  const b = new Builder(); const r = rng(seed);
  const h = (7 + r() * 5) * scale;
  b.cyl(0.22 * scale, 0.34 * scale, h * 0.42, 0x4a3524, [0, h * 0.21, 0], [0, 0, 0], 6);
  const tiers = 4;
  for (let i = 0; i < tiers; i++) {
    const t = i / tiers;
    const rad = (2.5 - t * 1.7) * scale * (0.9 + r() * 0.2);
    const y = h * (0.3 + t * 0.62);
    b.cone(rad, h * 0.34, 0xffffff, [0, y, 0], [0, r() * 3, 0], 7, 0.14);
  }
  return b.build();
}
function deciduous(seed, scale = 1) {
  const b = new Builder(); const r = rng(seed);
  const h = (6 + r() * 4) * scale;
  b.cyl(0.24 * scale, 0.4 * scale, h * 0.55, 0x54402a, [0, h * 0.27, 0], [0, 0, 0], 6);
  for (let i = 0; i < 4; i++) {
    const rad = (1.7 + r() * 1.1) * scale;
    b.sphere(rad, 0xffffff, [(r() - 0.5) * 1.9 * scale, h * (0.6 + r() * 0.28), (r() - 0.5) * 1.9 * scale], 7, 5, 0.18);
  }
  return b.build();
}
function deadTree(seed, scale = 1) {
  const b = new Builder(); const r = rng(seed);
  const h = (5 + r() * 4) * scale;
  b.cyl(0.16 * scale, 0.4 * scale, h, 0x5b5348, [0, h / 2, 0], [0, 0, 0], 6, 0.1);
  for (let i = 0; i < 5; i++) {
    const y = h * (0.45 + r() * 0.5), a = r() * Math.PI * 2;
    b.cyl(0.05 * scale, 0.12 * scale, 1.6 * scale, 0x5b5348,
      [Math.cos(a) * 0.7 * scale, y, Math.sin(a) * 0.7 * scale], [Math.sin(a) * 0.9, 0, Math.cos(a) * 0.9], 5, 0.1);
  }
  return b.build();
}
for (let i = 0; i < 3; i++) {
  reg(`tree_conifer_${i}`, () => conifer(101 + i * 37, 0.85 + i * 0.2));
  reg(`tree_deciduous_${i}`, () => deciduous(211 + i * 53, 0.85 + i * 0.18));
  reg(`tree_dead_${i}`, () => deadTree(307 + i * 29, 0.8 + i * 0.2));
}
reg('bush', () => {
  const b = new Builder(); const r = rng(5);
  for (let i = 0; i < 3; i++) b.sphere(0.6 + r() * 0.5, 0xffffff, [(r() - 0.5) * 1.1, 0.4 + r() * 0.3, (r() - 0.5) * 1.1], 6, 4, 0.2);
  return b.build();
});
reg('rock_small', () => {
  const b = new Builder(); const r = rng(9);
  const g = new THREE.DodecahedronGeometry(0.9, 0);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setXYZ(i, pos.getX(i) * (0.7 + r() * 0.6), pos.getY(i) * (0.5 + r() * 0.5), pos.getZ(i) * (0.7 + r() * 0.6));
  g.computeVertexNormals();
  b.add(g, 0xffffff, [0, 0.25, 0], [0, 0, 0], 0.16);
  return b.build();
});
reg('rock_large', () => {
  const b = new Builder(); const r = rng(23);
  for (let i = 0; i < 3; i++) {
    const g = new THREE.DodecahedronGeometry(2.2 - i * 0.5, 0);
    const pos = g.attributes.position;
    for (let k = 0; k < pos.count; k++) pos.setXYZ(k, pos.getX(k) * (0.7 + r() * 0.7), pos.getY(k) * (0.55 + r() * 0.6), pos.getZ(k) * (0.7 + r() * 0.7));
    g.computeVertexNormals();
    b.add(g, 0xffffff, [(r() - 0.5) * 2, 0.6 + i * 0.9, (r() - 0.5) * 2], [r(), r() * 3, r()], 0.14);
  }
  return b.build();
});
reg('reeds', () => {
  const b = new Builder(); const r = rng(31);
  for (let i = 0; i < 14; i++) b.cyl(0.02, 0.05, 1.1 + r() * 0.8, 0xffffff, [(r() - 0.5) * 1.6, 0.6, (r() - 0.5) * 1.6], [(r() - 0.5) * 0.3, 0, (r() - 0.5) * 0.3], 4, 0.2);
  return b.build();
});
reg('wheat', () => {
  const b = new Builder(); const r = rng(41);
  for (let i = 0; i < 10; i++) b.cone(0.09, 0.85 + r() * 0.3, 0xffffff, [(r() - 0.5) * 1.8, 0.42, (r() - 0.5) * 1.8], [0, 0, 0], 4, 0.18);
  return b.build();
});

/* ------------------------------------------------------------- structures */
reg('buffer_stop', () => {
  const b = new Builder();
  b.box(3.0, 0.9, 0.3, C.red, [0, 0.75, 0]);
  b.box(3.2, 0.22, 1.5, C.darkSteel, [0, 0.35, -0.6]);
  for (const s of [-1, 1]) b.box(0.22, 1.0, 1.2, C.steel, [s * 1.2, 0.6, -0.6]);
  b.box(0.5, 0.5, 0.16, C.white, [1.0, 0.78, 0.18]);
  b.box(0.5, 0.5, 0.16, C.white, [-1.0, 0.78, 0.18]);
  return b.build();
});

reg('signal_post', () => {
  const b = new Builder();
  b.cyl(0.09, 0.14, 5.4, C.darkSteel, [0, 2.7, 0], [0, 0, 0], 8);
  b.box(0.7, 1.5, 0.4, C.black, [0, 5.4, 0]);
  b.sphere(0.19, 0x33ff55, [0, 5.85, 0.22], 8, 6);
  b.sphere(0.19, 0xffcc33, [0, 5.4, 0.22], 8, 6);
  b.sphere(0.19, 0xff3322, [0, 4.95, 0.22], 8, 6);
  b.box(1.0, 0.1, 0.1, C.yellow, [0, 4.3, 0]);
  b.box(0.9, 0.5, 0.5, C.concrete, [0, 0.25, 0]);
  return b.build();
});

reg('station_small', () => {
  const b = new Builder();
  b.box(14, 4.2, 6.5, C.brick, [0, 2.1, 0], [0, 0, 0], 0.05);
  b.prism(7.6, 2.2, 14.6, C.roof, [0, 4.2, 0], [0, Math.PI / 2, 0]);
  for (let i = 0; i < 4; i++) {
    b.box(1.1, 1.5, 0.14, C.glass, [-4.6 + i * 3.05, 2.4, 3.3]);
    b.box(1.1, 1.5, 0.14, C.glass, [-4.6 + i * 3.05, 2.4, -3.3]);
  }
  b.box(1.4, 2.3, 0.16, C.darkWood, [5.6, 1.15, 3.3]);
  b.box(9, 0.3, 3.4, C.concrete, [0, 0.15, 5.0]);
  b.box(9.6, 2.0, 0.16, C.roof, [0, 4.0, 5.6]);
  for (const s of [-1, 1]) b.cyl(0.12, 0.12, 2.4, C.darkSteel, [s * 4.4, 2.0, 5.6], [0, 0, 0], 6);
  b.box(3.0, 0.7, 0.12, C.cream, [0, 3.6, 3.36]);
  b.box(1.6, 2.4, 1.6, C.brick, [4.6, 5.4, -1.4]);
  b.prism(2.0, 0.9, 2.0, C.roof, [4.6, 6.6, -1.4], [0, 0, 0]);
  return b.build();
});

reg('station_large', () => {
  const b = new Builder();
  b.box(24, 5.4, 8, C.brick, [0, 2.7, 0], [0, 0, 0], 0.05);
  b.box(24.6, 0.5, 8.6, C.cream, [0, 5.5, 0]);
  b.prism(9.2, 2.6, 25, C.roof, [0, 5.7, 0], [0, Math.PI / 2, 0]);
  for (let i = 0; i < 7; i++) {
    b.box(1.5, 2.2, 0.16, C.glass, [-9 + i * 3, 2.8, 4.05]);
    b.box(1.5, 2.2, 0.16, C.glass, [-9 + i * 3, 2.8, -4.05]);
  }
  b.box(2.2, 3.0, 0.2, C.darkWood, [8.4, 1.5, 4.05]);
  b.box(22, 0.5, 5, C.concrete, [0, 0.25, 6.6]);
  b.box(24, 0.3, 6.4, C.roof, [0, 5.0, 6.8]);
  for (let i = 0; i < 8; i++) b.cyl(0.16, 0.16, 5, C.darkSteel, [-10.5 + i * 3, 2.5, 9.4], [0, 0, 0], 6);
  b.box(2.6, 8.5, 2.6, C.brick, [9.5, 4.25, -2.5]);
  b.prism(3.2, 1.4, 3.2, C.roof, [9.5, 8.5, -2.5]);
  b.box(5, 1.0, 0.16, C.cream, [0, 4.6, 4.1]);
  return b.build();
});

reg('warehouse', () => {
  const b = new Builder();
  b.box(18, 6, 11, 0x8d8577, [0, 3, 0], [0, 0, 0], 0.05);
  b.prism(11.6, 2.6, 18.4, C.roof, [0, 6, 0], [0, Math.PI / 2, 0]);
  b.box(4.4, 4.4, 0.2, C.darkWood, [0, 2.2, 5.55]);
  for (const s of [-1, 1]) b.box(1.6, 1.4, 0.16, C.glass, [s * 6, 4, 5.55]);
  return b.build();
});

reg('grain_elevator', () => {
  const b = new Builder();
  b.box(9, 30, 9, C.concrete, [0, 15, 0], [0, 0, 0], 0.04);
  b.prism(10, 3, 10, C.roof, [0, 30, 0]);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) {
    b.cyl(3, 3, 24, C.concrete, [-3 + i * 3 + 6.6, 12, -2.4 + j * 4.8], [0, 0, 0], 12);
  }
  b.box(3.2, 18, 3.2, C.concrete, [-6.4, 9, 0]);
  b.box(14, 1.6, 2.2, C.steel, [0, 26, 5.6], [0.22, 0, 0]);
  b.box(6, 4, 6, 0x7d7568, [0, 2, 8]);
  return b.build();
});

reg('water_tower', () => {
  const b = new Builder();
  b.cyl(3.2, 3.2, 5.4, C.darkWood, [0, 8.4, 0], [0, 0, 0], 14);
  b.cone(3.8, 1.8, C.roof, [0, 12, 0], [0, 0, 0], 14);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    b.box(0.3, 8.4, 0.3, C.wood, [Math.cos(a) * 2.6, 4.2, Math.sin(a) * 2.6]);
  }
  for (let i = 0; i < 3; i++) b.box(6.4, 0.22, 0.22, C.wood, [0, 2 + i * 3, 0], [0, i * 0.7, 0]);
  b.cyl(0.4, 0.4, 4.5, C.steel, [0, 3.4, 2.8], [0.5, 0, 0], 8);
  return b.build();
});

reg('house', () => {
  const b = new Builder(); const r = rng(Math.floor(Math.random() * 999));
  const w = 6 + r() * 3, d = 5 + r() * 3, h = 3 + r() * 1.2;
  const wall = [0xc9b79a, 0xa8876a, 0xd6cdb8, 0x8f9c8a][Math.floor(r() * 4)];
  b.box(w, h, d, wall, [0, h / 2, 0], [0, 0, 0], 0.05);
  b.prism(d + 0.8, 1.8, w + 0.8, C.roof, [0, h, 0], [0, Math.PI / 2, 0]);
  b.box(1.0, 1.2, 0.12, C.glass, [w * 0.24, h * 0.6, d / 2 + 0.05]);
  b.box(1.0, 1.2, 0.12, C.glass, [-w * 0.24, h * 0.6, d / 2 + 0.05]);
  b.box(1.0, 2.0, 0.14, C.darkWood, [0, 1.0, d / 2 + 0.06]);
  b.box(0.8, 1.8, 0.8, C.brick, [w * 0.3, h + 1.2, -d * 0.2]);
  return b.build();
});

reg('foundry', () => {
  const b = new Builder();
  b.box(30, 10, 16, 0x6f6a63, [0, 5, 0], [0, 0, 0], 0.05);
  b.prism(17, 4, 30.6, C.roof, [0, 10, 0], [0, Math.PI / 2, 0]);
  for (let i = 0; i < 3; i++) b.cyl(1.5, 1.8, 16, C.brick, [-9 + i * 9, 15, -4], [0, 0, 0], 12);
  b.box(6, 6, 0.3, 0x2b2b2b, [0, 3, 8.1]);
  b.box(34, 0.4, 20, C.concrete, [0, 0.2, 0]);
  for (let i = 0; i < 5; i++) b.box(2.2, 2.2, 0.2, C.glass, [-12 + i * 6, 6.5, 8.1]);
  b.box(10, 4, 8, 0x7d7568, [16, 2, 6]);
  return b.build();
});

reg('mine_head', () => {
  const b = new Builder();
  b.box(16, 7, 12, 0x5f5a52, [0, 3.5, 0], [0, 0, 0], 0.05);
  for (let i = 0; i < 4; i++) {
    const x = (i % 2 ? 1 : -1) * 4, z = (i > 1 ? 1 : -1) * 4;
    b.box(0.7, 22, 0.7, C.darkSteel, [x, 11, z], [0, 0, 0]);
  }
  for (let i = 0; i < 4; i++) b.box(0.35, 9, 0.35, C.darkSteel, [0, 16, 0], [i * 0.4, i * 0.8, 0.5]);
  b.box(11, 1.2, 11, C.steel, [0, 22, 0]);
  b.cyl(2.2, 2.2, 1.0, C.wheel, [0, 23.4, 0], [0, 0, Math.PI / 2], 14);
  b.box(20, 0.5, 3, C.darkSteel, [0, 3, 8]);
  b.prism(13, 3, 16.6, C.roof, [0, 7, 0], [0, Math.PI / 2, 0]);
  return b.build();
});

reg('crane', () => {
  const b = new Builder();
  b.box(3, 14, 3, C.yellow, [0, 7, 0]);
  b.box(26, 1.6, 2.2, C.yellow, [4, 14.4, 0]);
  b.box(2.4, 2.4, 6, C.darkSteel, [-4, 12.6, 0]);
  b.box(0.3, 7, 0.3, C.steel, [14, 10.6, 0]);
  b.box(3, 2, 3, C.steel, [14, 6.6, 0]);
  b.box(6, 1.2, 6, C.concrete, [0, 0.6, 0]);
  return b.build();
});

reg('silo', () => {
  const b = new Builder();
  b.cyl(4, 4, 18, C.concrete, [0, 9, 0], [0, 0, 0], 16);
  b.cone(4.4, 3.4, C.roof, [0, 19.4, 0], [0, 0, 0], 16);
  b.box(1.4, 12, 1.4, C.steel, [4.6, 6, 0]);
  return b.build();
});

reg('lighthouse', () => {
  const b = new Builder();
  b.cyl(2.2, 3.4, 22, C.white, [0, 11, 0], [0, 0, 0], 16);
  for (let i = 0; i < 4; i++) b.cyl(2.5 - i * 0.08, 2.9 - i * 0.1, 1.6, C.red, [0, 3.4 + i * 5.2, 0], [0, 0, 0], 16);
  b.cyl(2.8, 2.8, 2.2, C.darkSteel, [0, 23, 0], [0, 0, 0], 14);
  b.sphere(1.5, 0xfff2b0, [0, 23, 0], 12, 8);
  b.cone(3.2, 2.6, C.red, [0, 25.2, 0], [0, 0, 0], 14);
  b.box(6, 0.6, 6, C.concrete, [0, 0.3, 0]);
  return b.build();
});

reg('ruin', () => {
  const b = new Builder(); const r = rng(77);
  b.box(22, 0.8, 16, 0x6b6a63, [0, 0.4, 0]);
  for (let i = 0; i < 9; i++) {
    const h = 3 + r() * 9;
    b.box(2.4 + r() * 2, h, 2.2 + r() * 2, 0x7d7367,
      [(r() - 0.5) * 18, h / 2 + 0.8, (r() - 0.5) * 12], [0, r() * 0.5, (r() - 0.5) * 0.06], 0.08);
  }
  b.cyl(1.6, 1.8, 14, 0x776c60, [7, 7.8, -4], [0, 0, 0], 10);
  b.box(4, 6, 4, 0x6f6558, [-8, 3.8, 4]);
  return b.build();
});

reg('rockarch', () => {
  const b = new Builder();
  for (const s of [-1, 1]) {
    b.box(7, 26, 9, 0x8a7f6d, [s * 13, 13, 0], [0, 0, s * 0.04], 0.08);
    b.box(9, 6, 11, 0x8a7f6d, [s * 15, 2, 0], [0, 0, 0], 0.08);
  }
  b.box(34, 6, 8, 0x8f8471, [0, 27, 0], [0, 0, 0], 0.07);
  b.box(30, 2.5, 6, 0x7d7361, [0, 23.6, 0]);
  return b.build();
});

reg('waterfall', () => {
  const b = new Builder();
  b.box(12, 34, 3, 0x7f7566, [0, 17, -1.5], [0, 0, 0], 0.07);
  b.box(16, 3, 8, 0x77695c, [0, 1, 2]);
  return b.build();
});

/* ---------------------------------------------------- bridges and tunnels */
reg('truss_span', () => {
  const b = new Builder(); const L = 20;
  for (const s of [-1, 1]) {
    b.box(0.4, 0.5, L, C.darkSteel, [s * 1.9, 0.4, 0]);
    b.box(0.4, 0.5, L, C.darkSteel, [s * 1.9, 5.2, 0]);
    for (let i = 0; i < 5; i++) {
      const z = -L / 2 + i * (L / 4);
      b.box(0.3, 5.0, 0.3, C.darkSteel, [s * 1.9, 2.8, z]);
      b.box(0.26, 6.6, 0.26, C.steel, [s * 1.9, 2.8, z + L / 8], [0.72, 0, 0]);
      b.box(0.26, 6.6, 0.26, C.steel, [s * 1.9, 2.8, z + L / 8], [-0.72, 0, 0]);
    }
  }
  for (let i = 0; i < 5; i++) b.box(4.2, 0.3, 0.3, C.darkSteel, [0, 5.2, -L / 2 + i * (L / 4)]);
  b.box(4.6, 0.3, L, C.darkSteel, [0, 0.15, 0]);
  return b.build();
});

reg('pier', () => {
  // masonry viaduct pier, 10 m nominal — scaled in Y to reach the valley floor
  const b = new Builder();
  b.trapezoid(3.0, 4.4, 10, 3.0, 0x8b8375, [0, 5, 0]);
  b.box(4.8, 0.7, 4.8, 0x7d7568, [0, 10.1, 0]);
  b.box(5.0, 0.5, 5.0, 0x6f6a5f, [0, 0.25, 0]);
  for (let i = 0; i < 5; i++) b.box(3.2, 0.12, 3.2, 0x7a7264, [0, 2 + i * 1.9, 0]);
  return b.build();
});

reg('trestle_bent', () => {
  const b = new Builder();
  const H = 10;
  for (const s of [-1, 1]) {
    b.box(0.5, H, 0.5, C.wood, [s * 2.4, H / 2, 0], [0, 0, s * 0.09]);
    b.box(0.4, H * 0.92, 0.4, C.wood, [s * 1.3, H * 0.46, 0], [0, 0, s * 0.05]);
  }
  for (let i = 0; i < 5; i++) {
    const y = 1 + i * (H / 5);
    b.box(5.4, 0.3, 0.3, C.wood, [0, y, 0]);
    b.box(0.3, 0.3, 3.4, C.wood, [2.4, y, 0]);
    b.box(0.3, 0.3, 3.4, C.wood, [-2.4, y, 0]);
    if (i < 4) b.box(4.6, 0.22, 0.22, C.darkWood, [0, y + 0.9, 0], [0.34, 0, 0]);
  }
  b.box(6.4, 0.6, 1.2, C.darkWood, [0, H + 0.2, 0]);
  return b.build();
});

reg('tunnel_portal', () => {
  const b = new Builder();
  const rock = 0x6f6a60;
  b.box(13, 9, 3.4, rock, [0, 4.5, 0], [0, 0, 0], 0.09);
  // arch opening built from segments
  for (let i = 0; i < 12; i++) {
    const a = (i / 11) * Math.PI;
    b.box(0.9, 1.2, 3.6, 0x5d574e, [Math.cos(a) * 3.1, 1.6 + Math.sin(a) * 3.4, 0], [0, 0, a - Math.PI / 2], 0.06);
  }
  b.box(8, 1.4, 3.8, rock, [0, 0.7, 0]);
  b.box(14.4, 1.2, 4.0, 0x7d776b, [0, 9.4, 0]);
  for (const s of [-1, 1]) b.box(2.6, 11, 5, rock, [s * 6.6, 5.5, -0.6], [0, 0, 0], 0.1);
  return b.build();
});

reg('covered_bridge', () => {
  const b = new Builder(); const L = 26;
  b.box(6.2, 0.5, L, C.darkWood, [0, 0.25, 0]);
  for (const s of [-1, 1]) {
    b.box(0.5, 4.6, L, C.wood, [s * 2.9, 2.6, 0], [0, 0, 0], 0.06);
    for (let i = 0; i < 9; i++) b.box(0.6, 0.5, 0.5, C.darkWood, [s * 2.9, 3.4, -L / 2 + 1.5 + i * (L - 3) / 8]);
  }
  b.prism(7.4, 2.0, L, C.roof, [0, 4.9, 0], [0, 0, 0]);
  b.box(6.4, 0.4, 0.6, C.darkWood, [0, 5.0, L / 2]);
  return b.build();
});

reg('swing_span', () => {
  const b = new Builder(); const L = 30;
  b.box(5.2, 0.7, L, C.darkSteel, [0, 0.35, 0]);
  for (const s of [-1, 1]) {
    b.box(0.4, 2.6, L, C.steel, [s * 2.4, 1.9, 0]);
    for (let i = 0; i < 7; i++) b.box(0.3, 3.2, 0.3, C.darkSteel, [s * 2.4, 1.8, -L / 2 + 2 + i * (L - 4) / 6]);
  }
  b.box(3.4, 3.4, 5, C.red, [0, 3.6, 0]);
  b.prism(4.2, 1.6, 5.4, C.roof, [0, 5.3, 0], [0, Math.PI / 2, 0]);
  b.cyl(0.2, 0.2, 6, C.steel, [0, 8, 0], [0, 0, 0], 6);
  return b.build();
});

reg('causeway_wall', () => {
  const b = new Builder();
  b.trapezoid(5.4, 9.0, 3.0, 12, C.ballast, [0, 1.5, 0]);
  b.box(5.6, 0.3, 12, 0x5f5a4f, [0, 3.05, 0]);
  return b.build();
});

reg('level_crossing', () => {
  const b = new Builder();
  b.box(9, 0.14, 6.4, 0x4a4a4a, [0, 0.07, 0]);
  for (let i = 0; i < 5; i++) b.box(9, 0.1, 0.5, C.wood, [0, 0.16, -2.4 + i * 1.2]);
  for (const s of [-1, 1]) {
    b.cyl(0.11, 0.14, 4.2, C.white, [s * 5.4, 2.1, 0], [0, 0, 0], 8);
    b.box(1.9, 0.5, 0.14, C.red, [s * 5.4, 4.0, 0], [0, 0, 0.6]);
    b.box(1.9, 0.5, 0.14, C.red, [s * 5.4, 4.0, 0], [0, 0, -0.6]);
    b.sphere(0.24, 0xff3020, [s * 5.4 + 0.5, 3.5, 0.14], 8, 6);
    b.sphere(0.24, 0xff3020, [s * 5.4 - 0.5, 3.5, 0.14], 8, 6);
  }
  return b.build();
});

reg('platform', () => {
  const b = new Builder();
  b.box(9, 1.0, 44, C.concrete, [0, 0.5, 0], [0, 0, 0], 0.06);
  b.box(9.2, 0.16, 44.2, 0x83796c, [0, 1.02, 0]);
  b.box(0.3, 0.3, 44, C.yellow, [4.2, 1.08, 0]);
  for (let i = 0; i < 5; i++) {
    b.cyl(0.14, 0.14, 4.6, C.darkSteel, [-3.4, 3.3, -18 + i * 9], [0, 0, 0], 6);
    b.sphere(0.34, 0xffe6a8, [-3.4, 5.7, -18 + i * 9], 8, 6);
  }
  b.box(5, 2.6, 8, C.wood, [-1.4, 2.3, 8]);
  b.prism(6, 1.2, 9, C.roof, [-1.4, 3.6, 8], [0, Math.PI / 2, 0]);
  for (let i = 0; i < 4; i++) b.box(2.4, 0.5, 0.7, C.wood, [-1.4, 0.5 + 1.1, 5.5 + i * 1.8]);
  return b.build();
});

reg('locked_sign', () => {
  const b = new Builder();
  b.cyl(0.12, 0.14, 3.4, C.darkSteel, [0, 1.7, 0], [0, 0, 0], 8);
  b.box(3.4, 1.6, 0.14, C.red, [0, 3.2, 0]);
  b.box(3.0, 1.2, 0.18, C.white, [0, 3.2, 0.04]);
  b.box(0.24, 0.9, 0.2, C.red, [0, 3.2, 0.16]);
  return b.build();
});

reg('station_sign', () => {
  const b = new Builder();
  for (const s of [-1, 1]) b.cyl(0.09, 0.11, 3.0, C.darkSteel, [s * 1.9, 1.5, 0], [0, 0, 0], 6);
  b.box(5.2, 1.3, 0.18, C.cream, [0, 2.7, 0]);
  b.box(5.4, 0.16, 0.26, C.darkWood, [0, 3.4, 0]);
  b.box(5.4, 0.16, 0.26, C.darkWood, [0, 2.0, 0]);
  for (let i = 0; i < 9; i++) b.box(0.3, 0.24, 0.06, C.black, [-1.9 + i * 0.47, 2.75, 0.11]);
  return b.build();
});

reg('cab_desk', () => {
  // The engineer's console, shown in cab view. Origin at the cab floor, top of
  // the desk at y = 0.95 so the gauges sit just under the eye line.
  const b = new Builder();
  b.box(1.92, 0.86, 0.52, C.darkSteel, [0, 0.43, 0]);
  b.box(2.02, 0.06, 0.62, C.steel, [0, 0.88, 0]);
  // sloped gauge panel
  b.box(1.7, 0.34, 0.05, C.black, [0, 0.76, -0.2], [-0.62, 0, 0]);
  const gauges = [[-0.55, 0.79], [-0.18, 0.79], [0.19, 0.79], [0.56, 0.79]];
  for (const [x, y] of gauges) {
    b.cyl(0.11, 0.11, 0.03, C.cream, [x, y, -0.185], [-0.62 + Math.PI / 2, 0, 0], 12);
    b.box(0.012, 0.09, 0.012, C.black, [x, y + 0.02, -0.16], [-0.62, 0, 0.7]);
  }
  // throttle lever on the right, brake valve on the left
  b.box(0.07, 0.34, 0.07, C.steel, [0.72, 1.02, 0.02], [0, 0, -0.22]);
  b.sphere(0.07, C.yellow, [0.755, 1.19, -0.055], 8, 6);
  b.cyl(0.05, 0.05, 0.3, C.steel, [-0.72, 1.02, 0.02], [0, 0, 0.18], 8);
  b.sphere(0.075, C.red, [-0.775, 1.17, 0.02], 8, 6);
  // a mug, because every cab has one
  b.cyl(0.05, 0.045, 0.1, C.white, [0.42, 0.96, 0.14], [0, 0, 0], 8);
  return b.build();
});

reg('peakmarker', () => {
  // A summit cairn with a survey post and a name board — the two named peaks
  // (Mount Ferrant, Sentinel Peak) are marked with these.
  const b = new Builder();
  b.box(1.55, 0.55, 1.35, 0x6b6f73, [0, 0.28, 0], [0, 0.22, 0], 0.07);
  b.box(1.18, 0.5, 1.02, 0x777b7f, [0.06, 0.79, -0.05], [0, -0.36, 0], 0.07);
  b.box(0.88, 0.44, 0.8, 0x6f7377, [-0.04, 1.23, 0.04], [0, 0.52, 0], 0.06);
  b.box(0.58, 0.36, 0.52, 0x7d8185, [0.02, 1.59, -0.01], [0, -0.2, 0], 0.06);
  b.sphere(0.14, 0xc8a44a, [0, 1.85, 0], 8, 6);            // the survey pin
  b.cyl(0.07, 0.095, 2.7, C.darkWood, [0, 3.05, 0], [0, 0, 0], 7);
  b.box(1.62, 0.66, 0.1, C.cream, [0, 3.72, 0.07]);
  b.box(1.74, 0.12, 0.16, C.darkWood, [0, 4.09, 0.07]);
  b.box(1.74, 0.12, 0.16, C.darkWood, [0, 3.35, 0.07]);
  for (let i = 0; i < 7; i++) b.box(0.13, 0.2, 0.05, C.black, [-0.55 + i * 0.19, 3.78, 0.13]);
  b.box(0.34, 0.3, 0.06, C.black, [0, 3.56, 0.13]);
  return b.build();
});

reg('fence', () => {
  const b = new Builder();
  for (let i = 0; i < 4; i++) b.box(0.16, 1.3, 0.16, C.wood, [-4.5 + i * 3, 0.65, 0]);
  b.box(10, 0.12, 0.1, C.wood, [0, 1.1, 0]);
  b.box(10, 0.12, 0.1, C.wood, [0, 0.6, 0]);
  return b.build();
});

reg('person', () => {
  const b = new Builder(); const r = rng(Math.floor(Math.random() * 500));
  const shirt = [0x3f6b8f, 0x8f4a3f, 0x4a6b3f, 0x6b5f8f, 0x8f7f3f][Math.floor(r() * 5)];
  b.cyl(0.12, 0.14, 0.75, 0x33414d, [0, 0.4, 0], [0, 0, 0], 6);
  b.box(0.42, 0.6, 0.26, shirt, [0, 1.05, 0]);
  b.sphere(0.17, 0xd9a882, [0, 1.52, 0], 8, 6);
  b.sphere(0.19, 0x2b2b2b, [0, 1.6, 0], 8, 4);
  return b.build();
});

/* --------------------------------------------------------------- track bits */
reg('tie', () => {
  const b = new Builder();
  b.box(2.6, 0.16, 0.24, C.tie, [0, 0.08, 0], [0, 0, 0], 0.12);
  return b.build();
});

reg('rail_profile', () => {
  // 1 m of rail running along +Z, railhead at y = 0.17
  const b = new Builder();
  b.box(0.07, 0.16, 1.0, C.rail, [0, 0.24, 0]);
  b.box(0.13, 0.05, 1.0, C.rail, [0, 0.17, 0]);
  b.box(0.05, 0.14, 1.0, C.darkSteel, [0, 0.09, 0]);
  return b.build();
});

reg('ballast_bed', () => {
  const b = new Builder();
  b.trapezoid(3.3, 4.6, 0.42, 1.0, C.ballast, [0, 0.16, 0]);
  return b.build();
});

reg('turnout_blade', () => {
  const b = new Builder();
  b.box(0.09, 0.14, 6.5, C.rail, [0, 0.22, 0]);
  return b.build();
});

export default AssetManager;
