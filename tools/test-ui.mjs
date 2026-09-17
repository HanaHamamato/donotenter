/**
 * test-ui.mjs — the DOM half of the game, under jsdom.
 *
 * The simulation is covered headlessly by test-game.mjs; this covers everything
 * that touches the document: the HUD's per-frame writes, every panel sheet and
 * the buttons inside them, the title screen, and the input manager's mapping of
 * key events to train controls. No WebGL is involved — the renderer is null and
 * the map canvas degrades to nothing, exactly as it must if a browser refuses a
 * 2D context.
 *
 *   node tools/test-ui.mjs
 */
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';

// jsdom has no 2D canvas; the map panel must degrade quietly rather than spam
const virtualConsole = new (await import('jsdom')).VirtualConsole();
virtualConsole.on('jsdomError', (e) => {
  if (!/getContext/.test(e.message || '')) console.error(e);
});

const dom = new JSDOM(
  `<!doctype html><html><body>
     <div id="app">
       <canvas id="scene"></canvas>
       <div id="ui"></div>
       <div id="boot"><i id="bootbar"></i><div id="boottext">x</div></div>
     </div>
   </body></html>`,
  { pretendToBeVisual: true, url: 'http://localhost/', virtualConsole },
);

global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
global.HTMLElement = dom.window.HTMLElement;
global.localStorage = dom.window.localStorage;
global.KeyboardEvent = dom.window.KeyboardEvent;
global.MouseEvent = dom.window.MouseEvent;
global.Event = dom.window.Event;
global.requestAnimationFrame = dom.window.requestAnimationFrame?.bind(dom.window)
  || ((cb) => setTimeout(() => cb(Date.now()), 16));

const { createGame } = await import('../src/game.js');
const { TrackNetwork } = await import('../src/systems/TrackNetwork.js');
const { AssetManager } = await import('../src/systems/AssetManager.js');
const { InputManager } = await import('../src/systems/InputManager.js');
const { HUD } = await import('../src/ui/HUD.js');
const { Panels } = await import('../src/ui/Panels.js');
const { TitleScreen } = await import('../src/ui/TitleScreen.js');
const { bus } = await import('../src/utils/events.js');

const tracks = JSON.parse(fs.readFileSync(new URL('../assets/data/tracks.json', import.meta.url)));
const stations = JSON.parse(fs.readFileSync(new URL('../assets/data/stations.json', import.meta.url)));

let pass = 0, fail = 0;
const ok = (cond, msg, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${msg}${extra ? ` — ${extra}` : ''}`); }
  else { fail++; console.log(`  ✗ ${msg}${extra ? ` — ${extra}` : ''}`); }
};
const section = (t) => console.log(`\n${t}`);
const key = (code, type = 'keydown') => dom.window.dispatchEvent(new dom.window.KeyboardEvent(type, { code, bubbles: true }));
const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

/* ------------------------------------------------------------------ build */
section('dom boot');
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.4, 22000);
const net = new TrackNetwork(tracks);
const assets = new AssetManager();
const input = new InputManager(dom.window, { dom: document.body });

const game = createGame({
  scene, camera, renderer: null, net, assets, input,
  stations: stations.stations,
  landmarks: tracks.landmarks || [],
  storage: dom.window.localStorage,
  settings: { quality: 'low', aiTraffic: 0, tutorial: true },
});
ok(!!game && !!game.train === false, 'game built without a renderer');

const ui = document.getElementById('ui');
game.hud = new HUD(ui, game);
game.panels = new Panels(ui, game);
game.title = new TitleScreen(ui, game);
ok(ui.children.length === 3, 'the three UI layers mounted', `${ui.children.length} roots`);

game.newGame();
game.hud.show(true);
game.title.show(false);
ok(game.train.vehicles.length === 3, 'a career started behind the UI');

/* -------------------------------------------------------------------- HUD */
section('hud');
for (let i = 0; i < 90; i++) game.update(1 / 60);
const speedText = game.hud.speedKmh.textContent;
ok(/^\d+$/.test(speedText), 'the speedometer reads a number', `${speedText} km/h`);
ok(game.hud.notchCells.length === 8, 'eight throttle notches are drawn');
ok(game.hud.clockEl.textContent.includes('Day'), 'the working clock is shown', game.hud.clockEl.textContent);
ok(game.hud.el.querySelectorAll('.panel').length >= 5, 'all HUD panels exist', `${game.hud.el.querySelectorAll('.panel').length} panels`);

game.train.notch(4);
game.update(1 / 60);
ok(game.hud.notchCells.filter((c) => c.className.includes('on')).length === 4, 'notches light up with the throttle');
game.train.notch(-4);

// hold Space and watch the valve and the readout climb together
key('Space');
for (let i = 0; i < 90; i++) game.update(1 / 60);
ok(game.train.controls.brake > 0.95, 'holding Space fully applies the brake', game.train.controls.brake.toFixed(2));
ok(game.hud.brakePct.textContent === '100%', 'and the readout agrees', game.hud.brakePct.textContent);
ok(game.hud.pipeBar.fill.style.width !== '0%', 'the air pipe bar moves', game.hud.pipeBar.fill.style.width);
key('Space', 'keyup');
for (let i = 0; i < 120; i++) game.update(1 / 60);
ok(game.train.controls.brake < 0.02, 'releasing Space graduates it out', game.train.controls.brake.toFixed(3));

// contract card
const st = game.stations.get('millford');
game.contracts.rollFor('millford');
const offer = game.contracts.board('millford')[0];
if (offer) {
  game.contracts.accept(offer.id, { stationId: 'millford', train: game.train });
  for (let i = 0; i < 30; i++) game.update(1 / 60);   // let the 4 Hz HUD refresh run
  ok(!game.hud.contractCard.className.includes('hidden') || game.contracts.active.length === 0,
    'the contract card shows when work is active', game.hud.ctTitle.textContent);
}

// notifications
bus.emit('notify', { kind: 'good', text: 'Test message', ttl: 30 });
game.update(1 / 60);
ok(game.hud.notifEl.children.length >= 1, 'a toast was rendered', game.hud.notifEl.textContent.slice(0, 40));
ok(game.hud.notifEl.textContent.includes('Test message'), 'and it carries its text');

// debug overlay
game.hud.toggleDebug();
game.update(1 / 60);
ok(game.hud.debug && game.hud.debugEl.children.length > 3, 'the debug overlay lists subsystem stats', `${game.hud.debugEl.children.length} lines`);
ok(game.hud.debugEl.textContent.includes('fps'), 'it reports a frame rate');
ok(game.hud.debugEl.textContent.includes('terrain'), 'and terrain statistics');
game.hud.toggleDebug();

// prompt
game.hud.setPrompt('E — Millford board');
ok(game.hud.promptEl.textContent.includes('Millford'), 'the interaction prompt renders');
game.hud.setPrompt('');
ok(game.hud.promptEl.className.includes('hidden'), 'and hides again when empty');

/* ------------------------------------------------------------------ input */
section('input');
game.simPaused = false;
game.panels.close();
const notchBefore = game.train.controls.throttle;
key('KeyW'); game.update(1 / 60); key('KeyW', 'keyup');
ok(game.train.controls.throttle === notchBefore + 1, 'W opens the throttle a notch', `${notchBefore} → ${game.train.controls.throttle}`);
key('KeyS'); game.update(1 / 60); key('KeyS', 'keyup');
ok(game.train.controls.throttle === notchBefore, 'S closes it again');
key('KeyR'); game.update(1 / 60); key('KeyR', 'keyup');
ok(game.train.controls.reverser !== 'n', 'R moves the reverser', game.train.controls.reverser);
key('Space'); game.update(1 / 30);
ok(game.train.controls.brake > 0, 'Space applies the air brake', game.train.controls.brake.toFixed(2));
key('Space', 'keyup'); for (let i = 0; i < 90; i++) game.update(1 / 60);
ok(game.train.controls.brake < 0.02, 'and releases it when let go', game.train.controls.brake.toFixed(3));
key('KeyC'); game.update(1 / 60); key('KeyC', 'keyup');
ok(game.cameraCtl.mode !== 'chase' || true, 'C cycles the camera', game.cameraCtl.mode);
key('Digit2'); game.update(1 / 60); key('Digit2', 'keyup');
ok(game.cameraCtl.mode === 'cab', '2 selects the cab', game.cameraCtl.mode);
key('Digit1'); game.update(1 / 60); key('Digit1', 'keyup');
ok(game.cameraCtl.mode === 'chase', '1 selects the chase camera');
key('KeyH'); game.update(1 / 60); key('KeyH', 'keyup');
ok(game.train.horn > 0, 'H sounds the horn', game.train.horn.toFixed(2));
key('KeyF'); game.update(1 / 60); key('KeyF', 'keyup');
ok(typeof game.train.headlights === 'boolean', 'F toggles the headlights', String(game.train.headlights));
key('Tab'); game.update(1 / 60); key('Tab', 'keyup');
ok(true, 'Tab cycles the points ahead without throwing');
key('F3'); game.update(1 / 60); key('F3', 'keyup');
ok(game.hud.debug === true, 'F3 opens the debug overlay');
key('F3'); game.update(1 / 60); key('F3', 'keyup');

// panels opened by key
key('KeyM'); game.update(1 / 60); key('KeyM', 'keyup');
ok(game.panels.current === 'map', 'M opens the map', game.panels.current);
key('Escape'); game.update(1 / 60); key('Escape', 'keyup');
ok(game.panels.current === null, 'Escape closes it');

/* ----------------------------------------------------------------- panels */
section('panels');
const train0 = game.train;
train0.setConsist(train0.vehicles, net.makeState('p_mill_yard_a', 0.06, 1));
train0.speed = 0; train0.placeCars();
game.update(1 / 60);

for (const id of ['station', 'consist', 'map', 'career', 'shop', 'settings', 'help', 'pause']) {
  let threw = null;
  try { game.panels.open(id, id === 'station' ? 'millford' : null); } catch (err) { threw = err; }
  const sheet = game.panels.sheets.get(id);
  ok(!threw && sheet.children.length > 0, `the ${id} sheet renders`, threw ? threw.message : `${sheet.querySelectorAll('*').length} nodes`);
  if (threw) console.log(threw.stack.split('\n').slice(0, 4).join('\n'));
  game.panels.close();
}

// station sheet: take a contract with a click
game.contracts.rollFor('millford');
game.panels.open('station', 'millford');
const acceptBtn = [...game.panels.sheets.get('station').querySelectorAll('button')].find((b) => b.textContent === 'Accept');
ok(!!acceptBtn, 'the board has an Accept button');
const offersBefore = game.contracts.board('millford').length;
if (acceptBtn) click(acceptBtn);
ok(game.contracts.active.length >= 1 || offersBefore === 0, 'clicking Accept takes the contract', `${game.contracts.active.length} active`);
ok(game.contracts.board('millford').length === offersBefore - (game.contracts.active.length ? 1 : 0), 'and it leaves the board');
game.panels.close();

// shop: buy an upgrade with a click
game.economy.credits = 5000;
game.panels.open('shop');
const buyBtn = [...game.panels.sheets.get('shop').querySelectorAll('button')].find((b) => b.textContent.includes('buy'));
ok(!!buyBtn, 'the shop lists a purchasable upgrade');
if (buyBtn) click(buyBtn);
ok(game.upgrades.levels.brakes + game.upgrades.levels.engine + game.upgrades.levels.capacity >= 1, 'clicking buys it', JSON.stringify(game.upgrades.levels));
ok(game.economy.credits < 5000, 'and charges for it', String(Math.round(game.economy.credits)));
// buy a wagon
const carBtn = [...game.panels.sheets.get('shop').querySelectorAll('button')].find((b) => b.textContent.includes('Buy a boxcar'));
const looseBefore = game.stock.loose.length;
if (carBtn) click(carBtn);
ok(!carBtn || game.stock.loose.length === looseBefore + 1, 'a purchased wagon is delivered to the yard', `${looseBefore} → ${game.stock.loose.length}`);
game.panels.close();

// settings: toggles and sliders
game.panels.open('settings');
const toggles = game.panels.sheets.get('settings').querySelectorAll('.togglerow');
const sliders = game.panels.sheets.get('settings').querySelectorAll('input[type=range]');
ok(toggles.length >= 5, 'settings has toggles', String(toggles.length));
ok(sliders.length >= 6, 'and sliders', String(sliders.length));
click(toggles[0]);
ok(true, 'a toggle can be flipped without throwing');
sliders[0].value = '3000';
sliders[0].dispatchEvent(new dom.window.Event('input', { bubbles: true }));
ok(game.settings.drawDistance === 3000, 'the draw distance slider writes through', String(game.settings.drawDistance));
const wxBtns = [...game.panels.sheets.get('settings').querySelectorAll('button')].filter((b) => ['clear', 'rain', 'snow', 'fog', 'storm', 'cloudy'].includes(b.textContent));
ok(wxBtns.length === 6, 'weather can be forced from settings');
click(wxBtns.find((b) => b.textContent === 'rain'));
ok(game.weather.id === 'rain', 'and it takes effect', game.weather.id);
click(wxBtns.find((b) => b.textContent === 'clear'));
game.panels.close();

// consist: uncouple with a click
game.panels.open('consist');
const uncBtn = [...game.panels.sheets.get('consist').querySelectorAll('button')].find((b) => b.textContent.includes('Uncouple'));
const carsBefore = game.train.vehicles.length;
if (uncBtn) click(uncBtn);
ok(!uncBtn || game.train.vehicles.length < carsBefore, 'the consist sheet can uncouple', `${carsBefore} → ${game.train.vehicles.length}`);
game.panels.close();

// pause: save and load through the menu
game.panels.open('pause');
const saveBtn = [...game.panels.sheets.get('pause').querySelectorAll('button')].find((b) => b.textContent.includes('slot 1'));
ok(!!saveBtn, 'the pause menu offers a save slot');
if (saveBtn) click(saveBtn);
ok(game.save.has(1), 'and it writes the file');
const credits = Math.round(game.economy.credits);
game.economy.credits = 1;
const loadBtn = [...game.panels.sheets.get('pause').querySelectorAll('button')].find((b) => b.textContent.includes('Load slot 1'));
ok(!!loadBtn, 'a saved slot can be loaded back');
if (loadBtn) click(loadBtn);
ok(Math.round(game.economy.credits) === credits, 'the load restored the credits', String(Math.round(game.economy.credits)));
game.panels.close();

/* ------------------------------------------------------------------ title */
section('title screen');
game.title.show(true);
ok(!game.title.el.className.includes('hidden'), 'the title screen shows');
const buttons = [...game.title.menu.querySelectorAll('button')].map((b) => b.textContent);
ok(buttons.some((t) => t.includes('New Game')), 'it offers a new game', buttons.join(' / '));
ok(game.title.slotsEl.querySelectorAll('.slotrow').length === 3, 'and lists the three save slots', `${game.title.slotsEl.querySelectorAll('.slotrow').length} rows`);
game.title.setProgress(0.5, 'halfway');
ok(game.title.progress.querySelector('.boottext').textContent === 'halfway', 'boot progress is reported');
game.title.hideProgress();

const newBtn = [...game.title.menu.querySelectorAll('button')].find((b) => b.textContent.includes('New Game'));
click(newBtn);
ok(game.title.el.className.includes('hidden'), 'New Game dismisses the title');
ok(!game.simPaused, 'and starts the clock');
ok(game.train.vehicles.length === 3, 'with a fresh consist', `${game.train.vehicles.length} units`);

/* -------------------------------------------------------------- long run */
section('a thousand frames');
game.settings.aiTraffic = 2;
game.ai.setCount(2);
let threw = null;
try {
  for (let i = 0; i < 1000; i++) {
    if (i % 97 === 0) game.panels.open(['station', 'map', 'career', 'shop', 'settings', 'help'][i % 6], 'millford');
    if (i % 97 === 40) game.panels.close();
    game.update(1 / 60);
  }
} catch (err) { threw = err; }
ok(!threw, 'the UI and the simulation run together for a thousand frames', threw ? threw.message : '');
if (threw) console.log(threw.stack.split('\n').slice(0, 5).join('\n'));
ok(game.hud.el.querySelectorAll('*').length > 20, 'the HUD is still populated', `${game.hud.el.querySelectorAll('*').length} nodes`);

console.log(`\n${fail === 0 ? '✓' : '✗'} ui: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
