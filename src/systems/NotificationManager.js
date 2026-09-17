/**
 * NotificationManager — the toast stack (GDD §6.4 notifications).
 *
 * Everything the game wants to tell the player arrives as a `notify` event on
 * the bus; this manager turns those into a short-lived stack of messages with a
 * severity, an optional title, and a lifetime. The UI just renders `items`.
 */
import { bus } from '../utils/events.js';

const DEFAULT_TTL = { info: 4.5, good: 5.5, warn: 6, bad: 7.5, milestone: 9 };
const MAX_ITEMS = 5;

let seq = 1;

export class NotificationManager {
  constructor(opts = {}) {
    /** @type {{id:number,kind:string,text:string,title?:string,ttl:number,age:number,pinned:boolean}[]} */
    this.items = [];
    this.max = opts.max || MAX_ITEMS;
    this.history = [];
    this.muted = false;
    this._unsubs = [
      bus.on('notify', (e) => this.push(e)),
      bus.on('station:arrive', (e) => {
        this.push({
          kind: 'info',
          title: e.station.name,
          text: e.station.def?.blurb || `${e.station.type} — ${e.station.region} region`,
          ttl: 5,
        });
      }),
    ];
  }

  push({ kind = 'info', text = '', title = null, ttl = null, pinned = false, dedupe = true } = {}) {
    if (this.muted || !text) return null;
    if (dedupe) {
      const dup = this.items.find((i) => i.text === text && i.age < 1.2);
      if (dup) { dup.age = 0; dup.ttl = ttl ?? dup.ttl; return dup; }
    }
    const item = { id: seq++, kind, text, title, ttl: ttl ?? DEFAULT_TTL[kind] ?? 5, age: 0, pinned, born: performance.now() };
    this.items.unshift(item);
    while (this.items.length > this.max) {
      const dropped = this.items.pop();
      if (!dropped.pinned) this._archive(dropped);
      else this.items.push(dropped);
    }
    this._archive(item, true);
    return item;
  }

  _archive(item, fresh = false) {
    if (fresh && this.history[this.history.length - 1]?.text === item.text) return;
    this.history.push({ kind: item.kind, text: item.text, title: item.title, at: item.born });
    if (this.history.length > 60) this.history.shift();
  }

  dismiss(id) {
    const i = this.items.findIndex((x) => x.id === id);
    if (i >= 0) this.items.splice(i, 1);
  }

  clear() { this.items.length = 0; }

  update(dt) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.age += dt;
      if (!it.pinned && it.age >= it.ttl) this.items.splice(i, 1);
    }
  }

  /** Opacity for fading out at the end of a toast's life. */
  static alpha(item) {
    const left = item.ttl - item.age;
    return Math.min(1, left / 0.6, Math.min(1, item.age / 0.18));
  }

  dispose() {
    for (const off of this._unsubs || []) off();
    this._unsubs = [];
  }
}

export default NotificationManager;
