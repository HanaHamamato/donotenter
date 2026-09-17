/**
 * Tiny DOM helper for the UI layer.
 *
 * The game is a canvas with a thin shell of HTML over it: no framework, no
 * virtual DOM, just elements created once and text written into them when the
 * numbers change. `h()` builds, `$()` finds, and `setText()` skips the write
 * when nothing changed so the HUD can be refreshed every frame without churn.
 */

export function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function setText(el, value) {
  if (!el) return;
  const s = String(value);
  if (el.textContent !== s) el.textContent = s;
}

export function setClass(el, name, on) {
  if (!el) return;
  el.classList.toggle(name, !!on);
}

export function clear(el) { while (el && el.firstChild) el.removeChild(el.firstChild); }

/** A labelled row: <div class="row"><span class="k">…</span><span class="v">…</span></div> */
export function row(label, value, cls = '') {
  return h('div', { class: `row ${cls}`.trim() }, [
    h('span', { class: 'k', text: label }),
    h('span', { class: 'v', text: value }),
  ]);
}

/** A horizontal bar with a fill element you can set `.style.width` on. */
export function bar(cls = '', fillPct = 0) {
  const fill = h('div', { class: 'fill', style: { width: `${fillPct * 100}%` } });
  const el = h('div', { class: `bar ${cls}`.trim() }, [fill]);
  el.fill = fill;
  el.set = (v, color) => {
    fill.style.width = `${Math.max(0, Math.min(1, v)) * 100}%`;
    if (color) fill.style.background = color;
  };
  return el;
}

/** A button that also pings the audio bus. */
export function button(label, onClick, cls = 'btn', title = null) {
  return h('button', {
    class: cls, type: 'button', title,
    onclick: (e) => { e.preventDefault(); onClick?.(e); },
    text: label,
  });
}

/** Request pointer lock release and mark a panel open (used for input gating). */
export function openOverlay(root, el) {
  root.appendChild(el);
  return el;
}

export default { h, $, $$, setText, setClass, clear, row, bar, button };
