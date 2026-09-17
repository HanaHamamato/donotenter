/**
 * Procedural world heightfield + hydrology for THE IRON REACHES (GDD §2.1/§2.2).
 *
 * Pure JS + deterministic noise. The *same* module is imported by
 *   • tools/gen-world.mjs        — lays the track on the land (Node),
 *   • systems/TerrainManager.js  — builds chunk meshes (browser),
 *   • systems/WaterManager.js    — builds sea planes and river ribbons,
 * so offline-generated track data always agrees with runtime terrain.
 *
 * Deviation from GDD §5.2.1 (64 heightmap PNGs): heights come from a seeded
 * noise field. Keeps the repo far below the 50 MB asset budget (GDD §12.3) and
 * lets the land be carved around the track (cuts, embankments, bridge ramps).
 */
import { fbm, ridged, noise2, hash2, distanceToPolyline } from './noise.js';
import { clamp01, smoothstep, lerp } from './math.js';
import { WORLD } from '../constants.js';

/* ---------------------------------------------------------- biome layout */
const SEEDS = {
  alpine: [[-3000, -5500], [1500, -5000], [-5500, -3500], [4500, -5600], [-1400, -6600], [6200, -6200]],
  forest: [[3600, -2100], [200, 200], [-1200, -1800], [-3200, -700], [5200, -2600], [1800, -600]],
  plains: [[-1600, 2800], [1000, 2600], [-4400, 400], [-3200, 2200], [3200, 1600], [-6200, 1800], [5600, 1200]],
  coastal: [[-2800, 5400], [2600, 5800], [600, 4700], [5200, 5000], [-5200, 5800], [6400, 3200], [-6400, 4200]],
};
const BIOME_KEYS = ['alpine', 'forest', 'plains', 'coastal'];
const SIGMA = 2500;
const GAMMA = 1.55;

const BIOME_SHAPE = {
  alpine: { base: 300, fbmAmp: 70, ridgeAmp: 250, freq: 0.00042 },
  forest: { base: 168, fbmAmp: 95, ridgeAmp: 0, freq: 0.00055 },
  plains: { base: 78, fbmAmp: 26, ridgeAmp: 0, freq: 0.00075 },
  coastal: { base: 13, fbmAmp: 8, ridgeAmp: 0, freq: 0.0009 },
};

const GRID_STEP = 200;
const GRID_N = Math.ceil(WORLD.size / GRID_STEP) + 1;
const WEIGHT_GRID = new Float32Array(GRID_N * GRID_N * 4);

for (let iz = 0; iz < GRID_N; iz++) {
  for (let ix = 0; ix < GRID_N; ix++) {
    const x = -WORLD.half + ix * GRID_STEP;
    const z = -WORLD.half + iz * GRID_STEP;
    const w = [0, 0, 0, 0];
    for (let b = 0; b < 4; b++) {
      let acc = 0;
      for (const [sx, sz] of SEEDS[BIOME_KEYS[b]]) {
        const dx = x - sx, dz = z - sz;
        acc += Math.exp(-(dx * dx + dz * dz) / (2 * SIGMA * SIGMA));
      }
      w[b] = Math.pow(acc, GAMMA);
    }
    const sum = w[0] + w[1] + w[2] + w[3];
    const o = (iz * GRID_N + ix) * 4;
    if (sum < 1e-12) { WEIGHT_GRID[o + 2] = 1; continue; }
    WEIGHT_GRID[o] = w[0] / sum; WEIGHT_GRID[o + 1] = w[1] / sum;
    WEIGHT_GRID[o + 2] = w[2] / sum; WEIGHT_GRID[o + 3] = w[3] / sum;
  }
}

/** Bilinear biome weights; the four values sum to 1. */
export function biomeWeights(x, z, out = { alpine: 0, forest: 0, plains: 0, coastal: 0 }) {
  const gx = clamp01((x + WORLD.half) / WORLD.size) * (GRID_N - 1);
  const gz = clamp01((z + WORLD.half) / WORLD.size) * (GRID_N - 1);
  const ix = gx | 0, iz = gz | 0;
  const jx = Math.min(GRID_N - 1, ix + 1), jz = Math.min(GRID_N - 1, iz + 1);
  const fx = gx - ix, fz = gz - iz;
  const a = (1 - fx) * (1 - fz), b = fx * (1 - fz), c = (1 - fx) * fz, d = fx * fz;
  const i00 = (iz * GRID_N + ix) * 4, i10 = (iz * GRID_N + jx) * 4;
  const i01 = (jz * GRID_N + ix) * 4, i11 = (jz * GRID_N + jx) * 4;
  for (let k = 0; k < 4; k++) {
    out[BIOME_KEYS[k]] = WEIGHT_GRID[i00 + k] * a + WEIGHT_GRID[i10 + k] * b
      + WEIGHT_GRID[i01 + k] * c + WEIGHT_GRID[i11 + k] * d;
  }
  return out;
}

const _w = { alpine: 0, forest: 0, plains: 0, coastal: 0 };

export function biomeAt(x, z) {
  const w = biomeWeights(x, z, _w);
  let best = 'plains', bv = -1;
  for (const k of BIOME_KEYS) if (w[k] > bv) { bv = w[k]; best = k; }
  return best;
}

/** Gameplay region == biome for this world (GDD §2.2 four regions). */
export function regionAt(x, z) { return biomeAt(x, z); }

/* ------------------------------------------------------------- hydrology */
/** Alder River: alpine headwaters → forest → plains → sea. */
export const RIVER = [
  [-1400, -4200], [-950, -3100], [-380, -2150], [420, -1300], [1240, -620],
  [2050, 520], [2380, 1650], [2880, 2850], [3250, 4050], [2950, 5150],
  [2150, 6150], [1150, 6950], [400, 7600],
];

/** Alder Creek: forest tributary joining the river near the covered bridge. */
export const CREEK = [
  [-1950, -2750], [-1320, -2020], [-760, -1420], [-260, -900], [300, -560], [900, -520],
];

/** Tidal inlet separating Portmouth from the coastal line — the swing bridge spans it. */
export const INLET = [
  [620, 7700], [240, 7000], [-160, 6560], [-560, 6240], [-1120, 5980], [-1760, 5620], [-2260, 5150],
];

/** Dry gorge in the alpine; the Pine Pass ↔ Snowpeak line crosses it on the trestle. */
export const GORGE = [
  [-700, -7000], [-520, -6100], [-330, -5300], [-210, -4700], [60, -3900], [420, -3100], [900, -2400],
];

export const BASINS = [
  { id: 'harbour', x: -2900, z: 6550, rInner: 380, rOuter: 1450, bed: -9, level: 0, name: 'Portmouth Harbour' },
  { id: 'marshwick_bay', x: 2900, z: 7300, rInner: 520, rOuter: 1800, bed: -7, level: 0, name: 'Marshwick Bay' },
  { id: 'lagoon', x: 650, z: 4500, rInner: 300, rOuter: 1500, bed: 18, level: 26, name: 'Glass Lagoon' },
];

export function coastlineZ(x) { return 6500 + 420 * Math.sin(x * 0.00035) + 260 * Math.sin(x * 0.00011 + 2.1); }
export function coastlineX(z) { return 7100 + 380 * Math.sin(z * 0.0004 + 1.3); }

/** Watercourses: carved channels with a computed surface level. */
const CHANNELS = [
  { id: 'alder_river', name: 'Alder River', poly: RIVER, width: 34, depth: 5.5, tidal: false },
  { id: 'alder_creek', name: 'Alder Creek', poly: CREEK, width: 17, depth: 3.6, tidal: false },
  { id: 'portmouth_inlet', name: 'Portmouth Inlet', poly: INLET, width: 78, depth: 8.0, tidal: true, level: 0 },
];

/* -------------------------------------------------------------- mountains */
export const PEAKS = [
  { x: -5200, z: -6300, r: 1500, h: 440, name: 'Mount Ferrant' },
  { x: -3100, z: -7150, r: 1150, h: 360, name: 'North Tooth' },
  { x: -6750, z: -4300, r: 1300, h: 300, name: 'Grey Sister' },
  { x: 4300, z: -6100, r: 1400, h: 390, name: 'Sentinel Peak' },
  { x: 5900, z: -4700, r: 1000, h: 250, name: 'Pine Crown' },
  { x: -900, z: -7250, r: 1200, h: 320, name: 'Ironhorn' },
  { x: 1900, z: -6650, r: 900, h: 230, name: 'Little Sentinel' },
];

function peakBumps(x, z) {
  let h = 0;
  for (let i = 0; i < PEAKS.length; i++) {
    const p = PEAKS[i];
    const dx = x - p.x, dz = z - p.z;
    const rr = p.r * 2.1;
    if (dx * dx + dz * dz > rr * rr) continue;
    const t = 1 - smoothstep(p.r * 0.12, p.r * 2.0, Math.hypot(dx, dz));
    h += p.h * t * t * (0.84 + 0.3 * noise2(x * 0.0016, z * 0.0016));
  }
  return h;
}

/* ------------------------------------------------------- distance fields */
const FIELD_STEP = 150;
const FIELD_N = Math.ceil(WORLD.size / FIELD_STEP) + 1;

function buildDistanceField(poly) {
  const f = new Float32Array(FIELD_N * FIELD_N);
  for (let iz = 0; iz < FIELD_N; iz++) {
    for (let ix = 0; ix < FIELD_N; ix++) {
      f[iz * FIELD_N + ix] = distanceToPolyline(poly, -WORLD.half + ix * FIELD_STEP, -WORLD.half + iz * FIELD_STEP).dist;
    }
  }
  return f;
}

function sampleField(f, x, z) {
  const gx = clamp01((x + WORLD.half) / WORLD.size) * (FIELD_N - 1);
  const gz = clamp01((z + WORLD.half) / WORLD.size) * (FIELD_N - 1);
  const ix = Math.min(FIELD_N - 2, gx | 0), iz = Math.min(FIELD_N - 2, gz | 0);
  const fx = gx - ix, fz = gz - iz;
  const a = f[iz * FIELD_N + ix], b = f[iz * FIELD_N + ix + 1];
  const c = f[(iz + 1) * FIELD_N + ix], d = f[(iz + 1) * FIELD_N + ix + 1];
  return a * (1 - fx) * (1 - fz) + b * fx * (1 - fz) + c * (1 - fx) * fz + d * fx * fz;
}

const CHANNEL_FIELDS = CHANNELS.map((c) => ({ ch: c, field: buildDistanceField(c.poly) }));
const GORGE_FIELD = buildDistanceField(GORGE);
const GORGE_CULL = 340;

function channelCarve(x, z) {
  let total = 0;
  for (const { ch, field } of CHANNEL_FIELDS) {
    const cull = ch.width * 3.4 + 140;
    if (sampleField(field, x, z) > cull) continue;
    const r = distanceToPolyline(ch.poly, x, z);
    const width = ch.width * (ch.tidal ? 1 + 0.25 * Math.sin(r.index * 1.3) : 1);
    if (r.dist > width * 3.0) continue;
    const t = 1 - smoothstep(width * 0.45, width * 3.0, r.dist);
    total += t * t * ch.depth * (0.6 + 0.4 * t);
  }
  return total;
}

function gorgeCarve(x, z) {
  if (sampleField(GORGE_FIELD, x, z) > GORGE_CULL) return 0;
  const g = distanceToPolyline(GORGE, x, z);
  const width = 62 + 26 * Math.sin(g.index * 1.7 + 0.6);
  if (g.dist > width * 2.4) return 0;
  const wall = 1 - smoothstep(width * 0.55, width * 2.4, g.dist);
  const floor = smoothstep(width * 1.0, width * 0.15, g.dist);
  return wall * (16 + floor * 86);
}

/* ---------------------------------------------------------------- height */
/**
 * Terrain height in metres, before water bodies are applied.
 * @param {boolean} raw skip channel/gorge/basin carving (used to compute water levels)
 */
export function landHeight(x, z, raw = false) {
  const w = biomeWeights(x, z, _w);
  let h = 0;
  for (let i = 0; i < 4; i++) {
    const wk = w[BIOME_KEYS[i]];
    if (wk < 0.0008) continue;
    const s = BIOME_SHAPE[BIOME_KEYS[i]];
    let bh = s.base;
    if (s.fbmAmp) bh += s.fbmAmp * fbm(x * s.freq, z * s.freq, i === 0 ? 5 : 4);
    if (s.ridgeAmp) bh += s.ridgeAmp * ridged(x * s.freq * 0.85 + 11.3, z * s.freq * 0.85 - 7.7, 5);
    h += wk * bh;
  }
  if (w.alpine > 0.02 || w.forest > 0.02) h += peakBumps(x, z) * (w.alpine * 0.9 + w.forest * 0.3);
  h += 11 * fbm(x * 0.00013 + 40, z * 0.00013 - 25, 3);
  if (raw) return h;
  h -= channelCarve(x, z);
  if (w.alpine > 0.05 || w.forest > 0.05) h -= gorgeCarve(x, z) * clamp01(w.alpine * 1.4 + w.forest * 0.5);
  return h;
}

function applyWater(h, x, z) {
  for (let i = 0; i < BASINS.length; i++) {
    const b = BASINS[i];
    const dx = x - b.x, dz = z - b.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > b.rOuter * b.rOuter) continue;
    const t = 1 - smoothstep(b.rInner, b.rOuter, Math.sqrt(d2));
    if (t > 0) h += (b.bed - h) * t;
  }
  const ts = smoothstep(coastlineZ(x) - 620, coastlineZ(x) + 900, z);
  if (ts > 0) h += (-13 - h) * ts;
  const te = smoothstep(coastlineX(z) - 620, coastlineX(z) + 900, x);
  if (te > 0) h += (-13 - h) * te;
  // Tidal channels are pulled to sea level so they stay wet at low tide.
  for (const ch of CHANNELS) {
    if (!ch.tidal) continue;
    const r = distanceToPolyline(ch.poly, x, z);
    if (r.dist > ch.width * 1.2) continue;
    const t = 1 - smoothstep(ch.width * 0.5, ch.width * 1.2, r.dist);
    if (t > 0) h += (ch.level - 4.5 - h) * t * 0.9;
  }
  return h;
}

/** Final terrain height at (x, z). Sea level is y = 0. */
export function heightAt(x, z) {
  let h = landHeight(x, z);
  h = applyWater(h, x, z);
  return h < -24 ? -24 : h;
}

/* ------------------------------------------- water surface level profiles */
/**
 * For each channel: a downstream-monotonic water surface level per vertex,
 * so rivers never flow uphill and ribbons can be built directly from this.
 */
const CHANNEL_LEVELS = CHANNELS.map((ch) => {
  const levels = ch.poly.map(([x, z]) => {
    if (ch.tidal) return ch.level;
    return landHeight(x, z, true) - ch.depth * 0.55;
  });
  if (!ch.tidal) {
    for (let i = 1; i < levels.length; i++) levels[i] = Math.min(levels[i], levels[i - 1] - 0.15);
    // smooth, keeping monotonicity
    for (let pass = 0; pass < 4; pass++) {
      for (let i = 1; i < levels.length - 1; i++) levels[i] = levels[i] * 0.5 + (levels[i - 1] + levels[i + 1]) * 0.25;
      for (let i = 1; i < levels.length; i++) levels[i] = Math.min(levels[i], levels[i - 1] - 0.08);
    }
  }
  return levels;
});

/** Sampled water ribbons: { id, name, level, points:[{x,y,z,width}] }. */
export function buildWaterCourses(spacing = 40) {
  return CHANNELS.map((ch, ci) => {
    const levels = CHANNEL_LEVELS[ci];
    const pts = [];
    for (let i = 0; i < ch.poly.length - 1; i++) {
      const [ax, az] = ch.poly[i], [bx, bz] = ch.poly[i + 1];
      const d = Math.hypot(bx - ax, bz - az);
      const n = Math.max(1, Math.round(d / spacing));
      for (let k = 0; k < n; k++) {
        const t = k / n;
        const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
        pts.push({ x, z, y: lerp(levels[i], levels[i + 1], t), width: ch.width * (ch.tidal ? 1 + 0.2 * Math.sin(i * 1.3) : 1) });
      }
    }
    const last = ch.poly[ch.poly.length - 1];
    pts.push({ x: last[0], z: last[1], y: levels[levels.length - 1], width: ch.width });
    return { id: ch.id, name: ch.name, tidal: !!ch.tidal, level: ch.tidal ? ch.level : null, points: pts };
  });
}

/** Water surface height for a channel at parameter (index, t). */
export function channelLevel(id, index, t = 0) {
  const ci = CHANNELS.findIndex((c) => c.id === id);
  if (ci < 0) return 0;
  const lv = CHANNEL_LEVELS[ci];
  const i = Math.min(lv.length - 2, Math.max(0, index));
  return lerp(lv[i], lv[i + 1], clamp01(t));
}

/**
 * Water covering (x, z) → { level, id, name, kind, depth } or null when dry.
 * kind: 'sea' | 'basin' | 'tidal' | 'river'
 */
export function waterAt(x, z) {
  const h = heightAt(x, z);
  let best = null;
  for (const b of BASINS) {
    const dx = x - b.x, dz = z - b.z;
    if (dx * dx + dz * dz > b.rOuter * b.rOuter * 1.1) continue;
    if (h < b.level - 0.1) best = { level: b.level, id: b.id, name: b.name, kind: 'basin' };
  }
  if (!best && h < WORLD.seaLevel - 0.1) best = { level: WORLD.seaLevel, id: 'sea', name: 'The Reach', kind: 'sea' };

  for (let ci = 0; ci < CHANNELS.length; ci++) {
    const ch = CHANNELS[ci];
    const cull = ch.width * 3 + 120;
    if (sampleField(CHANNEL_FIELDS[ci].field, x, z) > cull) continue;
    const r = distanceToPolyline(ch.poly, x, z);
    const width = ch.width * (ch.tidal ? 1 + 0.25 * Math.sin(r.index * 1.3) : 1);
    if (r.dist > width * 0.95) continue;
    const level = ch.tidal ? ch.level : channelLevel(ch.id, r.index, r.t);
    if (h < level - 0.1) {
      const cand = { level, id: ch.id, name: ch.name, kind: ch.tidal ? 'tidal' : 'river' };
      if (!best || level > best.level) best = cand;
    }
  }
  return best;
}

export function riverDistance(x, z) { return distanceToPolyline(RIVER, x, z).dist; }
export function creekDistance(x, z) { return distanceToPolyline(CREEK, x, z).dist; }
export function gorgeDistance(x, z) { return distanceToPolyline(GORGE, x, z).dist; }

/** Terrain slope magnitude (rise/run) — central differences. */
export function slopeAt(x, z, eps = 5) {
  const hx = (heightAt(x + eps, z) - heightAt(x - eps, z)) / (2 * eps);
  const hz = (heightAt(x, z + eps) - heightAt(x, z - eps)) / (2 * eps);
  return Math.hypot(hx, hz);
}

/** Snow cover 0..1 (alpine snow line, GDD §2.2). */
export function snowCover(x, z) {
  const w = biomeWeights(x, z, _w);
  if (w.alpine < 0.03) return 0;
  const line = 325 - 55 * hash2(Math.floor(x / 900), Math.floor(z / 900));
  return clamp01(smoothstep(line, line + 140, heightAt(x, z))) * clamp01(w.alpine * 1.35 + w.forest * 0.1);
}

/** Farmland mask (plains, gentle, dry) — drives the golden wheat fields. */
export function farmlandMask(x, z, slope, h) {
  const w = biomeWeights(x, z, _w);
  if (w.plains < 0.4) return 0;
  const field = hash2(Math.floor(x / 240), Math.floor(z / 240));
  if (field < 0.45) return 0;
  if (slope > 0.085 || h < 9) return 0;
  return clamp01((w.plains - 0.4) / 0.35) * (0.5 + 0.5 * field);
}

export const TERRAIN_DEBUG = { SIGMA, GRID_STEP, GAMMA, SEEDS, CHANNELS };
