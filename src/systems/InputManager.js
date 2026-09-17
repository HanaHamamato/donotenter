/**
 * InputManager — keyboard, mouse and pointer lock (GDD §6.2, §8 controls).
 *
 * Actions come from KEYBINDS in constants so rebinding is a data change, not a
 * code change. Two query flavours: `down(action)` for held state and
 * `pressed(action)` for a one-frame edge (edges are cleared by `endFrame()`,
 * which the main loop calls after every system has had its turn).
 */
import { KEYBINDS } from '../constants.js';
import { bus } from '../utils/events.js';

const CODE_TO_ACTION = (() => {
  const map = new Map();
  for (const [action, codes] of Object.entries(KEYBINDS)) {
    for (const code of codes) {
      if (!map.has(code)) map.set(code, []);
      map.get(code).push(action);
    }
  }
  return map;
})();

export class InputManager {
  constructor(target = typeof window !== 'undefined' ? window : null, opts = {}) {
    this.target = target;
    this.dom = opts.dom || (typeof document !== 'undefined' ? document.body : null);
    this.down_ = new Set();
    this.raw_ = new Set();
    this.pressed_ = new Set();
    this.released_ = new Set();
    this.enabled = true;
    this.pointerLocked = false;
    this.mouse = { dx: 0, dy: 0, x: 0, y: 0, wheel: 0, left: false, right: false, middle: false, dragX: 0, dragY: 0 };
    this.consumeMouse = opts.consumeMouse !== false;
    this.typingTarget = null;

    this._onKeyDown = (e) => this._key(e, true);
    this._onKeyUp = (e) => this._key(e, false);
    this._onMouseMove = (e) => this._move(e);
    this._onWheel = (e) => this._wheel(e);
    this._onDown = (e) => this._button(e, true);
    this._onUp = (e) => this._button(e, false);
    this._onLock = () => { this.pointerLocked = !!document.pointerLockElement; bus.emit('input:pointerlock', this.pointerLocked); };
    this._onBlur = () => { this.down_.clear(); this.raw_.clear(); this.mouse.left = this.mouse.right = false; };

    if (target) {
      target.addEventListener('keydown', this._onKeyDown);
      target.addEventListener('keyup', this._onKeyUp);
      target.addEventListener('blur', this._onBlur);
      target.addEventListener('mousemove', this._onMouseMove);
      target.addEventListener('wheel', this._onWheel, { passive: false });
      target.addEventListener('mousedown', this._onDown);
      target.addEventListener('mouseup', this._onUp);
      document.addEventListener('pointerlockchange', this._onLock);
    }
  }

  /** Ignore keystrokes while a text field has focus. */
  _isTyping() {
    const el = typeof document !== 'undefined' ? document.activeElement : null;
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  }

  _key(e, isDown) {
    if (isDown) this.raw_.add(e.code); else this.raw_.delete(e.code);
    if (this._isTyping() && e.code !== 'Escape') return;
    const actions = CODE_TO_ACTION.get(e.code);
    if (!actions) return;
    if (e.code === 'Tab' || actions.includes('junction')) e.preventDefault();
    if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    for (const a of actions) {
      if (isDown) {
        if (!e.repeat && !this.down_.has(a)) this.pressed_.add(a);
        if (!e.repeat) this.down_.add(a);
      } else {
        this.down_.delete(a);
        this.released_.add(a);
      }
    }
    if (!e.repeat) bus.emit(isDown ? 'input:down' : 'input:up', { code: e.code, actions });
  }

  _move(e) {
    this.mouse.x = e.clientX; this.mouse.y = e.clientY;
    if (this.pointerLocked) {
      this.mouse.dx += e.movementX || 0;
      this.mouse.dy += e.movementY || 0;
    } else if (this.mouse.left || this.mouse.right) {
      this.mouse.dragX += e.movementX || 0;
      this.mouse.dragY += e.movementY || 0;
    }
  }

  _wheel(e) {
    if (!this.enabled) return;
    if (this.consumeMouse && this.pointerLocked) e.preventDefault();
    this.mouse.wheel += Math.sign(e.deltaY) * Math.min(3, Math.abs(e.deltaY) / 60 + 0.4);
  }

  _button(e, isDown) {
    if (e.button === 0) this.mouse.left = isDown;
    if (e.button === 2) this.mouse.right = isDown;
    if (e.button === 1) this.mouse.middle = isDown;
    if (isDown) bus.emit('input:click', { button: e.button, x: e.clientX, y: e.clientY });
  }

  down(action) { return this.enabled && this.down_.has(action); }
  /** Raw KeyboardEvent.code state, for modes that need plain WASD (free fly). */
  keyDown(code) { return this.enabled && this.raw_.has(code); }
  pressed(action) { return this.enabled && this.pressed_.has(action); }
  released(action) { return this.enabled && this.released_.has(action); }
  anyPressed() { return this.pressed_.size > 0; }

  /** −1 / 0 / +1 from a pair of actions, e.g. throttle up/down. */
  axis(negAction, posAction) {
    return (this.down(posAction) ? 1 : 0) - (this.down(negAction) ? 1 : 0);
  }

  requestLock() {
    if (this.dom?.requestPointerLock && !this.pointerLocked) this.dom.requestPointerLock();
  }

  releaseLock() {
    if (typeof document !== 'undefined' && document.pointerLockElement) document.exitPointerLock();
  }

  /** Take this frame's accumulated mouse motion. */
  takeMouse() {
    const m = { ...this.mouse };
    this.mouse.dx = 0; this.mouse.dy = 0; this.mouse.dragX = 0; this.mouse.dragY = 0; this.mouse.wheel = 0;
    return m;
  }

  /** Call at the very end of the frame. */
  endFrame() {
    this.pressed_.clear();
    this.released_.clear();
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!on) { this.down_.clear(); this.raw_.clear(); this.releaseLock(); }
  }

  dispose() {
    const t = this.target;
    if (!t) return;
    t.removeEventListener('keydown', this._onKeyDown);
    t.removeEventListener('keyup', this._onKeyUp);
    t.removeEventListener('blur', this._onBlur);
    t.removeEventListener('mousemove', this._onMouseMove);
    t.removeEventListener('wheel', this._onWheel);
    t.removeEventListener('mousedown', this._onDown);
    t.removeEventListener('mouseup', this._onUp);
    document.removeEventListener('pointerlockchange', this._onLock);
  }
}

export default InputManager;
