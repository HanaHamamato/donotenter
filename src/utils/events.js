/** Tiny synchronous event bus — plain JS objects + events (GDD §"State management"). */
export class EventBus {
  constructor() { this._m = new Map(); }

  on(type, fn) {
    if (!this._m.has(type)) this._m.set(type, new Set());
    this._m.get(type).add(fn);
    return () => this.off(type, fn);
  }

  once(type, fn) {
    const off = this.on(type, (payload) => { off(); fn(payload); });
    return off;
  }

  off(type, fn) { this._m.get(type)?.delete(fn); }

  emit(type, payload) {
    const set = this._m.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(payload); } catch (err) { console.error(`[event:${type}]`, err); }
    }
    const wild = this._m.get('*');
    if (wild) for (const fn of [...wild]) fn({ type, payload });
  }

  clear() { this._m.clear(); }
}

export const bus = new EventBus();
