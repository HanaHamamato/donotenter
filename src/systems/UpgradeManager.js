/**
 * UpgradeManager — the three shop lines (GDD §3.5 upgrades).
 *
 * Brake rigging, engine tuning and coupler capacity, three tiers each, bought
 * at any station with credits. Levels are handed straight to TrainController,
 * which already applies them in its force calculations, so buying a tier is
 * immediately felt in how the train stops, pulls and how long it can be.
 */
import { UPGRADES } from '../constants.js';
import { formatMoney } from '../utils/math.js';
import { bus } from '../utils/events.js';

export class UpgradeManager {
  constructor(deps = {}) {
    this.economy = deps.economy;
    this.levels = { brakes: 0, engine: 0, capacity: 0, ...(deps.levels || {}) };
    this.train = deps.train || null;
    this._push();
  }

  setTrain(train) { this.train = train; this._push(); }

  _push() {
    if (!this.train) return;
    this.train.upgrades = { ...this.levels };
    this.train._recompute?.();
  }

  spec(id) { return UPGRADES[id] || null; }
  level(id) { return this.levels[id] || 0; }
  maxed(id) { return this.level(id) >= (UPGRADES[id]?.max ?? 0); }
  cost(id) {
    const s = UPGRADES[id];
    if (!s || this.maxed(id)) return null;
    return s.costs[this.level(id)] ?? null;
  }
  canBuy(id) {
    const c = this.cost(id);
    return c != null && (this.economy?.canAfford(c) ?? false);
  }

  buy(id) {
    const cost = this.cost(id);
    if (cost == null) {
      bus.emit('notify', { kind: 'warn', text: `${UPGRADES[id]?.label || id} is already at its highest tier.` });
      return false;
    }
    if (!this.economy?.spend(cost, `upgrade:${id}`)) return false;
    this.levels[id] = this.level(id) + 1;
    this._push();
    const s = UPGRADES[id];
    bus.emit('upgrade:bought', { id, level: this.levels[id], cost });
    bus.emit('notify', { kind: 'good', text: `${s.label} → tier ${this.levels[id]}. ${s.desc[this.levels[id] - 1] || ''}` });
    return true;
  }

  /** Effective multipliers, for the HUD's tech panel. */
  modifiers() {
    return {
      brakeTimeDiv: 1 + 0.25 * this.levels.brakes,
      brakeForceMul: 1 + 0.08 * this.levels.brakes,
      teMul: 1 + 0.15 * this.levels.engine,
      extraCars: this.levels.capacity,
    };
  }

  /** Shop listing for the UI. */
  table() {
    return Object.entries(UPGRADES).map(([id, s]) => ({
      id, label: s.label, max: s.max, level: this.level(id),
      cost: this.cost(id), desc: s.desc[this.level(id)] || s.desc[s.desc.length - 1],
      affordable: this.canBuy(id), maxed: this.maxed(id),
      tiers: s.costs.map((c, i) => ({ tier: i + 1, cost: c, owned: this.level(id) > i, desc: s.desc[i] })),
    }));
  }

  serialize() { return { levels: { ...this.levels } }; }
  restore(d) {
    if (!d?.levels) return;
    this.levels = { brakes: 0, engine: 0, capacity: 0, ...d.levels };
    this._push();
  }

  static priceList() {
    return Object.entries(UPGRADES).map(([id, s]) => `${s.label}: ${s.costs.map(formatMoney).join(' / ')}`);
  }
}

export default UpgradeManager;
