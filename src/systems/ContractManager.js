/**
 * ContractManager — the work (GDD §3.2 contract system).
 *
 * A contract is a promise: move N cars of cargo X from station A to station B
 * before the clock runs out. Offers are posted on the board at their origin
 * station, priced from the rail distance between the two, the number of cars,
 * whether the cargo is fragile, and how badly the destination wants it.
 *
 * Taking a contract loads your cars from the station's stock on the spot;
 * delivering them pays out, with a bonus for time in hand and for arriving with
 * the cargo in good condition. Miss the deadline and the contract fails, the
 * station's opinion of you drops, and the cars are still yours to deal with.
 */
import { ECONOMY, CARGO } from '../constants.js';
import { clamp, formatMoney } from '../utils/math.js';
import { bus } from '../utils/events.js';

let seq = 1;
const uid = () => `ct${(seq++).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

export class ContractManager {
  /**
   * @param {object} deps {net, stations: StationManager, economy: EconomyManager}
   */
  constructor(deps = {}) {
    this.net = deps.net;
    this.stations = deps.stations;
    this.economy = deps.economy;
    /** @type {Map<string, object[]>} station id → open offers */
    this.boards = new Map();
    /** @type {object[]} accepted contracts */
    this.active = [];
    this.done = [];
    this.failed = [];
    this.rollTimer = 0;
    this.passengersUnlocked = false;
    this.maxPerStation = ECONOMY.maxContractsPerStation;
    this.minPerStation = ECONOMY.minContractsPerStation;
    for (const st of this.stations?.list || []) this.boards.set(st.id, []);
  }

  /* ------------------------------------------------------------- generation */
  /** Minutes of work time a haul of `km` kilometres should take, with slack. */
  static deadlineFor(km, kind = 'freight') {
    const runHours = km / (kind === 'passenger' ? 62 : 38);
    const slack = kind === 'passenger' ? 0.55 : 1.35;
    return Math.round((runHours * 60 * (1 + slack)) + 35);
  }

  /** Base pay before bonuses (GDD §3.2 rates). */
  static basePay(km, cars, cargo) {
    const spec = CARGO[cargo] || {};
    let pay = km * ECONOMY.payPerKm + cars * ECONOMY.payPerCar;
    if (spec.fragile) pay *= ECONOMY.fragilePremium;
    if (spec.passenger) pay *= 1.25;
    return Math.round(pay / 5) * 5;
  }

  /**
   * Fill a station's board up to the minimum. Pass the player's `train` and the
   * board is guaranteed to carry at least one job the consist can actually run —
   * a board full of work you cannot haul is a dead end for the core loop.
   */
  rollFor(stationId, train = null) {
    const st = this.stations.get(stationId);
    if (!st) return [];
    const board = this.boards.get(stationId) || [];
    const open = () => this.stations.list.filter((s) =>
      s.id !== st.id && this.net.isOpen(s.node?.branches?.[0]?.segment) && this.net.isOpen(st.node?.branches?.[0]?.segment));
    const candidates = open();
    if (!candidates.length) return board;

    let guard = 0;
    while (board.length < this.minPerStation && guard++ < 12) {
      const c = this._makeOffer(st, candidates);
      if (c) board.push(c);
    }
    if (train) this._ensureRunnable(st, candidates, board, train);
    this.boards.set(stationId, board);
    return board;
  }

  /** Post work that fits the empty cars standing in `train`, if none is up. */
  _ensureRunnable(st, candidates, board, train) {
    const empties = new Map();
    for (const v of train.vehicles || []) {
      if (v.cargo) continue;
      empties.set(v.typeKey, (empties.get(v.typeKey) || 0) + 1);
    }
    if (!empties.size) return;
    const fits = (c) => (empties.get(c.carType) || 0) >= c.cars;
    if (board.some(fits)) return;
    for (const [carType, n] of empties) {
      for (let i = 0; i < 8 && board.length < this.maxPerStation + 2; i++) {
        const c = this._makeOffer(st, candidates, { carType, maxCars: n });
        if (c && fits(c)) { board.push(c); return; }
      }
    }
  }

  /**
   * @param {object|null} want  optional {carType, maxCars} to force an offer the
   *   given consist could haul (used by _ensureRunnable).
   */
  _makeOffer(st, candidates, want = null) {
    const passenger = !want && this.passengersUnlocked && Math.random() < 0.22;
    let cargo;
    let dest;
    if (passenger) {
      cargo = 'passengers';
      dest = candidates[(Math.random() * candidates.length) | 0];
    } else {
      let produces = st.produces.filter((c) => (st.stock[c] || 0) > 12);
      if (want?.carType) {
        produces = produces.filter((c) => (CARGO[c]?.car || 'boxcar') === want.carType);
      }
      if (!produces.length) return null;
      // Prefer work the yard can actually be loaded for: if a boxcar is standing
      // in the siding, post boxcar cargo. Otherwise the board advertises runs
      // nobody here could ever consist.
      if (st.yardCars?.size) {
        const matched = produces.filter((c) => st.yardCars.has(CARGO[c]?.car));
        if (matched.length) produces = matched;
      }
      // prefer cargo somebody actually wants
      const weighted = [];
      for (const c of produces) {
        for (const d of candidates) {
          if (d.consumes.includes(c)) weighted.push([`${c}|${d.id}`, 5]);
          else weighted.push([`${c}|${d.id}`, 1]);
        }
      }
      if (!weighted.length) return null;
      let total = weighted.reduce((a, r) => a + r[1], 0);
      let r = Math.random() * total;
      let pick = weighted[0][0];
      for (const [key, w] of weighted) { r -= w; if (r <= 0) { pick = key; break; } }
      const [c, destId] = pick.split('|');
      cargo = c;
      dest = this.stations.get(destId);
    }
    if (!dest) return null;

    const metres = this.stations.railDistance(st.id, dest.id);
    if (metres == null || metres < 400) return null;
    const km = metres / 1000;
    const spec = CARGO[cargo];
    const carType = passenger ? 'coach' : spec?.car || 'boxcar';
    // Size the job to what the yard can actually hand over: a contract for more
    // tonnage than exists could never be loaded, so it could never be finished.
    const stock = passenger ? Infinity : (st.stock[cargo] || 0);
    let cars = clamp(1 + Math.floor(Math.random() * (km > 22 ? 4 : 3)), 1, 5);
    if (!passenger) cars = clamp(Math.min(cars, Math.floor(stock / 22)), 1, 5);
    if (want?.maxCars) cars = clamp(Math.min(cars, want.maxCars), 1, 5);
    const perCar = passenger ? 14 : 26 + Math.random() * 26;
    const tons = Math.round(Math.min(stock, cars * perCar));
    if (tons < 4) return null;
    const issued = this.economy?.workMinutes ?? 0;
    const deadline = issued + ContractManager.deadlineFor(km, passenger ? 'passenger' : 'freight');
    const wanted = dest.consumes.includes(cargo) || passenger;
    const pay = Math.round(ContractManager.basePay(km, cars, cargo) * (wanted ? 1 : 0.72));

    return {
      id: uid(),
      kind: passenger ? 'passenger' : 'freight',
      origin: st.id, originName: st.name,
      dest: dest.id, destName: dest.name,
      cargo, cargoLabel: spec?.label || cargo, carType,
      cars, tons, km: Math.round(km * 10) / 10,
      pay, wanted,
      issued, deadline, expires: issued + ContractManager.deadlineFor(km) * 2.2,
      fragile: !!spec?.fragile,
      status: 'open',
      deliveredCars: 0, deliveredTons: 0,
    };
  }

  /** Offers posted at a station, refreshed on demand. */
  board(stationId) {
    if (!this.boards.has(stationId)) this.boards.set(stationId, []);
    return this.boards.get(stationId);
  }

  accept(contractId, opts = {}) {
    const stationId = opts.stationId;
    const train = opts.train;
    const board = this.boards.get(stationId) || [];
    const i = board.findIndex((c) => c.id === contractId);
    if (i < 0) {
      bus.emit('notify', { kind: 'warn', text: 'That contract is no longer on the board.' });
      return null;
    }
    const c = board[i];
    if (stationId !== c.origin) return null;
    board.splice(i, 1);
    c.status = 'active';
    c.accepted = this.economy?.workMinutes ?? 0;
    c.deliveredCars = 0;
    c.deliveredTons = 0;
    this.active.push(c);
    bus.emit('contract:accepted', { contract: c });
    bus.emit('notify', { kind: 'info', text: `Contract: ${c.tons} t of ${c.cargoLabel} to ${c.destName} — ${formatMoney(c.pay)}.` });

    // load whatever compatible empties are in the consist right now
    const loaded = train ? this.loadTrain(train, this.stations.get(c.origin), c) : { tons: 0, cars: 0 };
    if (loaded.cars === 0) {
      bus.emit('notify', { kind: 'warn', text: `You need ${c.cars} × ${CARGO[c.cargo]?.label || c.cargo} car (${c.carType}) to run this.` });
    }
    return c;
  }

  decline(contractId, stationId) {
    const board = this.boards.get(stationId) || [];
    const i = board.findIndex((c) => c.id === contractId);
    if (i >= 0) board.splice(i, 1);
  }

  /** Fill compatible cars from a station's stock for a contract (or any contract from here). */
  loadTrain(train, st, only = null) {
    if (!train || !st) return { tons: 0, cars: 0 };
    let tons = 0;
    let cars = 0;
    const contracts = (only ? [only] : this.active.filter((c) => c.origin === st.id && c.deliveredCars < c.cars));
    for (const c of contracts) {
      c.loadedCars ||= [];
      for (const v of train.vehicles) {
        if (c.loadedCars.length >= c.cars) break;
        if (c.loadedCars.includes(v.id)) continue;
        if (v.cargo && v.contractId === c.id) { c.loadedCars.push(v.id); continue; }
        if (v.cargo) continue;
        const want = Math.ceil(c.tons / c.cars);
        const got = this.stations.loadVehicle(v, st, c.cargo, want, c.id);
        if (got > 0) {
          c.loadedCars.push(v.id);
          tons += got; cars++;
          bus.emit('contract:loaded', { contract: c, vehicle: v, tons: got });
        }
      }
    }
    if (tons > 0) bus.emit('notify', { kind: 'info', text: `Loaded ${Math.round(tons)} t into ${cars} car${cars > 1 ? 's' : ''}.` });
    return { tons, cars };
  }

  /**
   * Contract payment for a single car being unloaded — handed to
   * StationManager.unload as its contract check.
   */
  contractPayFor(vehicle, st, tons) {
    if (!vehicle.contractId) return 0;
    const c = this.active.find((x) => x.id === vehicle.contractId);
    if (!c || c.dest !== st.id) return 0;
    const share = clamp(tons / Math.max(1, c.tons / c.cars), 0, 1);
    const pay = c.pay * (share / c.cars) * 1.0;
    c.deliveredCars++;
    c.deliveredTons += tons;
    return pay;
  }

  /**
   * Settle a train's arrival at `stationId`. Returns the money and the notes.
   */
  deliver(train, stationId) {
    const st = this.stations.get(stationId);
    if (!st || !train) return null;
    const result = this.stations.unload(train, st, (v, s, tons) => this.contractPayFor(v, s, tons));
    let pay = result.pay;
    const completed = [];
    const partial = [];

    for (const c of [...this.active]) {
      if (c.dest !== stationId) continue;
      const minutesLeft = (c.deadline ?? 0) - (this.economy?.workMinutes ?? 0);
      const done = c.deliveredCars >= c.cars;
      if (!done && c.deliveredCars > 0) { partial.push(c); continue; }
      if (!done) continue;
      // time bonus: up to timeBonusFactor of the base pay for arriving early
      const timeBonus = minutesLeft > 0 ? Math.round(c.pay * ECONOMY.timeBonusFactor * clamp(minutesLeft / Math.max(30, c.deadline - c.issued), 0, 1)) : 0;
      // condition bonus: fragile cargo that arrived intact
      const cond = this._conditionOf(train, c);
      const condBonus = c.fragile ? Math.round(c.pay * ECONOMY.conditionBonusFactor * (cond / 100)) : 0;
      pay += timeBonus + condBonus;
      c.status = 'done';
      c.paid = c.pay + timeBonus + condBonus;
      c.timeBonus = timeBonus;
      c.condBonus = condBonus;
      completed.push(c);
      this.active.splice(this.active.indexOf(c), 1);
      this.done.push(c);
      if (this.economy) {
        this.economy.deliveries++;
        if (timeBonus > 0) this.economy.timedBonuses++;
      }
      this.stations.addRep(st, c.kind === 'passenger' ? 0.55 : 0.42 + (timeBonus > 0 ? 0.18 : 0));
      bus.emit('contract:complete', { contract: c, pay: c.paid, timeBonus, condBonus, station: st });
    }

    if (pay > 0 && this.economy) this.economy.add(Math.round(pay), 'delivery');
    for (const c of partial) {
      bus.emit('notify', { kind: 'info', text: `${c.deliveredCars}/${c.cars} cars of ${c.cargoLabel} delivered — ${c.cars - c.deliveredCars} still at ${c.originName}.` });
    }
    if (result.ignored.length) {
      bus.emit('notify', { kind: 'warn', text: `${st.name} has no market for ${[...new Set(result.ignored.map((r) => r.cargo))].map((c) => CARGO[c]?.label || c).join(', ')} — sold at a discount.` });
    }
    return { pay: Math.round(pay), completed, partial, ignored: result.ignored, accepted: result.accepted };
  }

  /** True when at least one open offer matches empty cars in `train`. */
  _canRunAny(board, train) {
    const empties = new Map();
    for (const v of train.vehicles || []) {
      if (v.cargo) continue;
      empties.set(v.typeKey, (empties.get(v.typeKey) || 0) + 1);
    }
    return board.some((c) => (empties.get(c.carType) || 0) >= c.cars);
  }

  _conditionOf(train, c) {
    let sum = 0;
    let n = 0;
    for (const v of train.vehicles) if (v.contractId === c.id) { sum += v.condition; n++; }
    return n ? sum / n : 100;
  }

  /** Per-frame: expire offers, fail overdue contracts, top up boards. */
  update(dt, playerStationId, train = null) {
    const now = this.economy?.workMinutes ?? 0;
    this.rollTimer -= dt;

    // fail overdue work
    for (const c of [...this.active]) {
      if (now > c.deadline) {
        c.status = 'failed';
        this.active.splice(this.active.indexOf(c), 1);
        this.failed.push(c);
        const st = this.stations.get(c.dest);
        if (st) this.stations.addRep(st, -0.6);
        const penalty = Math.round(c.pay * 0.18);
        if (this.economy) this.economy.spend(penalty, 'contract penalty');
        bus.emit('contract:failed', { contract: c, penalty });
        bus.emit('notify', { kind: 'bad', text: `Contract to ${c.destName} expired. ${formatMoney(penalty)} penalty.` });
      }
    }

    // expire stale offers
    for (const [sid, board] of this.boards) {
      for (let i = board.length - 1; i >= 0; i--) {
        if (now > board[i].expires) board.splice(i, 1);
      }
    }

    // roll new work on the interval, and always when the player pulls in
    if (this.rollTimer <= 0) {
      this.rollTimer = 24;
      for (const st of this.stations.list) {
        const b = this.boards.get(st.id) || [];
        if (b.length < this.maxPerStation && Math.random() < 0.55) this.rollFor(st.id);
      }
    }
    if (playerStationId) {
      const b = this.boards.get(playerStationId) || [];
      // top up whenever the board is thin or nothing on it can be run
      if (b.length < this.minPerStation || (train && !this._canRunAny(b, train))) {
        this.rollFor(playerStationId, train);
      }
    }
  }

  /** Everything the HUD needs about the current load. */
  summary() {
    return this.active.map((c) => {
      const now = this.economy?.workMinutes ?? 0;
      const left = c.deadline - now;
      return {
        ...c,
        minutesLeft: Math.round(left),
        late: left < 0,
        urgent: left > 0 && left < 45,
        progress: c.cars ? c.deliveredCars / c.cars : 0,
      };
    });
  }

  setPassengers(on) { this.passengersUnlocked = !!on; }

  serialize() {
    return {
      seq,
      boards: [...this.boards.entries()].map(([k, v]) => [k, v]),
      active: this.active, done: this.done.slice(-30), failed: this.failed.slice(-30),
      passengers: this.passengersUnlocked,
    };
  }

  restore(d) {
    if (!d) return;
    seq = d.seq || seq;
    this.boards = new Map(d.boards || []);
    for (const st of this.stations?.list || []) if (!this.boards.has(st.id)) this.boards.set(st.id, []);
    this.active = d.active || [];
    this.done = d.done || [];
    this.failed = d.failed || [];
    this.passengersUnlocked = !!d.passengers;
  }
}

export default ContractManager;
