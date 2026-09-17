/** Small math helpers shared by every system (GDD §utils/math.js). */

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
};
export const smootherstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * t * (t * (t * 6 - 15) + 10);
};
export const deg = (r) => (r * 180) / Math.PI;
export const rad = (d) => (d * Math.PI) / 180;
export const kmh = (ms) => ms * 3.6;
export const ms = (kmh_) => kmh_ / 3.6;
export const sign = Math.sign;
export const TAU = Math.PI * 2;

/** Frame-rate independent exponential damping. */
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));

/** Unity-style critically damped spring (GDD §4.2 "smooth follow with damping"). */
export function smoothDamp(current, target, velRef, smoothTime, dt, maxSpeed = Infinity) {
  const st = Math.max(1e-4, smoothTime);
  const omega = 2 / st;
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  let change = current - target;
  const maxChange = maxSpeed * st;
  change = clamp(change, -maxChange, maxChange);
  const temp = (velRef.v + omega * change) * dt;
  let v = (velRef.v - omega * temp) * exp;
  let out = target + (change + temp) * exp;
  if (target - current > 0 === out > target) {
    out = target;
    v = (out - target) / dt;
  }
  velRef.v = clamp(v, -maxSpeed * 4, maxSpeed * 4);
  return out;
}

export function approach(current, target, maxDelta) {
  if (Math.abs(target - current) <= maxDelta) return target;
  return current + Math.sign(target - current) * maxDelta;
}

export function wrap(v, min, max) {
  const span = max - min;
  return ((((v - min) % span) + span) % span) + min;
}

/** Deterministic 32-bit hash → [0,1). */
export function hash01(x, y = 0, z = 0) {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (z | 0) * 2147483647;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function formatMoney(v) {
  const neg = v < 0;
  const n = Math.abs(Math.round(v));
  return `${neg ? '-' : ''}$${n.toLocaleString('en-US')}`;
}

export function formatClock(seconds) {
  if (!isFinite(seconds)) return '--:--';
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

export function formatTimeOfDay(t) {
  // t in [0,1), 0 = midnight
  const total = ((t % 1) + 1) % 1 * 24 * 60;
  const h = Math.floor(total / 60);
  const m = Math.floor(total % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Round to a nice human number for distances. */
export function formatDistance(metres) {
  const a = Math.abs(metres);
  if (a < 1000) return `${Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}

export function pickWeighted(items, weightFn, rand) {
  let total = 0;
  for (const it of items) total += weightFn(it);
  if (total <= 0) return items[0];
  let r = rand() * total;
  for (const it of items) {
    r -= weightFn(it);
    if (r <= 0) return it;
  }
  return items[items.length - 1];
}
