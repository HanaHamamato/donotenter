/**
 * TitleScreen — the front door (GDD §6.5 menus).
 *
 * The world keeps rendering behind it, so the title sits over a live view of
 * the railway at whatever time of day the save left it. New Game starts a
 * career; Continue and the slot list resume one; Settings and Controls open the
 * same sheets the pause menu uses.
 */
import { h, setText, setClass, clear, button } from './dom.js';
import { formatMoney } from '../utils/math.js';
import { bus } from '../utils/events.js';

export class TitleScreen {
  constructor(root, game) {
    this.root = root;
    this.game = game;
    this.visible = false;
    this.el = h('div', { class: 'title hidden' });
    this.root.appendChild(this.el);
    this.build();
  }

  build() {
    clear(this.el);
    const stage = h('div', { class: 'titlestage' });

    stage.appendChild(h('div', { class: 'titles' }, [
      h('div', { class: 'eyebrow', text: 'AN OPEN-WORLD RAILWAY' }),
      h('h1', { class: 'logo', text: 'IRONBOUND' }),
      h('div', { class: 'tagline', text: 'The Iron Reaches · 16 km of mountain, mill and coast · one train, one contract at a time' }),
    ]));

    this.menu = h('div', { class: 'titlemenu' });
    stage.appendChild(this.menu);

    this.slotsEl = h('div', { class: 'slots' });
    stage.appendChild(this.slotsEl);

    this.foot = h('div', { class: 'titlefoot', text: 'W/S throttle · Space brake · Tab points · E station board · M map · Esc menu' });
    stage.appendChild(this.foot);

    this.progress = h('div', { class: 'boot hidden' }, [
      h('div', { class: 'bootbar' }, [h('i', { class: 'fill' })]),
      h('div', { class: 'boottext', text: 'Building the railway…' }),
    ]);
    stage.appendChild(this.progress);

    this.el.appendChild(stage);
    this.render();
  }

  show(on) {
    this.visible = !!on;
    setClass(this.el, 'hidden', !on);
    if (on) this.render();
    this.game.input?.setEnabled?.(!on);
  }

  render() {
    const g = this.game;
    clear(this.menu);
    const saves = g.save?.available?.() ? g.save.list() : [];
    const hasAuto = saves.find((s) => s.slot === 'auto')?.exists;

    this.menu.appendChild(button('New Game', () => this._newGame(), 'btn primary big wide'));
    this.menu.appendChild(button(hasAuto ? 'Continue' : 'Continue (no autosave)', () => {
      if (hasAuto) g.loadSave('auto');
      this.show(false);
    }, `btn big wide${hasAuto ? '' : ' disabled'}`));
    this.menu.appendChild(button('Settings', () => g.panels.open('settings'), 'btn big wide'));
    this.menu.appendChild(button('Controls', () => g.panels.open('help'), 'btn big wide'));
    this.menu.appendChild(button('Credits', () => this._credits(), 'btn ghost big wide'));

    clear(this.slotsEl);
    for (const s of saves.filter((x) => x.slot !== 'auto')) {
      const row = h('div', { class: `slotrow${s.exists ? '' : ' empty'}` }, [
        h('div', { class: 'slotinfo' }, [
          h('b', { text: `Slot ${s.slot}` }),
          s.exists
            ? h('span', { text: `${s.meta?.rank || '—'} · ${formatMoney(s.meta?.credits || 0)} · Day ${s.meta?.day || 1} · ${s.meta?.deliveries || 0} deliveries · ${Math.floor((s.playtime || 0) / 60)}m played` })
            : h('span', { class: 'dim', text: 'empty' }),
        ]),
        h('div', { class: 'slotactions' }, [
          s.exists ? button('Load', () => { g.loadSave(s.slot); this.show(false); }, 'btn tiny') : null,
          button(s.exists ? 'Overwrite' : 'Save here', () => { g.save.save(s.slot); this.render(); }, 'btn tiny ghost'),
          s.exists ? button('Delete', () => { g.save.delete(s.slot); this.render(); }, 'btn tiny ghost') : null,
        ]),
      ]);
      this.slotsEl.appendChild(row);
    }
  }

  _newGame() {
    const g = this.game;
    bus.emit('notify', { kind: 'info', text: 'New career started at Millford Junction.', ttl: 6 });
    g.newGame();
    this.show(false);
  }

  _credits() {
    const g = this.game;
    g.panels.close();
    this.menu.innerHTML = '';
    this.menu.appendChild(h('div', { class: 'creditbox' }, [
      h('h3', { text: 'IRONBOUND' }),
      h('p', { text: 'An open-world train simulator built to the IRONBOUND design document.' }),
      h('p', { text: 'Everything you can see is generated at runtime: 56.8 km of spline track cut, filled, bridged and tunnelled through procedural terrain; fourteen tunnels; four bridges and viaducts; twelve stations with yards, industry and towns; instanced vegetation across four biomes; a twenty-minute day; weather that changes the grip under your wheels; and a procedural sound engine with no audio files in it at all.' }),
      h('p', { text: 'Rendered with three.js. No models, textures or samples ship with the game.' }),
      button('Back', () => this.render(), 'btn ghost'),
    ]));
  }

  /** Boot progress bar, driven from main.js while the world streams in. */
  setProgress(pct, text) {
    setClass(this.progress, 'hidden', false);
    this.progress.querySelector('.fill').style.width = `${Math.round(pct * 100)}%`;
    if (text) setText(this.progress.querySelector('.boottext'), text);
  }

  hideProgress() { setClass(this.progress, 'hidden', true); }
}

export default TitleScreen;
