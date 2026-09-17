/**
 * EconomyManager — money and the working clock (GDD §3 economy, §4.1 time).
 *
 * Two clocks run at once and they are deliberately different:
 *
 *   day/night  20 real minutes per day, owned by DayNightCycle — purely visual
 *   work time  ECONOMY.timeScale game-minutes per real minute — this is what
 *              contract deadlines, station restocking and wages are measured in
 *
 * Every credit that moves goes through `add()`/`spend()` so the ledger, the HUD
 * and the save file all agree.
 */
import { ECONOMY } from '../constants.js';
import { formatMoney } from '../utils/math.js';
import { bus } from '../utils/events.js';

export class EconomyManager {
  constructor(opts = {}) {
    this.credits = opts.credits ?? ECONOMY.startCredits;
    this.earned = opts.earned ?? 0;
    this.spent = opts.spent ?? 0;
    this.workMinutes = opts.workMinutes ?? 8 * 60;   // the shift starts at 08:00
    this.timeScale = opts.timeScale ?? ECONOMY.timeScale;
    this.paused = false;
    /** @type {{at:number, amount:number, reason:string}[]} */
    this.ledger = opts.ledger || [];
    this.deliveries = opts.deliveries ?? 0;
    this.timedBonuses = opts.timedBonuses ?? 0;
  }

  /** @param {number} dt real seconds */
  tick(dt) {
    if (this.paused) return;
    this.workMinutes += (dt / 60) * this.timeScale;
  }

  get day() { return Math.floor(this.workMinutes / (24 * 60)) + 1; }
  get hour() { return Math.floor(this.workMinutes / 60) % 24; }
  get minute() { return Math.floor(this.workMinutes) % 60; }

  /** "Day 3 — 14:20" */
  stamp() {
    const h = String(this.hour).padStart(2, '0');
    const m = String(this.minute).padStart(2, '0');
    return `Day ${this.day} · ${h}:${m}`;
  }

  get money() { return formatMoney(this.credits); }

  add(amount, reason = 'income') {
    if (amount <= 0) return false;
    this.credits += amount;
    this.earned += amount;
    this._log(amount, reason);
    bus.emit('economy:change', { credits: this.credits, delta: amount, reason });
    return true;
  }

  spend(amount, reason = 'purchase') {
    if (amount < 0) return false;
    if (this.credits < amount) {
      bus.emit('notify', { kind: 'warn', text: `Not enough credits — ${formatMoney(amount)} needed.` });
      bus.emit('economy:denied', { amount, reason });
      return false;
    }
    this.credits -= amount;
    this.spent += amount;
    this._log(-amount, reason);
    bus.emit('economy:change', { credits: this.credits, delta: -amount, reason });
    return true;
  }

  canAfford(amount) { return this.credits >= amount; }

  _log(amount, reason) {
    this.ledger.push({ at: Math.floor(this.workMinutes), amount: Math.round(amount), reason });
    if (this.ledger.length > 120) this.ledger.shift();
  }

  /** Stats object the milestone checks read (GDD §3.4). */
  stats(rep = {}) {
    return {
      deliveries: this.deliveries,
      earned: Math.round(this.earned),
      credits: Math.round(this.credits),
      timedBonuses: this.timedBonuses,
      rep,
      repStations: Object.values(rep).filter((v) => v >= 1).length,
    };
  }

  serialize() {
    return {
      credits: this.credits, earned: this.earned, spent: this.spent,
      workMinutes: this.workMinutes, timeScale: this.timeScale,
      ledger: this.ledger.slice(-40), deliveries: this.deliveries,
      timedBonuses: this.timedBonuses,
    };
  }

  restore(d) {
    if (!d) return;
    Object.assign(this, {
      credits: d.credits ?? this.credits, earned: d.earned ?? 0, spent: d.spent ?? 0,
      workMinutes: d.workMinutes ?? this.workMinutes, timeScale: d.timeScale ?? this.timeScale,
      deliveries: d.deliveries ?? 0, timedBonuses: d.timedBonuses ?? 0,
    });
    this.ledger = d.ledger || [];
  }
}

export default EconomyManager;
