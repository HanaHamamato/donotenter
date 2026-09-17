/**
 * ProgressionManager — milestones and unlocks (GDD §3.4).
 *
 * The map starts with the Plains open and a GP-7 in the shed. Everything else
 * is earned: reputation opens regions, money opens locomotives, timed passenger
 * work opens the coach business, and the last milestone opens the Summit Loop.
 * A milestone fires exactly once, announces itself, and immediately changes
 * what the track network considers open.
 */
import { MILESTONES, LOCOMOTIVES } from '../constants.js';
import { bus } from '../utils/events.js';

export class ProgressionManager {
  /**
   * @param {object} deps {net, stations: StationManager, economy: EconomyManager}
   */
  constructor(deps = {}) {
    this.net = deps.net;
    this.stations = deps.stations;
    this.economy = deps.economy;
    this.achieved = new Set();
    this.regions = new Set(['plains']);
    this.locos = new Set(['gp7']);
    this.branches = new Set();
    this.passengers = false;
    this.rank = 'Newcomer';
    this._apply();
  }

  _repTable() {
    const rep = {};
    for (const st of this.stations?.list || []) rep[st.id] = Math.floor(st.rep);
    return rep;
  }

  /** Milestone input state, exactly the shape the checks in constants expect. */
  state() {
    return this.economy?.stats(this._repTable()) || { deliveries: 0, earned: 0, rep: {}, timedBonuses: 0, repStations: 0 };
  }

  /** Check every unachieved milestone. Called after deliveries and rep changes. */
  update() {
    const s = this.state();
    const fired = [];
    for (const m of MILESTONES) {
      if (this.achieved.has(m.id)) continue;
      let ok = false;
      try { ok = !!m.check?.(s); } catch { ok = false; }
      if (!ok) continue;
      this.achieved.add(m.id);
      this.rank = m.name;
      if (m.unlockRegion) this.regions.add(m.unlockRegion);
      if (m.unlockLoco) this.locos.add(m.unlockLoco);
      if (m.unlockBranch) this.branches.add(m.unlockBranch);
      if (m.unlockPassengers) this.passengers = true;
      fired.push(m);
      bus.emit('milestone:reached', { milestone: m, state: s });
      bus.emit('notify', { kind: 'good', title: `Milestone — ${m.name}`, text: m.desc, ttl: 9 });
      if (m.unlockRegion) bus.emit('notify', { kind: 'info', text: `Region unlocked: ${m.unlockRegion}.`, ttl: 7 });
      if (m.unlockLoco) {
        const spec = LOCOMOTIVES[m.unlockLoco];
        bus.emit('notify', { kind: 'info', text: `Locomotive available: ${spec?.name || m.unlockLoco}.`, ttl: 7 });
      }
      if (m.unlockPassengers) bus.emit('passengers:unlocked', {});
    }
    if (fired.length) this._apply();
    return fired;
  }

  /** Push the unlock state into the track network so locked lines physically close. */
  _apply() {
    if (!this.net) return;
    this.net.setRegions([...this.regions]);
    for (const b of this.branches) this.net.openBranch(b);
  }

  isRegionOpen(id) { return this.regions.has(id); }
  isLocoOwned(id) { return this.locos.has(id); }
  lockedLocos() {
    return Object.values(LOCOMOTIVES).filter((l) => !this.locos.has(l.id));
  }

  /** Milestone list for the career panel. */
  table() {
    const s = this.state();
    return MILESTONES.map((m) => ({
      id: m.id, name: m.name, desc: m.desc,
      done: this.achieved.has(m.id),
      progress: m.id === 'licensed' ? `${s.deliveries}/5 deliveries`
        : m.id === 'trusted' ? `$${s.earned}/2000 earned`
        : m.id === 'harbormaster' ? `Millford rep ${s.rep.millford || 0}/3`
        : m.id === 'ironworker' ? `Ironvale rep ${s.rep.ironvale || 0}/3`
        : m.id === 'express' ? `${s.timedBonuses}/10 timed bonuses`
        : m.id === 'baron' ? `$${s.earned}/10000 · ${Object.values(s.rep).filter((v) => v >= 5).length}/3 stations at rep 5`
        : m.id === 'legend' ? `${Object.values(s.rep).filter((v) => v >= 5).length}/8 stations at rep 5`
        : '',
    }));
  }

  serialize() {
    return {
      achieved: [...this.achieved], regions: [...this.regions],
      locos: [...this.locos], branches: [...this.branches],
      passengers: this.passengers, rank: this.rank,
    };
  }

  restore(d) {
    if (!d) return;
    this.achieved = new Set(d.achieved || []);
    this.regions = new Set(d.regions?.length ? d.regions : ['plains']);
    this.locos = new Set(d.locos?.length ? d.locos : ['gp7']);
    this.branches = new Set(d.branches || []);
    this.passengers = !!d.passengers;
    this.rank = d.rank || 'Newcomer';
    this._apply();
  }
}

export default ProgressionManager;
