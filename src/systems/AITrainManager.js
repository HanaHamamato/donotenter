/**
 * AITrainManager — the rest of the railway (GDD §5.4 traffic, §7 AITrainManager).
 *
 * Each AI train is a real TrainController driven by a small brain that:
 *
 *   • plans a route with Dijkstra over the node graph to a chosen destination,
 *   • throws the switches it needs as it approaches each junction,
 *   • runs to the segment speed limit, braking early for curves, stations and
 *     buffer stops using a v = √(2·a·d) stopping curve,
 *   • holds at a red signal and creeps on yellow,
 *   • dwells at its destination, then picks a new one,
 *   • gets out of the way if it ever ends up derailed or stuck.
 *
 * Because AI trains occupy blocks in the shared BlockSystem, the player's
 * signals react to them and vice versa — two trains cannot be routed into the
 * same single-track section by the signals, though a determined driver can
 * still do it by hand.
 */
import * as THREE from 'three';
import { TrainController } from './TrainController.js';
import { CAR_TYPES, LOCOMOTIVES } from '../constants.js';
import { clamp, clamp01, pickWeighted } from '../utils/math.js';
import { bus } from '../utils/events.js';

const AI_BRAKE_DECEL = 0.55;        // m/s² the driver assumes it can hold
const DWELL = [9, 26];              // seconds at a station

class AIDriver {
  constructor(net, train, blocks, opts = {}) {
    this.net = net;
    this.train = train;
    this.blocks = blocks;
    this.mode = 'run';
    this.dest = null;
    this.field = null;
    this.dwell = 0;
    this.stuck = 0;
    this.held = 0;
    this.skill = opts.skill ?? 0.85 + Math.random() * 0.3;
    this.lastNodeSet = null;
    this.targetKmh = 0;
    this.reason = '';
  }

  /** Distance field from `destId` back over the whole node graph. */
  static plan(net, destId) {
    const dist = new Map([[destId, 0]]);
    const next = new Map();
    const pq = [[0, destId]];
    const done = new Set();
    let guard = 0;
    while (pq.length && guard++ < 4096) {
      pq.sort((a, b) => a[0] - b[0]);
      const [d, id] = pq.shift();
      if (done.has(id)) continue;
      done.add(id);
      const node = net.nodeById(id);
      if (!node) continue;
      for (const br of node.branches) {
        const seg = br.segment;
        if (!seg || !net.isOpen(seg)) continue;
        const other = seg.a === id ? seg.b : seg.a;
        const nd = d + seg.length;
        if (!dist.has(other) || nd < dist.get(other)) {
          dist.set(other, nd);
          next.set(other, seg.id);
          pq.push([nd, other]);
        }
      }
    }
    return { dist, next };
  }

  setDestination(nodeId) {
    this.dest = nodeId;
    this.field = AIDriver.plan(this.net, nodeId);
    this.mode = 'run';
    this.dwell = 0;
  }

  /** Which branch index to set at `node` to keep heading for the destination. */
  _routeIndex(node) {
    if (!this.field) return null;
    const wantSeg = this.field.next.get(node.id);
    if (!wantSeg) return null;
    const i = node.branches.findIndex((b) => b.seg === wantSeg);
    return i >= 0 ? i : null;
  }

  update(dt) {
    const t = this.train;
    if (!t.state || t.empty) return;
    if (!this.dest) return;

    // --- thrown switches: set them well before we arrive
    const look = this.net.scanAhead(t.state, 620, 22);
    let firstSignal = null;
    let stopDistance = Infinity;
    let stopReason = '';
    let speedTarget = (t.state.seg.speedLimit ?? 70) * 0.94 * this.skill;

    for (const f of look) {
      if (f.type === 'segment' && f.seg && f.distance < 340) {
        // a new speed limit ahead: start braking for it now, not at the board
        const lim = (f.seg.speedLimit ?? 80) * 0.94;
        const v = Math.sqrt(2 * AI_BRAKE_DECEL * Math.max(0, f.distance)) * 3.6;
        speedTarget = Math.min(speedTarget, Math.max(lim, v));
      }
      if (f.type === 'junction' || f.type === 'node' || (f.type === 'station' && f.node)) {
        const node = f.node;
        if (!node) continue;
        if (node.switchable && f.routes?.length > 1 && this.lastNodeSet !== node.id) {
          const idx = this._routeIndex(node);
          if (idx != null && node.active !== idx && f.distance < 420) {
            // do not yank a switch under the player: only throw it when we are next
            const occupants = this.blocks.occupants(node.branches[idx]?.segment?.id);
            const free = !occupants || [...occupants].every((id) => id === t.id);
            if (free) { this.net.setRouteIndex(node, idx); this.lastNodeSet = node.id; }
          }
          // points are slow: 45 km/h over the frog
          if (f.distance < 260) speedTarget = Math.min(speedTarget, 45);
        }
        // signal protecting this node
        const chosen = node.branches[Math.max(0, node.active | 0)]?.segment;
        if (chosen && !firstSignal) {
          const aspect = this.blocks.aspectAt(node, chosen);
          firstSignal = { distance: f.distance, aspect, node: node.id };
        }
      }
      if (f.type === 'buffer' && !firstSignal) {
        firstSignal = { distance: f.distance, aspect: 'red', node: f.node?.id, buffer: true };
      }
    }

    // --- signals
    if (firstSignal) {
      if (firstSignal.aspect === 'red') {
        const d = Math.max(6, firstSignal.distance - 26);
        stopDistance = Math.min(stopDistance, d);
        stopReason = firstSignal.buffer ? 'buffer stop' : 'signal at danger';
      } else if (firstSignal.aspect === 'yellow') {
        const d = Math.max(8, firstSignal.distance - 30);
        const v = Math.sqrt(2 * AI_BRAKE_DECEL * 0.55 * d) * 3.6;
        speedTarget = Math.min(speedTarget, Math.max(14, v));
      }
    }

    // --- a train in the block ahead
    const ahead = this.blocks.trainAhead(t.state, 700, t.id);
    if (ahead?.blocked && ahead.trains?.length) {
      const d = Math.max(8, ahead.distance - 60);
      stopDistance = Math.min(stopDistance, d);
      stopReason = 'train ahead';
    } else if (ahead?.blocked && !ahead.trains) {
      stopDistance = Math.min(stopDistance, Math.max(6, ahead.distance - 24));
      stopReason = ahead.reason || 'line blocked';
    }

    // --- arrival
    const toDest = this.net.distanceToNode(t.state, this.dest, 6000);
    if (toDest != null) {
      if (toDest < 340) {
        stopDistance = Math.min(stopDistance, Math.max(8, toDest - 40));
        stopReason = 'station stop';
        speedTarget = Math.min(speedTarget, 32);
      }
      if (toDest < 46 && t.kmh < 1.2 && this.mode === 'run') {
        this.mode = 'dwell';
        this.dwell = DWELL[0] + Math.random() * (DWELL[1] - DWELL[0]);
        t.controls.throttle = 0;
        t.setBrake(0.72);
        t.handbrake(true);
        bus.emit('ai:dwell', { train: t, station: this.dest });
      }
    }

    if (this.mode === 'dwell') {
      this.dwell -= dt;
      t.controls.throttle = 0;
      t.setBrake(0.8);
      if (this.dwell <= 0) {
        t.handbrake(false);
        t.setBrake(0);
        this.mode = 'run';
        this.lastNodeSet = null;
        bus.emit('ai:depart', { train: t, station: this.dest });
      }
      this.reason = 'dwelling';
      return;
    }

    // --- speed target from the nearest stopping point
    if (stopDistance < Infinity) {
      const v = Math.sqrt(2 * AI_BRAKE_DECEL * Math.max(0, stopDistance)) * 3.6;
      speedTarget = Math.min(speedTarget, Math.max(0, v));
    }
    this.targetKmh = speedTarget;
    this.reason = stopReason || 'running';

    // --- drive
    const err = speedTarget - t.kmh;
    if (err > 0.8) {
      t.setBrake(0);
      const notch = clamp(Math.round(err / 4) + 1, 1, 8);
      t.controls.reverser = 'f';
      t.notch(notch - t.controls.throttle);
      if (t.slip > 0.45) t.sand(true); else if (t.slip < 0.15) t.sand(false);
    } else if (err < -1.6) {
      t.notch(-t.controls.throttle);
      t.setBrake(clamp01(-err / 22));
    } else {
      t.setBrake(0);
      if (t.controls.throttle > 0 && err < -0.2) t.notch(-1);
    }

    // --- unstuck: creeping under power for too long means something is wrong
    if (t.kmh < 0.6 && t.controls.throttle > 0 && !t.derail) this.stuck += dt;
    else this.stuck = Math.max(0, this.stuck - dt * 2);
    if (this.stuck > 26 || t.derail) {
      this.stuck = 0;
      bus.emit('ai:stuck', { train: t, reason: t.derail?.reason || 'held up' });
      return 'reset';
    }

    // --- deadlock: standing still for a long time even with no power applied
    // (facing a buffer, or two trains holding each other) — move it on
    if (t.kmh < 0.6 && this.mode !== 'dwell') this.held += dt;
    else this.held = 0;
    if (this.held > 70) {
      this.held = 0;
      bus.emit('ai:stuck', { train: t, reason: 'deadlock' });
      return 'reset';
    }
    return null;
  }
}

export class AITrainManager {
  /**
   * @param {object} deps {scene, net, rollingstock, blocks, assets, weather}
   */
  constructor(deps = {}) {
    const { scene, net, rollingstock, blocks, assets } = deps;
    this.scene = scene;
    this.net = net;
    this.stock = rollingstock;
    this.blocks = blocks;
    this.assets = assets;
    this.weather = deps.weather || (() => 'clear');
    this.trains = [];
    this.target = deps.count ?? 3;
    this.enabled = deps.enabled !== false;
    this.stationNodes = net.stationNodes.filter((n) => n.station);
    this.spawnTimer = 0;
    this.group = new THREE.Group();
    this.group.name = 'aiTrains';
    scene?.add(this.group);
  }

  openStations() {
    return this.stationNodes.filter((n) => {
      const seg = n.branches[0]?.segment;
      return seg && this.net.isOpen(seg);
    });
  }

  /** Build one AI train and put it on the rails at a station. */
  spawnTrain(atNodeId, opts = {}) {
    const stations = this.openStations();
    if (!stations.length) return null;
    let node = atNodeId ? this.net.nodeById(atNodeId) : null;
    if (!node) {
      // prefer a station whose departure block is empty, so two AI trains never
      // start nose to tail and hold each other at a signal forever
      const shuffled = stations.slice().sort(() => Math.random() - 0.5);
      node = shuffled.find((n) => {
        const br = n.branches.find((b) => b.segment?.kind === 'main') || n.branches[0];
        return br?.segment ? !this.blocks.isOccupied(br.segment.id) : true;
      }) || shuffled[0];
    }
    if (!node) return null;
    const dests = stations.filter((s) => s.id !== node.id);
    if (!dests.length) return null;

    const AI_LOCOS = { gp7: 5, sd40: 3, funit: 1 };
    const locoKey = pickWeighted(Object.keys(AI_LOCOS), (k) => AI_LOCOS[k], Math.random);
    const spec = LOCOMOTIVES[locoKey] || LOCOMOTIVES.gp7;
    const id = `ai${this.trains.length + 1}_${Math.floor(Math.random() * 1e4)}`;
    const train = new TrainController(this.net, {
      id, isPlayer: false, weather: () => this.weather.id || 'clear', bus,
    });
    const loco = this.stock.loco(locoKey, { number: 100 + ((Math.random() * 800) | 0) });
    loco.build(this.assets);
    if (loco.group) this.group.add(loco.group);
    train.couple(loco);

    const cars = opts.cars ?? 1 + ((Math.random() * 3) | 0);
    const freightKeys = Object.keys(CAR_TYPES).filter((k) => CAR_TYPES[k].freight);
    for (let i = 0; i < cars; i++) {
      const key = freightKeys[(Math.random() * freightKeys.length) | 0];
      const v = this.stock.car(key, {});
      v.build(this.assets);
      if (v.group) this.group.add(v.group);
      train.couple(v);
    }

    const driver = new AIDriver(this.net, train, this.blocks, {});

    // Place it clear of the platform on a running line, nose pointed somewhere
    // the destination is actually reachable — a siding facing its buffer would
    // otherwise park the train there for good.
    const branchIdx = Math.max(0, node.branches.findIndex((b) => b.segment?.kind === 'main'));
    let state = this.net.stateAtNode(node.id, branchIdx, 90);
    let dest = dests[(Math.random() * dests.length) | 0];
    if (this.net.distanceToNode(state, dest.id, 40000) == null) {
      state = this.net.makeState(state.seg.id, state.u, -state.dir);
      if (this.net.distanceToNode(state, dest.id, 40000) == null) {
        const reachable = dests.find((d) => this.net.distanceToNode(state, d.id, 40000) != null);
        if (reachable) dest = reachable;
      }
    }
    train.setConsist(train.vehicles, state);
    train.placeCars();
    train.setReverser('f');
    driver.setDestination(dest.id);
    const entry = { train, driver, id, locoKey: spec.id, cars: train.vehicles.length };
    this.trains.push(entry);
    bus.emit('ai:spawn', { id, from: node.id, to: driver.dest });
    return entry;
  }

  setCount(n) {
    this.target = clamp(n | 0, 0, 8);
    while (this.trains.length > this.target) this.remove(this.trains[this.trains.length - 1]);
  }

  remove(entry) {
    const i = this.trains.indexOf(entry);
    if (i < 0) return;
    this.trains.splice(i, 1);
    for (const v of entry.train.vehicles) {
      if (v.group) v.group.removeFromParent();
      this.stock.remove(v);
    }
    entry.train.dispose();
  }

  update(dt, player) {
    if (!this.enabled) return;
    // keep the roster topped up, one at a time so nothing pops in a burst
    if (this.trains.length < this.target) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0) { this.spawnTrain(); this.spawnTimer = 12; }
    }

    for (const entry of [...this.trains]) {
      const { train, driver } = entry;
      // Trains nobody can see still have to keep moving, or the timetable on the
      // map freezes and the world stops feeling like a railway. Out of sight we
      // run them on a cheap cruise control instead of the full look-ahead brain.
      const verdict = this._nearPlayer(train, player)
        ? driver.update(dt)
        : this._cruise(entry, dt);
      train.step(dt);
      train.placeCars();
      if (verdict === 'reset') this._reset(entry);
      if (train.kmh < 0.4 && driver.mode !== 'dwell' && driver.stuck > 20) this._reset(entry);
    }
  }

  /**
   * Out-of-sight driving: hold the line speed, stop for a buffer, dwell at the
   * destination. No junction throwing, no signal look-ahead, no slip — the
   * player cannot see any of it, but the train still covers real kilometres on
   * the real graph, so it is where the map says it is when they arrive.
   */
  _cruise(entry, dt) {
    const { train, driver } = entry;
    if (!train.state || !driver.dest) return null;

    if (driver.mode === 'dwell') {
      driver.dwell -= dt;
      train.controls.throttle = 0;
      train.setBrake(0.8);
      if (driver.dwell <= 0) {
        train.handbrake(false);
        train.setBrake(0);
        driver.mode = 'run';
        driver.lastNodeSet = null;
        bus.emit('ai:depart', { train, station: driver.dest });
      }
      driver.reason = 'dwelling';
      return null;
    }

    // arrival check is a graph search, so only do it a couple of times a second
    driver._cruiseProbe = (driver._cruiseProbe || 0) - dt;
    if (driver._cruiseProbe <= 0) {
      driver._cruiseProbe = 0.5;
      const toDest = this.net.distanceToNode(train.state, driver.dest, 8000);
      if (toDest != null && toDest < 50) {
        driver.mode = 'dwell';
        driver.dwell = DWELL[0] + Math.random() * (DWELL[1] - DWELL[0]);
        train.controls.throttle = 0;
        train.setBrake(0.72);
        train.handbrake(true);
        bus.emit('ai:dwell', { train, station: driver.dest });
        return null;
      }
    }

    const target = Math.min((train.state.seg.speedLimit ?? 70) * 0.82 * driver.skill, 66);
    driver.targetKmh = target;
    driver.reason = 'running (out of sight)';
    const err = target - train.kmh;
    train.controls.reverser = 'f';
    if (err > 1) {
      train.setBrake(0);
      train.notch(clamp(Math.round(err / 5) + 1, 1, 8) - train.controls.throttle);
    } else if (err < -2) {
      train.notch(-train.controls.throttle);
      train.setBrake(clamp01(-err / 22));
    }

    // held up at a buffer or by a train that is itself out of sight: move it on
    if (train.kmh < 0.6) driver.held += dt; else driver.held = 0;
    if (driver.held > 70 || train.derail) {
      driver.held = 0;
      bus.emit('ai:stuck', { train, reason: train.derail?.reason || 'deadlock' });
      return 'reset';
    }
    return null;
  }

  /** Despawn-and-respawn somewhere sensible when an AI train gets into trouble. */
  _reset(entry) {
    const stations = this.openStations();
    if (!stations.length) return;
    const node = stations[(Math.random() * stations.length) | 0];
    const dests = stations.filter((s) => s.id !== node.id);
    // a running line, never a siding: branch 0 can face its own buffer stop
    const branchIdx = Math.max(0, node.branches.findIndex((b) => b.segment?.kind === 'main'));
    const state = this.net.stateAtNode(node.id, branchIdx, 120);
    entry.train.derail = null;
    entry.train.blocked = null;
    entry.train.speed = 0;
    entry.train.setConsist(entry.train.vehicles, state);
    entry.train.placeCars();
    entry.driver.lastNodeSet = null;
    entry.driver.setDestination(dests.length ? dests[(Math.random() * dests.length) | 0].id : node.id);
    bus.emit('ai:reset', { id: entry.id });
  }

  _nearPlayer(train, player, radius = 5200) {
    if (!player || !player.state || !train.state) return true;
    const a = this.net.positionOf(train.state, _v1);
    const b = this.net.positionOf(player.state, _v2);
    return a.distanceToSquared(b) < radius * radius;
  }

  /** Positions for the minimap and the timetable. */
  blips() {
    return this.trains.map((e) => {
      const p = e.train.state ? this.net.positionOf(e.train.state, _v1) : null;
      return {
        id: e.id, kind: 'ai', x: p?.x ?? 0, z: p?.z ?? 0,
        kmh: Math.round(e.train.kmh), dest: e.driver.dest, mode: e.driver.mode,
        heading: e.train.state?.dir ?? 1,
      };
    });
  }

  serialize() {
    return this.trains.map((e) => ({
      id: e.id,
      loco: e.locoKey,
      vehicles: e.train.vehicles.map((v) => v.toJSON()),
      seg: e.train.state?.seg.id, u: e.train.state?.u, dir: e.train.state?.dir,
      dest: e.driver.dest,
    }));
  }

  dispose() {
    for (const e of [...this.trains]) this.remove(e);
    this.group.removeFromParent();
  }
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();

export default AITrainManager;
