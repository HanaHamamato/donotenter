/**
 * StationManager — the twelve stations as living places (GDD §3.1, §3.3).
 *
 * Each station keeps its own reputation (0–5), a stockpile of whatever it
 * produces, a record of what it has been sent, and which of its sidings are
 * occupied. Stock rebuilds on the work clock, so a mill that has been shipped
 * nothing for a day has a full yard to load from, and one you have stripped
 * bare needs a few hours.
 *
 * Deliveries are judged here: cargo a station actually consumes pays full value
 * and earns reputation; cargo it has no use for still sells, but at a discount
 * and without the goodwill.
 */
import * as THREE from 'three';
import { CARGO, ECONOMY } from '../constants.js';
import { clamp, clamp01 } from '../utils/math.js';
import { bus } from '../utils/events.js';

const STOCK_CAP_BASE = 90;
const REP_MAX = 5;

export class StationManager {
  /**
   * @param {import('./TrackNetwork.js').TrackNetwork} net
   * @param {object[]} stationDefs from assets/data/stations.json
   */
  constructor(net, stationDefs = [], opts = {}) {
    this.net = net;
    this.economy = opts.economy || null;
    /** @type {Map<string, object>} */
    this.byId = new Map();
    this.list = [];

    for (const def of stationDefs) {
      const node = net.nodeById(def.node);
      const st = {
        def,
        id: def.id,
        name: def.name,
        region: def.region || def.biome || 'plains',
        type: def.type,
        produces: def.produces || [],
        consumes: def.consumes || [],
        node,
        pos: node ? node.position.clone() : new THREE.Vector3(),
        rep: 0,
        stock: {},
        demand: {},
        delivered: {},
        received: 0,
        visits: 0,
        sidings: (def.sidings || []).map((s) => ({ ...s, occupied: 0 })),
        restockTimer: 0,
        lastVisit: -1e9,
      };
      for (const c of st.produces) {
        st.stock[c] = STOCK_CAP_BASE * 0.6;
        st.demand[c] = 1;
      }
      for (const c of st.consumes) st.demand[c] = 1;
      this.byId.set(st.id, st);
      this.list.push(st);
    }
    this._nearestCache = { x: 0, z: 0, at: -1e9, result: null };
  }

  get(id) { return this.byId.get(id) || null; }
  all() { return this.list; }

  /** Stock capacity grows with reputation — a trusted station works harder. */
  cap(st, cargo) {
    return STOCK_CAP_BASE + st.rep * 34 + (st.produces.includes(cargo) ? 40 : 0);
  }

  /** Tons per work-hour a station produces. */
  rate(st, cargo) {
    const base = st.type === 'Port' || st.type === 'Mine' ? 9 : st.type === 'Junction' ? 7 : 5.5;
    return base * (0.7 + st.rep * 0.14) * (st.demand[cargo] ?? 1);
  }

  /** Buy/sell price index for a cargo at a station (1.0 = list value). */
  price(st, cargo) {
    const spec = CARGO[cargo];
    if (!spec) return 1;
    const wanted = st.consumes.includes(cargo) ? 1.18 : st.produces.includes(cargo) ? 0.82 : 0.62;
    const stock = st.stock[cargo] || 0;
    const cap = this.cap(st, cargo);
    const scarcity = 1 - clamp01(stock / cap) * 0.35;
    return wanted * scarcity * (0.9 + st.rep * 0.05);
  }

  /** Pay per ton for delivering `cargo` here, in credits. */
  valuePerTon(st, cargo) {
    const spec = CARGO[cargo];
    if (!spec) return 0;
    return spec.unitValue * 0.021 * this.price(st, cargo) * (spec.fragile ? ECONOMY.fragilePremium : 1);
  }

  /** Which station (if any) a train is standing at. */
  at(train, radius = 170, maxKmh = 6) {
    if (!train || train.empty || !train.state) return null;
    const p = this.net.positionOf(train.state, _v);
    let best = null;
    let bestD = radius;
    for (const st of this.list) {
      if (!st.node) continue;
      const d = Math.hypot(p.x - st.pos.x, p.z - st.pos.z);
      if (d < bestD) { bestD = d; best = { station: st, distance: d }; }
    }
    if (!best) return null;
    if (train.kmh > maxKmh) return { ...best, passing: true };
    return best;
  }

  nearest(x, z) {
    let best = null;
    let bestD = Infinity;
    for (const st of this.list) {
      const d = Math.hypot(x - st.pos.x, z - st.pos.z);
      if (d < bestD) { bestD = d; best = st; }
    }
    return best ? { station: best, distance: bestD } : null;
  }

  /** Distance in metres along the rails between two station nodes. */
  railDistance(aId, bId) {
    const key = aId < bId ? `${aId}|${bId}` : `${bId}|${aId}`;
    this._distCache ||= new Map();
    if (this._distCache.has(key)) return this._distCache.get(key);
    const d = StationManager.dijkstra(this.net, aId, bId);
    this._distCache.set(key, d);
    return d;
  }

  static dijkstra(net, aId, bId) {
    if (aId === bId) return 0;
    const dist = new Map([[aId, 0]]);
    const pq = [[0, aId]];
    const done = new Set();
    let guard = 0;
    while (pq.length && guard++ < 8192) {
      pq.sort((x, y) => x[0] - y[0]);
      const [d, id] = pq.shift();
      if (id === bId) return d;
      if (done.has(id)) continue;
      done.add(id);
      const node = net.nodeById(id);
      if (!node) continue;
      for (const br of node.branches) {
        const seg = br.segment;
        if (!seg) continue;
        const other = seg.a === id ? seg.b : seg.a;
        const nd = d + seg.length;
        if (!dist.has(other) || nd < dist.get(other)) {
          dist.set(other, nd);
          pq.push([nd, other]);
        }
      }
    }
    return dist.get(bId) ?? null;
  }

  /* ------------------------------------------------------------- simulation */
  /** @param {number} workDt game-minutes elapsed */
  tickWork(workDt, stationsOpen = true) {
    if (!stationsOpen) return;
    const hours = workDt / 60;
    for (const st of this.list) {
      for (const c of st.produces) {
        const cap = this.cap(st, c);
        st.stock[c] = clamp((st.stock[c] || 0) + this.rate(st, c) * hours, 0, cap);
      }
      // demand drifts back toward 1
      for (const c of Object.keys(st.demand)) st.demand[c] = clamp(st.demand[c] + (1 - st.demand[c]) * hours * 0.05, 0.55, 1.6);
    }
  }

  /** Per-real-frame: arrival notices, siding occupancy, atmosphere. */
  update(dt, player, rollingstock) {
    const workDt = (dt / 60) * (this.economy?.timeScale ?? ECONOMY.timeScale);
    this.tickWork(workDt);

    if (rollingstock) {
      for (const st of this.list) {
        let occupied = 0;
        for (const v of rollingstock.loose) {
          if (!v.state) continue;
          const p = this.net.positionOf(v.state, _v2);
          if (Math.hypot(p.x - st.pos.x, p.z - st.pos.z) < 260) occupied++;
        }
        st.parked = occupied;
      }
    }

    // arrival / departure notices for the player
    const at = player ? this.at(player) : null;
    const now = performance.now() / 1000;
    if (at && !at.passing) {
      const st = at.station;
      if (this._atId !== st.id) {
        this._atId = st.id;
        st.visits++;
        st.lastVisit = this.economy?.workMinutes ?? 0;
        bus.emit('station:arrive', { station: st, def: st.def, distance: at.distance });
      }
    } else if (!at && this._atId) {
      const st = this.byId.get(this._atId);
      this._atId = null;
      if (st) bus.emit('station:depart', { station: st });
    }
    this.current = at && !at.passing ? at.station : null;
    this._now = now;
  }

  /* --------------------------------------------------------------- commerce */
  addRep(st, amount) {
    const before = st.rep;
    st.rep = clamp(st.rep + amount, 0, REP_MAX);
    if (Math.floor(st.rep) > Math.floor(before)) {
      bus.emit('station:rep', { station: st, rep: st.rep });
      bus.emit('notify', { kind: 'good', text: `Reputation at ${st.name} is now ${Math.floor(st.rep)}.` });
    }
    return st.rep;
  }

  /**
   * Sell everything in the consist that this station will take.
   * @returns {{accepted:object[], ignored:object[], pay:number, repDelta:number}}
   */
  unload(train, st, contractCheck = null) {
    const accepted = [];
    const ignored = [];
    let pay = 0;
    for (const v of train.vehicles) {
      if (!v.cargo || v.tons <= 0) continue;
      const cargo = v.cargo;
      const wanted = st.consumes.includes(cargo);
      const tons = v.tons;
      const perTon = this.valuePerTon(st, cargo);
      const carPay = perTon * tons * (wanted ? 1 : 0.45);
      const contractPay = contractCheck ? contractCheck(v, st, tons) : 0;
      const entry = { vehicle: v, cargo, tons, wanted, pay: carPay + contractPay, contractPay };
      if (wanted || contractPay > 0) accepted.push(entry); else ignored.push(entry);
      pay += carPay + contractPay;
      st.delivered[cargo] = (st.delivered[cargo] || 0) + tons;
      st.received += tons;
      v.clearLoad();
    }
    const repDelta = accepted.length ? 0 : 0;
    return { accepted, ignored, pay, repDelta };
  }

  /**
   * Load one vehicle from the station's stock.
   * @returns {number} tons actually loaded
   */
  loadVehicle(vehicle, st, cargoKey, wantTons, contractId = null) {
    if (!vehicle.freight && !vehicle.passenger) return 0;
    if (vehicle.cargo && vehicle.cargo !== cargoKey) return 0;
    const spec = CARGO[cargoKey];
    if (!spec) return 0;
    const carType = spec.car;
    if (vehicle.typeKey !== carType && !(carType === 'coach' && vehicle.passenger)) return 0;
    const available = st.produces.includes(cargoKey) ? (st.stock[cargoKey] || 0) : this.cap(st, cargoKey) * 0.5;
    const capacity = (vehicle.capacity || (vehicle.massFull - vehicle.massEmpty)) / 1000; // tonnes
    const space = Math.max(0, capacity - vehicle.tons);
    const tons = clamp(Math.min(wantTons, available, space), 0, space);
    if (tons <= 0.05) return 0;
    if (st.produces.includes(cargoKey)) {
      st.stock[cargoKey] = Math.max(0, (st.stock[cargoKey] || 0) - tons);
      st.demand[cargoKey] = clamp((st.demand[cargoKey] ?? 1) + tons / 260, 0.55, 1.6);
    }
    vehicle.setLoad(cargoKey, vehicle.tons + tons, st.id, contractId);
    return tons;
  }

  /** Which cargos this station can load right now, and how much of each. */
  offers(st) {
    return st.produces.map((c) => ({
      cargo: c,
      label: CARGO[c]?.label || c,
      car: CARGO[c]?.car || 'boxcar',
      tons: Math.round(st.stock[c] || 0),
      perTon: Math.round(this.valuePerTon(st, c) * 100) / 100,
      fragile: !!CARGO[c]?.fragile,
    })).filter((o) => o.tons > 0.5);
  }

  /** What this station wants, for the contract board and the station panel. */
  wants(st) {
    return st.consumes.map((c) => ({
      cargo: c, label: CARGO[c]?.label || c,
      price: Math.round(this.price(st, c) * 100) / 100,
      received: Math.round(st.delivered[c] || 0),
    }));
  }

  reputationTable() {
    return this.list.map((st) => ({ id: st.id, name: st.name, rep: st.rep, region: st.region }));
  }

  serialize() {
    return this.list.map((st) => ({
      id: st.id, rep: st.rep, stock: { ...st.stock }, demand: { ...st.demand },
      delivered: { ...st.delivered }, received: st.received, visits: st.visits,
    }));
  }

  restore(list) {
    for (const d of list || []) {
      const st = this.byId.get(d.id);
      if (!st) continue;
      st.rep = d.rep ?? 0;
      st.stock = { ...st.stock, ...(d.stock || {}) };
      st.demand = { ...st.demand, ...(d.demand || {}) };
      st.delivered = d.delivered || {};
      st.received = d.received || 0;
      st.visits = d.visits || 0;
    }
  }
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

export default StationManager;
