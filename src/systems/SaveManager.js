/**
 * SaveManager — persistence (GDD §7 SaveManager, §8 save slots).
 *
 * One JSON blob holds the whole career: the working clock, the money, station
 * reputations and stock, every contract, the milestones earned, the upgrades
 * bought, every vehicle anywhere in the world (in a train or standing loose),
 * the player's consist and where it is on the rails, the switch settings, the
 * time of day and the weather.
 *
 * Three manual slots plus an autosave. Writes are debounced and wrapped in
 * try/catch, because a full save in a private browser tab can throw on quota.
 */
import { bus } from '../utils/events.js';

export const SAVE_VERSION = 3;
const KEY = (slot) => `ironbound.save.v${SAVE_VERSION}.${slot}`;
const SLOTS = ['auto', 1, 2, 3];

export class SaveManager {
  /**
   * @param {object} deps every system, keyed by name
   */
  constructor(deps = {}) {
    this.deps = deps;
    this.storage = deps.storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    this.autosaveEvery = deps.autosaveEvery ?? 90;   // real seconds
    this.timer = 0;
    this.lastSlot = 'auto';
    this.lastError = null;
    this.playtime = deps.playtime ?? 0;
    this._unsubs = [
      bus.on('save:request', (e) => this.save(e?.slot ?? this.lastSlot)),
      bus.on('load:request', (e) => this.load(e?.slot ?? 'auto')),
    ];
  }

  available() { return !!this.storage; }

  /* ----------------------------------------------------------------- gather */
  collect(meta = {}) {
    const d = this.deps;
    const net = d.net;
    const switches = {};
    for (const node of net?.nodes.values?.() || []) if (node.switchable) switches[node.id] = node.active | 0;

    const vehicles = [];
    for (const v of d.stock?.all?.values?.() || []) vehicles.push({ ...v.toJSON(), riders: v.riders || 0 });

    const train = d.train?.serialize?.() || null;
    if (train && d.train.vehicles) {
      train.riders = d.train.vehicles.map((v) => v.riders || 0);
    }

    return {
      version: SAVE_VERSION,
      savedAt: Date.now(),
      playtime: this.playtime,
      meta: {
        rank: d.progression?.rank || 'Newcomer',
        credits: Math.round(d.economy?.credits || 0),
        day: d.economy?.day || 1,
        deliveries: d.economy?.deliveries || 0,
        ...meta,
      },
      economy: d.economy?.serialize?.(),
      stations: d.stations?.serialize?.(),
      contracts: d.contracts?.serialize?.(),
      progression: d.progression?.serialize?.(),
      upgrades: d.upgrades?.serialize?.(),
      passengers: d.passengers?.serialize?.(),
      tutorial: d.tutorial?.serialize?.(),
      vehicles,
      loose: d.stock?.serializeLoose?.() || [],
      train,
      switches,
      cycle: { t: d.cycle?.t ?? 0.3, workMinutes: d.economy?.workMinutes ?? 480 },
      weather: d.weather?.id || 'clear',
      settings: d.settings ? { ...d.settings } : null,
      camera: d.camera ? { mode: d.camera.mode, free: d.camera.free?.pos?.toArray?.() } : null,
    };
  }

  save(slot = 'auto', meta = {}) {
    if (!this.storage) { this.lastError = 'no storage'; return null; }
    this.lastSlot = slot;
    const data = this.collect(meta);
    try {
      const json = JSON.stringify(data);
      this.storage.setItem(KEY(slot), json);
      this.lastError = null;
      bus.emit('save:done', { slot, bytes: json.length, meta: data.meta });
      if (slot !== 'auto') bus.emit('notify', { kind: 'good', text: `Saved to slot ${slot}.` });
      return data;
    } catch (err) {
      this.lastError = err?.message || String(err);
      console.warn('[save] failed:', this.lastError);
      bus.emit('notify', { kind: 'bad', text: `Save failed — ${this.lastError}` });
      bus.emit('save:error', { slot, error: this.lastError });
      return null;
    }
  }

  /** Slot metadata for the load screen, without parsing the whole save. */
  list() {
    const out = [];
    for (const slot of SLOTS) {
      let data = null;
      try {
        const raw = this.storage?.getItem(KEY(slot));
        if (raw) data = JSON.parse(raw);
      } catch { data = null; }
      out.push({
        slot,
        exists: !!data,
        meta: data?.meta || null,
        savedAt: data?.savedAt || null,
        playtime: data?.playtime || 0,
        version: data?.version || 0,
      });
    }
    return out;
  }

  has(slot) { return !!this.storage?.getItem(KEY(slot)); }

  delete(slot) {
    try { this.storage?.removeItem(KEY(slot)); } catch { /* noop */ }
    bus.emit('save:deleted', { slot });
  }

  /* ---------------------------------------------------------------- restore */
  load(slot = 'auto') {
    if (!this.storage) return null;
    let data = null;
    try {
      const raw = this.storage.getItem(KEY(slot));
      if (!raw) { bus.emit('notify', { kind: 'warn', text: `No save in slot ${slot}.` }); return null; }
      data = JSON.parse(raw);
    } catch (err) {
      bus.emit('notify', { kind: 'bad', text: `Save in slot ${slot} is corrupt.` });
      return null;
    }
    if (!data || data.version !== SAVE_VERSION) {
      bus.emit('notify', { kind: 'bad', text: `Save is from another version (${data?.version || '?'}) and cannot be loaded.` });
      return null;
    }
    this.apply(data);
    this.lastSlot = slot;
    bus.emit('load:done', { slot, data });
    bus.emit('notify', { kind: 'good', text: `Loaded slot ${slot} — ${data.meta?.rank || ''}, ${data.meta?.credits || 0} credits.` });
    return data;
  }

  /** Push a save blob back into every system. */
  apply(data) {
    const d = this.deps;
    this.playtime = data.playtime || 0;

    d.economy?.restore?.(data.economy);
    d.progression?.restore?.(data.progression);
    d.stations?.restore?.(data.stations);
    d.contracts?.restore?.(data.contracts);
    d.upgrades?.restore?.(data.upgrades);
    d.passengers?.restore?.(data.passengers);
    d.tutorial?.restore?.(data.tutorial);

    // switch settings
    for (const [id, idx] of Object.entries(data.switches || {})) {
      const node = d.net?.nodeById?.(id);
      if (node) d.net.setRouteIndex(node, idx);
    }

    // rolling stock: rebuild every vehicle, then re-park the loose ones
    if (d.stock) {
      const byId = new Map();
      for (const rec of data.vehicles || []) {
        const v = d.stock.all.get(rec.id) || d.stock.spawn(rec.kind, rec.typeKey, { id: rec.id });
        v.setLoad(rec.cargo, rec.tons, rec.origin, rec.contractId);
        v.condition = rec.condition ?? 100;
        v.riders = rec.riders || 0;
        byId.set(v.id, v);
      }
      for (const v of [...d.stock.all.values()]) if (!byId.has(v.id)) d.stock.remove(v);
      d.stock.loose.length = 0;
      d.stock.restoreLoose(d.net, data.loose);
    }

    // the player's consist
    if (d.train && data.train?.seg && d.net?.segments?.has(data.train.seg)) {
      const vehicles = (data.train.vehicles || []).map((rec, i) => {
        const v = d.stock?.all?.get(rec.id) || d.stock?.spawn(rec.kind, rec.typeKey, { id: rec.id });
        if (!v) return null;
        v.setLoad(rec.cargo, rec.tons, rec.origin, rec.contractId);
        v.condition = rec.condition ?? 100;
        v.riders = data.train.riders?.[i] || 0;
        v.build?.(d.assets);
        return v;
      }).filter(Boolean);
      const state = d.net.makeState(data.train.seg, data.train.u ?? 0, data.train.dir ?? 1);
      d.train.setConsist(vehicles, state);
      d.train.speed = data.train.speed || 0;
      d.train.moving = data.train.moving || 1;
      d.train.tripKm = data.train.tripKm || 0;
      Object.assign(d.train.controls, data.train.controls || {});
      d.upgrades?.setTrain?.(d.train);
      d.train.placeCars();
    }

    // world state
    if (d.cycle && data.cycle) d.cycle.t = data.cycle.t ?? d.cycle.t;
    d.weather?.setWeather?.(data.weather || 'clear', true);
    d.camera?.setMode?.(data.camera?.mode || 'chase', true);
    if (d.settings && data.settings) Object.assign(d.settings, data.settings);

    bus.emit('world:restored', { data });
  }

  /** Called every frame; autosaves on the interval when something is worth saving. */
  update(dt) {
    this.playtime += dt;
    this.timer += dt;
    if (this.timer >= this.autosaveEvery) {
      this.timer = 0;
      if (this.deps.economy && this.deps.train?.state) this.save('auto');
    }
  }

  exportText(slot = 'auto') {
    try { return this.storage?.getItem(KEY(slot)) || null; } catch { return null; }
  }

  importText(text, slot = 1) {
    try {
      const data = JSON.parse(text);
      if (data.version !== SAVE_VERSION) throw new Error('version mismatch');
      this.storage?.setItem(KEY(slot), JSON.stringify(data));
      bus.emit('notify', { kind: 'good', text: `Imported into slot ${slot}.` });
      return true;
    } catch (err) {
      bus.emit('notify', { kind: 'bad', text: `Import failed — ${err.message}` });
      return false;
    }
  }

  dispose() { for (const off of this._unsubs) off(); this._unsubs = []; }
}

export default SaveManager;
