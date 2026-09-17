/**
 * Spline utilities — arc-length parameterisation and frame sampling
 * (GDD §5.2.2 "Custom rail physics: 1D simulation on spline").
 */
import * as THREE from 'three';

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

/** Build a smooth centripetal Catmull-Rom curve through control points. */
export function makeCurve(points, closed = false) {
  const pts = points.map((p) => (p.isVector3 ? p.clone() : new THREE.Vector3(p.x, p.y, p.z)));
  const curve = new THREE.CatmullRomCurve3(pts, closed, 'catmullrom', 0.5);
  // Denser LUT → smoother getPointAt() on long segments.
  curve.arcLengthDivisions = Math.max(400, Math.min(8000, Math.round(curve.getLength() * 2)));
  curve.updateArcLengths();
  return curve;
}

/** Position at normalised arc-length u ∈ [0,1]. */
export function pointAt(curve, u, out = new THREE.Vector3()) {
  return curve.getPointAt(THREE.MathUtils.clamp(u, 0, 1), out);
}

/** Unit tangent at u. */
export function tangentAt(curve, u, out = new THREE.Vector3()) {
  return curve.getTangentAt(THREE.MathUtils.clamp(u, 0, 1), out);
}

/**
 * Signed curvature (1/R) at u, via a three-point circumradius in the XZ plane
 * combined with the vertical curvature. Cheap and stable enough for physics.
 */
export function curvatureAt(curve, u, step = 0.004) {
  const a = pointAt(curve, Math.max(0, u - step), _v1);
  const b = pointAt(curve, u, _v2);
  const c = pointAt(curve, Math.min(1, u + step), _v3);
  const ax = a.x, az = a.z, bx = b.x, bz = b.z, cx = c.x, cz = c.z;
  const area = Math.abs((bx - ax) * (cz - az) - (cx - ax) * (bz - az));
  const la = Math.hypot(bx - ax, bz - az);
  const lb = Math.hypot(cx - bx, cz - bz);
  const lc = Math.hypot(cx - ax, cz - az);
  const denom = la * lb * lc;
  const horiz = denom > 1e-9 ? (2 * area) / denom : 0; // = 1/R
  // vertical curvature from slope change
  const s1 = (b.y - a.y) / Math.max(1e-6, Math.hypot(bx - ax, bz - az));
  const s2 = (c.y - b.y) / Math.max(1e-6, Math.hypot(cx - bx, cz - bz));
  const arcLen = (la + lb) * 0.5;
  const vert = arcLen > 1e-6 ? Math.abs(s2 - s1) / arcLen : 0;
  return { horizontal: horiz, vertical: vert, total: Math.hypot(horiz, vert * 0.5) };
}

/**
 * Right-hand horizontal normal (perpendicular to the tangent, in the XZ plane),
 * used for gauge offsets and banking.
 */
export function sideNormal(tangent, out = new THREE.Vector3()) {
  out.set(-tangent.z, 0, tangent.x);
  const l = Math.hypot(out.x, out.z) || 1;
  return out.multiplyScalar(1 / l);
}

/**
 * Full track frame at u: position, forward tangent, up (with superelevation),
 * right vector, curvature and grade.
 * @param {number} bank superelevation in radians (positive = tilt to the right of travel)
 */
export function frameAt(curve, u, bank = 0, dir = 1, out = {}) {
  out.position = pointAt(curve, u, out.position || new THREE.Vector3());
  out.tangent = tangentAt(curve, u, out.tangent || new THREE.Vector3());
  if (dir < 0) out.tangent.negate();
  out.right = sideNormal(out.tangent, out.right || new THREE.Vector3());
  out.up = out.up || new THREE.Vector3();
  out.up.set(0, 1, 0).applyAxisAngle(out.tangent, -bank * dir);
  out.up.normalize();
  out.grade = out.tangent.y; // sin(theta)
  out.curvature = curvatureAt(curve, u).horizontal;
  return out;
}

/** Total arc length in metres. */
export function curveLength(curve) { return curve.getLength(); }

/** Convert metres → u using the curve's arc-length LUT. */
export function metresToU(curve, metres) {
  const L = curve.getLength();
  return L > 0 ? THREE.MathUtils.clamp(metres / L, 0, 1) : 0;
}

/** Uniformly resample the curve into `count` world-space points. */
export function resample(curve, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(pointAt(curve, i / (count - 1), new THREE.Vector3()));
  return out;
}

/** Catmull-Rom through 2D control points with automatic subdivision + jitter. */
export function densify2D(points, spacing = 60, jitter = 0, rand = Math.random) {
  if (points.length < 2) return points.slice();
  const out = [points[0].slice()];
  for (let i = 0; i < points.length - 1; i++) {
    const [ax, az] = points[i];
    const [bx, bz] = points[i + 1];
    const d = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.round(d / spacing));
    const nx = -(bz - az) / d, nz = (bx - ax) / d;
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const off = k === n ? 0 : (rand() - 0.5) * 2 * jitter;
      out.push([ax + (bx - ax) * t + nx * off, az + (bz - az) * t + nz * off]);
    }
  }
  return out;
}
