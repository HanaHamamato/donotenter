/**
 * TrackRenderer — turns spline segments into rails, sleepers, ballast, tunnels,
 * bridges and earthworks (GDD §5.1, §7 TrackRenderer).
 *
 * Everything is generated from the same curve the physics uses, so the visuals
 * and the simulation can never disagree. Geometry is emitted in ~350 m tiles
 * (so the frustum culls properly) at two levels of detail:
 *
 *   LOD2  ballast + sleepers + both rails + structures + tunnel lining
 *   LOD1  a coarse ballast ribbon only — reads as track from a kilometre out
 *
 * Builds are amortised across frames: a segment entering the detail radius is
 * queued, and at most one heavy tile set is generated per frame.
 */
import * as THREE from 'three';
import { COLORS, GAUGE, TIE_SPACING } from '../constants.js';
import { clamp01, clamp } from '../utils/math.js';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
import { landHeight } from '../utils/terrain.js';

const DETAIL_TILE = 350;   // metres of track per LOD2 mesh group
const FAR_TILE = 1400;
const MAX_EARTH_DEPTH = 34;

const _c = new THREE.Color();

/**
 * Sweep a cross-section profile along a piece of track.
 * @param profileFn (frame, u, out) => number of profile points; out is an array
 *   of {x, y} in the track frame (x = localX / train's left, y = up).
 */
function ribbon(seg, u0, u1, stepMetres, profileFn, colorFn, out) {
  const positions = out.positions, colors = out.colors, index = out.index;
  const st = { seg, u: 0, dir: 1 };
  const f = {};
  const prof = [];
  const stepU = stepMetres / seg.length;
  let rings = 0, P = 0;
  for (let u = u0; ; u = Math.min(u1, u + stepU)) {
    st.u = u;
    seg.network.frame(st, f);
    P = profileFn(f, u, prof);
    const base = positions.length / 3;
    for (let j = 0; j < P; j++) {
      const p = prof[j];
      positions.push(
        f.position.x + f.localX.x * p.x + f.up.x * p.y,
        f.position.y + f.localX.y * p.x + f.up.y * p.y,
        f.position.z + f.localX.z * p.x + f.up.z * p.y,
      );
      colorFn(f, u, j, _c);
      colors.push(_c.r, _c.g, _c.b);
    }
    if (rings > 0) {
      for (let j = 0; j < P - 1; j++) {
        const a = base - P + j, b = base + j;
        index.push(a, b, b + 1, a, b + 1, a + 1);
      }
    }
    rings++;
    if (u >= u1 - 1e-9) break;
  }
  return rings;
}

function finishRibbon(out) {
  if (!out.positions.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out.positions, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(out.colors, 3));
  g.setIndex(out.index);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

const newOut = () => ({ positions: [], colors: [], index: [] });

export class TrackRenderer {
  /**
   * @param {THREE.Scene} scene
   * @param {import('./TrackNetwork.js').TrackNetwork} net
   * @param {import('./AssetManager.js').AssetManager} assets
   */
  constructor(scene, net, assets, opts = {}) {
    this.scene = scene;
    this.net = net;
    this.assets = assets;
    this.root = new THREE.Group();
    this.root.name = 'track';
    this.root.matrixAutoUpdate = false;
    scene.add(this.root);

    this.quality = { detailRadius: 900, farRadius: 6000, tieStep: TIE_SPACING, railStep: 1.1, ballastStep: 1.7, earthStep: 3.2, structures: true };

    /** @type {Map<string, {lod:number, group:THREE.Group|null}>} */
    this.entries = new Map();
    this.queue = [];
    this.timeBudget = 3.5;      // ms of geometry generation per frame
    this.minTilesPerFrame = 1;
    this.maxTilesPerFrame = 6;
    this.lastBuildMs = 0;
    this.lastTiles = 0;

    this.materials = {
      track: new THREE.MeshLambertMaterial({ vertexColors: true }),
      rail: new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x0a0a0a }),
      tie: new THREE.MeshLambertMaterial({ color: COLORS.tie }),
      lining: new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }),
      earth: new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }),
      deck: new THREE.MeshLambertMaterial({ vertexColors: true }),
      structure: assets.materials.paint,
    };
    this.geometries = {
      tie: new THREE.BoxGeometry(2.6, 0.16, 0.24),
    };

    // cheap distance probes for LOD selection
    this.probes = [];
    for (const seg of net.segments.values()) {
      const pts = [];
      const n = Math.max(2, Math.ceil(seg.length / 240));
      for (let i = 0; i <= n; i++) pts.push(seg.curve.getPoint(i / n));
      this.probes.push({ seg, pts });
    }
    this.stats = { tiles: 0, triangles: 0, builds: 0 };
    this.setQuality(opts.preset || 'high');
  }

  setQuality(preset) {
    const q = this.quality;
    if (preset === 'low') Object.assign(q, { detailRadius: 420, farRadius: 2400, tieStep: 1.2, railStep: 2.4, ballastStep: 3.4, earthStep: 6, structures: true });
    else if (preset === 'medium') Object.assign(q, { detailRadius: 700, farRadius: 4200, tieStep: TIE_SPACING, railStep: 1.6, ballastStep: 2.4, earthStep: 4.4, structures: true });
    else Object.assign(q, { detailRadius: 1000, farRadius: 7000, tieStep: TIE_SPACING, railStep: 1.0, ballastStep: 1.6, earthStep: 3.0, structures: true });
    this.invalidate();
  }

  /** Drop every built tile (used when quality or the network changes). */
  invalidate() {
    for (const [id, e] of this.entries) {
      if (e.group) this._destroy(e.group);
      this.entries.set(id, { lod: 0, group: null });
    }
    this.queue.length = 0;
  }

  _destroy(group) {
    group.traverse((o) => {
      if (o.isMesh || o.isInstancedMesh) {
        o.geometry.dispose?.();
        this.stats.tiles--;
      }
    });
    group.removeFromParent();
  }

  /** Per-frame update: pick LODs, queue tile builds, spend a fixed slice of time. */
  update(cameraPos, dt = 0.016) {
    for (const { seg, pts } of this.probes) {
      let d = Infinity;
      for (const p of pts) { const dd = p.distanceToSquared(cameraPos); if (dd < d) d = dd; }
      d = Math.sqrt(d);
      const lod = d < this.quality.detailRadius ? 2 : d < this.quality.farRadius ? 1 : 0;
      let e = this.entries.get(seg.id);
      if (!e) { e = { lod: 0, group: null, gen: 0 }; this.entries.set(seg.id, e); }
      if (e.lod === lod) continue;
      e.lod = lod;
      e.gen++;                       // invalidates any queued tile jobs
      if (e.group) { this._destroy(e.group); e.group = null; }
      if (lod === 0) continue;
      const group = new THREE.Group();
      group.name = `track_${seg.id}`;
      group.matrixAutoUpdate = false;
      e.group = group;
      this.root.add(group);
      const tileSize = lod === 2 ? DETAIL_TILE : FAR_TILE;
      const nTiles = Math.max(1, Math.ceil(seg.length / tileSize));
      for (let i = 0; i < nTiles; i++) {
        this.queue.push({ seg, lod, gen: e.gen, group, i, nTiles });
      }
    }
    this.root.updateMatrix();

    // Spend a bounded slice of the frame on generation so streaming never hitches.
    const budgetMs = this.timeBudget;
    const t0 = now();
    let built = 0;
    while (this.queue.length && (built < this.minTilesPerFrame || now() - t0 < budgetMs)) {
      const job = this.queue.shift();
      const e = this.entries.get(job.seg.id);
      if (!e || e.gen !== job.gen) continue;          // superseded by an LOD change
      const u0 = job.i / job.nTiles, u1 = (job.i + 1) / job.nTiles;
      const t = job.lod === 2 ? this._detailTile(job.seg, u0, u1) : this._farTile(job.seg, u0, u1);
      if (t) job.group.add(t);
      built++;
      if (built >= this.maxTilesPerFrame) break;
    }
    this.lastBuildMs = built ? now() - t0 : 0;
    this.lastTiles = built;
  }

  /** Coarse ribbon: ballast only. */
  _farTile(seg, u0, u1) {
    const out = newOut();
    ribbon(seg, u0, u1, 8, (f, u, p) => {
      p.length = 0;
      p.push({ x: -2.4, y: -0.55 }, { x: -1.7, y: -0.1 }, { x: 1.7, y: -0.1 }, { x: 2.4, y: -0.55 });
      return 4;
    }, (f, u, j, c) => {
      c.setHex(COLORS.ballast);
      c.offsetHSL(0, 0, (j === 1 || j === 2 ? 0.05 : -0.06));
      c.multiplyScalar(0.86 + 0.14 * this._biomeTint(seg));
    }, out);
    const g = finishRibbon(out);
    if (!g) return null;
    const m = new THREE.Mesh(g, this.materials.track);
    m.receiveShadow = true;
    this.stats.tiles++; this.stats.triangles += g.index.count / 3;
    return m;
  }

  _biomeTint(seg) {
    return { alpine: 1.06, forest: 0.94, plains: 1.0, coastal: 0.92 }[seg.biome] ?? 1;
  }

  /** Full detail: ballast, sleepers, rails, structures, earthworks, lining. */
  _detailTile(seg, u0, u1) {
    const g = new THREE.Group();
    const q = this.quality;
    const span = (u1 - u0) * seg.length;
    if (span < 0.5) return null;

    // ---- which structural ranges touch this tile
    const bridges = seg.bridges.filter((r) => r.u1 >= u0 && r.u0 <= u1).concat(seg.viaducts.filter((r) => r.u1 >= u0 && r.u0 <= u1));
    const tunnels = seg.tunnels.filter((r) => r.u1 >= u0 && r.u0 <= u1);
    const earth = seg.cuttings.concat(seg.embankments).filter((r) => r.u1 >= u0 && r.u0 <= u1 && r.max > 0.6);
    const onBridge = (u) => bridges.find((r) => u >= r.u0 - 1e-4 && u <= r.u1 + 1e-4) || null;

    // ---- ballast (suppressed over bridge decks)
    {
      const out = newOut();
      const step = q.ballastStep;
      const st = { seg, u: 0, dir: 1 }; const f = {};
      const stepU = step / seg.length;
      let rings = 0;
      const positions = out.positions, colors = out.colors, index = out.index;
      for (let u = u0; ; u = Math.min(u1, u + stepU)) {
        st.u = u; seg.network.frame(st, f);
        const br = onBridge(u);
        const P = 4;
        const base = positions.length / 3;
        const half = br ? 3.1 : 1.7, drop = br ? -0.75 : -0.14, outer = br ? 3.4 : 2.45, outerY = br ? -0.9 : -0.62;
        const pts = [{ x: -outer, y: outerY }, { x: -half, y: drop }, { x: half, y: drop }, { x: outer, y: outerY }];
        for (let j = 0; j < P; j++) {
          const p = pts[j];
          positions.push(
            f.position.x + f.localX.x * p.x + f.up.x * p.y,
            f.position.y + f.localX.y * p.x + f.up.y * p.y,
            f.position.z + f.localX.z * p.x + f.up.z * p.y,
          );
          _c.setHex(br ? 0x6a665e : COLORS.ballast);
          const n = this._grain(seg, u, j);
          _c.offsetHSL(0, 0, (j === 1 || j === 2 ? 0.045 : -0.05) + n * 0.05);
          colors.push(_c.r, _c.g, _c.b);
        }
        if (rings > 0) for (let j = 0; j < P - 1; j++) {
          const a = base - P + j, b = base + j;
          index.push(a, b, b + 1, a, b + 1, a + 1);
        }
        rings++;
        if (u >= u1 - 1e-9) break;
      }
      const geo = finishRibbon(out);
      if (geo) {
        const m = new THREE.Mesh(geo, this.materials.track);
        m.receiveShadow = true;
        g.add(m);
        this.stats.tiles++; this.stats.triangles += geo.index.count / 3;
      }
    }

    // ---- sleepers (instanced)
    if (q.tieStep < 2) {
      const count = Math.max(1, Math.floor(span / q.tieStep));
      const inst = new THREE.InstancedMesh(this.geometries.tie, this.materials.tie, count);
      inst.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      const m4 = new THREE.Matrix4(), qq = new THREE.Quaternion(), pos = new THREE.Vector3(), scl = new THREE.Vector3(1, 1, 1);
      const basis = new THREE.Matrix4();
      const st = { seg, u: 0, dir: 1 }; const f = {};
      let i = 0;
      for (let d = 0; d < span && i < count; d += q.tieStep, i++) {
        st.u = clamp01(u0 + d / seg.length);
        seg.network.frame(st, f);
        pos.copy(f.position).addScaledVector(f.up, -0.13);
        basis.makeBasis(f.localX, f.up, f.forward);
        qq.setFromRotationMatrix(basis);
        m4.compose(pos, qq, scl);
        inst.setMatrixAt(i, m4);
      }
      inst.count = i;
      inst.instanceMatrix.needsUpdate = true;
      inst.castShadow = false;
      inst.receiveShadow = true;
      inst.frustumCulled = true;
      g.add(inst);
      this.stats.tiles++;
    }

    // ---- rails
    {
      const out = newOut();
      const railX = GAUGE / 2;
      const w = 0.075, top = 0.0, bot = -0.085;
      const profile = (side) => (f, u, p) => {
        p.length = 0;
        const x = side * railX;
        p.push({ x: x - w, y: bot }, { x: x - w, y: top }, { x: x + w, y: top }, { x: x + w, y: bot });
        return 4;
      };
      const color = (f, u, j, c) => {
        c.setHex(COLORS.rail);
        c.offsetHSL(0, 0, j === 2 ? 0.12 : j === 1 ? 0.04 : -0.16);
        if (f.bridge) c.multiplyScalar(0.94);
      };
      ribbon(seg, u0, u1, q.railStep, profile(-1), color, out);
      ribbon(seg, u0, u1, q.railStep, profile(1), color, out);
      const geo = finishRibbon(out);
      if (geo) {
        const m = new THREE.Mesh(geo, this.materials.rail);
        m.receiveShadow = false;
        g.add(m);
        this.stats.tiles++; this.stats.triangles += geo.index.count / 3;
      }
    }

    // ---- structures
    if (q.structures) {
      for (const r of bridges) this._buildBridge(g, seg, r, u0, u1);
      for (const r of tunnels) this._buildTunnel(g, seg, r, u0, u1);
      for (const r of earth) this._buildEarthwork(g, seg, r, u0, u1, seg.cuttings.includes(r) ? 'cut' : 'fill');
    }
    return g;
  }

  /** Deterministic 0..1 grain so ballast is not flat-coloured. */
  _grain(seg, u, j) {
    const s = Math.sin((u * 977 + j * 31 + seg.length) * 12.9898) * 43758.5453;
    return s - Math.floor(s);
  }

  /* ------------------------------------------------------- bridges/tunnels */
  _buildBridge(g, seg, r, u0, u1) {
    const a = Math.max(r.u0, u0), b = Math.min(r.u1, u1);
    if (b <= a) return;
    const kind = seg.structure || 'trestle';
    const st = { seg, u: 0, dir: 1 }; const f = {};

    // deck sides / parapets
    const out = newOut();
    ribbon(seg, a, b, 2.6, (fr, u, p) => {
      p.length = 0;
      p.push({ x: -3.5, y: -0.9 }, { x: -3.5, y: 0.35 }, { x: -3.15, y: 0.35 }, { x: -3.15, y: -0.9 });
      return 4;
    }, (fr, u, j, c) => { c.setHex(j === 1 ? 0x7d7a72 : 0x5f5c55); c.offsetHSL(0, 0, this._grain(seg, u, j) * 0.05 - 0.02); }, out);
    ribbon(seg, a, b, 2.6, (fr, u, p) => {
      p.length = 0;
      p.push({ x: 3.15, y: -0.9 }, { x: 3.15, y: 0.35 }, { x: 3.5, y: 0.35 }, { x: 3.5, y: -0.9 });
      return 4;
    }, (fr, u, j, c) => { c.setHex(j === 1 ? 0x7d7a72 : 0x5f5c55); c.offsetHSL(0, 0, this._grain(seg, u, j) * 0.05 - 0.02); }, out);
    const deck = finishRibbon(out);
    if (deck) {
      const m = new THREE.Mesh(deck, this.materials.deck);
      m.castShadow = true; m.receiveShadow = true;
      g.add(m); this.stats.tiles++; this.stats.triangles += deck.index.count / 3;
    }

    const centre = (r.u0 + r.u1) / 2;
    const span = (r.u1 - r.u0) * seg.length;
    st.u = centre; seg.network.frame(st, f);

    if (kind === 'trestle' || kind === 'arch' || !kind) {
      // Supports down to the ground: timber bents for low work, masonry piers
      // where the valley is too deep for a bent to read properly.
      const heights = [];
      const probe = Math.max(6, span / 60);
      for (let d = probe / 2; d < span; d += probe) {
        st.u = clamp01(a + d / seg.length); seg.network.frame(st, f);
        const ground = Math.max(landHeight(f.position.x, f.position.z), -8);
        heights.push({ u: st.u, h: f.position.y - ground });
      }
      const deepest = heights.reduce((m, x) => Math.max(m, x.h), 0);
      const masonry = kind === 'arch' || deepest > 26;
      const every = masonry ? 24 : 12;
      const n = Math.max(1, Math.round(span / every));
      const geo = this.assets.geometry(masonry ? 'pier' : 'trestle_bent');
      const inst = new THREE.InstancedMesh(geo, this.materials.structure, n + 2);
      const m4 = new THREE.Matrix4(), basis = new THREE.Matrix4(), qq = new THREE.Quaternion();
      const pos = new THREE.Vector3(), scl = new THREE.Vector3();
      let i = 0;
      for (let k = 0; k < n && i < n + 2; k++) {
        const u = clamp01(a + (b - a) * ((k + 0.5) / n));
        st.u = u; seg.network.frame(st, f);
        const ground = Math.max(landHeight(f.position.x, f.position.z), -8);
        const h = f.position.y - ground;
        if (h < 1.6) continue;
        const nominal = masonry ? 10 : 10;
        pos.copy(f.position).addScaledVector(f.up, -h / 2);
        basis.makeBasis(f.localX, f.up, f.forward);
        qq.setFromRotationMatrix(basis);
        const sy = clamp(h / nominal, 0.2, 12);
        scl.set(masonry ? 1.25 : 1, sy, masonry ? 1.25 : 1);
        m4.compose(pos, qq, scl);
        inst.setMatrixAt(i++, m4);
      }
      inst.count = i;
      inst.instanceMatrix.needsUpdate = true;
      inst.castShadow = true;
      if (i) { g.add(inst); this.stats.tiles++; } else inst.dispose();
    } else {
      // truss / covered / swing / causeway: one prismatic model scaled to span
      const key = { truss: 'truss_span', covered: 'covered_bridge', swing: 'swing_span', causeway: 'causeway_wall' }[kind] || 'truss_span';
      const nominal = { truss_span: 20, covered_bridge: 26, swing_span: 30, causeway_wall: 12 }[key] || 20;
      const mesh = this.assets.mesh(key, this.materials.structure);
      mesh.position.copy(f.position).addScaledVector(f.up, kind === 'causeway' ? -1.5 : -0.35);
      const basis = new THREE.Matrix4().makeBasis(f.localX, f.up, f.forward);
      mesh.quaternion.setFromRotationMatrix(basis);
      mesh.scale.set(1, 1, clamp(span / nominal, 0.6, 6));
      g.add(mesh);
      this.stats.tiles++;
      if (kind === 'causeway') {
        // repeat the wall so the whole crossing reads as an embankment
        const reps = Math.max(1, Math.round(span / 12));
        const inst = new THREE.InstancedMesh(this.assets.geometry('causeway_wall'), this.materials.structure, reps);
        const m4 = new THREE.Matrix4(), bs = new THREE.Matrix4(), qq = new THREE.Quaternion(), pos = new THREE.Vector3(), scl = new THREE.Vector3(1, 1, 1);
        for (let k = 0; k < reps; k++) {
          st.u = clamp01(a + (b - a) * ((k + 0.5) / reps));
          seg.network.frame(st, f);
          pos.copy(f.position).addScaledVector(f.up, -1.6);
          bs.makeBasis(f.localX, f.up, f.forward); qq.setFromRotationMatrix(bs);
          m4.compose(pos, qq, scl);
          inst.setMatrixAt(k, m4);
        }
        inst.instanceMatrix.needsUpdate = true;
        inst.castShadow = true; inst.receiveShadow = true;
        g.add(inst);
        this.stats.tiles++;
      }
    }
  }

  _buildTunnel(g, seg, r, u0, u1) {
    const a = Math.max(r.u0, u0), b = Math.min(r.u1, u1);
    if (b <= a) return;
    // lining: an arch swept along the bore
    const out = newOut();
    const arch = (f, u, p) => {
      p.length = 0;
      const R = 3.1, H = 4.9;
      const N = 9;
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        let x, y;
        if (t < 0.25) { x = -R; y = -0.7 + (t / 0.25) * (H * 0.62 + 0.7); }
        else if (t > 0.75) { x = R; y = -0.7 + ((1 - t) / 0.25) * (H * 0.62 + 0.7); }
        else {
          const ang = Math.PI * ((t - 0.25) / 0.5);
          x = -Math.cos(ang) * R; y = H * 0.62 + Math.sin(ang) * (H * 0.38);
        }
        p.push({ x, y });
      }
      return p.length;
    };
    const color = (f, u, j, c) => {
      c.setHex(0x4b463e);
      c.offsetHSL(0, 0, this._grain(seg, u, j) * 0.1 - 0.05);
    };
    ribbon(seg, a, b, 2.4, arch, color, out);
    const geo = finishRibbon(out);
    if (geo) {
      const m = new THREE.Mesh(geo, this.materials.lining);
      m.receiveShadow = false;
      g.add(m); this.stats.tiles++; this.stats.triangles += geo.index.count / 3;
    }
    // portals at the mouths that fall inside this tile
    const st = { seg, u: 0, dir: 1 }; const f = {};
    for (const end of [r.u0, r.u1]) {
      if (end < u0 - 1e-6 || end > u1 + 1e-6) continue;
      st.u = clamp01(end); seg.network.frame(st, f);
      const portal = this.assets.mesh('tunnel_portal', this.materials.structure);
      portal.position.copy(f.position).addScaledVector(f.up, -0.4);
      const basis = new THREE.Matrix4().makeBasis(f.localX, f.up, f.forward);
      portal.quaternion.setFromRotationMatrix(basis);
      if (end === r.u1) portal.rotateY(Math.PI);
      g.add(portal);
      this.stats.tiles++;
    }
  }

  /** Cutting / embankment walls that blend the formation into the terrain. */
  _buildEarthwork(g, seg, r, u0, u1, mode) {
    const a = Math.max(r.u0, u0), b = Math.min(r.u1, u1);
    if (b <= a) return;
    const st = { seg, u: 0, dir: 1 }; const f = {};
    for (const side of [-1, 1]) {
      const out = newOut();
      const stepU = this.quality.earthStep / seg.length;
      let rings = 0;
      const positions = out.positions, colors = out.colors, index = out.index;
      const prev = { x: 0, yTop: 0, yBot: 0 };
      for (let u = a; ; u = Math.min(b, u + stepU)) {
        st.u = u; seg.network.frame(st, f);
        const inner = 2.5;
        const px = f.position.x + f.localX.x * inner * side;
        const pz = f.position.z + f.localX.z * inner * side;
        const ground = landHeight(px, pz);
        let dy = clamp(ground - f.position.y, -MAX_EARTH_DEPTH, MAX_EARTH_DEPTH);
        if (mode === 'cut') dy = Math.max(0.4, dy); else dy = Math.min(-0.4, dy);
        const slope = mode === 'cut' ? 0.55 : 1.45;
        const outer = inner + Math.abs(dy) * slope;
        const ox = f.position.x + f.localX.x * outer * side;
        const oz = f.position.z + f.localX.z * outer * side;
        const base = positions.length / 3;
        // top edge (at the formation) and bottom edge (at the ground)
        const topY = f.position.y - 0.35;
        const botY = f.position.y + dy;
        positions.push(px, topY, pz, ox, botY, oz);
        const rock = mode === 'cut' ? 0x7a7264 : 0x6f6a4e;
        for (let j = 0; j < 2; j++) {
          _c.setHex(rock);
          _c.offsetHSL(0, 0, this._grain(seg, u, j + side * 3) * 0.12 - 0.06 + (j ? -0.05 : 0.03));
          colors.push(_c.r, _c.g, _c.b);
        }
        if (rings > 0) {
          const p0 = base - 2;
          if (side > 0) index.push(p0, base, base + 1, p0, base + 1, p0 + 1);
          else index.push(p0, base + 1, base, p0, p0 + 1, base + 1);
        }
        rings++;
        prev.x = outer; prev.yTop = topY; prev.yBot = botY;
        if (u >= b - 1e-9) break;
      }
      const geo = finishRibbon(out);
      if (!geo) continue;
      const m = new THREE.Mesh(geo, this.materials.earth);
      m.receiveShadow = true;
      g.add(m); this.stats.tiles++; this.stats.triangles += geo.index.count / 3;
    }
  }

  /* --------------------------------------------------------------- info */
  /** Total triangles currently resident, for the debug overlay. */
  triangleCount() {
    let tris = 0;
    this.root.traverse((o) => {
      if (o.isInstancedMesh) tris += (o.geometry.index ? o.geometry.index.count / 3 : o.geometry.attributes.position.count / 3) * o.count;
      else if (o.isMesh && o.geometry.index) tris += o.geometry.index.count / 3;
    });
    return Math.round(tris);
  }

  builtSegments() {
    let n = 0;
    for (const e of this.entries.values()) if (e.group) n++;
    return n;
  }

  dispose() {
    for (const e of this.entries.values()) if (e.group) this._destroy(e.group);
    this.entries.clear();
    this.geometries.tie.dispose();
    for (const m of Object.values(this.materials)) m.dispose?.();
    this.root.removeFromParent();
  }
}

export default TrackRenderer;
