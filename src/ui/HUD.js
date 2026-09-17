/**
 * HUD — everything the crew needs while driving (GDD §6.1).
 *
 * Built once, then only text and widths are written each frame. The slow bits
 * (what is coming up the line, the consist list, the contract card) refresh on
 * a 4 Hz timer instead of every frame.
 */
import { h, setText, setClass, clear } from './dom.js';
import { CARGO } from '../constants.js';
import { formatMoney, formatDistance, clamp01 } from '../utils/math.js';
import { NotificationManager } from '../systems/NotificationManager.js';
import * as THREE from 'three';

const ASPECT_LABEL = { red: 'STOP', yellow: 'CAUTION', green: 'CLEAR' };
const _tmpV = new THREE.Vector3();

export class HUD {
  /** @param {HTMLElement} root @param {object} game */
  constructor(root, game) {
    this.root = root;
    this.game = game;
    this.visible = true;
    this.debug = false;
    this.slow = 0;
    this.fps = 60;
    this._fpsAcc = 0;
    this._fpsN = 0;
    this.promptText = '';
    this.build();
  }

  build() {
    const el = h('div', { class: 'hud' });

    /* ---------------------------------------------------- speed & controls */
    this.speedEl = h('div', { class: 'speed' });
    this.speedKmh = h('span', { class: 'kmh', text: '0' });
    this.speedUnit = h('span', { class: 'unit', text: 'km/h' });
    this.limitEl = h('span', { class: 'limit', text: '—' });
    this.speedEl.append(this.speedKmh, this.speedUnit, h('div', { class: 'limitwrap' }, [
      h('span', { class: 'limlabel', text: 'LIMIT' }), this.limitEl,
    ]));

    this.notchRow = h('div', { class: 'notches' });
    this.notchCells = [];
    for (let i = 0; i < 8; i++) {
      const c = h('i', { class: 'notch' });
      this.notchCells.push(c);
      this.notchRow.appendChild(c);
    }
    this.revEl = h('span', { class: 'rev', text: 'N' });
    this.throttleWrap = h('div', { class: 'ctl' }, [
      h('div', { class: 'ctllabel' }, ['THROTTLE', this.revEl]),
      this.notchRow,
    ]);

    this.brakeBar = this._bar('brake');
    this.pipeBar = this._bar('pipe');
    this.dynBar = this._bar('dyn');
    this.brakeWrap = h('div', { class: 'ctl' }, [
      h('div', { class: 'ctllabel' }, [h('span', {}, 'BRAKE'), this.brakePct = h('span', { class: 'pct', text: '0%' })]),
      this.brakeBar,
      h('div', { class: 'ctllabel' }, [h('span', {}, 'AIR PIPE'), this.pipePct = h('span', { class: 'pct', text: '0%' })]),
      this.pipeBar,
      h('div', { class: 'ctllabel' }, [h('span', {}, 'DYNAMIC'), this.dynPct = h('span', { class: 'pct', text: '0' })]),
      this.dynBar,
    ]);

    this.slipEl = h('div', { class: 'slip', text: 'WHEEL SLIP' });
    this.emergEl = h('div', { class: 'emerg', text: 'EMERGENCY' });

    el.appendChild(h('div', { class: 'panel bottom-left' }, [
      this.speedEl, this.throttleWrap, this.brakeWrap,
      h('div', { class: 'warnrow' }, [this.slipEl, this.emergEl]),
    ]));

    /* ---------------------------------------------------------- the line ahead */
    this.signalLamp = h('i', { class: 'lamp green' });
    this.signalText = h('span', { class: 'sigtext', text: 'CLEAR' });
    this.signalDist = h('span', { class: 'sigdist', text: '' });
    this.nextStation = h('div', { class: 'nextstation', text: '—' });
    this.nextStationDist = h('span', { class: 'nsdist', text: '' });
    this.routeEl = h('div', { class: 'route', text: '' });
    this.lockEl = h('div', { class: 'lockwarn', text: '' });
    el.appendChild(h('div', { class: 'panel top-right ahead' }, [
      h('div', { class: 'sigrow' }, [this.signalLamp, this.signalText, this.signalDist]),
      h('div', { class: 'nsrow' }, [this.nextStation, this.nextStationDist]),
      this.routeEl,
      this.lockEl,
    ]));

    /* ------------------------------------------------------------- contract */
    this.contractCard = h('div', { class: 'panel top-left contract hidden' });
    this.ctTitle = h('div', { class: 'cttitle', text: '' });
    this.ctBody = h('div', { class: 'ctbody' });
    this.ctTime = h('div', { class: 'cttime', text: '' });
    this.ctBar = this._bar('ct');
    this.contractCard.append(this.ctTitle, this.ctBody, this.ctBar, this.ctTime);
    el.appendChild(this.contractCard);

    /* --------------------------------------------------------------- clock */
    this.clockEl = h('div', { class: 'clock', text: 'Day 1 · 08:00' });
    this.moneyEl = h('div', { class: 'money', text: formatMoney(0) });
    this.weatherEl = h('div', { class: 'wx', text: 'Clear' });
    this.biomeEl = h('div', { class: 'biome', text: 'Plains' });
    this.visEl = h('div', { class: 'vis', text: '' });
    this.rankEl = h('div', { class: 'rank', text: 'Newcomer' });
    el.appendChild(h('div', { class: 'panel bottom-right' }, [
      this.clockEl, this.moneyEl, this.rankEl, this.weatherEl, this.biomeEl, this.visEl,
    ]));

    /* ------------------------------------------------------------- consist */
    this.consistEl = h('div', { class: 'panel bottom-centre consist' });
    this.consistHead = h('div', { class: 'chead', text: '0 cars · 0 t · 0 m' });
    this.consistChips = h('div', { class: 'chips' });
    this.consistEl.append(this.consistHead, this.consistChips);
    el.appendChild(this.consistEl);

    /* ------------------------------------------------------- notifications */
    this.notifEl = h('div', { class: 'notifs' });
    el.appendChild(this.notifEl);

    /* ------------------------------------------------------------- prompt */
    this.promptEl = h('div', { class: 'prompt hidden', text: '' });
    el.appendChild(this.promptEl);

    /* -------------------------------------------------------------- tutorial */
    this.tutEl = h('div', { class: 'panel tutorial hidden' });
    this.tutTitle = h('div', { class: 'tuttitle', text: '' });
    this.tutText = h('div', { class: 'tuttext', text: '' });
    this.tutHint = h('div', { class: 'tuthint', text: '' });
    this.tutEl.append(this.tutTitle, this.tutText, this.tutHint);
    el.appendChild(this.tutEl);

    /* ---------------------------------------------------------------- debug */
    this.debugEl = h('div', { class: 'panel debug hidden' });
    el.appendChild(this.debugEl);

    /* --------------------------------------------------------------- damage */
    this.flashEl = h('div', { class: 'damage-flash' });
    el.appendChild(this.flashEl);
    this.vigEl = h('div', { class: 'tunnel-vig' });
    el.appendChild(this.vigEl);

    this.el = el;
    this.root.appendChild(el);
  }

  _bar(cls) {
    const fill = h('div', { class: 'fill' });
    const el = h('div', { class: `bar ${cls}` }, [fill]);
    el.fill = fill;
    el.set = (v) => { fill.style.width = `${clamp01(v) * 100}%`; };
    return el;
  }

  show(on) {
    this.visible = !!on;
    setClass(this.el, 'hidden', !on);
  }

  toggleDebug() {
    this.debug = !this.debug;
    setClass(this.debugEl, 'hidden', !this.debug);
    return this.debug;
  }

  /** Impact / derail flash. */
  flash(amount = 1) {
    this.flashEl.style.opacity = String(clamp01(amount));
    this._flashT = 0.4;
  }

  setPrompt(text) {
    if (text === this.promptText) return;
    this.promptText = text;
    setText(this.promptEl, text);
    setClass(this.promptEl, 'hidden', !text);
  }

  update(dt) {
    const g = this.game;
    const train = g.train;

    // fps
    this._fpsAcc += dt; this._fpsN++;
    if (this._fpsAcc > 0.4) { this.fps = this._fpsN / this._fpsAcc; this._fpsAcc = 0; this._fpsN = 0; }

    if (this._flashT > 0) {
      this._flashT -= dt;
      this.flashEl.style.opacity = String(Math.max(0, this._flashT / 0.4) * 0.55);
    }
    this.vigEl.style.opacity = String(clamp01(g.tunnel || 0) * 0.85);

    /* ------------------------------------------------------------ fast path */
    const kmh = train ? train.kmh : 0;
    setText(this.speedKmh, Math.round(kmh));
    setClass(this.speedEl, 'over', !!train && kmh > (train.currentLimit() + 1));
    setText(this.limitEl, train ? `${Math.round(train.currentLimit())}` : '—');

    const notch = train ? train.controls.throttle : 0;
    for (let i = 0; i < 8; i++) setClass(this.notchCells[i], 'on', i < notch);
    setText(this.revEl, train ? ({ f: 'F', n: 'N', r: 'R' })[train.controls.reverser] : 'N');
    setClass(this.revEl, 'rev', train?.controls.reverser === 'r');
    this.brakeBar.set(train?.controls.brake || 0);
    setText(this.brakePct, `${Math.round((train?.controls.brake || 0) * 100)}%`);
    this.pipeBar.set(train?.brakePipe || 0);
    setText(this.pipePct, `${Math.round((train?.brakePipe || 0) * 100)}%`);
    this.dynBar.set((train?.controls.dynamic || 0) / 8);
    setText(this.dynPct, String(train?.controls.dynamic || 0));
    setClass(this.slipEl, 'on', (train?.slip || 0) > 0.22);
    setClass(this.emergEl, 'on', !!train?.controls.emergency);

    /* ----------------------------------------------------------- slow path */
    this.slow -= dt;
    if (this.slow <= 0) {
      this.slow = 0.25;
      this._updateSlow();
    }

    /* ------------------------------------------------------- notifications */
    this._renderNotifs(g.notifs);

    /* ---------------------------------------------------------- tutorial */
    const tut = g.tutorial;
    if (tut?.enabled && !tut.finished && tut.step && !tut.step.terminal) {
      setClass(this.tutEl, 'hidden', false);
      setText(this.tutTitle, tut.step.title);
      setText(this.tutText, tut.step.text);
      setText(this.tutHint, tut.step.hint || '');
    } else {
      setClass(this.tutEl, 'hidden', true);
    }

    /* ------------------------------------------------------------- debug */
    if (this.debug) this._renderDebug(dt);
  }

  _updateSlow() {
    const g = this.game;
    const train = g.train;

    // clock / money / weather
    setText(this.clockEl, g.economy?.stamp() || '');
    setText(this.moneyEl, formatMoney(g.economy?.credits || 0));
    setText(this.rankEl, g.progression?.rank || '');
    const wx = g.weather;
    setText(this.weatherEl, wx ? `${wx.label()}${wx.state.precip > 0.05 ? ` · ${Math.round(wx.state.precip * 100)}%` : ''}` : '');
    setText(this.biomeEl, g.biome?.label() || '');
    const vis = wx ? wx.visibility() : 0;
    setText(this.visEl, vis < 3000 ? `Visibility ${formatDistance(vis)}` : '');

    // signal + next station + route
    if (train?.state) {
      const sig = g.blocks?.nextAspect?.(train, 1400);
      if (sig) {
        this.signalLamp.className = `lamp ${sig.aspect}`;
        setText(this.signalText, sig.buffer ? 'BUFFER STOP' : ASPECT_LABEL[sig.aspect] || 'CLEAR');
        setText(this.signalDist, formatDistance(sig.distance));
      } else {
        this.signalLamp.className = 'lamp green';
        setText(this.signalText, 'CLEAR');
        setText(this.signalDist, '');
      }
      const look = train.lookAhead(6000);
      let station = null;
      let junction = null;
      for (const f of look) {
        if (!station && f.type === 'station' && f.node?.station) station = f;
        if (!junction && f.type === 'junction' && f.switchable) junction = f;
        if (station && junction) break;
      }
      const st = station ? g.stations.get(station.node.station) : null;
      setText(this.nextStation, st ? st.name : '—');
      setText(this.nextStationDist, station ? formatDistance(station.distance) : '');
      if (junction) {
        const routes = junction.routes || [];
        const active = routes[junction.activeRoute];
        const dest = active?.segment ? (active.segment.a === junction.node.id ? active.segment.b : active.segment.a) : null;
        const destNode = dest ? g.net.nodeById(dest) : null;
        const destSt = destNode?.station ? g.stations.get(destNode.station) : null;
        setText(this.routeEl, `Points ${formatDistance(junction.distance)} → ${destSt ? destSt.name : destNode?.name || dest || '?'}  [Tab]`);
        setClass(this.routeEl, 'hidden', false);
      } else {
        setClass(this.routeEl, 'hidden', true);
      }
      const locked = train.state.seg && !g.net.isOpen(train.state.seg) ? g.net.closedReason(train.state.seg) : null;
      setText(this.lockEl, locked || '');
      setClass(this.lockEl, 'hidden', !locked);
    }

    // consist
    if (train && !train.empty) {
      const cars = train.vehicles.length - train.locomotives.length;
      setText(this.consistHead, `${cars} car${cars === 1 ? '' : 's'} · ${Math.round(train.tonnes)} t · ${Math.round(train.length)} m`);
      const loads = {};
      for (const v of train.vehicles) {
        if (!v.cargo) continue;
        loads[v.cargo] = (loads[v.cargo] || 0) + v.tons;
      }
      const keys = Object.keys(loads);
      if (keys.length !== this._chipKeys?.length || keys.some((k, i) => this._chipKeys?.[i] !== k)) {
        this._chipKeys = keys;
        clear(this.consistChips);
        for (const k of keys) {
          const chip = h('span', { class: 'chip' }, [
            h('i', { class: 'dot', style: { background: `#${(CARGO[k]?.color || 0x888888).toString(16).padStart(6, '0')}` } }),
            h('span', { class: 'ct', text: `${CARGO[k]?.label || k} ` }),
            h('b', { class: 'cv', text: `${Math.round(loads[k])} t` }),
          ]);
          chip.dataset.cargo = k;
          this.consistChips.appendChild(chip);
        }
      } else {
        for (const chip of this.consistChips.children) {
          const k = chip.dataset.cargo;
          setText(chip.querySelector('.cv'), `${Math.round(loads[k] || 0)} t`);
        }
      }
    } else {
      setText(this.consistHead, 'no consist');
      if (this._chipKeys?.length) { this._chipKeys = []; clear(this.consistChips); }
    }

    // contract card
    const active = g.contracts?.summary?.() || [];
    if (active.length) {
      setClass(this.contractCard, 'hidden', false);
      const c = active[0];
      setText(this.ctTitle, `${c.cargoLabel} → ${c.destName}`);
      clear(this.ctBody);
      this.ctBody.append(
        h('span', {}, `${c.deliveredCars}/${c.cars} cars · ${Math.round(c.deliveredTons)}/${c.tons} t`),
        h('span', { class: 'pay' }, formatMoney(c.pay)),
      );
      const total = Math.max(1, c.deadline - c.issued);
      const left = clamp01((c.deadline - (g.economy?.workMinutes || 0)) / total);
      this.ctBar.set(left);
      this.ctBar.fill.style.background = c.late ? '#c0392b' : c.urgent ? '#e0a33c' : '#5fae7a';
      setText(this.ctTime, c.late ? 'OVERDUE' : `${Math.floor(c.minutesLeft / 60)}h ${String(c.minutesLeft % 60).padStart(2, '0')}m left · ${c.km} km`);
      setClass(this.ctTime, 'late', c.late);
      if (active.length > 1) {
        this.ctBody.appendChild(h('span', { class: 'more', text: `+${active.length - 1} more` }));
      }
    } else {
      setClass(this.contractCard, 'hidden', true);
    }
  }

  _renderNotifs(notifs) {
    if (!notifs) return;
    const items = notifs.items;
    if (this._notifIds?.length === items.length && items.every((it, i) => this._notifIds[i] === it.id)) {
      for (let i = 0; i < items.length; i++) {
        const el = this.notifEl.children[i];
        if (el) el.style.opacity = String(NotificationManager.alpha(items[i]));
      }
      return;
    }
    this._notifIds = items.map((i) => i.id);
    clear(this.notifEl);
    for (const it of items) {
      const node = h('div', { class: `notif ${it.kind}`, style: { opacity: String(NotificationManager.alpha(it)) } }, [
        it.title ? h('div', { class: 'ntitle', text: it.title }) : null,
        h('div', { class: 'ntext', text: it.text }),
      ]);
      this.notifEl.appendChild(node);
    }
  }

  _renderDebug() {
    const g = this.game;
    const info = g.renderer?.info;
    const s = g.world?.stats?.() || {};
    const train = g.train;
    const p = train?.state ? g.net.positionOf(train.state, _tmpV) : null;
    const lines = [
      `fps ${this.fps.toFixed(0)}  draw ${info?.render?.calls ?? 0}  tris ${((info?.render?.triangles ?? 0) / 1000).toFixed(0)}k`,
      `pos ${p ? `${p.x.toFixed(0)}, ${(p.y ?? 0).toFixed(1)}, ${p.z.toFixed(0)}` : '—'}  seg ${train?.state?.seg?.id ?? '—'} u ${(train?.state?.u ?? 0).toFixed(3)}`,
      `odo ${(train?.pathOdo ?? 0).toFixed(0)} m  trip ${(train?.tripKm ?? 0).toFixed(2)} km  accel ${(train?.accel ?? 0).toFixed(3)} m/s²`,
      `TE ${(train?.forces?.te ?? 0 / 1000).toFixed?.(0) ?? 0} N  adh ${((train?.forces?.adhesion ?? 0) / 1000).toFixed(0)} kN  res ${((train?.forces?.resistance ?? 0) / 1000).toFixed(1)} kN  brk ${((train?.forces?.brake ?? 0) / 1000).toFixed(1)} kN`,
      `terrain tris ${(s.terrainTris ?? 0).toLocaleString()} q ${s.terrainQueued ?? 0}  track tris ${(s.trackTris ?? 0).toLocaleString()} q ${s.trackQueued ?? 0} segs ${s.trackSegments ?? 0}`,
      `veg ${s.vegProps ?? 0} props / ${(s.vegTris ?? 0).toLocaleString()} tris / ${s.vegCells ?? 0} cells  structs ${s.structures ?? 0}  water ${(s.waterTris ?? 0).toLocaleString()}`,
      `biome ${s.biome ?? '—'}  weather ${s.weather ?? '—'}  vis ${(s.visibility ?? 0).toLocaleString()} m  tunnel ${(g.tunnel ?? 0).toFixed(2)}`,
      `frame ms: ${Object.entries(s.ms || {}).map(([k, v]) => `${k} ${v.toFixed(1)}`).join('  ')}`,
      `ai ${g.ai?.trains?.length ?? 0} trains  credits ${Math.round(g.economy?.credits ?? 0)}  work ${Math.round(g.economy?.workMinutes ?? 0)} min`,
      `cycle t ${(g.cycle?.t ?? 0).toFixed(3)} sun el ${((g.cycle?.elevation ?? 0) * 90).toFixed(1)}°  grip ${(g.weather?.grip?.() ?? 1).toFixed(2)}`,
    ];
    clear(this.debugEl);
    for (const l of lines) this.debugEl.appendChild(h('div', { class: 'dl', text: l }));
  }
}

export default HUD;
