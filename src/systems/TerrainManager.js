/**
 * TerrainManager — chunked, camera-following heightmap (GDD §4.2, §5.2.3).
 *
 * The world is 16 km × 16 km split into 8×8 chunks of 2 km. Each chunk is
 * tessellated at a resolution chosen by its Chebyshev ring distance from the
 * camera chunk (CHUNK_LOD): 128² near, 8² at the horizon.
 *
 * Nothing is ever generated in one go. A chunk is filled in row bands across as
 * many frames as it needs under a millisecond budget, and the outgoing mesh
 * stays on screen until its replacement is complete — so a chunk boundary
 * crossing costs the player no frames at all.
 *
 * Vertices inside the track corridor are dressed to the formation height (the
 * same sample grid TrackNetwork builds for scatter rejection), which is what
 * makes cuttings read as cuttings and embankments as embankments. Bridges and
 * tunnels opt out, so valleys stay open and bores stay buried.
 */
import * as THREE from 'three';
import { WORLD, CHUNK_LOD, BIOMES } from '../constants.js';
import { heightAt, biomeWeights } from '../utils/terrain.js';
import { hash2 } from '../utils/noise.js';
import { clamp, clamp01, smoothstep } from '../utils/math.js';

const _w = { alpine: 0, forest: 0, plains: 0, coastal: 0 };
const _c = new THREE.Color();
const _c2 = new THREE.Color();

/* palette */
const C_ROCK = new THREE.Color(0x6d675c);
const C_ROCK_DARK = new THREE.Color(0x57524a);
const C_SNOW = new THREE.Color(0xeef3f7);
const C_SAND = new THREE.Color(0xc8b588);
const C_MUD = new THREE.Color(0x4c4a3c);
const C_SEABED = new THREE.Color(0x57533f);
const C_DEEP = new THREE.Color(0x2f3a3a);
const C_FARM = new THREE.Color(0xc0a24a);
const C_GRASS = new THREE.Color(0x77913f);
const C_MARSH = new THREE.Color(0x5d6b45);
const C_MOSS = new THREE.Color(0x3f5c33);
const C_SCREE = new THREE.Color(0x83796a);

const BIOME_BASE = {
  alpine: new THREE.Color(BIOMES.alpine.ground),
  forest: new THREE.Color(BIOMES.forest.ground),
  plains: new THREE.Color(BIOMES.plains.ground),
  coastal: new THREE.Color(BIOMES.coastal.ground),
};

/**
 * Per-vertex colour for one biome, given local conditions.
 * @param {string} biome
 * @param {number} h height, @param {number} slope rise/run, @param {number} snow 0..1
 */
function shade(biome, x, z, h, slope, snow, farm, out) {
  out.copy(BIOME_BASE[biome]);
  switch (biome) {
    case 'alpine':
      if (slope > 0.30) out.lerp(C_ROCK, clamp01((slope - 0.30) * 2.2));
      if (slope > 0.75) out.lerp(C_ROCK_DARK, clamp01((slope - 0.75) * 1.6));
      if (h > 250 && slope < 0.5) out.lerp(C_SCREE, clamp01((h - 250) / 220) * 0.5);
      if (snow > 0) out.lerp(C_SNOW, snow);
      break;
    case 'forest':
      out.lerp(C_MOSS, clamp01(0.35 - slope * 0.6));
      if (slope > 0.42) out.lerp(C_ROCK, clamp01((slope - 0.42) * 1.8));
      if (h < 12) out.lerp(C_MARSH, clamp01((12 - h) / 12) * 0.6);
      break;
    case 'plains':
      out.lerp(C_GRASS, 0.45);
      if (farm > 0) out.lerp(C_FARM, farm);
      if (slope > 0.22) out.lerp(C_ROCK, clamp01((slope - 0.22) * 1.4) * 0.6);
      if (h < 8) out.lerp(C_MARSH, clamp01((8 - h) / 8) * 0.5);
      break;
    case 'coastal':
      out.lerp(C_MARSH, 0.5);
      if (h < 3.5) out.lerp(C_MUD, clamp01((3.5 - h) / 3.5));
      if (slope > 0.3) out.lerp(C_ROCK, clamp01((slope - 0.3) * 1.5));
      break;
  }
  return out;
}

export class TerrainChunk {
  constructor(cx, cz, size, res, net) {
    this.cx = cx; this.cz = cz;
    this.size = size; this.res = res;
    this.net = net;
    this.step = size / res;
    this.ox = cx * size - WORLD.half;
    this.oz = cz * size - WORLD.half;
    this.n = res + 1;
    this.count = this.n * this.n;
    this.positions = new Float32Array(this.count * 3);
    this.colors = new Float32Array(this.count * 3);
    this.heights = new Float32Array(this.count);
    this.row = 0;          // heights phase cursor
    this.crow = 0;         // colour phase cursor
    this.phase = 0;        // 0 heights, 1 colours, 2 done
    this.mesh = null;
    this.skirtDrop = Math.min(90, Math.max(4, this.step * 1.2));
    this.cGrid = null;
    this.cCell = 64;
    this._indexCorridor();
  }

  /**
   * A per-chunk spatial hash of the track corridor. Querying the network's
   * global grid for all 16 k vertices of a chunk would dominate the build, so
   * chunks that hold no track at all skip dressing entirely.
   */
  _indexCorridor() {
    const net = this.net;
    if (!net?.corridor) return;
    const pad = 60;
    const x0 = this.ox - pad, x1 = this.ox + this.size + pad;
    const z0 = this.oz - pad, z1 = this.oz + this.size + pad;
    const grid = new Map();
    let any = false;
    for (const s of net.corridor) {
      if (s.r <= 0) continue;                 // tunnels and bridges: leave ground alone
      if (s.x < x0 || s.x > x1 || s.z < z0 || s.z > z1) continue;
      any = true;
      const key = `${Math.floor((s.x - x0) / this.cCell)},${Math.floor((s.z - z0) / this.cCell)}`;
      let list = grid.get(key);
      if (!list) { list = []; grid.set(key, list); }
      list.push(s);
    }
    if (any) this.cGrid = grid;
  }

  /** Nearest dressing sample for a vertex, or null. */
  _corridorAt(x, z) {
    const grid = this.cGrid;
    if (!grid) return null;
    const cx = Math.floor((x - this.ox) / this.cCell), cz = Math.floor((z - this.oz) / this.cCell);
    let best = null, bd = 46 * 46;
    for (let iz = -1; iz <= 1; iz++) {
      for (let ix = -1; ix <= 1; ix++) {
        const list = grid.get(`${cx + ix},${cz + iz}`);
        if (!list) continue;
        for (const s of list) {
          const d = (s.x - x) ** 2 + (s.z - z) ** 2;
          if (d < bd) { bd = d; best = s; }
        }
      }
    }
    return best;
  }

  get done() { return this.phase >= 2; }

  ix(i, j) { return j * this.n + i; }

  /** Do up to `budget` vertex-rows of work. Returns rows completed. */
  work(budget = 6) {
    if (this.phase >= 2) return 0;
    let rows = 0;
    if (this.phase === 0) {
      while (rows < budget && this.row < this.n) { this._heightRow(this.row++); rows++; }
      if (this.row >= this.n) this.phase = 1;
      return rows;
    }
    while (rows < budget && this.crow < this.n) { this._colourRow(this.crow++); rows++; }
    if (this.crow >= this.n) this.phase = 2;
    return rows;
  }

  _heightRow(j) {
    const z = this.oz + j * this.step;
    const dress = this.cGrid !== null;
    const blend = Math.min(30, Math.max(10, this.step * 1.2));
    for (let i = 0; i < this.n; i++) {
      const x = this.ox + i * this.step;
      let h = heightAt(x, z);
      // dress the ground to the track formation where the corridor asks for it
      if (dress) {
        const s = this._corridorAt(x, z);
        if (s) {
          const d = Math.hypot(s.x - x, s.z - z);
          const t = 1 - smoothstep(s.r, s.r + blend, d);
          if (t > 0) h += (s.y - 0.35 - h) * t;
        }
      }
      const k = this.ix(i, j);
      this.heights[k] = h;
      const p = k * 3;
      this.positions[p] = x; this.positions[p + 1] = h; this.positions[p + 2] = z;
    }
  }

  _colourRow(j) {
    const n = this.n, step = this.step;
    for (let i = 0; i < n; i++) {
      const k = this.ix(i, j);
      const h = this.heights[k];
      const x = this.ox + i * step, z = this.oz + j * step;
      // slope from the grid itself — no extra height queries
      const hl = this.heights[this.ix(Math.max(0, i - 1), j)];
      const hr = this.heights[this.ix(Math.min(n - 1, i + 1), j)];
      const hd = this.heights[this.ix(i, Math.max(0, j - 1))];
      const hu = this.heights[this.ix(i, Math.min(n - 1, j + 1))];
      const dx = i === 0 || i === n - 1 ? (hr - hl) / step : (hr - hl) / (2 * step);
      const dz = j === 0 || j === n - 1 ? (hu - hd) / step : (hu - hd) / (2 * step);
      const slope = Math.hypot(dx, dz);

      biomeWeights(x, z, _w);
      let r = 0, g = 0, b = 0, wsum = 0;
      for (const key of ['alpine', 'forest', 'plains', 'coastal']) {
        const w = _w[key];
        if (w < 0.015) continue;
        let snow = 0;
        if (key === 'alpine') {
          const line = 325 - 55 * hash2(Math.floor(x / 900), Math.floor(z / 900));
          snow = clamp01(smoothstep(line, line + 140, h)) * clamp01(w * 1.35 + _w.forest * 0.1);
        }
        let farm = 0;
        if (key === 'plains' && w > 0.4) {
          const field = hash2(Math.floor(x / 240), Math.floor(z / 240));
          if (field > 0.45 && slope < 0.085 && h > 9) farm = clamp01((w - 0.4) / 0.35) * (0.5 + 0.5 * field);
        }
        shade(key, x, z, h, slope, snow, farm, _c);
        r += _c.r * w; g += _c.g * w; b += _c.b * w; wsum += w;
      }
      if (wsum > 0) { r /= wsum; g /= wsum; b /= wsum; }
      else { r = 0.4; g = 0.4; b = 0.35; }

      if (h < 0.5) {
        // shoreline, beach and seabed
        const beach = clamp01(smoothstep(-1.2, 2.4, h));
        _c2.copy(C_SEABED).lerp(C_DEEP, clamp01(-h / 16));
        _c2.lerp(C_SAND, clamp01(smoothstep(-2.5, 0.8, h)));
        r += (_c2.r - r) * (1 - beach); g += (_c2.g - g) * (1 - beach); b += (_c2.b - b) * (1 - beach);
        r += (C_SAND.r - r) * clamp01(smoothstep(0.2, 2.2, h)) * 0.75 * (slope < 0.3 ? 1 : 0);
        g += (C_SAND.g - g) * clamp01(smoothstep(0.2, 2.2, h)) * 0.75 * (slope < 0.3 ? 1 : 0);
        b += (C_SAND.b - b) * clamp01(smoothstep(0.2, 2.2, h)) * 0.75 * (slope < 0.3 ? 1 : 0);
      }
      // fine grain so large flats do not look like painted cardboard
      const grain = 0.94 + 0.12 * hash2(Math.floor(x / 9), Math.floor(z / 9));
      const mottle = 0.97 + 0.06 * hash2(Math.floor(x / 137) + 31, Math.floor(z / 137) - 17);
      const p = k * 3;
      this.colors[p] = clamp01(r * grain * mottle);
      this.colors[p + 1] = clamp01(g * grain * mottle);
      this.colors[p + 2] = clamp01(b * grain * mottle);
    }
  }

  /** Build the final geometry (grid + skirts) once both phases are done. */
  finalize(material) {
    const n = this.n, res = this.res;
    const index = [];
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const a = this.ix(i, j), b = this.ix(i + 1, j), c = this.ix(i, j + 1), d = this.ix(i + 1, j + 1);
        index.push(a, c, b, b, c, d);
      }
    }
    // skirts hide T-junction cracks against neighbouring chunks at another LOD
    const positions = this.positions;
    const colors = this.colors;
    const extra = [];
    const extraCol = [];
    const base = this.count;
    // flip = true when the ring runs such that (top0, top1, bot0) faces inward
    const pushRing = (getIdx, flip) => {
      const start = base + extra.length / 3;
      for (let t = 0; t < n; t++) {
        const k = getIdx(t);
        extra.push(positions[k * 3], positions[k * 3 + 1] - this.skirtDrop, positions[k * 3 + 2]);
        extraCol.push(colors[k * 3] * 0.55, colors[k * 3 + 1] * 0.55, colors[k * 3 + 2] * 0.55);
      }
      for (let t = 0; t < n - 1; t++) {
        const top0 = getIdx(t), top1 = getIdx(t + 1);
        const bot0 = start + t, bot1 = start + t + 1;
        if (flip) index.push(top0, bot0, top1, top1, bot0, bot1);
        else index.push(top0, top1, bot0, top1, bot1, bot0);
      }
    };
    pushRing((t) => this.ix(t, 0), false);   // south face looks −Z
    pushRing((t) => this.ix(t, res), true);  // north face looks +Z
    pushRing((t) => this.ix(0, t), true);    // west face looks −X
    pushRing((t) => this.ix(res, t), false); // east face looks +X

    const pos = new Float32Array(positions.length + extra.length);
    pos.set(positions, 0);
    pos.set(extra, positions.length);
    const col = new Float32Array(colors.length + extraCol.length);
    col.set(colors, 0);
    col.set(extraCol, colors.length);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(index);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = `terrain_${this.cx}_${this.cz}_${res}`;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.mesh = mesh;
    this.positions = null; this.colors = null; this.heights = null;
    return mesh;
  }

  dispose() {
    if (this.mesh) { this.mesh.geometry.dispose(); this.mesh.removeFromParent(); this.mesh = null; }
    this.positions = this.colors = this.heights = null;
  }
}

export class TerrainManager {
  constructor(scene, net, opts = {}) {
    this.scene = scene;
    this.net = net;
    this.size = WORLD.chunkSize;
    this.perSide = WORLD.chunksPerSide;
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: opts.flatShading ?? false });
    this.root = new THREE.Group();
    this.root.name = 'terrain';
    this.root.matrixAutoUpdate = false;
    scene.add(this.root);

    /** @type {Map<string, {mesh:THREE.Mesh|null, pending:TerrainChunk|null, lod:number}>} */
    this.chunks = new Map();
    this.budgetRows = opts.budgetRows ?? 5;
    this.timeBudget = opts.timeBudget ?? 4.5; // ms per frame
    this.lastCameraChunk = null;
    this.stats = { built: 0, queued: 0, ms: 0 };
    this.rings = CHUNK_LOD;
  }

  key(cx, cz) { return `${cx},${cz}`; }

  resolutionFor(ring) {
    for (const r of this.rings) if (ring <= r.radius) return r.resolution;
    return 8;
  }

  update(cameraPos) {
    const t0 = now();
    const ccx = Math.floor((cameraPos.x + WORLD.half) / this.size);
    const ccz = Math.floor((cameraPos.z + WORLD.half) / this.size);
    const moved = !this.lastCameraChunk || this.lastCameraChunk.x !== ccx || this.lastCameraChunk.z !== ccz;
    this.lastCameraChunk = { x: ccx, z: ccz };

    // desired state for every chunk in the world (only 64 of them)
    for (let cz = 0; cz < this.perSide; cz++) {
      for (let cx = 0; cx < this.perSide; cx++) {
        const ring = Math.max(Math.abs(cx - ccx), Math.abs(cz - ccz));
        const res = this.resolutionFor(ring);
        const k = this.key(cx, cz);
        let e = this.chunks.get(k);
        if (!e) { e = { mesh: null, pending: null, lod: -1 }; this.chunks.set(k, e); }
        if (e.lod === res && (e.mesh || e.pending)) continue;
        e.lod = res;
        if (e.pending) { e.pending.dispose(); e.pending = null; }
        e.pending = new TerrainChunk(cx, cz, this.size, res, this.net);
      }
    }

    // spend the frame budget on whichever pending chunk is closest to the camera
    let guard = 0;
    while (guard++ < 400) {
      let best = null, bd = Infinity;
      for (const e of this.chunks.values()) {
        if (!e.pending || e.pending.done) continue;
        const d = Math.abs(e.pending.cx - ccx) + Math.abs(e.pending.cz - ccz);
        if (d < bd) { bd = d; best = e; }
      }
      if (!best) break;
      const chunk = best.pending;
      const rows = chunk.work(this.budgetRows);
      if (rows <= 0) break;
      if (chunk.done) {
        const mesh = chunk.finalize(this.material);
        this.root.add(mesh);
        if (best.mesh) { best.mesh.removeFromParent(); best.mesh.geometry.dispose(); }
        best.mesh = mesh;
        best.pending = null;
        this.stats.built++;
      }
      if (now() - t0 > this.timeBudget) break;
    }
    this.stats.ms = now() - t0;
    let queued = 0;
    for (const e of this.chunks.values()) if (e.pending) queued++;
    this.stats.queued = queued;
  }

  /** Terrain height including track-corridor dressing (what props should sit on). */
  surfaceHeight(x, z) {
    let h = heightAt(x, z);
    const s = this.net?.nearestFormation(x, z, 46);
    if (s) {
      const d = Math.hypot(s.x - x, s.z - z);
      const t = 1 - smoothstep(s.r, s.r + 14, d);
      if (t > 0) h += (s.y - 0.35 - h) * t;
    }
    return h;
  }

  /** True where scatter (trees, rocks, buildings) must not be placed. */
  isCorridor(x, z, margin = 3) {
    const s = this.net?.nearestCorridor(x, z, 34);
    if (!s) return false;
    return Math.hypot(s.x - x, s.z - z) < (s.r || 9) + margin;
  }

  /** Distance to the nearest rail, or Infinity. */
  distanceToTrack(x, z, maxDist = 60) {
    const s = this.net?.nearestCorridor(x, z, maxDist);
    return s ? Math.hypot(s.x - x, s.z - z) : Infinity;
  }

  triangleCount() {
    let t = 0;
    for (const e of this.chunks.values()) if (e.mesh) t += e.mesh.geometry.index.count / 3;
    return Math.round(t);
  }

  vertexCount() {
    let v = 0;
    for (const e of this.chunks.values()) if (e.mesh) v += e.mesh.geometry.attributes.position.count;
    return v;
  }

  dispose() {
    for (const e of this.chunks.values()) {
      if (e.mesh) { e.mesh.geometry.dispose(); e.mesh.removeFromParent(); }
      e.pending?.dispose();
    }
    this.chunks.clear();
    this.material.dispose();
    this.root.removeFromParent();
  }
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export default TerrainManager;
