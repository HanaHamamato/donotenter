/**
 * TrainController — consist + 1-D spline rail physics (GDD §5.2.2).
 *
 * One instance per train (player or AI). It owns an ordered list of vehicles, a
 * head state on the track graph, and integrates longitudinal forces at a fixed
 * 60 Hz:
 *
 *   TE      = min(adhesion, notch·power / v)          tractive effort
 *   R       = m·(A + B·v + C·v²) + m·g·grade + curve  resistance
 *   B       = pipe·mu_brake·m·g                       air / dynamic / hand brake
 *   a       = (TE − R − B) / m
 *
 * Cars are placed by walking the head's *path history* backwards, so consists
 * articulate correctly through junctions, tunnels and while shunting in
 * reverse. Air brake propagation is modelled front-to-rear (GDD §5.2.3).
 */
import * as THREE from 'three';
import { PHYS, CAR_GAP, LOCOMOTIVES } from '../constants.js';
import { clamp, damp } from '../utils/math.js';
import { bus as defaultBus } from '../utils/events.js';

const TRAIL_STEP = 2;       // metres between path-history samples
const MAX_NOTCH = 8;
const REVERSE_SPEED_CAP = 25 / 3.6; // shunting cap, m/s (GDD §5.1)

export class TrainController {
  /**
   * @param {import('./TrackNetwork.js').TrackNetwork} net
   */
  constructor(net, opts = {}) {
    this.net = net;
    this.bus = opts.bus || defaultBus;
    this.id = opts.id || 'player';
    this.isPlayer = opts.isPlayer !== false;
    this.weather = opts.weather || (() => 'clear');
    this.upgrades = { brakes: 0, engine: 0, capacity: 0, ...(opts.upgrades || {}) };

    /** @type {import('./RollingStockManager.js').Vehicle[]} */
    this.vehicles = [];
    this.state = null;             // head-centre state; forward == nose direction
    this.frame = {};               // cached frame() output for the head
    this.speed = 0;                // m/s, magnitude
    this.moving = 1;               // +1 travel along the nose, −1 reversing
    this.accel = 0;
    this.slip = 0;                 // 0..1 wheel slip
    this.forces = { te: 0, power: 0, adhesion: 0, resistance: 0, brake: 0, grade: 0, net: 0 };

    this.controls = {
      throttle: 0,                 // 0..8 notches
      brake: 0,                    // 0..1 target (automatic brake valve)
      dynamic: 0,                  // 0..8
      reverser: 'n',               // 'f' | 'n' | 'r'
      handbrake: false,
      sander: false,
      emergency: false,
    };
    this.brakePipe = 0;            // 0..1 propagated pressure
    this.braking = 0;              // effective deceleration applied, m/s²

    this.mass = 0;                 // kg
    this.brakeMass = 0;            // kg of braked wheelbase
    this.length = 0;               // m over couplers
    this.powerW = 0;
    this.teStart = 0;
    this.maxSpeed = 0;             // m/s
    this.driveMass = 0;            // kg on driven axles

    this.pathOdo = 0;              // arc length travelled (always increasing)
    this.tripKm = 0;
    this.trail = [];
    this.derail = null;
    this.blocked = null;
    this.horn = 0;
    this.bell = false;
    this.headlights = false;
    this.lastNode = null;
    this.stationStop = null;       // { node, at } while standing at a platform
    this.roll = 0;
    this._acc = 0;
    this._sinceSample = 0;
    this._tmpState = null;
    this.jolt = 0;                 // 0..1 impact shake for the camera
  }

  /* ------------------------------------------------------------ consist */
  get head() { return this.vehicles[0] || null; }
  /** The unit the crew is riding in — the first locomotive, wherever it sits.
   *  Matters when you shove a car: the head of the consist is then a wagon. */
  get cabUnit() { return this.vehicles.find((v) => v.isLoco) || this.vehicles[0] || null; }
  get tail() { return this.vehicles[this.vehicles.length - 1] || null; }
  get locomotives() { return this.vehicles.filter((v) => v.isLoco); }
  get freightCars() { return this.vehicles.filter((v) => v.freight); }
  get coaches() { return this.vehicles.filter((v) => v.passenger); }
  get empty() { return this.vehicles.length === 0; }
  get kmh() { return this.speed * 3.6; }
  get stopped() { return this.speed < 0.08; }
  get tonnes() { return this.mass / 1000; }
  get maxCars() {
    const loco = this.locomotives[0];
    const base = loco ? LOCOMOTIVES[loco.typeKey].maxCars : 2;
    return base + this.upgrades.capacity;
  }

  /** Attach a consist and place it on the track. */
  setConsist(vehicles, state) {
    this.vehicles = vehicles.slice();
    for (const v of this.vehicles) v.train = this;
    this.state = this.net.cloneState(state);
    this._recompute();
    this._seedTrail();
    this.placeCars();
    return this;
  }

  /** Append a vehicle (coupling). Returns false when the train is too long. */
  couple(vehicle, atFront = false) {
    if (this.vehicles.length >= this.maxCars + this.locomotives.length) {
      this.bus.emit('notify', { kind: 'warn', text: 'Couplers at capacity — upgrade to pull more cars.' });
      return false;
    }
    vehicle.train = this;
    if (atFront) this.vehicles.unshift(vehicle); else this.vehicles.push(vehicle);
    this._recompute();
    this._seedTrail();
    this.placeCars();
    this.bus.emit('train:coupled', { train: this, vehicle });
    return true;
  }

  /**
   * Split the consist after `index` (0-based) — everything behind it becomes
   * loose stock parked where it stands. Only legal when nearly stopped.
   */
  decouple(index, rollingstock) {
    if (this.speed > PHYS.coupleMaxSpeed) {
      this.bus.emit('notify', { kind: 'warn', text: 'Too fast to uncouple — bring the train to a halt.' });
      return [];
    }
    if (index < 0 || index >= this.vehicles.length - 1) return [];
    const rear = this.vehicles.splice(index + 1);
    for (const v of rear) {
      v.train = null;
      if (rollingstock && v.state) rollingstock.park(v, this.net.cloneState(v.state));
    }
    this._recompute();
    this._seedTrail();
    this.placeCars();
    this.bus.emit('train:decoupled', { train: this, vehicles: rear });
    return rear;
  }

  _recompute() {
    let mass = 0, length = 0, power = 0, te = 0, drive = 0, brakeMass = 0, maxSpeed = 0;
    for (const v of this.vehicles) {
      mass += v.mass;
      length += v.length;
      brakeMass += v.mass;
      if (v.isLoco) {
        const spec = LOCOMOTIVES[v.typeKey];
        power += spec.powerHP * 746;
        te += spec.teStart;
        drive += spec.mass;
        maxSpeed = Math.max(maxSpeed, spec.maxSpeed / 3.6);
      }
    }
    length += Math.max(0, this.vehicles.length - 1) * CAR_GAP;
    this.mass = mass || 1;
    this.brakeMass = brakeMass;
    this.length = length;
    this.powerW = power;
    this.teStart = te;
    this.driveMass = drive;
    this.maxSpeed = maxSpeed || 80 / 3.6;
  }

  /** Build a path history behind the head so cars can be placed immediately. */
  _seedTrail() {
    this.trail.length = 0;
    if (!this.state) return;
    const total = this.length + 80;
    const s = this.net.cloneState(this.state);
    // {segId,u,d} where d = arc length back from the head
    const samples = [{ segId: s.seg.id, u: s.u, dir: s.dir, d: 0 }];
    for (let d = 0; d < total; d += TRAIL_STEP) {
      const moved = this.net.advance(s, -TRAIL_STEP);
      if (s.blocked || Math.abs(moved) < 1e-6) break;
      samples.push({ segId: s.seg.id, u: s.u, dir: s.dir, d: samples[samples.length - 1].d + Math.abs(moved) });
    }
    samples.reverse();
    for (const sm of samples) {
      this.trail.push({ odo: this.pathOdo - sm.d, segId: sm.segId, u: sm.u, dir: sm.dir });
    }
    this._sinceSample = 0;
  }

  _sampleTrail(travelled) {
    if (travelled <= 0) return;
    this._sinceSample = (this._sinceSample || 0) + travelled;
    while (this._sinceSample >= TRAIL_STEP) {
      this._sinceSample -= TRAIL_STEP;
      this.trail.push({
        odo: this.pathOdo, segId: this.state.seg.id, u: this.state.u, dir: this.state.dir,
      });
    }
    // keep just enough history for the whole consist plus a margin
    const keep = Math.ceil((this.length + 120) / TRAIL_STEP) + 4;
    if (this.trail.length > keep) this.trail.splice(0, this.trail.length - keep);
  }

  /* ------------------------------------------------------------ controls */
  notch(delta) {
    if (this.derail) return;
    const t = clamp(Math.round(this.controls.throttle + delta), 0, MAX_NOTCH);
    if (t !== this.controls.throttle) {
      this.controls.throttle = t;
      if (t > 0 && this.controls.reverser === 'n') this.setReverser('f');
      this.bus.emit('train:notch', { train: this, notch: t });
    }
  }

  setBrake(value) {
    this.controls.brake = clamp(value, 0, 1);
    if (value > 0.02) this.controls.emergency = false;
  }

  brakeStep(delta) { this.setBrake(this.controls.brake + delta); }

  setDynamic(value) { this.controls.dynamic = clamp(Math.round(value), 0, MAX_NOTCH); }

  setReverser(mode) {
    if (mode === this.controls.reverser) return;
    if (this.speed > 0.35 && Math.sign(this.speed) !== 0) {
      this.bus.emit('notify', { kind: 'warn', text: 'Reverser is locked while the train is rolling.' });
      return;
    }
    this.controls.reverser = mode;
    this.moving = mode === 'r' ? -1 : 1;
    if (mode === 'n') { this.controls.throttle = 0; this.controls.dynamic = 0; }
    this.bus.emit('train:reverser', { train: this, mode });
  }

  toggleReverse() {
    this.setReverser(this.controls.reverser === 'r' ? 'f' : 'r');
  }

  emergencyBrake(on = true) {
    this.controls.emergency = !!on;
    if (on) { this.controls.brake = 1; this.controls.throttle = 0; this.bus.emit('train:emergency', { train: this }); }
  }

  handbrake(on) { this.controls.handbrake = !!on; }
  sand(on) { this.controls.sander = !!on; }
  hornPress(sec = 0.7) { this.horn = Math.max(this.horn, sec); this.bus.emit('train:horn', { train: this }); }
  toggleBell() { this.bell = !this.bell; this.bus.emit('train:bell', { train: this, on: this.bell }); }
  setHeadlights(on) {
    this.headlights = !!on;
    for (const v of this.vehicles) v.setHeadlight(this.headlights);
  }

  /** Everything off, brakes on — what the player does when leaving the cab. */
  secure() {
    this.controls.throttle = 0;
    this.controls.dynamic = 0;
    this.controls.reverser = 'n';
    this.controls.brake = 1;
    this.controls.handbrake = true;
  }

  /* ------------------------------------------------------------- physics */
  /** Fixed-step simulation; safe with variable frame times. */
  step(dt) {
    if (!this.state || this.empty) return;
    this._acc += Math.min(dt, 0.25);
    const h = PHYS.fixedStep;
    let steps = 0;
    while (this._acc >= h && steps++ < PHYS.maxSubSteps * 4) {
      this._physics(h);
      this._acc -= h;
    }
    if (steps >= PHYS.maxSubSteps * 4) this._acc = 0;
    this.frame = this.net.frame(this.state, this.frame);
    this.placeCars();
    this.horn = Math.max(0, this.horn - dt);
    this.jolt = Math.max(0, this.jolt - dt * 2.4);
  }

  _physics(h) {
    const f = this.net.frame(this.state, this.frame);
    const c = this.controls;
    const v = this.speed;
    const m = this.mass;
    const g = PHYS.gravity;
    const weatherMul = PHYS.adhesionWeather[this.weather()] ?? 1;

    // --- brake pipe propagation (front → rear), GDD §5.2.3
    const nCars = this.vehicles.length;
    const applyTime = Math.max(0.2, PHYS.brakePipeBase + PHYS.brakePipePerCar * nCars) / (1 + 0.25 * this.upgrades.brakes);
    const releaseTime = Math.max(0.2, PHYS.brakePipeBase * 0.7 + PHYS.brakeReleasePerCar * nCars);
    const target = c.emergency ? 1 : c.brake;
    const tau = Math.max(0.06, target > this.brakePipe ? applyTime : releaseTime);
    this.brakePipe += (target - this.brakePipe) * clamp(h / tau, 0, 1);
    if (Math.abs(this.brakePipe - target) < 0.004) this.brakePipe = target;

    const neutral = c.reverser === 'n';
    const reversing = c.reverser === 'r';
    this.moving = reversing ? -1 : 1;

    // --- tractive effort
    const notch = neutral || this.derail ? 0 : c.throttle;
    const sandMul = c.sander ? 1.35 : 1;
    const adhesion = PHYS.adhesionCoeff * sandMul * weatherMul * this.driveMass * g * (1 + 0.15 * this.upgrades.engine);
    const vv = Math.max(v, PHYS.minSpeedForPower);
    let power = (notch / MAX_NOTCH) * this.powerW / vv * (1 + 0.15 * this.upgrades.engine);
    if (reversing) power *= 0.6;
    // governor: no power above the loco's design speed (or the shunt cap)
    const cap = reversing ? REVERSE_SPEED_CAP : this.maxSpeed;
    if (v >= cap) power = 0;
    let te = Math.min(adhesion, power);
    // wheel slip: demanding more than the rail can take spins the wheels
    const demand = power;
    this.slip = demand > adhesion * 1.001 ? clamp((demand - adhesion) / Math.max(1, adhesion), 0, 1) : Math.max(0, this.slip - h * 2);
    if (this.slip > 0.02 && !c.sander) te *= 1 - 0.45 * this.slip;
    if (this.slip > 0.35) this.bus.emit('train:slip', { train: this, slip: this.slip });

    // --- resistance
    const grade = f.grade * this.moving; // grade as seen in the direction of motion
    const roll = m * (PHYS.rollA + PHYS.rollB * v + PHYS.rollC * v * v);
    const gradeF = m * g * grade;
    const curveF = m * v * v * f.kappa * PHYS.curveResistCoeff;
    const resistance = roll + curveF;

    // --- brakes
    let brakeDecel = this.brakePipe * PHYS.brakeCoeff * (c.emergency ? PHYS.emergencyBrakeMul : 1) * (1 + 0.08 * this.upgrades.brakes);
    if (c.handbrake) brakeDecel += PHYS.handBrakeDecel;
    const dyn = neutral ? 0 : (c.dynamic / MAX_NOTCH);
    let dynForce = 0;
    if (dyn > 0 && v > 1.2) {
      const fade = clamp(1 - (v - cap * 0.55) / Math.max(1, cap * 0.6), 0.15, 1);
      dynForce = dyn * this.teStart * 0.55 * fade;
    }
    const brakeForce = brakeDecel * m * g + dynForce;
    this.braking = brakeForce / m;

    // --- integrate
    const netForce = te - resistance - gradeF - brakeForce;
    let a = netForce / m;
    // a stopped train will not be dragged backwards by a grade once brakes hold
    if (v <= 0.001 && (brakeDecel * g) > Math.abs(gradeF) / m) a = Math.max(0, a);
    let next = v + a * h;
    if (next < 0) { next = 0; a = -v / h; }
    this.accel = a;
    this.speed = next;
    this.forces.te = te; this.forces.power = power; this.forces.adhesion = adhesion;
    this.forces.resistance = resistance; this.forces.brake = brakeForce;
    this.forces.grade = gradeF; this.forces.net = netForce;

    // --- move along the graph
    const ds = this.speed * h * this.moving;
    if (Math.abs(ds) > 1e-9) {
      const before = this.state.seg;
      const moved = this.net.advance(this.state, ds);
      const travelled = Math.abs(moved);
      this.pathOdo += travelled;
      this.tripKm += travelled / 1000;
      this._sampleTrail(travelled);
      if (travelled < Math.abs(ds) - 1e-6) this._handleBlocked(travelled);
      if (this.state.node && this.state.node !== this.lastNode) this._handleNode(this.state.node, before);
      this.lastNode = this.state.node || this.lastNode;
    }

    // --- derailment (GDD §5.2.4)
    this._checkDerail(f);
  }

  _handleBlocked(travelled) {
    const reason = this.state.blocked;
    const impact = this.speed;
    if (reason === 'buffer') {
      if (impact > 2.5) {
        this.jolt = clamp(impact / 8, 0.3, 1);
        for (const v of this.vehicles) v.damage(impact * 2.2);
        this.bus.emit('train:buffer', { train: this, speed: impact, damage: impact * 2.2 });
        this.bus.emit('notify', { kind: 'bad', text: `Hit the buffer stop at ${Math.round(impact * 3.6)} km/h!` });
      }
      this.speed = 0;
    } else if (reason === 'Region locked' || reason === 'Branch not rebuilt') {
      this.speed = 0;
      this.bus.emit('train:locked', { train: this, reason, seg: this.state.seg });
    } else if (reason) {
      this.speed = 0;
      this.bus.emit('train:blocked', { train: this, reason });
    }
    this.blocked = reason;
  }

  _handleNode(node, fromSeg) {
    if (node.station) {
      this.stationStop = this.speed < 0.4 ? { node, at: performance.now?.() || Date.now() } : null;
      this.bus.emit('train:station', { train: this, node, station: node.station, speed: this.speed, from: fromSeg?.id });
    } else if (node.switchable) {
      this.bus.emit('train:junction', { train: this, node, route: this.state.routeTaken });
    } else {
      this.bus.emit('train:node', { train: this, node });
    }
  }

  _checkDerail(f) {
    if (this.derail || this.speed < 1) return;
    const limit = f.effectiveLimit / 3.6;
    let reason = null;
    if (this.speed > limit * PHYS.derailSpeedFactor) reason = 'overspeed';
    else if (f.unbalancedAt(this.speed) > PHYS.maxLateralAccel * PHYS.derailCurveFactor) reason = 'curve';
    if (!reason) return;
    this.derail = {
      reason,
      speed: this.speed,
      limit: f.effectiveLimit,
      position: f.position.clone(),
      segId: f.segId, u: f.u,
    };
    this.speed = 0;
    this.controls.throttle = 0;
    this.controls.dynamic = 0;
    for (const v of this.vehicles) v.damage(18 + Math.random() * 22);
    this.bus.emit('train:derail', { train: this, ...this.derail });
  }

  /** Pay the recovery cost and put the consist back on the rails. */
  rerail() {
    if (!this.derail) return false;
    const s = this.net.makeState(this.derail.segId, this.derail.u, this.state.dir);
    this.state = s;
    this.speed = 0;
    this.derail = null;
    this.blocked = null;
    this.controls.throttle = 0;
    this.controls.brake = 1;
    this._seedTrail();
    this.placeCars();
    this.bus.emit('train:rerailed', { train: this });
    return true;
  }

  /* ------------------------------------------------------- car placement */
  /** Position every vehicle mesh along the head's path history. */
  placeCars() {
    if (!this.state) return;
    const head = this.vehicles[0];
    if (!head) return;
    this.frame = this.net.frame(this.state, this.frame);
    if (head.group) {
      head.group.position.copy(this.frame.position);
      head.group.matrix.makeBasis(this.frame.localX, this.frame.up, this.frame.forward);
      head.group.quaternion.setFromRotationMatrix(head.group.matrix);
      head.group.matrixAutoUpdate = true;
    }
    head.state = this.net.cloneState(this.state);
    head.state.odo = this.pathOdo;

    let cursor = head.state;
    let dist = 0;
    for (let i = 1; i < this.vehicles.length; i++) {
      const prev = this.vehicles[i - 1];
      const v = this.vehicles[i];
      dist = prev.length / 2 + CAR_GAP + v.length / 2;
      const probe = this.net.cloneState(cursor);
      probe.odo = cursor.odo;
      cursor = this.net.back(probe, dist, this.trail);
      cursor.odo = probe.odo - dist;
      v.state = cursor;
      if (!v.group) continue;
      const fr = this.net.frame(cursor, v._frame || (v._frame = {}));
      v.group.position.copy(fr.position);
      v.group.matrix.makeBasis(fr.localX, fr.up, fr.forward);
      v.group.quaternion.setFromRotationMatrix(v.group.matrix);
    }
    // body roll from unbalanced lateral acceleration
    const aLat = this.speed * this.speed * this.frame.kappa - Math.abs(this.frame.bank) * 9.81 * 0.85;
    this.roll = clamp(-aLat * 0.012, -0.09, 0.09);
    for (const v of this.vehicles) {
      const body = v.group?.children[0];
      if (body) body.rotation.z = damp(body.rotation.z, this.roll, 3, 1 / 60);
    }
  }

  /* --------------------------------------------------------------- data */
  /** Nearest speed restriction ahead, for the HUD (GDD §6.1). */
  lookAhead(maxDist = 1200) {
    if (!this.state) return [];
    return this.net.scanAhead(this.state, maxDist, 14);
  }

  currentLimit() {
    const f = this.frame;
    let limit = f.effectiveLimit ?? 80;
    if (this.moving < 0) limit = Math.min(limit, REVERSE_SPEED_CAP * 3.6);
    return limit;
  }

  /** Load/consist summary for the HUD and contracts. */
  manifest() {
    const loads = {};
    for (const v of this.vehicles) if (v.cargo) loads[v.cargo] = (loads[v.cargo] || 0) + v.tons;
    return {
      cars: this.vehicles.length,
      tonnes: Math.round(this.tonnes),
      length: Math.round(this.length),
      loads,
      types: this.vehicles.map((v) => v.typeKey),
    };
  }

  /** Where the whole consist is, for streaming and the minimap. */
  bounds() {
    const box = new THREE.Box3();
    for (const v of this.vehicles) if (v.group) box.expandByObject(v.group);
    return box;
  }

  serialize() {
    return {
      vehicles: this.vehicles.map((v) => v.toJSON()),
      seg: this.state?.seg.id, u: this.state?.u, dir: this.state?.dir,
      speed: this.speed, moving: this.moving,
      controls: { ...this.controls }, tripKm: this.tripKm,
      upgrades: { ...this.upgrades },
    };
  }

  dispose() {
    for (const v of this.vehicles) if (v.group) v.group.removeFromParent();
    this.vehicles.length = 0;
    this.trail.length = 0;
  }
}

export default TrainController;
