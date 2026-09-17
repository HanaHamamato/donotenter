/**
 * PassengerSystem — people, not tonnes (GDD §3.6 passenger running).
 *
 * Unlocked by the Express Driver milestone. Once it is, stations accumulate
 * passengers waiting, coaches can be boarded at the origin of a timed run, and
 * how the train is driven matters: an emergency application or a buffer-stop
 * kiss costs satisfaction, and satisfaction is written into the coach's
 * condition, which is exactly what the contract's condition bonus reads.
 */
import { clamp, clamp01 } from '../utils/math.js';
import { bus } from '../utils/events.js';

const WAIT_RATE = 3.4;      // passengers per work-hour per station
const WAIT_CAP = 220;

export class PassengerSystem {
  constructor(deps = {}) {
    this.stations = deps.stations;
    this.economy = deps.economy;
    this.unlocked = false;
    /** @type {Map<string, number>} station id → passengers waiting */
    this.waiting = new Map();
    for (const st of this.stations?.list || []) this.waiting.set(st.id, 20 + Math.random() * 60);
    this.riders = 0;
    this.delivered = 0;
    this.satisfaction = 100;
    this._train = null;
    this._unsubs = [];
  }

  setUnlocked(on) {
    this.unlocked = !!on;
    if (on) {
      this._unsubs.push(
        bus.on('train:emergency', (e) => this._rough(e.train, 22, 'Emergency brake — the passengers were thrown about.')),
        bus.on('train:buffer', (e) => this._rough(e.train, 10 + Math.min(24, e.speed * 6), 'A heavy stop at the buffers.')),
        bus.on('train:derail', (e) => this._rough(e.train, 55, 'Derailed with passengers aboard!')),
        bus.on('train:slip', () => this._slip()),
      );
      bus.emit('notify', { kind: 'good', title: 'Passenger service opened', text: 'Timed passenger runs are now posted at every station.', ttl: 9 });
    }
  }

  setTrain(train) { this._train = train; }

  waitingAt(stationId) { return this.unlocked ? Math.round(this.waiting.get(stationId) || 0) : 0; }

  /** Board a coach: how many seats got filled. */
  board(vehicle, stationId, seats = 64) {
    if (!this.unlocked || !vehicle.passenger) return 0;
    const have = this.waiting.get(stationId) || 0;
    const n = Math.min(seats, Math.floor(have));
    if (n <= 0) return 0;
    this.waiting.set(stationId, have - n);
    vehicle.riders = (vehicle.riders || 0) + n;
    vehicle.condition = 100;
    this.riders += n;
    bus.emit('passengers:boarded', { vehicle, station: stationId, count: n });
    bus.emit('notify', { kind: 'info', text: `${n} passengers boarded.` });
    return n;
  }

  /** Alight at the destination. */
  alight(vehicle, stationId) {
    if (!vehicle.passenger) return 0;
    const n = vehicle.riders || 0;
    vehicle.riders = 0;
    this.delivered += n;
    if (n > 0) bus.emit('passengers:alighted', { vehicle, station: stationId, count: n });
    return n;
  }

  _rough(train, penalty, message) {
    if (!train || train !== this._train) return;
    let hit = 0;
    for (const v of train.vehicles) {
      if (!v.passenger || !(v.riders > 0)) continue;
      v.damage(penalty);
      hit++;
    }
    if (!hit) return;
    this.satisfaction = clamp(this.satisfaction - penalty * 0.6, 0, 100);
    bus.emit('notify', { kind: 'bad', text: message });
  }

  _slip() {
    const t = this._train;
    if (!t) return;
    for (const v of t.vehicles) if (v.passenger && v.riders > 0) v.damage(0.6);
    this.satisfaction = clamp(this.satisfaction - 0.35, 0, 100);
  }

  /** Per-frame: waiting passengers accumulate, satisfaction recovers. */
  update(dt, workDt) {
    if (!this.unlocked) return;
    const hours = (workDt ?? 0) / 60;
    for (const st of this.stations?.list || []) {
      const w = (this.waiting.get(st.id) || 0) + WAIT_RATE * hours * (0.6 + st.rep * 0.16);
      this.waiting.set(st.id, clamp(w, 0, WAIT_CAP));
    }
    this.satisfaction = clamp(this.satisfaction + dt * 0.35, 0, 100);
    // gentle comfort cost for sustained harsh running
    const t = this._train;
    if (t && t.kmh > 4) {
      const rough = clamp01((t.jolt || 0) * 1.4 + (t.slip || 0) * 0.5);
      if (rough > 0.05) {
        for (const v of t.vehicles) if (v.passenger && v.riders > 0) v.damage(rough * dt * 1.6);
      }
    }
  }

  stats() {
    return {
      unlocked: this.unlocked,
      riders: this.riders,
      delivered: this.delivered,
      satisfaction: Math.round(this.satisfaction),
      waiting: [...this.waiting.entries()].map(([id, n]) => ({ id, waiting: Math.round(n) })),
    };
  }

  serialize() {
    return {
      unlocked: this.unlocked, riders: this.riders, delivered: this.delivered,
      satisfaction: this.satisfaction, waiting: [...this.waiting.entries()],
    };
  }

  restore(d) {
    if (!d) return;
    this.riders = d.riders || 0;
    this.delivered = d.delivered || 0;
    this.satisfaction = d.satisfaction ?? 100;
    this.waiting = new Map(d.waiting || []);
    if (d.unlocked && !this.unlocked) this.setUnlocked(true);
  }

  dispose() { for (const off of this._unsubs) off(); this._unsubs = []; }
}

export default PassengerSystem;
