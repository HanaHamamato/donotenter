/**
 * RollingStockManager — the fleet (GDD §7 RollingStockManager).
 *
 * Owns every vehicle in the world: the player's roster, loose stock standing in
 * yard tracks waiting to be coupled, and AI consists. Vehicles are plain data
 * plus one lazily-built THREE.Group; geometry is shared through AssetManager so
 * a 40-car yard costs 40 draw calls, not 40 models.
 */
import * as THREE from 'three';
import { pointAt } from '../utils/spline.js';
import { CAR_TYPES, LOCOMOTIVES, CARGO, CAR_GAP } from '../constants.js';
import { bus } from '../utils/events.js';

let _uid = 1;
const uid = (p) => `${p}${(_uid++).toString(36)}`;

/** Cargo → visible load model. */
const LOAD_MODEL = {
  timber: 'cargo_timber', steel: 'cargo_coils', coal: 'cargo_bulk', grain: 'cargo_bulk',
  ironore: 'cargo_bulk', fertilizer: 'cargo_bulk', livestock: 'cargo_pile',
  parts: 'cargo_crates', goods: 'cargo_crates', food: 'cargo_crates', fish: 'cargo_crates',
  supplies: 'cargo_crates', passengers: null,
};

export class Vehicle {
  /**
   * @param {'loco'|'freight'|'passenger'|'caboose'} kind
   * @param {string} typeKey  CAR_TYPES key, or LOCOMOTIVES key when kind === 'loco'
   */
  constructor(kind, typeKey, opts = {}) {
    this.id = opts.id || uid(kind === 'loco' ? 'loc' : 'car');
    this.kind = kind;
    this.typeKey = typeKey;
    const spec = kind === 'loco' ? LOCOMOTIVES[typeKey] : CAR_TYPES[typeKey];
    if (!spec) throw new Error(`[rollingstock] unknown vehicle type "${typeKey}"`);
    this.spec = spec;
    this.name = spec.name || spec.label;
    this.length = kind === 'loco' ? spec.bodyLength : spec.length;
    this.massEmpty = kind === 'loco' ? spec.mass : spec.massEmpty;
    this.massFull = kind === 'loco' ? spec.mass : spec.massLoaded;
    this.color = spec.color;
    this.freight = !!spec.freight;
    this.passenger = !!spec.passenger;

    this.cargo = null;      // CARGO key
    this.tons = 0;          // 0..capacity
    this.capacity = this.massFull - this.massEmpty; // kg
    this.condition = 100;   // GDD §3.4 fragile cargo condition
    this.origin = null;     // station id the load came from
    this.contractId = null;

    this.brakePct = 0;      // per-car applied brake (pipe propagation)
    this.wheelPhase = Math.random() * Math.PI * 2;
    this.slipping = 0;
    this.group = null;
    this.state = null;
    this.train = null;
    this.headlight = false;
    this.markerColor = opts.markerColor ?? null;
  }

  get loaded() { return this.tons > 1; }
  get loadFraction() { return this.capacity > 0 ? this.tons * 1000 / this.capacity : 0; }
  get mass() { return this.massEmpty + this.tons * 1000; }
  get isLoco() { return this.kind === 'loco'; }
  get modelKey() { return this.kind === 'loco' ? `loco_${this.typeKey}` : `car_${this.typeKey}`; }
  get couplerGap() { return CAR_GAP; }

  setLoad(cargoKey, tons, origin = null, contractId = null) {
    this.cargo = cargoKey || null;
    this.tons = cargoKey ? Math.max(0, tons) : 0;
    this.origin = origin;
    this.contractId = contractId;
    this.condition = 100;
    this._refreshLoadMesh();
    return this;
  }

  clearLoad() { return this.setLoad(null, 0); }

  damage(points) {
    this.condition = Math.max(0, this.condition - points);
    bus.emit('vehicle:damaged', { vehicle: this, points, condition: this.condition });
  }

  /** Build (or rebuild) the visible model. Called once on first placement. */
  build(assets) {
    if (this.group) return this.group;
    const g = new THREE.Group();
    g.name = this.id;
    g.add(assets.mesh(this.modelKey, assets.materials.paint));
    if (this.isLoco) {
      // one real light on the player's lead unit; emissive faces elsewhere
      const lamp = new THREE.Mesh(
        new THREE.SphereGeometry(0.34, 10, 8),
        new THREE.MeshBasicMaterial({ color: 0xfff3d0 }),
      );
      lamp.position.set(0.62, 1.9, this.length / 2 - 0.1);
      lamp.name = 'headlightLamp';
      lamp.visible = false;
      g.add(lamp);
      const lamp2 = lamp.clone();
      lamp2.position.x = -0.62;
      lamp2.name = 'headlightLamp2';
      g.add(lamp2);
      const spot = new THREE.SpotLight(0xfff0d2, 0, 420, Math.PI / 7, 0.45, 1.1);
      spot.position.set(0, 2.2, this.length / 2);
      spot.target.position.set(0, 0, this.length / 2 + 200);
      spot.name = 'headlight';
      spot.visible = false;
      g.add(spot, spot.target);
      this.spot = spot;
    }
    this.group = g;
    this._refreshLoadMesh();
    return g;
  }

  _refreshLoadMesh() {
    if (!this.group) return;
    if (this.loadMesh) {
      this.group.remove(this.loadMesh);
      this.loadMesh.geometry.dispose?.();
      this.loadMesh = null;
    }
    if (!this.loaded || !this.cargo) return;
    const key = LOAD_MODEL[this.cargo];
    if (!key) return;
    const assets = Vehicle._assets;
    if (!assets) return;
    const cargo = CARGO[this.cargo];
    const mat = assets.cargoMaterial(cargo.color);
    const mesh = new THREE.Mesh(assets.geometry(key), mat);
    mesh.castShadow = true;
    // sit the pile on the car floor; open cars carry it high, boxcars get a low placard
    const deck = this.typeKey === 'flatbed' ? 1.35 : this.typeKey === 'gondola' ? 1.4 : this.typeKey === 'hopper' ? 3.1 : 0.2;
    mesh.position.y = deck;
    if (key === 'cargo_pile') mesh.scale.setScalar(0.9);
    if (!this.freight) mesh.visible = false;
    mesh.name = 'load';
    this.group.add(mesh);
    this.loadMesh = mesh;
  }

  setHeadlight(on) {
    this.headlight = !!on;
    if (!this.group) return;
    const spot = this.group.getObjectByName('headlight');
    if (spot) { spot.visible = on; spot.intensity = on ? 900 : 0; }
    for (const n of ['headlightLamp', 'headlightLamp2']) {
      const l = this.group.getObjectByName(n);
      if (l) l.visible = on;
    }
  }

  toJSON() {
    return {
      id: this.id, kind: this.kind, typeKey: this.typeKey,
      cargo: this.cargo, tons: this.tons, condition: this.condition,
      origin: this.origin, contractId: this.contractId,
    };
  }
}

const _probe = new THREE.Vector3();

export class RollingStockManager {
  constructor(assets) {
    this.assets = assets;
    Vehicle._assets = assets;
    assets.cargoMaterial = (color) => {
      assets._cargoMats ||= new Map();
      let m = assets._cargoMats.get(color);
      if (!m) {
        m = new THREE.MeshLambertMaterial({ color, vertexColors: true });
        assets._cargoMats.set(color, m);
      }
      return m;
    };
    /** @type {Map<string, Vehicle>} */
    this.all = new Map();
    /** Vehicles standing loose in the world, awaiting coupling. */
    this.loose = [];
  }

  /** Create and register a vehicle. */
  spawn(kind, typeKey, opts = {}) {
    const v = new Vehicle(kind, typeKey, opts);
    this.all.set(v.id, v);
    return v;
  }

  loco(typeKey, opts) { return this.spawn('loco', typeKey, opts); }
  car(typeKey, opts) {
    const kind = CAR_TYPES[typeKey]?.passenger ? 'passenger' : typeKey === 'caboose' ? 'caboose' : 'freight';
    return this.spawn(kind, typeKey, opts);
  }

  get(id) { return this.all.get(id); }
  remove(v) {
    if (v.group) { v.group.removeFromParent(); v.group = null; }
    this.all.delete(v.id);
    const i = this.loose.indexOf(v);
    if (i >= 0) this.loose.splice(i, 1);
  }

  /** Park a vehicle on the rails, unattached to any train. */
  park(v, state) {
    v.state = state;
    v.train = null;
    if (!this.loose.includes(v)) this.loose.push(v);
    return v;
  }

  unpark(v) {
    const i = this.loose.indexOf(v);
    if (i >= 0) this.loose.splice(i, 1);
  }

  /** Loose stock within `radius` metres of a world point, sorted nearest first. */
  looseNear(x, z, radius = 8) {
    const out = [];
    for (const v of this.loose) {
      if (!v.state) continue;
      // arc-length position (pointAt), not curve.getPoint — the whole network
      // works in arc-length u, and mixing the two puts cars metres off
      const p = v.state.seg?.curve ? pointAt(v.state.seg.curve, v.state.u, _probe) : null;
      if (!p) continue;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d <= radius) out.push({ vehicle: v, distance: d, point: p });
    }
    return out.sort((a, b) => a.distance - b.distance);
  }

  roster() { return [...this.all.values()]; }

  /** Serialise everything not currently in the player's train. */
  serializeLoose() {
    return this.loose.filter((v) => v.state).map((v) => ({
      ...v.toJSON(),
      seg: v.state.seg.id, u: v.state.u, dir: v.state.dir,
    }));
  }

  restoreLoose(net, list) {
    for (const d of list || []) {
      if (!net.segments.has(d.seg)) continue;
      const v = this.all.get(d.id) || this.spawn(d.kind, d.typeKey, { id: d.id });
      v.setLoad(d.cargo, d.tons, d.origin, d.contractId);
      v.condition = d.condition ?? 100;
      this.park(v, net.makeState(d.seg, d.u, d.dir));
    }
  }

  dispose() {
    for (const v of this.all.values()) if (v.group) v.group.removeFromParent();
    this.all.clear();
    this.loose.length = 0;
  }
}

export default RollingStockManager;
