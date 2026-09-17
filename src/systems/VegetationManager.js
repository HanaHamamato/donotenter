/**
 * VegetationManager — biome-driven scatter (GDD §4.3, §7 VegetationManager).
 *
 * The world is tiled into 200 m cells. Each cell's contents are generated
 * deterministically from its coordinates, so a forest looks identical every
 * time the player comes back and nothing has to be saved. Cells inside the
 * streaming radius are collected into a handful of shared InstancedMeshes —
 * one draw call per species for the whole visible world — and per-instance
 * colour gives each tree its own hue without a single extra material.
 *
 * Placement rules: never on the track corridor, never in water, never on a
 * slope too steep to hold a root ball, species chosen by biome and altitude.
 */
import * as THREE from 'three';
import { BIOMES, VEGETATION_RADIUS } from '../constants.js';
import { heightAt, biomeWeights, biomeAt } from '../utils/terrain.js';
import { hash2 } from '../utils/noise.js';
import { clamp, mulberry32 } from '../utils/math.js';

const CELL = 200;
const _w = { alpine: 0, forest: 0, plains: 0, coastal: 0 };
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const _col = new THREE.Color();

const SPECIES = {
  conifer: ['tree_conifer_0', 'tree_conifer_1', 'tree_conifer_2'],
  deciduous: ['tree_deciduous_0', 'tree_deciduous_1', 'tree_deciduous_2'],
  dead: ['tree_dead_0', 'tree_dead_1', 'tree_dead_2'],
  bush: ['bush'],
  rock: ['rock_small', 'rock_large'],
  reeds: ['reeds'],
  wheat: ['wheat'],
};

export class VegetationManager {
  /**
   * @param {THREE.Scene} scene
   * @param {import('./TrackNetwork.js').TrackNetwork} net
   * @param {import('./AssetManager.js').AssetManager} assets
   * @param {import('./TerrainManager.js').TerrainManager} terrain
   */
  constructor(scene, net, assets, terrain, opts = {}) {
    this.scene = scene;
    this.net = net;
    this.assets = assets;
    this.terrain = terrain;
    this.cell = CELL;
    this.shadowMode = 'trees';
    this.radius = opts.radius ?? VEGETATION_RADIUS;
    this.density = 1;
    this.group = new THREE.Group();
    this.group.name = 'vegetation';
    scene.add(this.group);

    /** @type {Map<string, {cx:number,cz:number,props:Array}>} */
    this.cells = new Map();
    this.meshes = new Map();
    this.capacity = opts.capacity ?? 26000;
    this.timeBudget = opts.timeBudget ?? 3.2;
    this.lastKey = null;
    this.dirty = true;
    this.stats = { props: 0, cells: 0, ms: 0 };

    for (const group of Object.values(SPECIES)) {
      for (const key of group) this._ensureMesh(key);
    }
  }

  _ensureMesh(key) {
    if (this.meshes.has(key)) return this.meshes.get(key);
    const geo = this.assets.geometry(key);
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const inst = new THREE.InstancedMesh(geo, mat, this.capacity);
    inst.count = 0;
    inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Shadows are opt-in per preset: with frustumCulled off, every live instance
    // is drawn into the shadow map, so only the presets that can afford it do.
    inst.castShadow = this.shadowMode === 'all' || (this.shadowMode === 'trees' && key.startsWith('tree_'));
    inst.receiveShadow = true;
    inst.frustumCulled = false;   // matrices are refilled wholesale
    inst.name = `veg_${key}`;
    // per-instance tint
    inst.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3);
    inst.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.group.add(inst);
    const entry = { inst, key, fill: 0 };
    this.meshes.set(key, entry);
    return entry;
  }

  /** 'none' | 'trees' | 'all' — which props cast into the shadow map. */
  setShadows(mode) {
    this.shadowMode = mode === 'all' || mode === 'trees' ? mode : 'none';
    for (const e of this.meshes.values()) {
      e.inst.castShadow = this.shadowMode === 'all' || (this.shadowMode === 'trees' && e.key.startsWith('tree_'));
    }
  }

  setDensity(d) {
    d = clamp(d, 0, 2);
    if (d === this.density) return;
    this.density = d;
    this.cells.clear();
    this.dirty = true;
  }

  setRadius(r) {
    this.radius = r;
    this.dirty = true;
  }

  update(cameraPos) {
    const t0 = now();
    const cx = Math.floor(cameraPos.x / this.cell);
    const cz = Math.floor(cameraPos.z / this.cell);
    const key = `${cx},${cz}`;
    const reach = Math.ceil(this.radius / this.cell);
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.dirty = true;
      // drop cells that fell out of range
      for (const [k, c] of this.cells) {
        if (Math.abs(c.cx - cx) > reach + 1 || Math.abs(c.cz - cz) > reach + 1) this.cells.delete(k);
      }
    }
    // generate cells inside the radius, nearest first, under a time budget
    if (this.dirty) {
      const wanted = [];
      for (let j = -reach; j <= reach; j++) {
        for (let i = -reach; i <= reach; i++) {
          const k = `${cx + i},${cz + j}`;
          if (this.cells.has(k)) continue;
          if (Math.hypot(i, j) > reach + 0.5) continue;
          wanted.push([cx + i, cz + j, Math.hypot(i, j)]);
        }
      }
      wanted.sort((a, b) => a[2] - b[2]);
      for (const [i, j] of wanted) {
        if (now() - t0 > this.timeBudget) break;
        const c = this._generateCell(i, j);
        this.cells.set(`${i},${j}`, c);
      }
      let remaining = 0;
      for (let j2 = -reach; j2 <= reach; j2++) for (let i2 = -reach; i2 <= reach; i2++) {
        if (!this.cells.has(`${cx + i2},${cz + j2}`)) remaining++;
      }
      if (!remaining) this.dirty = false;
      this._refill(t0);
    }
    this.stats.ms = now() - t0;
    this.stats.cells = this.cells.size;
  }

  /* ------------------------------------------------------- scatter rules */
  _generateCell(cx, cz) {
    const props = [];
    const x0 = cx * this.cell, z0 = cz * this.cell;
    // how many candidates: driven by the dominant biome of the cell centre
    const bx = x0 + this.cell / 2, bz = z0 + this.cell / 2;
    biomeWeights(bx, bz, _w);
    const dom = biomeAt(bx, bz);
    const base = BIOMES[dom]?.treeDensity ?? 0.2;
    const h0 = heightAt(bx, bz);
    if (h0 < -1) return { cx, cz, props };   // open water: nothing to grow

    const rand = mulberry32((cx * 73856093) ^ (cz * 19349663) ^ 0x5f3a);
    const attempts = Math.round((26 + base * 130) * this.density);
    for (let i = 0; i < attempts; i++) {
      const x = x0 + rand() * this.cell;
      const z = z0 + rand() * this.cell;
      const h = heightAt(x, z);
      if (h < 0.35) continue;                       // in water
      const slope = this._slope(x, z, h);
      const w = { alpine: 0, forest: 0, plains: 0, coastal: 0 };
      biomeWeights(x, z, w);
      const near = this.net.nearestCorridor(x, z, 26);
      const clearance = near ? Math.hypot(near.x - x, near.z - z) - (near.r || 9) : 99;
      const kind = this._pickKind(rand, w, h, slope, clearance, x, z);
      if (!kind) continue;
      const model = SPECIES[kind.group][Math.floor(rand() * SPECIES[kind.group].length)];
      const y = this.terrain ? this.terrain.surfaceHeight(x, z) : h;
      props.push({
        model, x, y: y - kind.sink, z,
        rot: rand() * Math.PI * 2,
        scale: kind.scale * (0.72 + rand() * 0.62),
        tint: kind.tint(rand(), h),
      });
    }
    return { cx, cz, props };
  }

  _slope(x, z, h) {
    const d = 5;
    const dx = (heightAt(x + d, z) - heightAt(x - d, z)) / (2 * d);
    const dz = (heightAt(x, z + d) - heightAt(x, z - d)) / (2 * d);
    return Math.hypot(dx, dz);
  }

  /** Choose what grows here, or null if nothing should. */
  _pickKind(rand, w, h, slope, clearance, x, z) {
    if (clearance < 3.5) return null;               // keep the right-of-way clear
    const alpine = w.alpine, forest = w.forest, plains = w.plains, coastal = w.coastal;

    // shorelines get reeds
    if (h < 3.2 && h > 0.2 && (coastal > 0.25 || forest > 0.2) && rand() < 0.5) {
      return { group: 'reeds', scale: 1, sink: 0.15, tint: () => 0x6f8a4a };
    }
    // boulders on steep or rocky ground
    const rockBias = alpine * 0.75 + slope * 0.9;
    if (slope > 0.55 || rand() < rockBias * 0.14) {
      if (rand() < 0.55) return { group: 'rock', scale: alpine > 0.3 ? 1.5 : 1, sink: 0.4, tint: (r) => (r < 0.5 ? 0x8b8578 : 0x77715f) };
    }
    if (slope > 0.85) return null;                  // bare rock faces

    // farmland: wheat instead of trees
    if (plains > 0.45 && slope < 0.09 && h > 8) {
      const field = hash2(Math.floor(x / 240), Math.floor(z / 240));
      if (field > 0.45 && rand() < 0.85) return { group: 'wheat', scale: 1.1, sink: 0.05, tint: (r) => (r < 0.7 ? 0xd8bd63 : 0xc2a94f) };
    }

    // tree line: conifers take over with altitude and latitude of the peaks
    const density = forest * 0.95 + alpine * 0.30 + coastal * 0.28 + plains * 0.10;
    if (rand() > density * 1.35) {
      if (rand() < 0.25 * (plains + coastal)) return { group: 'bush', scale: 1, sink: 0.1, tint: (r) => (r < 0.5 ? 0x5d7a3c : 0x6d8442) };
      return null;
    }
    const snowLine = 325 - 55 * hash2(Math.floor(x / 900), Math.floor(z / 900));
    let group = 'deciduous';
    if (alpine > 0.35 || h > snowLine * 0.62 || forest > 0.55) group = 'conifer';
    if (h > snowLine - 40 || (coastal > 0.5 && rand() < 0.45) || (alpine > 0.6 && rand() < 0.3)) group = 'dead';
    const tint = (r) => {
      if (group === 'conifer') return r < 0.5 ? 0x2f5233 : 0x3a6135;
      if (group === 'deciduous') return r < 0.4 ? 0x4e7a34 : r < 0.7 ? 0x5d8a3a : 0x77913f;
      return 0x6b6255;
    };
    const scale = group === 'conifer' ? (alpine > 0.4 ? 0.85 : 1.1) : group === 'dead' ? 0.9 : 1;
    return { group, scale, sink: 0.25, tint };
  }

  /* ------------------------------------------------------------- batching */
  _refill(t0) {
    for (const e of this.meshes.values()) e.fill = 0;
    let total = 0;
    for (const cell of this.cells.values()) {
      for (const pr of cell.props) {
        const e = this.meshes.get(pr.model);
        if (!e || e.fill >= this.capacity) continue;
        const i = e.fill++;
        _p.set(pr.x, pr.y, pr.z);
        _e.set(0, pr.rot, 0);
        _q.setFromEuler(_e);
        _s.setScalar(pr.scale);
        _m.compose(_p, _q, _s);
        e.inst.setMatrixAt(i, _m);
        _col.setHex(pr.tint);
        e.inst.setColorAt(i, _col);
        total++;
      }
      if (now() - t0 > this.timeBudget * 2.5) break;
    }
    for (const e of this.meshes.values()) {
      e.inst.count = e.fill;
      e.inst.instanceMatrix.needsUpdate = true;
      if (e.inst.instanceColor) e.inst.instanceColor.needsUpdate = true;
      e.inst.computeBoundingSphere?.();
    }
    this.stats.props = total;
  }

  /** Hide everything (used by the map/photo modes and quality presets). */
  setVisible(v) { this.group.visible = !!v; }

  triangleCount() {
    let t = 0;
    for (const e of this.meshes.values()) {
      const g = e.inst.geometry;
      t += ((g.index ? g.index.count : g.attributes.position.count) / 3) * e.inst.count;
    }
    return Math.round(t);
  }

  dispose() {
    for (const e of this.meshes.values()) { e.inst.dispose(); e.inst.material.dispose(); }
    this.meshes.clear();
    this.cells.clear();
    this.group.removeFromParent();
  }
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export default VegetationManager;
