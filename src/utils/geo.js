/**
 * Geometry kit: build stylised low-poly models as a SINGLE merged,
 * vertex-coloured BufferGeometry. One geometry + one shared material means one
 * draw call per model and trivial instancing (GDD §5.2.1 draw-call budget).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _c = new THREE.Color();

export class Builder {
  constructor() { this.parts = []; }

  _paint(geo, color, jitter = 0) {
    const n = geo.attributes.position.count;
    const arr = new Float32Array(n * 3);
    _c.set(color);
    for (let i = 0; i < n; i++) {
      const j = jitter ? 1 + (Math.random() - 0.5) * jitter : 1;
      arr[i * 3] = _c.r * j; arr[i * 3 + 1] = _c.g * j; arr[i * 3 + 2] = _c.b * j;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return geo;
  }

  _place(geo, x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
    _e.set(rx, ry, rz);
    _q.setFromEuler(_e);
    _v.set(x, y, z);
    _m.compose(_v, _q, new THREE.Vector3(sx, sy, sz));
    geo.applyMatrix4(_m);
    return geo;
  }

  add(geo, color, pos = [0, 0, 0], rot = [0, 0, 0], jitter = 0) {
    this._paint(geo, color, jitter);
    this._place(geo, pos[0], pos[1], pos[2], rot[0], rot[1], rot[2]);
    this.parts.push(geo);
    return this;
  }

  box(w, h, d, color, pos = [0, 0, 0], rot = [0, 0, 0], jitter = 0) {
    return this.add(new THREE.BoxGeometry(w, h, d), color, pos, rot, jitter);
  }

  cyl(rt, rb, h, color, pos = [0, 0, 0], rot = [0, 0, 0], seg = 10, jitter = 0) {
    return this.add(new THREE.CylinderGeometry(rt, rb, h, seg), color, pos, rot, jitter);
  }

  cone(r, h, color, pos = [0, 0, 0], rot = [0, 0, 0], seg = 8, jitter = 0) {
    return this.add(new THREE.ConeGeometry(r, h, seg), color, pos, rot, jitter);
  }

  sphere(r, color, pos = [0, 0, 0], w = 8, h = 6, jitter = 0) {
    return this.add(new THREE.SphereGeometry(r, w, h), color, pos, [0, 0, 0], jitter);
  }

  /** Horizontal prism (roof / hopper sides) from a triangle extrusion. */
  prism(width, height, depth, color, pos = [0, 0, 0], rot = [0, 0, 0]) {
    const shape = new THREE.Shape();
    shape.moveTo(-width / 2, 0); shape.lineTo(width / 2, 0); shape.lineTo(0, height); shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
    geo.translate(0, 0, -depth / 2);
    return this.add(geo, color, pos, rot);
  }

  /** Trapezoid beam (ballast, embankments). */
  trapezoid(topW, botW, height, depth, color, pos = [0, 0, 0], rot = [0, 0, 0]) {
    const shape = new THREE.Shape();
    shape.moveTo(-botW / 2, -height / 2); shape.lineTo(botW / 2, -height / 2);
    shape.lineTo(topW / 2, height / 2); shape.lineTo(-topW / 2, height / 2); shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
    geo.translate(0, 0, -depth / 2);
    return this.add(geo, color, pos, rot);
  }

  plane(w, d, color, pos = [0, 0, 0], rot = [-Math.PI / 2, 0, 0]) {
    return this.add(new THREE.PlaneGeometry(w, d), color, pos, rot);
  }

  /** Merge everything; returns a single non-indexed-friendly BufferGeometry. */
  build() {
    if (!this.parts.length) return new THREE.BufferGeometry();
    const cleaned = this.parts.map((g) => {
      let geo = g.index ? g.toNonIndexed() : g;
      if (!geo.attributes.normal) geo.computeVertexNormals();
      return geo;
    });
    const merged = mergeGeometries(cleaned, false);
    for (const g of cleaned) g.dispose();
    this.parts.length = 0;
    merged.computeBoundingSphere();
    return merged;
  }

  mesh(material) {
    const geo = this.build();
    const m = new THREE.Mesh(geo, material);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  }
}

/** Shared materials so identical models batch nicely. */
export const MATERIALS = {
  paint: () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0.06 }),
  metal: () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.72 }),
  matte: () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0.0 }),
  glass: () => new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.15, metalness: 0.4, transparent: true, opacity: 0.72,
  }),
  emissive: (intensity = 1) => new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.5, metalness: 0.1, emissive: 0xffffff, emissiveIntensity: intensity,
  }),
};

/** Simple deterministic RNG for model variation. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
