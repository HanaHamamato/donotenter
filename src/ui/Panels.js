/**
 * Panels — every full-screen sheet in the game (GDD §6.2–§6.4).
 *
 * One overlay, one sheet at a time: the station board and its contract list,
 * the consist roster, the network map, the career page, the depot and upgrade
 * shop, settings, controls, and the pause menu. Opening a sheet releases the
 * pointer lock and tells the input manager to stop driving the train, so the
 * mouse does normal mouse things while a panel is up.
 */
import { h, setText, setClass, clear, button } from './dom.js';
import { CARGO, LOCOMOTIVES, ECONOMY, KEYBINDS, RENDER, WORLD } from '../constants.js';
import { formatMoney, clamp01 } from '../utils/math.js';
import { bus } from '../utils/events.js';
import * as THREE from 'three';

const PANELS = ['station', 'consist', 'map', 'career', 'shop', 'settings', 'help', 'pause'];
const _tmpV = new THREE.Vector3();

export class Panels {
  constructor(root, game) {
    this.root = root;
    this.game = game;
    this.current = null;
    this.sheets = new Map();
    this.build();
  }

  build() {
    this.overlay = h('div', { class: 'overlay hidden' });
    this.root.appendChild(this.overlay);
    for (const id of PANELS) {
      const sheet = h('div', { class: `sheet sheet-${id} hidden`, dataset: { panel: id } });
      this.overlay.appendChild(sheet);
      this.sheets.set(id, sheet);
    }
  }

  isOpen() { return !!this.current; }

  open(id, arg = null) {
    if (!this.sheets.has(id)) return;
    this.arg = arg;
    if (this.current === id) return this.close();
    this.current = id;
    setClass(this.overlay, 'hidden', false);
    for (const [key, sheet] of this.sheets) setClass(sheet, 'hidden', key !== id);
    // Release the mouse but keep the keyboard live: Escape has to close this,
    // even when the sheet was opened from the title screen.
    this.game.input?.releaseLock?.();
    this.game.input?.setEnabled?.(true);
    bus.emit('ui:panel', { id, open: true, arg });
    this.render(id);
    return id;
  }

  close() {
    if (!this.current) return;
    const id = this.current;
    this.current = null;
    setClass(this.overlay, 'hidden', true);
    for (const sheet of this.sheets.values()) setClass(sheet, 'hidden', true);
    if (this.game.focusWorld) this.game.focusWorld();
    bus.emit('ui:panel', { id, open: false });
  }

  toggle(id) { this.current === id ? this.close() : this.open(id); }

  render(id) {
    switch (id) {
      case 'station': return this.renderStation();
      case 'consist': return this.renderConsist();
      case 'map': return this.renderMap();
      case 'career': return this.renderCareer();
      case 'shop': return this.renderShop();
      case 'settings': return this.renderSettings();
      case 'help': return this.renderHelp();
      case 'pause': return this.renderPause();
      default: return null;
    }
  }

  /* ============================================================ station */
  renderStation() {
    const g = this.game;
    const sheet = this.sheets.get('station');
    clear(sheet);
    const st = this.arg ? g.stations.get(this.arg) : g.stations.current || g.stations.at(g.train)?.station;
    if (!st) {
      sheet.appendChild(h('div', { class: 'empty', text: 'You are not at a station.' }));
      sheet.appendChild(button('Close', () => this.close(), 'btn ghost'));
      return;
    }

    sheet.appendChild(h('header', { class: 'sheet-head' }, [
      h('div', {}, [
        h('h2', { text: st.name }),
        h('div', { class: 'sub', text: `${st.type} · ${st.region} region · ${st.def.blurb || ''}` }),
      ]),
      h('div', { class: 'rep' }, [
        h('span', { class: 'replabel', text: 'Reputation' }),
        h('div', { class: 'stars' }, Array.from({ length: 5 }, (_, i) =>
          h('i', { class: `star${i < Math.floor(st.rep) ? ' on' : ''}` }))),
        h('span', { class: 'repval', text: st.rep.toFixed(1) }),
      ]),
      button('Close  [Esc]', () => this.close(), 'btn ghost close'),
    ]));

    const body = h('div', { class: 'sheet-body cols' });

    /* --- left: the board */
    const left = h('section', { class: 'col' });
    left.appendChild(h('h3', { text: 'Contract board' }));
    const board = g.contracts.board(st.id);
    if (!board.length) {
      g.contracts.rollFor(st.id);
    }
    const list = g.contracts.board(st.id);
    if (!list.length) left.appendChild(h('div', { class: 'empty', text: 'No work posted right now. Check back in an hour.' }));
    for (const c of list) {
      const card = h('div', { class: `offer${c.fragile ? ' fragile' : ''}${c.kind === 'passenger' ? ' passenger' : ''}` }, [
        h('div', { class: 'otop' }, [
          h('span', { class: 'ocargo', text: `${c.cargoLabel}` }),
          h('span', { class: 'opay', text: formatMoney(c.pay) }),
        ]),
        h('div', { class: 'ometa', text: `${c.cars} × ${c.carType} · ${c.tons} t · ${c.km} km to ${c.destName}` }),
        h('div', { class: 'ometa dim', text: `${c.wanted ? 'Wanted there' : 'No market there — discount'} · ${c.fragile ? 'fragile, handle gently' : 'bulk'} · deadline ${Math.round((c.deadline - c.issued) / 60)} h` }),
        h('div', { class: 'oactions' }, [
          button('Accept', () => {
            const taken = g.contracts.accept(c.id, { stationId: st.id, train: g.train });
            if (taken) this.renderStation();
          }, 'btn primary'),
          button('Decline', () => { g.contracts.decline(c.id, st.id); g.contracts.rollFor(st.id); this.renderStation(); }, 'btn ghost'),
        ]),
      ]);
      left.appendChild(card);
    }

    /* --- active contracts */
    const active = g.contracts.summary();
    if (active.length) {
      left.appendChild(h('h3', { text: 'Your contracts' }));
      for (const c of active) {
        left.appendChild(h('div', { class: `offer active${c.late ? ' late' : ''}` }, [
          h('div', { class: 'otop' }, [
            h('span', { class: 'ocargo', text: `${c.cargoLabel} → ${c.destName}` }),
            h('span', { class: 'opay', text: formatMoney(c.pay) }),
          ]),
          h('div', { class: 'ometa', text: `${c.deliveredCars}/${c.cars} cars delivered · ${Math.round(c.deliveredTons)}/${c.tons} t · ${c.km} km` }),
          h('div', { class: `ometa ${c.late ? 'bad' : c.urgent ? 'warn' : 'dim'}`, text: c.late ? 'OVERDUE' : `${Math.floor(c.minutesLeft / 60)}h ${String(Math.max(0, c.minutesLeft % 60)).padStart(2, '0')}m remaining` }),
        ]));
      }
    }
    body.appendChild(left);

    /* --- right: the yard */
    const right = h('section', { class: 'col' });
    right.appendChild(h('h3', { text: 'Yard stock' }));
    const offers = g.stations.offers(st);
    if (!offers.length) right.appendChild(h('div', { class: 'empty', text: 'The yard is empty — it restocks over the working day.' }));
    for (const o of offers) {
      right.appendChild(h('div', { class: 'stockrow' }, [
        h('i', { class: 'dot', style: { background: `#${o.cargo ? (CARGO[o.cargo]?.color ?? 0x888888).toString(16).padStart(6, '0') : '888888'}` } }),
        h('span', { class: 'sname', text: o.label }),
        h('span', { class: 'scar', text: o.car }),
        h('span', { class: 'stons', text: `${o.tons} t` }),
        h('span', { class: 'sprice', text: `${o.perTon.toFixed(2)}/t` }),
      ]));
    }

    right.appendChild(h('h3', { text: 'Wanted here' }));
    for (const w of g.stations.wants(st)) {
      right.appendChild(h('div', { class: 'stockrow' }, [
        h('i', { class: 'dot', style: { background: `#${(CARGO[w.cargo]?.color ?? 0x888888).toString(16).padStart(6, '0')}` } }),
        h('span', { class: 'sname', text: w.label }),
        h('span', { class: 'sprice', text: `×${w.price.toFixed(2)}` }),
        h('span', { class: 'stons dim', text: `${w.received} t received` }),
      ]));
    }

    if (g.passengers?.unlocked) {
      right.appendChild(h('h3', { text: 'Passengers' }));
      right.appendChild(h('div', { class: 'stockrow' }, [
        h('span', { class: 'sname', text: 'Waiting' }),
        h('span', { class: 'stons', text: `${g.passengers.waitingAt(st.id)}` }),
        h('span', { class: 'sprice dim', text: `satisfaction ${Math.round(g.passengers.satisfaction)}%` }),
      ]));
    }

    right.appendChild(h('h3', { text: 'Actions' }));
    const actions = h('div', { class: 'actions' });
    actions.appendChild(button('Load cars for my contracts', () => {
      const r = g.contracts.loadTrain(g.train, st);
      if (!r.cars) bus.emit('notify', { kind: 'warn', text: 'No compatible empty cars in your consist, or nothing left to load.' });
      this.renderStation();
    }, 'btn'));
    actions.appendChild(button('Sell everything aboard', () => {
      const r = g.contracts.deliver(g.train, st.id);
      if (r && r.pay > 0) bus.emit('notify', { kind: 'good', text: `Sold ${formatMoney(r.pay)} of cargo at ${st.name}.` });
      else if (r && !r.accepted.length && !r.ignored.length) bus.emit('notify', { kind: 'info', text: 'Nothing to sell — your cars are empty.' });
      this.renderStation();
    }, 'btn'));
    actions.appendChild(button('Consist & uncoupling', () => this.open('consist'), 'btn ghost'));
    actions.appendChild(button('Depot & upgrades', () => this.open('shop'), 'btn ghost'));
    actions.appendChild(button('Save here', () => { g.save.save(g.save.lastSlot === 'auto' ? 1 : g.save.lastSlot); this.renderStation(); }, 'btn ghost'));
    right.appendChild(actions);
    body.appendChild(right);

    sheet.appendChild(body);
  }

  /* ============================================================ consist */
  renderConsist() {
    const g = this.game;
    const sheet = this.sheets.get('consist');
    clear(sheet);
    const train = g.train;
    sheet.appendChild(h('header', { class: 'sheet-head' }, [
      h('div', {}, [
        h('h2', { text: 'Consist' }),
        h('div', { class: 'sub', text: train.empty ? 'Nothing coupled.' : `${train.vehicles.length} units · ${Math.round(train.tonnes)} t · ${Math.round(train.length)} m · ${Math.round(train.powerW / 745.7).toLocaleString()} hp` }),
      ]),
      button('Close  [Esc]', () => this.close(), 'btn ghost close'),
    ]));

    const body = h('div', { class: 'sheet-body' });
    const list = h('div', { class: 'carlist' });
    train.vehicles.forEach((v, i) => {
      const row = h('div', { class: `carrow ${v.isLoco ? 'loco' : ''}` }, [
        h('span', { class: 'cidx', text: String(i + 1) }),
        h('span', { class: 'cname', text: v.isLoco ? `${v.name} #${v.number || ''}` : v.name }),
        h('span', { class: 'ccargo', text: v.cargo ? `${CARGO[v.cargo]?.label || v.cargo} · ${Math.round(v.tons)} t` : 'empty' }),
        h('span', { class: 'ccond', text: v.isLoco ? '' : `${Math.round(v.condition)}%` }),
        h('span', { class: 'cmass', text: `${(v.mass / 1000).toFixed(0)} t` }),
      ]);
      if (!v.isLoco && i < train.vehicles.length) {
        row.appendChild(button('Uncouple here', () => {
          const off = train.decouple(i, g.stock);
          if (off?.length) {
            bus.emit('notify', { kind: 'info', text: `${off.length} car(s) left on the rails.` });
            this.renderConsist();
          }
        }, 'btn tiny'));
      }
      list.appendChild(row);
    });
    body.appendChild(list);

    const hints = h('div', { class: 'hints' }, [
      h('p', { text: 'Couple by driving gently into a standing car (under 6 km/h). Uncouple from the cab with Q — it drops everything behind the locomotive.' }),
      h('p', { text: 'Brake rigging runs front to rear: the longer the train, the longer it takes to stop. Keep heavy cars ahead of light ones where you can.' }),
    ]);
    body.appendChild(hints);
    sheet.appendChild(body);
  }

  /* ================================================================ map */
  renderMap() {
    const g = this.game;
    const sheet = this.sheets.get('map');
    clear(sheet);
    sheet.appendChild(h('header', { class: 'sheet-head' }, [
      h('div', {}, [h('h2', { text: 'The Iron Reaches' }), h('div', { class: 'sub', text: `${(WORLD.size / 1000).toFixed(0)} km × ${(WORLD.size / 1000).toFixed(0)} km · ${(g.net.totalLength / 1000).toFixed(1)} km of track` })]),
      button('Close  [M]', () => this.close(), 'btn ghost close'),
    ]));

    const wrap = h('div', { class: 'mapwrap' });
    const canvas = h('canvas', { class: 'mapcanvas', width: '1100', height: '760' });
    wrap.appendChild(canvas);
    const legend = h('div', { class: 'legend' });
    const side = h('aside', { class: 'mapside' }, [legend]);
    wrap.appendChild(side);
    sheet.appendChild(wrap);

    const polylines = g.net.mapPolylines();
    const draw = () => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;   // no 2D context (headless, or a browser that refuses)
      const W = canvas.width, H = canvas.height;
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#0f1519';
      ctx.fillRect(0, 0, W, H);
      const s = Math.min(W, H) / WORLD.size;
      const tx = (x) => W / 2 + x * s;
      const tz = (z) => H / 2 + z * s;

      // region washes
      const regions = { plains: '#1c2a1c', forest: '#15261c', coastal: '#152230', alpine: '#22262c' };
      for (const [name, col] of Object.entries(regions)) {
        ctx.fillStyle = col;
        ctx.globalAlpha = g.progression.isRegionOpen(name) ? 0.55 : 0.18;
        const boxes = { plains: [-8000, -1200, 8000, 2600], forest: [-8000, 2600, 1400, 8000], coastal: [-8000, -8000, -1400, -1200], alpine: [1400, 2600, 8000, 8000] };
        const b = boxes[name];
        ctx.fillRect(tx(b[0]), tz(b[1]), (b[2] - b[0]) * s, (b[3] - b[1]) * s);
      }
      ctx.globalAlpha = 1;

      // track
      for (const pl of polylines) {
        const open = g.progression.isRegionOpen(pl.region);
        ctx.strokeStyle = open ? (pl.kind === 'siding' ? '#9a8f6c' : '#d8c795') : '#5a5148';
        ctx.lineWidth = open ? (pl.kind === 'siding' ? 1.7 : 2.5) : 1.5;
        ctx.setLineDash(open ? [] : [6, 5]);
        ctx.beginPath();
        pl.pts.forEach(([x, z], i) => (i ? ctx.lineTo(tx(x), tz(z)) : ctx.moveTo(tx(x), tz(z))));
        ctx.stroke();
      }
      ctx.setLineDash([]);

      // stations
      for (const st of g.stations.list) {
        const x = tx(st.pos.x), z = tz(st.pos.z);
        ctx.fillStyle = g.progression.isRegionOpen(st.region) ? '#f0e6d2' : '#6b6459';
        ctx.beginPath(); ctx.arc(x, z, 6, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#0f1519'; ctx.lineWidth = 1.5; ctx.stroke();
        ctx.fillStyle = '#e8e2d4';
        ctx.font = '13px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(st.name, x, z - 11);
        ctx.fillStyle = '#9fb0a4';
        ctx.font = '11px ui-monospace, monospace';
        ctx.fillText(`rep ${st.rep.toFixed(1)}`, x, z + 19);
      }

      // AI trains
      for (const b of g.ai?.blips?.() || []) {
        ctx.fillStyle = '#e0a33c';
        ctx.beginPath(); ctx.arc(tx(b.x), tz(b.z), 4.5, 0, Math.PI * 2); ctx.fill();
      }

      // player
      const p = g.train?.state ? g.net.positionOf(g.train.state, _tmpV) : null;
      if (p) {
        ctx.save();
        ctx.translate(tx(p.x), tz(p.z));
        ctx.fillStyle = '#7fd4ff';
        ctx.strokeStyle = '#0f1519'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(0, 0, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.restore();
      }

      // legend
      clear(legend);
      legend.appendChild(h('h3', { text: 'Legend' }));
      for (const [label, color] of [['Your train', '#7fd4ff'], ['AI traffic', '#e0a33c'], ['Station', '#f0e6d2'], ['Open line', '#c8b98a'], ['Locked line', '#5a5148']]) {
        legend.appendChild(h('div', { class: 'lrow' }, [h('i', { class: 'sw', style: { background: color } }), h('span', { text: label })]));
      }
      legend.appendChild(h('h3', { text: 'Regions' }));
      for (const r of ['plains', 'forest', 'coastal', 'alpine']) {
        legend.appendChild(h('div', { class: 'lrow' }, [
          h('i', { class: `sw${g.progression.isRegionOpen(r) ? ' open' : ''}` }),
          h('span', { text: `${r}${g.progression.isRegionOpen(r) ? '' : ' — locked'}` }),
        ]));
      }
      const active = g.contracts.summary();
      if (active.length) {
        legend.appendChild(h('h3', { text: 'Contracts' }));
        for (const c of active) {
          legend.appendChild(h('div', { class: 'lrow' }, [
            h('i', { class: 'sw', style: { background: `#${(CARGO[c.cargo]?.color ?? 0x888888).toString(16).padStart(6, '0')}` } }),
            h('span', { text: `${c.cargoLabel} → ${c.destName}` }),
          ]));
          // draw the destination marker on the map
          const dst = g.stations.get(c.dest);
          if (dst) {
            const ctx2 = ctx;
            ctx2.strokeStyle = '#7fd4ff'; ctx2.lineWidth = 2;
            ctx2.beginPath(); ctx2.arc(tx(dst.pos.x), tz(dst.pos.z), 13, 0, Math.PI * 2); ctx2.stroke();
          }
        }
      }
    };
    draw();
    this._mapDraw = draw;
    this._mapTimer = setInterval(draw, 900);
    const stop = () => { clearInterval(this._mapTimer); this._mapTimer = null; bus.off('ui:panel', stop); };
    bus.on('ui:panel', (e) => { if (!e.open || e.id !== 'map') stop(); });
  }

  /* ============================================================= career */
  renderCareer() {
    const g = this.game;
    const sheet = this.sheets.get('career');
    clear(sheet);
    const e = g.economy;
    sheet.appendChild(h('header', { class: 'sheet-head' }, [
      h('div', {}, [h('h2', { text: 'Career' }), h('div', { class: 'sub', text: `${g.progression.rank} · ${e.stamp()} · ${formatMoney(e.credits)}` })]),
      button('Close', () => this.close(), 'btn ghost close'),
    ]));
    const body = h('div', { class: 'sheet-body cols' });

    const stats = h('section', { class: 'col' }, [
      h('h3', { text: 'Ledger' }),
      ...[
        ['Credits', formatMoney(e.credits)],
        ['Earned', formatMoney(e.earned)],
        ['Spent', formatMoney(e.spent)],
        ['Deliveries', String(e.deliveries)],
        ['Timed bonuses', String(e.timedBonuses)],
        ['Play time', `${Math.floor(g.save.playtime / 60)}m ${Math.floor(g.save.playtime % 60)}s`],
        ['Distance run', `${(g.train?.tripKm || 0).toFixed(1)} km this trip`],
      ].map(([k, v]) => h('div', { class: 'row' }, [h('span', { class: 'k', text: k }), h('span', { class: 'v', text: v })])),
      h('h3', { text: 'Recent entries' }),
      h('div', { class: 'ledger' }, e.ledger.slice(-12).reverse().map((l) =>
        h('div', { class: `lrow ${l.amount >= 0 ? 'good' : 'bad'}` }, [
          h('span', { text: l.reason }),
          h('span', { text: formatMoney(l.amount) }),
        ]))),
    ]);
    body.appendChild(stats);

    const miles = h('section', { class: 'col' }, [h('h3', { text: 'Milestones' })]);
    for (const m of g.progression.table()) {
      miles.appendChild(h('div', { class: `mile${m.done ? ' done' : ''}` }, [
        h('div', { class: 'mtop' }, [h('b', { text: m.name }), m.done ? h('span', { class: 'tick', text: '✓' }) : null]),
        h('div', { class: 'mdesc', text: m.desc }),
        m.progress && !m.done ? h('div', { class: 'mprog', text: m.progress }) : null,
      ]));
    }
    miles.appendChild(h('h3', { text: 'Reputation' }));
    for (const r of g.stations.reputationTable()) {
      miles.appendChild(h('div', { class: 'row' }, [
        h('span', { class: 'k', text: r.name }),
        h('span', { class: 'v' }, [
          h('span', { class: 'stars small' }, Array.from({ length: 5 }, (_, i) => h('i', { class: `star${i < Math.floor(r.rep) ? ' on' : ''}` }))),
          h('span', { text: ` ${r.rep.toFixed(1)}` }),
        ]),
      ]));
    }
    body.appendChild(miles);
    sheet.appendChild(body);
  }

  /* ============================================================== shop */
  renderShop() {
    const g = this.game;
    const sheet = this.sheets.get('shop');
    clear(sheet);
    sheet.appendChild(h('header', { class: 'sheet-head' }, [
      h('div', {}, [h('h2', { text: 'Depot & upgrades' }), h('div', { class: 'sub', text: `Credits ${formatMoney(g.economy.credits)} · repairs and iron are bought at any station` })]),
      button('Close', () => this.close(), 'btn ghost close'),
    ]));
    const body = h('div', { class: 'sheet-body cols' });

    const up = h('section', { class: 'col' }, [h('h3', { text: 'Upgrades' })]);
    for (const u of g.upgrades.table()) {
      const card = h('div', { class: 'upg' }, [
        h('div', { class: 'utop' }, [
          h('b', { text: u.label }),
          h('span', { class: 'tier', text: `tier ${u.level}/${u.max}` }),
        ]),
        h('div', { class: 'udesc', text: u.maxed ? 'Fully upgraded.' : u.desc }),
        h('div', { class: 'tiers' }, u.tiers.map((t) => h('i', { class: `pip${t.owned ? ' on' : ''}`, title: `${formatMoney(t.cost)} — ${t.desc}` }))),
        u.maxed ? null : button(`${formatMoney(u.cost)} — buy`, () => {
          if (g.upgrades.buy(u.id)) this.renderShop();
        }, `btn ${u.affordable ? 'primary' : 'disabled'}`),
      ]);
      up.appendChild(card);
    }
    up.appendChild(h('h3', { text: 'Repairs' }));
    const damaged = g.train.vehicles.filter((v) => v.condition < 99.5);
    if (!damaged.length) up.appendChild(h('div', { class: 'empty', text: 'Every car is in good order.' }));
    for (const v of damaged) {
      const pts = Math.round(100 - v.condition);
      const cost = Math.round(pts * ECONOMY.repairCostPerPoint);
      up.appendChild(h('div', { class: 'row' }, [
        h('span', { class: 'k', text: `${v.name} — ${Math.round(v.condition)}%` }),
        h('span', { class: 'v' }, [button(`Repair ${formatMoney(cost)}`, () => {
          if (g.economy.spend(cost, 'repair')) { v.condition = 100; bus.emit('notify', { kind: 'good', text: `${v.name} repaired.` }); this.renderShop(); }
        }, 'btn tiny'), ' ']),
      ]));
    }
    body.appendChild(up);

    const depot = h('section', { class: 'col' }, [h('h3', { text: 'Locomotives' })]);
    for (const spec of Object.values(LOCOMOTIVES)) {
      const owned = g.progression.isLocoOwned(spec.id);
      depot.appendChild(h('div', { class: `loco${owned ? ' owned' : ' locked'}` }, [
        h('div', { class: 'utop' }, [h('b', { text: spec.name }), h('span', { class: 'tier', text: `${spec.powerHP} hp · ${spec.maxSpeed} km/h · ${spec.maxCars} cars` })]),
        h('div', { class: 'udesc', text: spec.desc }),
        owned
          ? (spec.cost ? button(`Buy another — ${formatMoney(spec.cost)}`, () => this._buyLoco(spec), `btn ${g.economy.canAfford(spec.cost) ? 'primary' : 'disabled'}`) : h('span', { class: 'tick', text: 'in service' }))
          : h('span', { class: 'lockedtext', text: `Locked — ${spec.unlock}` }),
      ]));
    }
    depot.appendChild(h('h3', { text: 'Rolling stock' }));
    depot.appendChild(h('div', { class: 'empty', text: 'Freight cars are found in yards and sidings across the map — couple up to them and take them with you.' }));
    depot.appendChild(h('div', { class: 'actions' }, [
      button('Buy a boxcar — ' + formatMoney(600), () => this._buyCar('boxcar', 600), 'btn'),
      button('Buy a hopper — ' + formatMoney(650), () => this._buyCar('hopper', 650), 'btn'),
      button('Buy a flatbed — ' + formatMoney(580), () => this._buyCar('flatbed', 580), 'btn'),
      button('Buy a tanker — ' + formatMoney(720), () => this._buyCar('tanker', 720), 'btn'),
      button('Buy a gondola — ' + formatMoney(640), () => this._buyCar('gondola', 640), 'btn'),
    ]));
    body.appendChild(depot);
    sheet.appendChild(body);
  }

  /** Park a newly bought vehicle on the nearest siding, or behind the train. */
  _spawnAtStation(vehicle) {
    const g = this.game;
    const st = g.stations.current || g.stations.at(g.train)?.station;
    let state = null;
    if (st?.def.sidings?.length) {
      const sid = st.def.sidings[0];
      const seg = g.net.segmentById(sid.seg);
      if (seg) state = g.net.makeState(seg.id, clamp01((sid.from || 20) / seg.length), 1);
    }
    if (!state && g.train?.state) {
      state = g.net.cloneState(g.train.state);
      g.net.advance(state, -(g.train.length + 30));
    }
    if (!state) {
      bus.emit('notify', { kind: 'warn', text: 'Nowhere to put it — drive to a station first.' });
      g.stock.remove(vehicle);
      return false;
    }
    vehicle.build(g.assets);
    if (vehicle.group && !vehicle.group.parent) g.scene.add(vehicle.group);
    g.stock.park(vehicle, state);
    return true;
  }

  _buyLoco(spec) {
    const g = this.game;
    if (!g.economy.spend(spec.cost, `locomotive:${spec.id}`)) return;
    const v = g.stock.loco(spec.id, { number: 100 + Math.floor(Math.random() * 900) });
    if (this._spawnAtStation(v)) bus.emit('notify', { kind: 'good', text: `${spec.name} delivered to the yard.` });
    this.renderShop();
  }

  _buyCar(typeKey, cost) {
    const g = this.game;
    if (!g.economy.spend(cost, `car:${typeKey}`)) return;
    const v = g.stock.car(typeKey, {});
    if (this._spawnAtStation(v)) bus.emit('notify', { kind: 'good', text: `New ${v.name} left in the yard.` });
    this.renderShop();
  }

  /* =========================================================== settings */
  renderSettings() {
    const g = this.game;
    const sheet = this.sheets.get('settings');
    clear(sheet);
    const s = g.settings;
    sheet.appendChild(h('header', { class: 'sheet-head' }, [
      h('div', {}, [h('h2', { text: 'Settings' })]),
      button('Close', () => this.close(), 'btn ghost close'),
    ]));
    const body = h('div', { class: 'sheet-body cols' });

    const gfx = h('section', { class: 'col' }, [h('h3', { text: 'Graphics' })]);
    const qrow = h('div', { class: 'row' }, [h('span', { class: 'k', text: 'Quality preset' })]);
    const qbtns = h('span', { class: 'v segs' });
    for (const p of ['low', 'medium', 'high']) {
      qbtns.appendChild(button(p, () => { s.quality = p; g.applyQuality(p); this.renderSettings(); }, `btn tiny${s.quality === p ? ' on' : ''}`));
    }
    qrow.appendChild(qbtns);
    gfx.appendChild(qrow);
    gfx.appendChild(this._toggle('Post processing', s.post, (v) => { s.post = v; if (g.postFX) g.postFX.enabled = v; }));
    gfx.appendChild(this._toggle('Bloom', s.bloom, (v) => { s.bloom = v; if (g.postFX) g.postFX.bloom.enabled = v; }));
    gfx.appendChild(this._slider('Draw distance', s.drawDistance, 1200, 12000, 200, 'm', (v) => { s.drawDistance = v; g.applyDrawDistance(v); }));
    gfx.appendChild(this._slider('Vegetation density', s.vegetation, 0.2, 1.8, 0.1, '×', (v) => { s.vegetation = v; g.world?.vegetation.setDensity(v); }));
    gfx.appendChild(this._slider('Resolution scale', s.pixelRatio, 0.6, 1.6, 0.05, '×', (v) => { s.pixelRatio = v; g.applyPixelRatio(v); }));
    gfx.appendChild(this._toggle('Shadows', s.shadows, (v) => {
      s.shadows = v;
      if (g.renderer) g.renderer.shadowMap.enabled = v;
      g.world?.track.invalidate();
      g.world?.vegetation.invalidate?.();
    }));
    body.appendChild(gfx);

    const audio = h('section', { class: 'col' }, [h('h3', { text: 'Audio' })]);
    for (const k of ['master', 'engine', 'effects', 'ambient', 'ui']) {
      audio.appendChild(this._slider(k[0].toUpperCase() + k.slice(1), g.audio.volumes[k], 0, 1, 0.05, '', (v) => { g.audio.setVolume(k, v); }));
    }
    audio.appendChild(h('h3', { text: 'Controls' }));
    audio.appendChild(this._slider('Mouse sensitivity', s.sensitivity, 0.3, 2.5, 0.05, '×', (v) => { s.sensitivity = v; g.cameraCtl.sensitivity = v; }));
    audio.appendChild(this._toggle('Invert look Y', s.invertY, (v) => { s.invertY = v; }));
    audio.appendChild(h('h3', { text: 'Simulation' }));
    audio.appendChild(this._slider('Time scale', g.economy.timeScale, 1, 24, 1, '×', (v) => { g.economy.timeScale = v; }));
    audio.appendChild(this._toggle('Tutorial', g.settings.tutorial, (v) => { g.settings.tutorial = v; g.tutorial.enabled = v; if (!v) g.tutorial.skip(); }));
    audio.appendChild(this._slider('AI traffic', g.ai.target, 0, 6, 1, ' trains', (v) => { g.ai.setCount(v); }));
    const wx = h('div', { class: 'row' }, [h('span', { class: 'k', text: 'Force weather' })]);
    const wxbtns = h('span', { class: 'v segs wrap' });
    for (const id of ['clear', 'cloudy', 'rain', 'storm', 'fog', 'snow']) {
      wxbtns.appendChild(button(id, () => { g.weather.setWeather(id); this.renderSettings(); }, `btn tiny${g.weather.id === id ? ' on' : ''}`));
    }
    wx.appendChild(wxbtns);
    audio.appendChild(wx);
    audio.appendChild(this._toggle('Auto weather', g.weather.auto, (v) => { g.weather.auto = v; }));
    body.appendChild(audio);
    sheet.appendChild(body);
  }

  _toggle(label, value, onChange) {
    const box = h('i', { class: `check${value ? ' on' : ''}` });
    const row = h('div', { class: 'row togglerow' }, [h('span', { class: 'k', text: label }), box]);
    row.addEventListener('click', () => {
      const next = !box.classList.contains('on');
      setClass(box, 'on', next);
      onChange(next);
      bus.emit('ui:click', {});
    });
    return row;
  }

  _slider(label, value, min, max, step, suffix, onChange) {
    const out = h('span', { class: 'v', text: `${value}${suffix}` });
    const input = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) });
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      setText(out, `${Math.round(v * 100) / 100}${suffix}`);
      onChange(v);
    });
    return h('div', { class: 'row sliderrow' }, [h('span', { class: 'k', text: label }), h('span', { class: 'slider' }, [input, out])]);
  }

  /* =============================================================== help */
  renderHelp() {
    const sheet = this.sheets.get('help');
    clear(sheet);
    sheet.appendChild(h('header', { class: 'sheet-head' }, [
      h('div', {}, [h('h2', { text: 'Controls' }), h('div', { class: 'sub', text: 'Everything is on the keyboard; the mouse only steers the camera.' })]),
      button('Close', () => this.close(), 'btn ghost close'),
    ]));
    const groups = {
      'Driving': [['W / ↑', 'throttle up'], ['S / ↓', 'throttle down'], ['Space', 'air brake (hold)'], ['B', 'emergency brake'], ['R', 'reverser forward / back / neutral'], ['X', 'dynamic brake'], ['Z', 'sanders'], ['H', 'horn'], ['L', 'bell'], ['F', 'headlights']],
      'Working': [['Tab', 'cycle the route at the junction ahead'], ['E', 'station board / interact'], ['Q', 'uncouple everything behind the locomotive'], ['Shift + Q', 'uncouple the last car only'], ['C', 'cycle camera'], ['1-4', 'camera: chase / cab / orbit / trackside'], ['P', 'photo mode'], ['M', 'map'], ['J', 'career'], ['U', 'depot & upgrades'], ['F3', 'debug overlay']],
      'System': [['Esc', 'pause menu / close panel'], ['F5', 'quick save'], ['F9', 'quick load']],
    };
    const body = h('div', { class: 'sheet-body cols' });
    for (const [title, rows] of Object.entries(groups)) {
      const sec = h('section', { class: 'col' }, [h('h3', { text: title })]);
      for (const [key, what] of rows) {
        sec.appendChild(h('div', { class: 'row keyrow' }, [h('kbd', { text: key }), h('span', { class: 'v', text: what })]));
      }
      body.appendChild(sec);
    }
    const tips = h('section', { class: 'col' }, [
      h('h3', { text: 'How to make money' }),
      h('p', { text: 'Take a contract at the station you are standing in. Compatible empty cars in your consist are loaded from the yard immediately. Run it to the destination and stop — the cargo sells itself, and arriving early pays a time bonus.' }),
      h('p', { text: 'Cargo a station does not want still sells, but at a discount and without earning reputation. Reputation opens regions; regions open longer, better-paid runs.' }),
      h('p', { text: 'Fragile loads — machine parts, food, fish, passengers — lose condition when you handle them roughly. Emergency brakes, buffer stops and derailments all cost you the condition bonus.' }),
      h('h3', { text: 'How not to derail' }),
      h('p', { text: 'Every segment has a speed limit, shown top-left of the speed readout. Curves have their own lower limit. Exceed either by too much and the wheels climb the rail.' }),
      h('p', { text: 'Wet rail grips less. In rain, snow or fog, ease the throttle and brake earlier — the adhesion table is unforgiving on the mountain.' }),
      h('p', { text: 'Air brakes propagate front to rear. A twenty-car train needs a kilometre to stop; start braking for the platform early.' }),
    ]);
    body.appendChild(tips);
    sheet.appendChild(body);
  }

  /* ============================================================== pause */
  renderPause() {
    const g = this.game;
    const sheet = this.sheets.get('pause');
    clear(sheet);
    sheet.appendChild(h('div', { class: 'pausebox' }, [
      h('h2', { text: 'Paused' }),
      h('div', { class: 'sub', text: `${g.economy.stamp()} · ${formatMoney(g.economy.credits)} · ${g.progression.rank}` }),
      h('div', { class: 'actions col' }, [
        button('Resume', () => this.close(), 'btn primary big'),
        button('Station board', () => this.open('station'), 'btn big'),
        button('Consist', () => this.open('consist'), 'btn big'),
        button('Map', () => this.open('map'), 'btn big'),
        button('Career', () => this.open('career'), 'btn big'),
        button('Depot & upgrades', () => this.open('shop'), 'btn big'),
        button('Settings', () => this.open('settings'), 'btn big'),
        button('Controls', () => this.open('help'), 'btn big'),
        h('div', { class: 'saverow' }, [
          button('Save → slot 1', () => { g.save.save(1); this.renderPause(); }, 'btn'),
          button('Save → slot 2', () => { g.save.save(2); this.renderPause(); }, 'btn'),
          button('Save → slot 3', () => { g.save.save(3); this.renderPause(); }, 'btn'),
        ]),
        h('div', { class: 'saverow' }, g.save.list().filter((s) => s.exists && s.slot !== 'auto').map((s) =>
          button(`Load slot ${s.slot} — ${s.meta?.rank || ''} ${formatMoney(s.meta?.credits || 0)}`, () => {
            g.loadSave(s.slot);
            this.close();
          }, 'btn ghost'))),
        button('Quit to title', () => { g.save.save('auto'); g.toTitle(); }, 'btn ghost big'),
      ]),
    ]));
  }
}

export default Panels;
