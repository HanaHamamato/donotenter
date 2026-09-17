/**
 * TrackNetwork — the directed graph of track segments and junctions
 * (GDD §1.2 "Rail & Junction System", §5.2.2 "Custom rail physics").
 *
 * A train's position is a 1-D state on the graph:
 *
 *   state = { seg: Segment, u: number /* 0..1 arc-length *\/, dir: 1|-1 }
 *
 * `dir = +1` travels from the segment's `a` node toward its `b` node.
 * Everything (physics, car following, AI, signals) is expressed in metres of
 * arc length, which makes long consists and junction routing trivial.
 */
import * as THREE from 'three';
import { makeCurve, pointAt, tangentAt } from '../utils/spline.js';
import { landHeight } from '../utils/terrain.js';
import { clamp, clamp01 } from '../utils/math.js';
import { PHYS } from '../constants.js';

const _pos = new THREE.Vector3();
const _tan = new THREE.Vector3();
const _p0 = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _p2 = new THREE.Vector3();

/** Cover thresholds (metres) used to classify the rail against the terrain. */
const TUNNEL_COVER = 9;   // deeper than this and it is a bore, not a cutting
const CUT_COVER = 1.2;    // shallower than this and the ground is simply dressed
const FILL_COVER = 1.2;   // rail this far above the ground needs an embankment
const VIADUCT_DROP = 12;  // above this it is carried, not filled

/** Sort and fuse overlapping or near-touching u ranges. */
function mergeRanges(list, gapU) {
  const out = [];
  const sorted = list.slice().sort((a, b) => a.u0 - b.u0);
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.u0 <= last.u1 + gapU) {
      last.u1 = Math.max(last.u1, r.u1);
      last.max = Math.max(last.max || 0, r.max || 0);
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

export class Segment {
  constructor(def, network) {
    this.id = def.id;
    this.def = def;
    this.network = network;
    this.a = def.a; // node id at u=0
    this.b = def.b; // node id at u=1
    this.speedLimit = def.speedLimit; // km/h
    this.region = def.region;
    this.biome = def.biome;
    this.kind = def.kind;
    this.structure = def.structure;
    this.gated = def.gated;
    this.bridges = def.bridges || [];
    this.viaducts = def.viaducts || [];
    this.tunnels = def.tunnels || [];
    this.cuttings = def.cuttings || [];
    this.embankments = def.embankments || [];

    this.points = def.points.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
    this.bank = def.points.map((p) => p[3] || 0);
    this.curve = makeCurve(this.points);
    this.length = this.curve.getLength();
    // Ranges arrive either as a proper [t0,t1] window or as a centre point plus
    // a metre span (short features are measured from sample midpoints). Now that
    // the length is known, normalise both into u0..u1.
    for (const list of [this.bridges, this.viaducts, this.tunnels, this.cuttings, this.embankments]) {
      for (let i = 0; i < list.length; i++) list[i] = this._normRange(list[i]);
    }
    this._deriveEarthworks();
    this.nodeA = network.nodes.get(this.a);
    this.nodeB = network.nodes.get(this.b);

    // Cached per-sample curvature + grade tables (every ~8 m) for cheap physics.
    this.sampleStep = 8;
    this.samples = Math.max(8, Math.ceil(this.length / this.sampleStep));
    this.kappa = new Float32Array(this.samples + 1);
    this.grade = new Float32Array(this.samples + 1);
    this.bankAt = new Float32Array(this.samples + 1);
    this._buildTables();
  }

  _buildTables() {
    const n = this.samples;
    // Sample the curvature over a fixed ~8 m baseline: tiny baselines make the
    // circumradius estimate numerically noisy (a straight rail would look curved).
    const du = Math.min(0.02, Math.max(0.0008, 4 / this.length));
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      const a = pointAt(this.curve, Math.max(0, u - du), _p0);
      const b = pointAt(this.curve, u, _p1);
      const c = pointAt(this.curve, Math.min(1, u + du), _p2);
      const ax = b.x - a.x, az = b.z - a.z, ay = b.y - a.y;
      const bx = c.x - b.x, bz = c.z - b.z, by = c.y - b.y;
      const la = Math.hypot(ax, ay, az) || 1e-6;
      const lb = Math.hypot(bx, by, bz) || 1e-6;
      const cross = (ax / la) * (bz / lb) - (az / la) * (bx / lb);
      const arc = (la + lb) * 0.5;
      this.kappa[i] = arc > 0.5 ? Math.abs(cross) / arc : 0;
      this.grade[i] = arc > 0.5 ? (by + ay) / (2 * arc) : 0;
      this.bankAt[i] = this._bankAt(u);
    }
  }

  _normRange(r) {
    const t0 = Math.min(r.t0, r.t1), t1 = Math.max(r.t0, r.t1);
    if ((t1 - t0) * this.length > r.span * 0.5) return { ...r, t0, t1, u0: t0, u1: t1 };
    const c = (t0 + t1) / 2, half = r.span / 2 / this.length;
    return { ...r, t0: c, t1: c, u0: clamp01(c - half), u1: clamp01(c + half) };
  }

  /**
   * Re-derive cuttings, embankments and tunnels from the actual terrain.
   *
   * The generator flags features from its own profile solver, but that leaves
   * gaps — stretches where the rail runs many metres below the natural surface
   * with nothing recorded, which would render as track buried in a hillside.
   * Measuring the cover directly is authoritative and cheap (one height query
   * every ~8 m, once, at load). Generated tunnels are unioned in so the
   * hand-placed bores and their landmarks are preserved.
   */
  _deriveEarthworks() {
    const STEP = 8;
    const n = Math.max(8, Math.ceil(this.length / STEP));
    const p = new THREE.Vector3();
    const cls = new Int8Array(n + 1);   // 1 tunnel, 2 cutting, 3 embankment
    const depth = new Float32Array(n + 1);
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      pointAt(this.curve, u, p);
      const onStructure = this.inRanges(u, this.bridges) || this.inRanges(u, this.viaducts);
      if (onStructure) { cls[i] = 0; continue; }
      const cover = landHeight(p.x, p.z) - p.y;
      depth[i] = cover;
      const wasTunnel = this.tunnels.some((r) => u >= r.u0 - 1e-4 && u <= r.u1 + 1e-4);
      if (cover < -VIADUCT_DROP) cls[i] = 4;
      else if (cover > TUNNEL_COVER || wasTunnel) cls[i] = 1;
      else if (cover > CUT_COVER) cls[i] = 2;
      else if (cover < -FILL_COVER) cls[i] = 3;
    }
    const runs = (code, minMetres, mergeGap) => {
      const out = [];
      let i = 0;
      while (i <= n) {
        if (cls[i] !== code) { i++; continue; }
        let j = i, last = i, gap = 0, max = 0;
        while (j <= n) {
          if (cls[j] === code) { last = j; gap = 0; max = Math.max(max, Math.abs(depth[j])); }
          else if (++gap > mergeGap) break;
          j++;
        }
        const u0 = i / n, u1 = last / n;
        if ((u1 - u0) * this.length >= minMetres) {
          out.push({ t0: u0, t1: u1, u0, u1, span: (u1 - u0) * this.length, max, code });
        }
        i = last + 1;
      }
      return out;
    };
    // Tunnels win over cuttings: clear the cut class inside any tunnel run.
    const tunnels = runs(1, 18, 3);
    for (const r of tunnels) {
      for (let i = Math.floor(r.u0 * n); i <= Math.ceil(r.u1 * n) && i <= n; i++) if (cls[i] === 2) cls[i] = 1;
    }
    // A deep patch too short to bore becomes a rock cutting instead, so it still
    // gets retaining walls rather than being left as a bare slot in the ground.
    for (let i = 0; i <= n; i++) {
      if (cls[i] !== 1) continue;
      const u = i / n;
      if (!tunnels.some((r) => u >= r.u0 - 1e-6 && u <= r.u1 + 1e-6)) cls[i] = 2;
    }
    const cuttings = runs(2, 14, 3).filter((r) => r.max > 1.2);
    const embankments = runs(3, 14, 3).filter((r) => r.max > 1.2);
    // High ground is not an embankment, it is a viaduct: fold the derived runs
    // into whatever the generator already decided so a cliff edge does not leave
    // a few metres of unsupported rail hanging over a hundred-metre drop.
    const viaducts = mergeRanges(this.viaducts.concat(runs(4, 4, 8)), 64 / this.length);
    for (const list of [tunnels, cuttings, embankments, viaducts]) {
      for (const r of list) { r.t0 = r.u0; r.t1 = r.u1; r.span = (r.u1 - r.u0) * this.length; delete r.code; }
    }
    this.tunnels = tunnels;
    this.cuttings = cuttings;
    this.embankments = embankments.filter((r) => !viaducts.some((v) => r.u0 < v.u1 && r.u1 > v.u0));
    this.viaducts = viaducts;
    this.isTunnel = tunnels.length > 0;
    this.isBridge = this.bridges.length > 0 || this.viaducts.length > 0;
  }

  _bankAt(u) {
    const b = this.bank;
    if (!b.length) return 0;
    const f = clamp01(u) * (b.length - 1);
    const i = Math.floor(f);
    const j = Math.min(b.length - 1, i + 1);
    return b[i] + (b[j] - b[i]) * (f - i);
  }

  nodeAtEnd(end) { return end === 'a' ? this.nodeA : this.nodeB; }
  endForNode(nodeId) { return nodeId === this.a ? 'a' : 'b'; }

  bankAtU(u) { return this._bankAt(u); }
  kappaAtU(u) { return this.kappa[Math.round(clamp01(u) * this.samples)]; }
  gradeAtU(u) { return this.grade[Math.round(clamp01(u) * this.samples)]; }

  /** The range containing u, or null. */
  inRanges(u, ranges) {
    for (const r of ranges) if (u >= r.u0 - 1e-4 && u <= r.u1 + 1e-4) return r;
    return null;
  }

  /** First range of `ranges` after u, for look-ahead signage. */
  nextRange(u, ranges) {
    let best = null;
    for (const r of ranges) if (r.u0 > u && (!best || r.u0 < best.u0)) best = r;
    return best;
  }

  get isTunnelSegment() { return this.tunnels.length > 0; }
}

export class TrackNetwork {
  constructor(data) {
    this.data = data;
    this.nodes = new Map();
    this.segments = new Map();
    this.openRegions = new Set(['plains']);
    this.openBranches = new Set();

    for (const nd of data.nodes) {
      this.nodes.set(nd.id, {
        ...nd,
        position: new THREE.Vector3(nd.x, nd.y, nd.z),
        branches: nd.branches.map((b) => ({ ...b })),
        active: nd.default || 0,
        switchAnim: 0, // 0..1 turnout animation
        switchTarget: 0,
      });
    }
    for (const sd of data.segments) {
      const seg = new Segment(sd, this);
      this.segments.set(seg.id, seg);
    }
    // resolve node references now that all segments exist
    for (const node of this.nodes.values()) {
      for (const br of node.branches) br.segment = this.segments.get(br.seg);
    }
    this.totalLength = [...this.segments.values()].reduce((a, s) => a + s.length, 0);
    this._buildCorridor();
    this._buildStationIndex();
  }

  /* ------------------------------------------------------------ open/closed */
  setRegions(regions) { this.openRegions = new Set(regions); }
  openBranch(id) { this.openBranches.add(id); }

  isOpen(seg) {
    if (!seg) return false;
    if (!this.openRegions.has(seg.region)) return false;
    if (seg.gated && !this.openBranches.has(seg.gated)) return false;
    return true;
  }

  /** Reason a segment is closed, for HUD signage. */
  closedReason(seg) {
    if (this.isOpen(seg)) return null;
    if (seg.gated && !this.openBranches.has(seg.gated)) return 'Branch not rebuilt';
    return 'Region locked';
  }

  /* ------------------------------------------------------------- states */
  makeState(segId, u = 0, dir = 1) {
    const seg = this.segments.get(segId);
    return { seg, u: clamp01(u), dir: dir < 0 ? -1 : 1, odo: 0, node: null };
  }

  cloneState(s) { return { seg: s.seg, u: s.u, dir: s.dir, odo: s.odo, node: s.node }; }

  /** Metres along the segment measured in the direction of travel. */
  metresOf(state) { return state.dir > 0 ? state.u * state.seg.length : (1 - state.u) * state.seg.length; }

  /**
   * Advance a state by `ds` metres along the direction of travel (negative ds
   * reverses). Handles node transitions, junction routing, buffer stops and
   * locked regions. Returns the distance actually travelled; `state.blocked`
   * is set when movement stopped short.
   */
  advance(state, ds) {
    if (ds < 0) {
      // `state.dir` records which way the vehicle's NOSE points, which is not
      // necessarily the direction of motion (shunting / reverse running).
      // Re-orient so that travel is always "forward", recurse, then restore:
      // after every node crossing `dir` is set so forward == motion, so a
      // single negation at the end puts the nose back where it belongs.
      state.dir = -state.dir;
      const moved = this.advance(state, -ds);
      state.dir = -state.dir;
      return -moved;
    }
    let remaining = ds;
    let travelled = 0;
    state.blocked = null;
    let guard = 0;
    while (Math.abs(remaining) > 1e-9 && guard++ < 512) {
      const seg = state.seg;
      const L = seg.length;
      if (!(L > 0)) { state.blocked = 'degenerate'; break; }
      const p = state.dir > 0 ? state.u * L : (1 - state.u) * L;
      const forward = remaining > 0;
      const room = forward ? L - p : p;
      const step = forward ? Math.min(remaining, room) : Math.max(remaining, -room);
      const nextP = p + step;
      state.u = state.dir > 0 ? nextP / L : 1 - nextP / L;
      state.odo += step;
      travelled += step;
      remaining -= step;
      if (Math.abs(remaining) < 1e-9) break;

      const end = forward ? (state.dir > 0 ? 'b' : 'a') : (state.dir > 0 ? 'a' : 'b');
      const node = end === 'b' ? seg.nodeB : seg.nodeA;
      const resolved = this.resolveNode(node, seg, end, state);
      state.u = end === 'b' ? 1 : 0;
      if (!resolved) {
        state.blocked = node.kind === 'buffer' ? 'buffer' : (node.lockReason || 'blocked');
        state.lastNode = node;
        break;
      }
      state.seg = resolved.segment || this.segments.get(resolved.seg);
      state.dir = resolved.end === 'a' ? 1 : -1;
      state.u = resolved.end === 'a' ? 0 : 1;
      state.node = node;
      state.lastNode = node;
      state.routeTaken = resolved;
    }
    return travelled;
  }

  /**
   * Which branch does a train take when it arrives at `node` from `fromSeg`?
   * Returns { seg, end } or null when the movement is not possible.
   */
  resolveNode(node, fromSeg, fromEnd, state) {
    const options = node.branches.filter((b) => b.segment !== fromSeg && this.isOpen(b.segment));
    if (!options.length) {
      const anyOther = node.branches.find((b) => b.segment !== fromSeg);
      if (anyOther && !this.isOpen(anyOther.segment)) node.lockReason = this.closedReason(anyOther.segment);
      return null;
    }
    if (options.length === 1) return options[0];
    // multiple routes: use the switch setting, skipping the incoming branch
    const idx = clamp(node.active | 0, 0, node.branches.length - 1);
    let chosen = node.branches[idx];
    if (!chosen || chosen.segment === fromSeg || !this.isOpen(chosen.segment)) {
      chosen = options.find((o) => this.isOpen(o.segment)) || options[0];
    }
    if (state) state.routeTaken = chosen;
    return chosen;
  }

  /** Valid destinations when arriving at `node` from `fromSeg`. */
  routesFrom(node, fromSeg) {
    return node.branches.filter((b) => b.segment !== fromSeg);
  }

  /** Cycle the switch for a train arriving from `fromSeg`. */
  cycleRoute(node, fromSeg) {
    const opts = this.routesFrom(node, fromSeg);
    if (opts.length < 2) return false;
    const cur = opts.indexOf(node.branches[clamp(node.active, 0, node.branches.length - 1)]);
    const nextIdx = opts[(cur + 1 + opts.length) % opts.length];
    node.active = node.branches.indexOf(nextIdx);
    node.switchTarget = 1;
    return true;
  }

  setRouteIndex(node, i) {
    node.active = clamp(i | 0, 0, node.branches.length - 1);
    node.switchTarget = 1;
  }

  /* -------------------------------------------------------------- frames */
  /**
   * World-space track frame for a state — an orthonormal, superelevated basis:
   *
   *   forward : unit tangent in the direction of travel (model local +Z)
   *   right   : the crew's right-hand side (banked)
   *   up      : track normal (banked) — leans INTO the curve
   *   localX  : cross(up, forward) — the model's local +X (== the train's LEFT)
   *
   * Cant convention: a positive stored bank means "right-hand curve", the outer
   * (left) rail is raised and `up` tilts toward `right`. Travelling backwards
   * through it flips the sign, hence `bank * dir`.
   */
  frame(state, out = {}) {
    const seg = state.seg;
    const u = clamp01(state.u);
    out.position = pointAt(seg.curve, u, out.position || new THREE.Vector3());
    out.forward = tangentAt(seg.curve, u, out.forward || new THREE.Vector3());
    if (state.dir < 0) out.forward.negate();
    out.forward.normalize();

    const f = out.forward;
    out.right = (out.right || new THREE.Vector3()).set(-f.z, 0, f.x);
    if (out.right.lengthSq() < 1e-8) out.right.set(1, 0, 0);
    out.right.normalize();

    const up0 = (out._up0 || (out._up0 = new THREE.Vector3())).crossVectors(out.right, f).normalize();
    const cant = seg.bankAtU(u) * state.dir;
    const c = Math.cos(cant), sn = Math.sin(cant);
    out.up = (out.up || new THREE.Vector3()).copy(up0).multiplyScalar(c).addScaledVector(out.right, sn).normalize();
    out.right.multiplyScalar(c).addScaledVector(up0, -sn).normalize();
    out.localX = (out.localX || new THREE.Vector3()).crossVectors(out.up, f).normalize();

    out.bank = cant;
    out.grade = f.y; // sin(theta), positive = uphill in the direction of travel
    out.kappa = seg.kappaAtU(u);
    out.speedLimit = seg.speedLimit;
    // curve speed limit: v = sqrt(a_lat / kappa), helped by cant
    const aLat = PHYS.maxLateralAccel + Math.min(0.9, Math.abs(cant) * 9.81);
    out.curveLimit = out.kappa > 1e-5 ? Math.sqrt(aLat / out.kappa) * 3.6 : Infinity;
    out.effectiveLimit = Math.min(seg.speedLimit, out.curveLimit);
    // unbalanced lateral acceleration at a given speed (m/s²), for derailment checks
    out.unbalancedAt = (v) => Math.max(0, v * v * out.kappa - Math.abs(cant) * 9.81 * 0.85);
    out.segId = seg.id;
    out.segment = seg;
    out.tunnel = seg.inRanges(u, seg.tunnels) || null;
    out.bridge = seg.inRanges(u, seg.bridges) || seg.inRanges(u, seg.viaducts) || null;
    out.biome = seg.biome;
    out.region = seg.region;
    out.u = u;
    out.metres = u * seg.length;
    return out;
  }

  /** Build the model matrix basis for a state (used to place every vehicle mesh). */
  orient(object3d, state, heightOffset = 0, lateralOffset = 0, out = {}) {
    const f = this.frame(state, out);
    object3d.position.copy(f.position)
      .addScaledVector(f.up, heightOffset)
      .addScaledVector(f.right, lateralOffset);
    object3d.matrix.makeBasis(f.localX, f.up, f.forward);
    object3d.quaternion.setFromRotationMatrix(object3d.matrix);
    return f;
  }

  /** Convenience: world position of a state. */
  positionOf(state, out = new THREE.Vector3()) {
    return pointAt(state.seg.curve, clamp01(state.u), out);
  }

  tangentOf(state, out = new THREE.Vector3()) {
    const t = tangentAt(state.seg.curve, clamp01(state.u), out);
    return state.dir < 0 ? t.negate() : t;
  }

  /**
   * Walk backwards `distance` metres from a state, honouring the route that was
   * actually taken (used for placing cars of a consist and loose stock).
   * `trail` is an optional array of {odo, segId, u, dir} samples, newest last.
   */
  back(state, distance, trail) {
    if (trail && trail.length > 1) {
      const target = state.odo - distance;
      if (target <= trail[0].odo) {
        const t0 = trail[0];
        return this.makeState(t0.segId, t0.u, t0.dir);
      }
      for (let i = trail.length - 1; i >= 1; i--) {
        const a = trail[i - 1], b = trail[i];
        if (target < a.odo || target > b.odo) continue;
        const span = b.odo - a.odo;
        if (a.segId === b.segId) {
          const f = span < 1e-9 ? 0 : (target - a.odo) / span;
          return this.makeState(a.segId, clamp01(a.u + (b.u - a.u) * f), a.dir);
        }
        if (span < 1e-9) return this.makeState(b.segId, b.u, b.dir);
        // A node lies between the two samples. Place the target exactly by
        // measuring a's remaining distance to that node, then walking on into
        // b's segment — this is what keeps a consist evenly spaced over points.
        const sa = this.segments.get(a.segId), sb = this.segments.get(b.segId);
        if (!sa || !sb) return this.makeState(b.segId, b.u, b.dir);
        // Walking "back" runs p downwards, so a's exit node is the one at p = 0.
        const toEnd = (a.dir > 0 ? a.u : 1 - a.u) * sa.length;
        const t = target - a.odo;
        if (t <= toEnd) {
          const u = a.dir > 0 ? a.u - t / sa.length : a.u + t / sa.length;
          return this.makeState(a.segId, clamp01(u), a.dir);
        }
        // Past the shared node: measure into b from whichever end they meet at.
        const into = t - toEnd;
        const shared = sa.a === sb.a || sa.a === sb.b ? sa.a : sa.b;
        const u = shared === sb.a ? into / sb.length : 1 - into / sb.length;
        return this.makeState(b.segId, clamp01(u), b.dir);
      }
    }
    const s = this.cloneState(state);
    s.odo = state.odo;
    this.advance(s, -distance);
    s.odo = state.odo - distance;
    return s;
  }

  /* ---------------------------------------------------- corridor for terrain */
  _buildCorridor() {
    this.corridor = [];
    const CELL = 40;
    this.corridorGrid = new Map();
    for (const seg of this.segments.values()) {
      const step = 6;
      const n = Math.ceil(seg.length / step);
      for (let i = 0; i <= n; i++) {
        const u = i / n;
        const p = pointAt(seg.curve, u, new THREE.Vector3());
        const tunnel = !!seg.inRanges(u, seg.tunnels);
        const bridge = !!seg.inRanges(u, seg.bridges) || !!seg.inRanges(u, seg.viaducts);
        // r = how far either side the terrain is dressed to the formation.
        // Zero under bridges and inside tunnels: there the ground must stay put.
        const r = tunnel || bridge ? 0 : seg.kind === 'siding' ? 9 : 13;
        const sample = { x: p.x, y: p.y, z: p.z, r, tunnel, bridge, seg: seg.id };
        this.corridor.push(sample);
        const key = `${Math.floor(p.x / CELL)},${Math.floor(p.z / CELL)}`;
        if (!this.corridorGrid.has(key)) this.corridorGrid.set(key, []);
        this.corridorGrid.get(key).push(sample);
      }
    }
    this.corridorCell = CELL;
  }

  /** Track formation samples near a world point (for terrain carving / scatter rejection). */
  corridorNear(x, z, radius = 60) {
    const CELL = this.corridorCell;
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    const reach = Math.ceil(radius / CELL);
    const out = [];
    for (let iz = -reach; iz <= reach; iz++) {
      for (let ix = -reach; ix <= reach; ix++) {
        const list = this.corridorGrid.get(`${cx + ix},${cz + iz}`);
        if (!list) continue;
        for (const s of list) {
          const dx = s.x - x, dz = s.z - z;
          if (dx * dx + dz * dz <= radius * radius) out.push(s);
        }
      }
    }
    return out;
  }

  /**
   * Nearest sample the terrain may be dressed to (skips tunnels and bridges,
   * where the ground must be left exactly as nature made it).
   */
  nearestFormation(x, z, maxDist = 46) {
    const near = this.corridorNear(x, z, maxDist);
    let best = null, bd = maxDist * maxDist;
    for (const s of near) {
      if (s.r <= 0) continue;
      const d = (s.x - x) ** 2 + (s.z - z) ** 2;
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }

  /** Nearest formation sample, or null. Used to reject vegetation/props on track. */
  nearestCorridor(x, z, maxDist = 40) {
    const near = this.corridorNear(x, z, maxDist);
    let best = null, bd = maxDist * maxDist;
    for (const s of near) {
      const d = (s.x - x) ** 2 + (s.z - z) ** 2;
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }

  /* --------------------------------------------------------- station index */
  _buildStationIndex() {
    this.stationNodes = [];
    for (const node of this.nodes.values()) {
      if (node.station) this.stationNodes.push(node);
    }
  }

  nodeById(id) { return this.nodes.get(id); }
  segmentById(id) { return this.segments.get(id); }

  /** A state placed at a node, facing along a chosen branch. */
  stateAtNode(nodeId, branchIndex = 0, offset = 0) {
    const node = this.nodes.get(nodeId);
    const br = node.branches[clamp(branchIndex, 0, node.branches.length - 1)];
    const state = this.makeState(br.seg, br.end === 'a' ? 0 : 1, br.end === 'a' ? 1 : -1);
    if (offset) this.advance(state, offset);
    return state;
  }

  /**
   * Look ahead along the current route and collect features.
   * @returns {{distance:number, type:string, ...}[]} sorted by distance
   */
  scanAhead(state, maxDist = 2500, step = 12) {
    const out = [];
    const s = this.cloneState(state);
    let travelled = 0;
    let lastSeg = s.seg;
    const seenNodes = new Set();
    while (travelled < maxDist) {
      const d = Math.min(step, maxDist - travelled);
      const before = s.seg;
      const moved = this.advance(s, d);
      travelled += moved;
      if (s.blocked) {
        out.push({ type: 'buffer', distance: travelled, node: s.lastNode || null, reason: s.blocked });
        break;
      }
      if (moved < d - 1e-6) break;
      if (s.node && !seenNodes.has(s.node.id)) {
        seenNodes.add(s.node.id);
        const routes = this.routesFrom(s.node, before);
        out.push({
          type: s.node.station ? 'station' : (routes.length > 1 ? 'junction' : 'node'),
          distance: travelled, node: s.node, routes, seg: s.seg,
          switchable: !!s.node.switchable && routes.length > 1,
          activeRoute: routes.indexOf(s.routeTaken),
        });
      }
      if (s.seg !== lastSeg) {
        out.push({ type: 'segment', distance: travelled, seg: s.seg, speedLimit: s.seg.speedLimit, region: s.seg.region });
        lastSeg = s.seg;
      }
      if (moved <= 0) break;
    }
    return out;
  }

  /** Distance in metres from a state to a node along the current route, or null. */
  distanceToNode(state, nodeId, maxDist = 4000) {
    if (state.dir > 0 && state.seg.b === nodeId) return (1 - state.u) * state.seg.length;
    if (state.dir < 0 && state.seg.a === nodeId) return state.u * state.seg.length;
    for (const f of this.scanAhead(state, maxDist, 25)) if (f.node && f.node.id === nodeId) return f.distance;
    return null;
  }

  /** All segments whose bounding box overlaps a rect (for streaming/rendering). */
  segmentsInRect(x0, z0, x1, z1, pad = 200) {
    const out = [];
    for (const seg of this.segments.values()) {
      if (!seg._bbox) {
        seg._bbox = new THREE.Box2();
        for (const p of seg.points) seg._bbox.expandByPoint(new THREE.Vector2(p.x, p.z));
      }
      const b = seg._bbox;
      if (b.max.x < x0 - pad || b.min.x > x1 + pad || b.max.y < z0 - pad || b.min.y > z1 + pad) continue;
      out.push(seg);
    }
    return out;
  }

  nodesInRect(x0, z0, x1, z1, pad = 200) {
    const out = [];
    for (const node of this.nodes.values()) {
      if (node.x < x0 - pad || node.x > x1 + pad || node.z < z0 - pad || node.z > z1 + pad) continue;
      out.push(node);
    }
    return out;
  }

  /** Flat list of 2-D points for the minimap / full map. */
  mapPolylines() {
    return [...this.segments.values()].map((seg) => ({
      id: seg.id, region: seg.region, kind: seg.kind, gated: seg.gated,
      pts: seg.points.map((p) => [p.x, p.z]),
    }));
  }
}

export default TrackNetwork;
