/**
 * Deterministic value/gradient noise. Pure JS — no dependencies — so the same
 * module runs in the browser (TerrainManager) and in Node (tools/gen-world.mjs),
 * guaranteeing the offline-generated track data matches the runtime terrain.
 */
import { clamp01, smoothstep } from './math.js';

const PERM_SIZE = 512;

function buildPerm(seed) {
  const p = new Uint8Array(PERM_SIZE);
  let s = seed >>> 0;
  const rnd = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  for (let i = 0; i < 256; i++) p[i + 256] = p[i];
  return p;
}

const PERM = buildPerm(1337);

const GRAD2 = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1, 0], [-1, 0], [0, 1], [0, -1],
];

function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }

/** 2D Perlin-style gradient noise, output roughly [-1, 1]. */
export function noise2(x, y) {
  const X = Math.floor(x) & 255;
  const Y = Math.floor(y) & 255;
  const xf = x - Math.floor(x);
  const yf = y - Math.floor(y);
  const u = fade(xf);
  const v = fade(yf);

  const aa = PERM[PERM[X] + Y] & 7;
  const ab = PERM[PERM[X] + Y + 1] & 7;
  const ba = PERM[PERM[X + 1] + Y] & 7;
  const bb = PERM[PERM[X + 1] + Y + 1] & 7;

  const d = (g, dx, dy) => GRAD2[g][0] * dx + GRAD2[g][1] * dy;
  const x1 = d(aa, xf, yf) + u * (d(ba, xf - 1, yf) - d(aa, xf, yf));
  const x2 = d(ab, xf, yf - 1) + u * (d(bb, xf - 1, yf - 1) - d(ab, xf, yf - 1));
  return (x1 + v * (x2 - x1)) * 0.7;
}

/** Fractal Brownian motion. */
export function fbm(x, y, octaves = 5, lacunarity = 2.02, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2(x * freq, y * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Ridged multifractal — sharp alpine peaks. */
export function ridged(x, y, octaves = 5, lacunarity = 2.07, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(noise2(x * freq, y * freq));
    sum += amp * n * n;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Cheap 2D hash → [0,1). Good for scatter/jitter. */
export function hash2(x, y) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function hashRange(x, y, lo, hi) {
  return lo + hash2(x, y) * (hi - lo);
}

/** Distance to a polyline in the XZ plane. Returns { dist, t, index, point }. */
export function distanceToPolyline(poly, x, z) {
  let best = Infinity, bestT = 0, bestI = 0, bx = poly[0][0], bz = poly[0][1];
  for (let i = 0; i < poly.length - 1; i++) {
    const ax = poly[i][0], az = poly[i][1];
    const bxx = poly[i + 1][0], bzz = poly[i + 1][1];
    const dx = bxx - ax, dz = bzz - az;
    const len2 = dx * dx + dz * dz || 1e-9;
    let t = ((x - ax) * dx + (z - az) * dz) / len2;
    t = clamp01(t);
    const px = ax + dx * t, pz = az + dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < best) { best = d; bestT = t; bestI = i; bx = px; bz = pz; }
  }
  return { dist: best, t: bestT, index: bestI, x: bx, z: bz };
}

export { smoothstep };
