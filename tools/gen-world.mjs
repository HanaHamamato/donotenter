/**
 * IRONBOUND world generator (GDD §5.2.4 track data format).
 *
 * Authors the 16 km "Iron Reaches" network topology, drops it onto the
 * procedural terrain from src/utils/terrain.js, enforces realistic grades,
 * auto-detects bridges / viaducts / tunnels / water crossings and writes:
 *
 *   assets/data/tracks.json    segments, nodes (junctions), structures, landmarks
 *   assets/data/stations.json  the 12 stations + produce/consume tables
 *   assets/data/biomes.json    biome rendering parameters
 *
 * Run with:  npm run gen:world
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { heightAt, waterAt, biomeAt, RIVER, CREEK, INLET, GORGE, BASINS } from '../src/utils/terrain.js';
import { noise2 } from '../src/utils/noise.js';

/** Stable per-segment seed from its id. */
function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}
import { BIOMES, WORLD } from '../src/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'assets', 'data');

const BED_OFFSET = 0.55; // rail head above the formation
const BRIDGE_CLEARANCE = 3.4; // deck above water

/* ------------------------------------------------------------------ author */
const nodes = new Map();
const segments = new Map();
const problems = [];

function N(id, x, z, opts = {}) {
  nodes.set(id, { id, x, y: heightAt(x, z), z, kind: 'link', branches: [], ...opts });
  return id;
}

function S(id, from, to, opts = {}) {
  segments.set(id, {
    id, from, to,
    via: opts.via || [],
    speed: opts.speed ?? 70,
    region: opts.region || null,
    kind: opts.kind || 'main',
    maxGrade: opts.maxGrade ?? (opts.kind === 'siding' ? 0.04 : 0.042),
    structure: opts.structure || null,
    deck: opts.deck ?? null, // fixed deck height for authored bridges
    tunnel: opts.tunnel || null,
    gated: opts.gated || null,
  });
  return id;
}

/* =============================================================== TOPOLOGY */
/* ---- COASTAL (SE) ------------------------------------------------------ */
N('portmouth', -2800, 5400, { kind: 'station', station: 'portmouth', name: 'Portmouth Throat' });
N('quay', -3820, 5760, { kind: 'buffer' });
N('portyard', -2280, 4620, { kind: 'buffer' });
N('j_swing_w', -1300, 6100, { kind: 'junction', switchable: false, name: 'Swing Bridge West' });
N('j_swing_e', 300, 6320, { kind: 'junction', switchable: false, name: 'Swing Bridge East' });
N('marshwick', 2600, 5800, { kind: 'station', station: 'marshwick', name: 'Marshwick' });
N('j_causeway_e', 1700, 5250, { kind: 'junction', switchable: false, name: 'Causeway East' });
N('j_causeway_w', -900, 4050, { kind: 'junction', switchable: false, name: 'Causeway West' });
N('marshspur', 3760, 6340, { kind: 'buffer' });

S('c_harbour_spur', 'portmouth', 'quay', { via: [[-3360, 5480]], kind: 'siding', speed: 30, region: 'coastal' });
S('c_port_yard', 'portmouth', 'portyard', { via: [[-2580, 4980]], kind: 'siding', speed: 30, region: 'coastal' });
S('c_main_1', 'portmouth', 'j_swing_w', { via: [[-2320, 5820], [-1820, 6010]], speed: 55, region: 'coastal' });
S('c_swing', 'j_swing_w', 'j_swing_e', { via: [[-760, 6210], [-280, 6270]], speed: 25, region: 'coastal', structure: 'swing', deck: 7.5 });
S('c_main_2', 'j_swing_e', 'marshwick', { via: [[1100, 6300], [1900, 6060], [2300, 5900]], speed: 70, region: 'coastal' });
S('c_marsh_spur', 'marshwick', 'marshspur', { via: [[3240, 6000]], kind: 'siding', speed: 30, region: 'coastal' });
S('c_lagoon_n', 'marshwick', 'j_causeway_e', { via: [[2180, 5400]], speed: 60, region: 'coastal' });
S('c_causeway', 'j_causeway_e', 'j_causeway_w', { via: [[1200, 4760], [640, 4480], [40, 4300], [-520, 4120]], speed: 45, region: 'coastal', structure: 'causeway' });

/* ---- PLAINS (SW) ------------------------------------------------------- */
N('dustflats', -1600, 2800, { kind: 'station', station: 'dustflats', name: 'Dustflats Junction' });
N('buf_grain', -2420, 2200, { kind: 'buffer' });
N('millford', 1000, 2600, { kind: 'station', station: 'millford', name: 'Millford' });
N('buf_mill_a', 1760, 3240, { kind: 'buffer' });
N('buf_mill_b', 1480, 1940, { kind: 'buffer' });
N('j_plains_w', -3080, 1680, { kind: 'junction', switchable: true, name: 'West Plains Junction' });
N('coalridge', -4400, 400, { kind: 'station', station: 'coalridge', name: 'Coalridge' });
N('buf_coal', -5080, -180, { kind: 'buffer' });

S('p_causeway_link', 'j_causeway_w', 'dustflats', { via: [[-1220, 3480]], speed: 80, region: 'plains' });
S('p_grain_spur', 'dustflats', 'buf_grain', { via: [[-2060, 2560]], kind: 'siding', speed: 30, region: 'plains' });
S('p_main_2', 'dustflats', 'millford', { via: [[-880, 2800], [-120, 2740], [520, 2680]], speed: 100, region: 'plains' });
S('p_mill_yard_a', 'millford', 'buf_mill_a', { via: [[1440, 2980]], kind: 'siding', speed: 30, region: 'plains' });
S('p_mill_yard_b', 'millford', 'buf_mill_b', { via: [[1300, 2260]], kind: 'siding', speed: 30, region: 'plains' });
S('p_main_3', 'millford', 'cedarmill', { via: [[820, 1760], [520, 900]], speed: 95, region: 'plains' });
S('p_west_1', 'dustflats', 'j_plains_w', { via: [[-2380, 2300], [-2860, 1990]], speed: 80, region: 'plains' });
S('p_west_2', 'j_plains_w', 'coalridge', { via: [[-3700, 1240], [-4180, 800]], speed: 70, region: 'plains' });
S('p_coal_spur', 'coalridge', 'buf_coal', { via: [[-4780, 140]], kind: 'siding', speed: 30, region: 'plains' });
S('p_alpine_1', 'coalridge', 'j_oldred', { via: [[-3820, 220], [-3180, -60]], speed: 65, region: 'plains', maxGrade: 0.05 });

/* ---- FOREST (NE / centre) --------------------------------------------- */
N('cedarmill', 200, 300, { kind: 'station', station: 'cedarmill', name: 'Cedarmill Junction' });
N('buf_cedar', 900, -120, { kind: 'buffer' });
N('greenhollow', 3400, -1400, { kind: 'station', station: 'greenhollow', name: 'Greenhollow' });
N('buf_green', 4200, -1800, { kind: 'buffer' });
N('j_pineline', 2980, -3380, { kind: 'junction', switchable: false, name: 'Pine Line Border' });
N('ironvale', -1000, -1800, { kind: 'station', station: 'ironvale', name: 'Ironvale' });
N('buf_iron', -1620, -2400, { kind: 'buffer' });
N('j_oldred', -2520, -180, { kind: 'junction', switchable: true, name: 'Old Redstone Junction' });
N('oldredstone', -3320, -940, { kind: 'station', station: 'oldredstone', name: 'Old Redstone' });
N('buf_oldred', -3980, -1380, { kind: 'buffer' });

S('f_yard', 'cedarmill', 'buf_cedar', { via: [[560, 130]], kind: 'siding', speed: 30, region: 'forest' });
S('f_east_1', 'cedarmill', 'greenhollow', {
  via: [[820, -60], [1240, -300], [1560, -480], [2000, -700], [2560, -960], [3040, -1210]],
  speed: 85, region: 'forest', structure: 'covered',
});
S('f_green_spur', 'greenhollow', 'buf_green', { via: [[3880, -1580]], kind: 'siding', speed: 30, region: 'forest' });
S('f_east_2', 'greenhollow', 'j_pineline', { via: [[3480, -2060], [3400, -2560], [3200, -3000]], speed: 70, region: 'forest', maxGrade: 0.055 });
S('f_north_1', 'cedarmill', 'ironvale', { via: [[-140, -420], [-520, -1120], [-840, -1580]], speed: 80, region: 'forest', structure: 'arch', maxGrade: 0.05 });
S('f_iron_spur', 'ironvale', 'buf_iron', { via: [[-1360, -2140]], kind: 'siding', speed: 30, region: 'forest' });
S('f_oldred_1', 'j_oldred', 'oldredstone', { via: [[-2900, -480], [-3160, -760]], speed: 55, region: 'forest', kind: 'branch' });
S('f_oldred_spur', 'oldredstone', 'buf_oldred', { via: [[-3700, -1200]], kind: 'siding', speed: 25, region: 'forest' });
S('f_oldred_2', 'j_oldred', 'ironvale', { via: [[-1960, -760], [-1480, -1320]], speed: 70, region: 'forest', maxGrade: 0.055 });

/* ---- ALPINE (N) ------------------------------------------------------- */
N('pinepass', 2200, -4200, { kind: 'station', station: 'pinepass', name: 'Pine Pass' });
N('buf_pine', 1380, -4760, { kind: 'buffer' });
N('j_trestle_e', 620, -4520, { kind: 'junction', switchable: false, name: 'Trestle East' });
N('j_trestle_w', -1120, -4900, { kind: 'junction', switchable: true, name: 'Trestle West' });
N('snowpeak', -2600, -5200, { kind: 'station', station: 'snowpeak', name: 'Snowpeak Summit' });
N('buf_summit', -3000, -5350, { kind: 'buffer' });
N('j_loop', -1200, -5790, { kind: 'junction', switchable: true, name: 'Summit Loop Junction' });
N('j_loop_e', -560, -5350, { kind: 'junction', switchable: false, name: 'Summit Loop East' });
N('overlook', -3120, -6120, { kind: 'buffer', station: 'summitloop', name: 'Ferrant Overlook' });

S('a_climb_1', 'j_pineline', 'pinepass', { via: [[2860, -3660], [2700, -3900], [2440, -4060]], speed: 65, region: 'alpine', maxGrade: 0.06, tunnel: [0.34, 0.5] });
S('a_pine_spur', 'pinepass', 'buf_pine', { via: [[1800, -4500]], kind: 'siding', speed: 30, region: 'alpine', maxGrade: 0.045 });
S('a_ridge_1', 'pinepass', 'j_trestle_e', { via: [[1560, -4360], [1080, -4400]], speed: 60, region: 'alpine', maxGrade: 0.05 });
S('a_trestle', 'j_trestle_e', 'j_trestle_w', { via: [[160, -4650], [-300, -4750], [-760, -4850]], speed: 40, region: 'alpine', structure: 'trestle', maxGrade: 0.045 });
S('a_ridge_2', 'j_trestle_w', 'snowpeak', { via: [[-1700, -5020], [-2200, -5130]], speed: 55, region: 'alpine', maxGrade: 0.055, tunnel: [0.38, 0.58] });
S('a_summit_spur', 'snowpeak', 'buf_summit', { via: [[-2860, -5270]], kind: 'siding', speed: 30, region: 'alpine', maxGrade: 0.045 });
S('a_loop_1', 'snowpeak', 'j_loop', { via: [[-2050, -5330], [-1600, -5520]], speed: 50, region: 'alpine', kind: 'branch', maxGrade: 0.055, gated: 'summitloop' });
S('a_loop_2', 'j_loop', 'j_loop_e', { via: [[-860, -5980], [-520, -5820], [-420, -5560]], speed: 50, region: 'alpine', kind: 'branch', maxGrade: 0.06, gated: 'summitloop' });
S('a_loop_3', 'j_loop_e', 'j_trestle_w', { via: [[-880, -5120]], speed: 50, region: 'alpine', kind: 'branch', maxGrade: 0.055, gated: 'summitloop' });
S('a_overlook', 'j_loop', 'overlook', {
  via: [[-1700, -6050], [-2300, -6200], [-2800, -6280]],
  kind: 'siding', speed: 40, region: 'alpine', maxGrade: 0.05, gated: 'summitloop',
});

/* ======================================================= GEOMETRY PIPELINE */
function densify(pts, spacing) {
  const out = [[pts[0][0], pts[0][1]]];
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    const d = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.round(d / spacing));
    for (let k = 1; k <= n; k++) out.push([ax + (bx - ax) * (k / n), az + (bz - az) * (k / n)]);
  }
  return out;
}

/** Ramer–Douglas–Peucker simplification of an XZ polyline. */
function rdp(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = -1, idx = -1;
    const [ax, az] = pts[a], [bx, bz] = pts[b];
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz) || 1e-9;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - ax) * dz - (pts[i][1] - az) * dx) / len;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

function movingAverage(y, passes = 2) {
  let cur = y.slice();
  for (let p = 0; p < passes; p++) {
    const next = cur.slice();
    for (let i = 1; i < cur.length - 1; i++) next[i] = cur[i - 1] * 0.25 + cur[i] * 0.5 + cur[i + 1] * 0.25;
    cur = next;
  }
  return cur;
}

/** Drop control points closer than `min` metres (keeps spline + grade maths sane). */
function minSpacing(pts, min) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const last = out[out.length - 1];
    if (Math.hypot(pts[i][0] - last[0], pts[i][1] - last[1]) >= min) out.push(pts[i]);
  }
  const last = out[out.length - 1];
  const end = pts[pts.length - 1];
  if (Math.hypot(end[0] - last[0], end[1] - last[1]) < min * 0.5) out[out.length - 1] = end;
  else out.push(end);
  return out;
}

/**
 * Limit the deflection angle between consecutive control points. Combined with
 * the minimum spacing this bounds the curve radius: R ≈ spacing / (2·sin(θ/2)),
 * so mainline track never gets tighter than ~250 m and yards ~85 m.
 */
function limitTurnAngles(pts, maxTurnDeg, passes = 6) {
  const maxTurn = (maxTurnDeg * Math.PI) / 180;
  const out = pts.map((p) => p.slice());
  for (let pass = 0; pass < passes; pass++) {
    let changed = false;
    for (let i = 1; i < out.length - 1; i++) {
      const ax = out[i][0] - out[i - 1][0], az = out[i][1] - out[i - 1][1];
      const bx = out[i + 1][0] - out[i][0], bz = out[i + 1][1] - out[i][1];
      const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
      if (la < 1e-6 || lb < 1e-6) continue;
      const dot = (ax * bx + az * bz) / (la * lb);
      const ang = Math.acos(Math.max(-1, Math.min(1, dot)));
      if (ang > maxTurn) {
        // pull the offending point toward the chord midpoint until it behaves
        out[i][0] = out[i][0] * 0.55 + (out[i - 1][0] + out[i + 1][0]) * 0.225;
        out[i][1] = out[i][1] * 0.55 + (out[i - 1][1] + out[i + 1][1]) * 0.225;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return out;
}

/** Fit a profile that hugs the land but never exceeds maxGrade, honouring floors. */
function fitProfile(xz, target, floors, maxGrade) {
  const n = xz.length;
  const ds = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) ds[i] = Math.max(1e-3, Math.hypot(xz[i + 1][0] - xz[i][0], xz[i + 1][1] - xz[i][1]));
  const y = target.slice();
  const y0 = y[0], yN = y[n - 1];
  for (let iter = 0; iter < 70; iter++) {
    if (iter > 0 && iter < 45) for (let i = 0; i < n; i++) y[i] += (target[i] - y[i]) * (0.5 - 0.4 * (iter / 45));
    // Endpoints are hard constraints (shared nodes) — only interior samples move.
    for (let i = 1; i <= n - 2; i++) y[i] = Math.min(y[i], y[i - 1] + maxGrade * ds[i - 1]);
    for (let i = n - 2; i >= 1; i--) y[i] = Math.min(y[i], y[i + 1] + maxGrade * ds[i]);
    for (let i = 1; i <= n - 2; i++) y[i] = Math.max(y[i], y[i - 1] - maxGrade * ds[i - 1]);
    for (let i = n - 2; i >= 1; i--) y[i] = Math.max(y[i], y[i + 1] - maxGrade * ds[i]);
    for (let i = 1; i <= n - 2; i++) if (floors[i] > y[i]) y[i] = floors[i];
    y[0] = y0; y[n - 1] = yN;
  }
  return y;
}

const CURVE_PRESET = {
  plains: { amp: 13, wl: 1250 },
  coastal: { amp: 15, wl: 1050 },
  forest: { amp: 20, wl: 820 },
  alpine: { amp: 27, wl: 620 },
};

/**
 * Give straight-authored corridors an organic alignment: a low-frequency
 * lateral wander that is windowed to zero at both nodes so segments still meet.
 * Real curvature matters — it drives superelevation, curve resistance and the
 * per-curve speed limit the derailment check uses (GDD §1.1).
 */
function wander(xz, amp, wl, seed) {
  const n = xz.length;
  if (n < 3 || amp <= 0) return xz;
  const out = new Array(n);
  const k1 = 24 / wl, k2 = 24 / (wl * 0.43); // sample index → noise phase
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const win = Math.pow(Math.sin(Math.PI * t), 0.8);
    const off = amp * win * (0.68 * noise2(i * k1 + seed, seed * 2.7)
      + 0.32 * noise2(i * k2 - seed * 1.3, seed * 5.1 + 9));
    const p = xz[Math.max(0, i - 1)], q = xz[Math.min(n - 1, i + 1)];
    const dx = q[0] - p[0], dz = q[1] - p[1];
    const l = Math.hypot(dx, dz) || 1;
    out[i] = [xz[i][0] + (-dz / l) * off, xz[i][1] + (dx / l) * off];
  }
  return out;
}

function buildSegment(seg) {
  const a = nodes.get(seg.from), b = nodes.get(seg.to);
  if (!a || !b) throw new Error(`segment ${seg.id}: unknown node`);
  const raw = [[a.x, a.z], ...seg.via, [b.x, b.z]];
  const preset = CURVE_PRESET[seg.region || biomeAt(a.x, a.z)] || CURVE_PRESET.plains;
  const amp = seg.kind === 'siding' ? preset.amp * 0.35 : preset.amp;
  const seed = hashSeed(seg.id) * 40;
  let xz = wander(densify(raw, 24), amp, preset.wl, seed);
  xz = minSpacing(rdp(xz, 0.3), seg.kind === 'siding' ? 26 : 42);
  xz = limitTurnAngles(xz, seg.kind === 'siding' ? 20 : 9);
  xz[0] = [a.x, a.z]; xz[xz.length - 1] = [b.x, b.z];
  // a collar point just off each node keeps joins smooth for Catmull-Rom
  const n = xz.length;
  const target = new Array(n);
  const floors = new Array(n).fill(-Infinity);
  const water = new Array(n).fill(null);
  const ground = new Array(n);

  for (let i = 0; i < n; i++) {
    const [x, z] = xz[i];
    const g = heightAt(x, z);
    ground[i] = g;
    let t = g + BED_OFFSET;
    const w = waterAt(x, z);
    if (w) {
      const deck = w.level + BRIDGE_CLEARANCE;
      water[i] = { ...w, deck };
      if (deck > t) t = deck;
    }
    if (seg.deck != null) { t = Math.max(t, seg.deck); floors[i] = seg.deck; }
    target[i] = t;
  }
  target[0] = a.y + BED_OFFSET; target[n - 1] = b.y + BED_OFFSET;
  floors[0] = -Infinity; floors[n - 1] = -Infinity;
  if (seg.deck == null) { /* node elevations are authoritative */ }
  else { target[0] = Math.max(target[0], seg.deck); target[n - 1] = Math.max(target[n - 1], seg.deck); }

  let y = movingAverage(target, 2);
  for (let i = 0; i < n; i++) if (floors[i] > y[i]) y[i] = floors[i];
  y[0] = target[0]; y[n - 1] = target[n - 1];
  y = fitProfile(xz, y, floors, seg.maxGrade);

  const pts = xz.map(([x, z], i) => ({ x, y: y[i], z }));
  return { pts, water, ground, target };
}

/** Superelevation from curvature: e = v²κ/g · 0.62, capped at 6°. */
function computeBank(pts, speedKmh) {
  const bank = new Array(pts.length).fill(0);
  const v = speedKmh / 3.6;
  for (let i = 1; i < pts.length - 1; i++) {
    const p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1];
    const ax = p1.x - p0.x, az = p1.z - p0.z, bx = p2.x - p1.x, bz = p2.z - p1.z;
    const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
    if (la < 1e-6 || lb < 1e-6) continue;
    const cross = (ax / la) * (bz / lb) - (az / la) * (bx / lb);
    const kappa = Math.abs(cross) / Math.max(1e-3, (la + lb) * 0.5);
    const e = Math.min(0.105, ((v * v * kappa) / WORLD.gravity) * 0.62);
    bank[i] = Math.sign(cross) * -e;
  }
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 1; i < bank.length - 1; i++) bank[i] = bank[i - 1] * 0.25 + bank[i] * 0.5 + bank[i + 1] * 0.25;
  }
  bank[0] = bank[1] || 0; bank[bank.length - 1] = bank[bank.length - 2] || 0;
  return bank;
}

/** Group contiguous samples matching a predicate into { t0, t1, max } runs. */
function runs(pts, cum, L, pred, value, minSpan = 20) {
  const out = [];
  let i = 0;
  while (i < pts.length) {
    if (!pred(i)) { i++; continue; }
    const i0 = i;
    let max = value(i);
    while (i + 1 < pts.length && pred(i + 1)) { i++; max = Math.max(max, value(i)); }
    const lo = i0 > 0 ? (cum[i0] + cum[i0 - 1]) * 0.5 : cum[i0];
    const hi = i < pts.length - 1 ? (cum[i] + cum[i + 1]) * 0.5 : cum[i];
    const span = hi - lo;
    if (span >= minSpan) out.push({ t0: round(cum[i0] / L, 4), t1: round(cum[i] / L, 4), max: round(max, 1), span: Math.round(span) });
    i++;
  }
  return out;
}

const round = (v, d = 2) => { const m = 10 ** d; return Math.round(v * m) / m; };

/* ------------------------------------------- global node elevation solve */
function approxLength(seg) {
  const a = nodes.get(seg.from), b = nodes.get(seg.to);
  const pts = [[a.x, a.z], ...seg.via, [b.x, b.z]];
  let L = 0;
  for (let i = 0; i < pts.length - 1; i++) L += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  return L * 1.06;
}

/**
 * Node elevations must be mutually reachable within each segment's ruling grade,
 * otherwise no profile can exist. Relax them: pull infeasible pairs together and
 * spring every node back toward its natural ground height. Stations resist moving
 * (they have buildings) more than plain junctions.
 */
function relaxNodeHeights(iters = 90) {
  for (const nd of nodes.values()) nd.naturalY = nd.y;
  const lengths = new Map([...segments.values()].map((sg) => [sg.id, approxLength(sg)]));
  let worst = 0;
  for (let it = 0; it < iters; it++) {
    for (const seg of segments.values()) {
      const a = nodes.get(seg.from), b = nodes.get(seg.to);
      const maxDh = seg.maxGrade * lengths.get(seg.id) * 0.78;
      const dh = b.y - a.y;
      if (Math.abs(dh) <= maxDh) continue;
      const excess = (Math.abs(dh) - maxDh) * 0.5 * Math.sign(dh);
      a.y += excess * (a.kind === 'station' ? 0.3 : 0.6);
      b.y -= excess * (b.kind === 'station' ? 0.3 : 0.6);
    }
    if (it < iters - 12) {
      for (const nd of nodes.values()) if (!nd.fixed) nd.y += (nd.naturalY - nd.y) * (nd.kind === 'station' ? 0.1 : 0.045);
    }
  }
  for (const seg of segments.values()) {
    const a = nodes.get(seg.from), b = nodes.get(seg.to);
    const g = Math.abs(b.y - a.y) / lengths.get(seg.id);
    worst = Math.max(worst, g);
    if (g > seg.maxGrade * 1.02) problems.push(`${seg.id}: nodes still infeasible (${(g * 100).toFixed(1)}% needed)`);
  }
  return worst;
}
const worstGrade = relaxNodeHeights();
for (const seg of segments.values()) {
  if (seg.deck == null) continue;
  for (const id of [seg.from, seg.to]) {
    const nd = nodes.get(id);
    nd.y = seg.deck - BED_OFFSET;
    nd.fixed = true;
  }
}
console.log(`node elevation solve: worst ruling grade ${(worstGrade * 100).toFixed(2)}%`);

/* =============================================================== ASSEMBLY */
const built = new Map();
let totalLength = 0;
const report = [];

for (const seg of segments.values()) {
  const { pts, water, ground } = buildSegment(seg);
  const n = pts.length;
  const cum = [0];
  for (let i = 1; i < n; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y, pts[i].z - pts[i - 1].z));
  }
  const L = cum[n - 1] || 1;
  const bank = computeBank(pts, seg.speed);

  const fill = (i) => pts[i].y - ground[i];
  const cut = (i) => ground[i] - pts[i].y;

  const bridges = runs(pts, cum, L, (i) => !!water[i], (i) => fill(i), 15);
  const viaducts = runs(pts, cum, L, (i) => !water[i] && fill(i) > 11, fill, 25);
  const cuttings = runs(pts, cum, L, (i) => !water[i] && cut(i) > 5 && cut(i) <= 16, cut, 35);
  const tunnels = runs(pts, cum, L, (i) => !water[i] && cut(i) > 16, cut, 55);
  if (seg.tunnel) {
    tunnels.push({ t0: seg.tunnel[0], t1: seg.tunnel[1], max: 0, span: Math.round((seg.tunnel[1] - seg.tunnel[0]) * L), forced: true });
    tunnels.sort((a, b) => a.t0 - b.t0);
  }
  const embankments = runs(pts, cum, L, (i) => !water[i] && fill(i) > 2.5 && fill(i) <= 11, fill, 40);
  if (seg.deck != null && !bridges.length) bridges.push({ t0: 0, t1: 1, max: 0, span: Math.round(L), deck: true });

  const a = nodes.get(seg.from), b = nodes.get(seg.to);
  const mid = pts[n >> 1];
  const biome = biomeAt(mid.x, mid.z);

  built.set(seg.id, {
    id: seg.id,
    points: pts.map((p, i) => [round(p.x), round(p.y), round(p.z), round(bank[i], 4)]),
    speedLimit: seg.speed,
    a: seg.from,
    b: seg.to,
    kind: seg.kind,
    region: seg.region || biome,
    biome,
    length: Math.round(L),
    isBridge: bridges.length > 0 || seg.structure === 'swing' || seg.structure === 'causeway' || seg.structure === 'trestle',
    isTunnel: tunnels.length > 0,
    structure: seg.structure || (viaducts.length ? 'trestle' : null),
    bridges, viaducts, tunnels, cuttings, embankments,
    waterIds: [...new Set(water.filter(Boolean).map((w2) => w2.id))],
    gated: seg.gated || null,
  });

  a.branches.push({ seg: seg.id, end: 'a' });
  b.branches.push({ seg: seg.id, end: 'b' });
  totalLength += L;

  let maxGrade = 0;
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    maxGrade = Math.max(maxGrade, Math.abs(pts[i].y - pts[i - 1].y) / Math.max(1e-3, d));
  }
  if (maxGrade > seg.maxGrade + 0.004) problems.push(`${seg.id}: grade ${(maxGrade * 100).toFixed(1)}% exceeds limit`);
  if (maxGrade > 0.062) problems.push(`${seg.id}: extreme grade ${(maxGrade * 100).toFixed(1)}%`);
  const maxCut = Math.max(...Array.from({ length: n }, (_, i) => cut(i)));
  const maxFill = Math.max(...Array.from({ length: n }, (_, i) => fill(i)));
  if (maxCut > 34 && !tunnels.length) problems.push(`${seg.id}: deep cut ${maxCut.toFixed(0)} m with no tunnel`);

  report.push({
    id: seg.id, km: L / 1000, grade: maxGrade * 100, pts: n,
    bri: bridges.length, via: viaducts.length, tun: tunnels.length,
    y0: pts[0].y, y1: pts[n - 1].y, cut: maxCut, fill: maxFill,
    water: [...new Set(water.filter(Boolean).map((w2) => w2.name))].join('+'),
  });
}

/* node kinds + validation */
for (const node of nodes.values()) {
  if (node.branches.length === 1) node.kind = 'buffer';
  else if (node.kind === 'link' && node.branches.length > 2) node.kind = 'junction';
  if (node.kind === 'junction' && node.switchable === undefined) node.switchable = true;
  if (node.station) node.switchable = node.branches.length > 2;
  node.naturalY = heightAt(node.x, node.z);
  if (Math.abs(node.y - node.naturalY) > 26) problems.push(`node ${node.id} moved ${(node.y - node.naturalY).toFixed(0)} m from natural ground`);
  const w = waterAt(node.x, node.z);
  if (w) problems.push(`node ${node.id} is under water (${w.name}, level ${w.level})`);
  if (node.branches.length === 0) problems.push(`node ${node.id} has no segments`);
}

/* graph connectivity check */
const adj = new Map([...nodes.keys()].map((id) => [id, new Set()]));
for (const seg of built.values()) { adj.get(seg.a).add(seg.b); adj.get(seg.b).add(seg.a); }
const seen = new Set(['dustflats']);
const queue = ['dustflats'];
while (queue.length) {
  const cur = queue.shift();
  for (const nxt of adj.get(cur)) if (!seen.has(nxt)) { seen.add(nxt); queue.push(nxt); }
}
const gatedNodes = new Set();
for (const seg of built.values()) if (seg.gated) { gatedNodes.add(seg.a); gatedNodes.add(seg.b); }
for (const id of nodes.keys()) {
  if (!seen.has(id) && !gatedNodes.has(id)) problems.push(`node ${id} is unreachable from Dustflats`);
}

/* =============================================================== STATIONS */
const STATIONS = [
  {
    id: 'portmouth', name: 'Portmouth Harbor', node: 'portmouth', biome: 'coastal', region: 'coastal',
    type: 'Port', produces: ['fertilizer', 'supplies'], consumes: ['steel', 'grain', 'timber'],
    sidings: [{ seg: 'c_harbour_spur', from: 55, capacity: 4 }, { seg: 'c_port_yard', from: 40, capacity: 4 }],
    blurb: 'Deep-water quays, gantry cranes, salt and diesel.',
  },
  {
    id: 'marshwick', name: 'Marshwick', node: 'marshwick', biome: 'coastal', region: 'coastal',
    type: 'Fishing Village', produces: ['fish', 'food'], consumes: ['goods', 'supplies'],
    sidings: [{ seg: 'c_marsh_spur', from: 40, capacity: 3 }],
    blurb: 'Stilt houses, gulls, and the best smoked eel in the Reaches.',
  },
  {
    id: 'dustflats', name: 'Dustflats Granary', node: 'dustflats', biome: 'plains', region: 'plains',
    type: 'Agriculture', produces: ['grain', 'livestock'], consumes: ['fertilizer', 'goods'],
    sidings: [{ seg: 'p_grain_spur', from: 45, capacity: 5 }],
    blurb: 'Ninety silos of wheat and a level crossing that never stops ringing.',
    home: true,
  },
  {
    id: 'millford', name: 'Millford', node: 'millford', biome: 'plains', region: 'plains',
    type: 'Market Town', produces: ['goods', 'food'], consumes: ['grain', 'timber', 'steel', 'parts'],
    sidings: [{ seg: 'p_mill_yard_a', from: 40, capacity: 4 }, { seg: 'p_mill_yard_b', from: 30, capacity: 3 }],
    blurb: 'The market town of the plains — everything passes through here twice.',
  },
  {
    id: 'coalridge', name: 'Coalridge Mine', node: 'coalridge', biome: 'plains', region: 'plains',
    type: 'Mine', produces: ['coal', 'ironore'], consumes: ['parts', 'supplies', 'timber'],
    sidings: [{ seg: 'p_coal_spur', from: 40, capacity: 5 }],
    blurb: 'Black dust, bright lamps, and hoppers that are never empty.',
  },
  {
    id: 'cedarmill', name: 'Cedarmill Junction', node: 'cedarmill', biome: 'forest', region: 'forest',
    type: 'Rail Hub', produces: ['supplies'], consumes: ['coal', 'goods'],
    sidings: [{ seg: 'f_yard', from: 40, capacity: 4 }],
    blurb: 'Four routes meet under one signal box. Mind the switch.',
  },
  {
    id: 'greenhollow', name: 'Greenhollow', node: 'greenhollow', biome: 'forest', region: 'forest',
    type: 'Town', produces: ['goods', 'food'], consumes: ['coal', 'grain', 'supplies'],
    sidings: [{ seg: 'f_green_spur', from: 40, capacity: 3 }],
    blurb: 'A green valley town with a covered bridge and a very loud church bell.',
  },
  {
    id: 'ironvale', name: 'Ironvale Foundry', node: 'ironvale', biome: 'forest', region: 'forest',
    type: 'Heavy Industry', produces: ['steel', 'parts'], consumes: ['ironore', 'coal'],
    sidings: [{ seg: 'f_iron_spur', from: 40, capacity: 5 }],
    blurb: 'Taps at midnight. The glow is visible from Coalridge.',
  },
  {
    id: 'oldredstone', name: 'Old Redstone', node: 'oldredstone', biome: 'forest', region: 'forest',
    type: 'Abandoned Station', produces: [], consumes: [], inactive: true, unlock: 'baron',
    sidings: [{ seg: 'f_oldred_spur', from: 30, capacity: 3 }],
    blurb: 'Brick and ivy. Rebuild it and the branch wakes up.',
  },
  {
    id: 'pinepass', name: 'Pine Pass Depot', node: 'pinepass', biome: 'alpine', region: 'alpine',
    type: 'Logging Camp', produces: ['timber'], consumes: ['supplies', 'food', 'parts'],
    sidings: [{ seg: 'a_pine_spur', from: 40, capacity: 5 }],
    blurb: 'Sawdust, cold air, and flatcars stacked with fresh-cut pine.',
  },
  {
    id: 'snowpeak', name: 'Snowpeak Summit', node: 'snowpeak', biome: 'alpine', region: 'alpine',
    type: 'Waystation', produces: ['supplies'], consumes: ['food', 'coal', 'goods'],
    sidings: [{ seg: 'a_summit_spur', from: 40, capacity: 3 }],
    blurb: 'The highest station in the Reaches. Bring sand for the rails.',
  },
  {
    id: 'summitloop', name: 'The Summit Loop', node: 'overlook', biome: 'alpine', region: 'alpine',
    type: 'Scenic Overlook', produces: [], consumes: [], inactive: true, unlock: 'legend', scenic: true,
    sidings: [{ seg: 'a_overlook', from: 30, capacity: 2 }],
    blurb: 'A balloon loop above the clouds. Drive it once, drive it again.',
  },
];

/* landmarks (GDD §10) placed by StructureManager */
const LANDMARKS = [
  { id: 'lighthouse', kind: 'lighthouse', x: -3980, z: 6980 },
  { id: 'castle', kind: 'ruin', x: -4350, z: -1850 },
  { id: 'waterfall', kind: 'waterfall', x: 1120, z: -3120 },
  { id: 'rockarch', kind: 'rockarch', x: -5450, z: 2450 },
  { id: 'ferrant', kind: 'peakmarker', x: -5200, z: -6300, name: 'Mount Ferrant' },
  { id: 'sentinel', kind: 'peakmarker', x: 4300, z: -6100, name: 'Sentinel Peak' },
];
for (const l of LANDMARKS) l.y = round(heightAt(l.x, l.z));

const tracks = {
  version: 1,
  generated: new Date().toISOString().slice(0, 10),
  world: { size: WORLD.size, seaLevel: WORLD.seaLevel },
  nodes: [...nodes.values()].map((nd) => ({
    id: nd.id, kind: nd.kind, x: round(nd.x), y: round(nd.y), z: round(nd.z),
    name: nd.name || null, station: nd.station || null, switchable: !!nd.switchable,
    groundY: round(nd.naturalY),
    branches: nd.branches, default: 0,
  })),
  segments: [...built.values()],
  landmarks: LANDMARKS,
  water: { river: RIVER, creek: CREEK, inlet: INLET, gorge: GORGE, basins: BASINS },
};

fs.mkdirSync(OUT, { recursive: true });
const write = (name, obj) => {
  const file = path.join(OUT, name);
  fs.writeFileSync(file, JSON.stringify(obj));
  console.log(`  wrote ${path.relative(ROOT, file)}  (${(fs.statSync(file).size / 1024).toFixed(1)} KB)`);
};
console.log('IRONBOUND world generator');
write('tracks.json', tracks);
write('stations.json', { version: 1, stations: STATIONS });
write('biomes.json', { version: 1, biomes: Object.values(BIOMES) });

/* ================================================================ REPORT */
const sw = [...nodes.values()].filter((nd) => nd.switchable).length;
const sidings = [...segments.values()].filter((s) => s.kind === 'siding').length;
const tun = [...built.values()].reduce((a, s) => a + s.tunnels.length, 0);
const bri = [...built.values()].reduce((a, s) => a + s.bridges.length + s.viaducts.length, 0);
console.log(`\n${segments.size} segments · ${nodes.size} nodes · ${(totalLength / 1000).toFixed(1)} km of rail`);
console.log(`switchable: ${sw} · sidings: ${sidings} · tunnels: ${tun} · bridges/viaducts: ${bri} · stations: ${STATIONS.length}`);
console.log('\nsegment                 km   grade  pts bri via tun  cut fill  y0    y1   water');
for (const r of report) {
  console.log([
    r.id.padEnd(18), r.km.toFixed(2).padStart(6), (r.grade.toFixed(1) + '%').padStart(7),
    String(r.pts).padStart(4), String(r.bri).padStart(3), String(r.via).padStart(3), String(r.tun).padStart(3),
    r.cut.toFixed(0).padStart(4), r.fill.toFixed(0).padStart(4),
    r.y0.toFixed(0).padStart(5), r.y1.toFixed(0).padStart(5), ' ' + r.water,
  ].join(' '));
}
if (problems.length) {
  console.log('\n⚠ PROBLEMS:');
  for (const p of problems) console.log('  - ' + p);
} else {
  console.log('\n✓ no problems detected');
}
