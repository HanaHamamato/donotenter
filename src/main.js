/**
 * main.js — the browser shell (GDD §12 entry point).
 *
 * Everything that touches the DOM lives here and nowhere else: the canvas, the
 * renderer, the boot sequence with its progress bar, the UI sheets, the pointer
 * lock, resize, autosave-on-close, and the requestAnimationFrame loop. The
 * simulation itself is `createGame()` in game.js, which this file feeds a
 * renderer, a camera, an input manager and the HUD.
 */
import * as THREE from 'three';
import tracksData from '../assets/data/tracks.json';
import stationsData from '../assets/data/stations.json';
import { createGame, DEFAULT_SETTINGS, SPAWN } from './game.js';
import { AssetManager } from './systems/AssetManager.js';
import { TrackNetwork } from './systems/TrackNetwork.js';
import { PostFX } from './systems/PostFX.js';
import { InputManager } from './systems/InputManager.js';
import { AudioManager } from './systems/AudioManager.js';
import { HUD } from './ui/HUD.js';
import { Panels } from './ui/Panels.js';
import { TitleScreen } from './ui/TitleScreen.js';
import { RENDER, ECONOMY } from './constants.js';
import { bus } from './utils/events.js';
import { clamp, formatMoney } from './utils/math.js';
import './styles.css';

const SETTINGS_KEY = 'ironbound.settings.v1';
const $ = (id) => document.getElementById(id);
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  } catch { return { ...DEFAULT_SETTINGS }; }
}

function persistSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* quota */ }
}

let game = null;
let adaptCooldown = 0;

async function boot() {
  const bar = $('bootbar');
  const label = $('boottext');
  const step = async (pct, text) => {
    if (bar) bar.style.width = `${Math.round(pct * 100)}%`;
    if (label) label.textContent = text;
    await nextFrame();
  };

  try {
    /* ------------------------------------------------------- renderer */
    await step(0.05, 'Waking the renderer…');
    const canvas = $('scene');
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.02;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setClearColor(0x0b1015, 1);

    const scene = new THREE.Scene();
    scene.name = 'ironbound';
    const camera = new THREE.PerspectiveCamera(RENDER.fov, window.innerWidth / Math.max(1, window.innerHeight), RENDER.near, RENDER.far);

    /* ----------------------------------------------------------- data */
    await step(0.16, 'Laying 56.8 km of track…');
    const net = new TrackNetwork(tracksData);

    await step(0.28, 'Building the model library…');
    const assets = new AssetManager();
    for (const key of assets.keys()) assets.geometry(key);

    /* ----------------------------------------------------------- game */
    await step(0.4, 'Raising the terrain…');
    const settings = loadSettings();
    renderer.setPixelRatio(clamp(settings.pixelRatio * (window.devicePixelRatio > 1.6 ? 1.4 : 1), 0.5, 2));
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.shadowMap.enabled = settings.shadows;

    const postFX = new PostFX(renderer, scene, camera, {
      enabled: settings.post, msaa: settings.quality === 'low' ? 0 : 4,
    });
    const input = new InputManager(window, { dom: canvas });
    const audio = new AudioManager();

    game = createGame({
      scene, camera, renderer, net, assets,
      stations: stationsData.stations,
      landmarks: tracksData.landmarks || [],
      settings,
      storage: localStorage,
      postFX, input, audio,
      width: window.innerWidth, height: window.innerHeight,
      onSettings: persistSettings,
      onFps: adaptQuality,
    });

    await step(0.62, 'Opening for business…');
    game.panels = new Panels($('ui'), game);
    game.hud = new HUD($('ui'), game);
    game.title = new TitleScreen($('ui'), game);
    game.hud.show(true);

    wireEvents();
    wirePointer(canvas);
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { game.simPaused = true; audio.suspend(); }
      else { game.simPaused = game.title.visible || game.panels.isOpen(); audio.resume(); }
    });
    window.addEventListener('beforeunload', () => { if (game.booted) game.save.save('auto'); });
    onResize();

    /* -------------------------------------------------- dress the world */
    await step(0.72, 'Dressing the countryside…');
    game.newGame();
    game.notifs.clear();
    game.applySettings();
    game.simPaused = true;

    // let the streamer build the starting view before the player sees anything
    const spawn = net.positionOf(net.makeState(SPAWN.seg, SPAWN.u, SPAWN.dir), new THREE.Vector3());
    camera.position.set(spawn.x - 140, spawn.y + 70, spawn.z - 150);
    camera.lookAt(spawn);
    game.cameraCtl.orbit.dist = 190;
    game.cameraCtl.orbit.el = 0.22;
    game.cameraCtl.setMode('orbit', true);
    game.cameraCtl.blend = 1;

    const t0 = performance.now();
    let frames = 0;
    while (performance.now() - t0 < 2400 && frames < 200) {
      game.update(1 / 60);
      frames++;
      if (frames % 12 === 0) await step(0.72 + 0.24 * Math.min(1, frames / 120), 'Dressing the countryside…');
      await nextFrame();
    }

    await step(0.99, 'All aboard.');
    game.booted = true;
    $('boot')?.classList.add('hidden');
    game.title.show(true);
    game.hud.show(false);
    requestAnimationFrame(frame);
  } catch (err) {
    console.error('[boot]', err);
    const el = $('boottext');
    if (el) { el.textContent = `Failed to start — ${err && err.message ? err.message : err}`; el.classList.add('bad'); }
    $('boot')?.classList.add('failed');
  }
}

/* ------------------------------------------------------------------ frame */
let last = performance.now();

function frame(nowMs) {
  requestAnimationFrame(frame);
  const dt = clamp((nowMs - last) / 1000, 0, 0.1);
  last = nowMs;
  game.update(dt);
  game.render();
}

/* --------------------------------------------------------------- resizing */
function onResize() {
  if (!game) return;
  const w = window.innerWidth, h = Math.max(1, window.innerHeight);
  game.camera.aspect = w / h;
  game.camera.updateProjectionMatrix();
  game.renderer.setSize(w, h, false);
  game.postFX?.resize(w, h);
}

/* ------------------------------------------------------------ auto quality */
function adaptQuality(fps) {
  if (!game?.booted) return;
  adaptCooldown -= 0.5;
  if (adaptCooldown > 0) return;
  const s = game.settings;
  if (fps < 26 && s.quality !== 'low') {
    adaptCooldown = 30;
    s.quality = s.quality === 'high' ? 'medium' : 'low';
    game.applyQuality(s.quality);
    bus.emit('notify', { kind: 'warn', text: `Frame rate was low — quality set to ${s.quality}.`, ttl: 6 });
  } else if (fps < 38 && s.post) {
    adaptCooldown = 30;
    s.post = false;
    game.postFX.enabled = false;
    persistSettings(s);
    bus.emit('notify', { kind: 'warn', text: 'Post-processing disabled to keep the frame rate up.', ttl: 6 });
  }
}

/* ----------------------------------------------------------------- events */
function wireEvents() {
  bus.on('game:new', () => { game.hud?.show(!game.photo); game.focusWorld(); });
  bus.on('game:loaded', () => { game.hud?.show(!game.photo); game.focusWorld(); });

  bus.on('train:derail', (e) => {
    if (e.train !== game.train) return;
    game.economy.spend(ECONOMY.derailPenalty, 'derailment');
    bus.emit('notify', {
      kind: 'bad', title: 'Derailed!',
      text: `${e.reason === 'overspeed' ? 'Over the speed limit' : 'Too fast for the curve'} — ${formatMoney(ECONOMY.derailPenalty)} for the crane, and every car took damage. G when you are ready.`,
      ttl: 12,
    });
    game.hud?.flash(1);
  });
  bus.on('train:buffer', (e) => { if (e.train === game.train) game.hud?.flash(0.65); });
  bus.on('train:blocked', (e) => {
    if (e.train !== game.train) return;
    bus.emit('notify', { kind: 'warn', text: `Line closed ahead — ${e.reason || 'that region is still locked'}.`, ttl: 5 });
  });
  bus.on('contract:complete', (e) => {
    bus.emit('notify', {
      kind: 'good', title: `Delivered — ${formatMoney(e.pay)}`,
      text: `${e.timeBonus ? `Time bonus ${formatMoney(e.timeBonus)}. ` : ''}${e.condBonus ? `Condition bonus ${formatMoney(e.condBonus)}. ` : ''}Reputation at ${e.station.name} improved.`,
      ttl: 8,
    });
    game.progression.update();
  });
  bus.on('passengers:unlocked', () => {
    game.contracts.setPassengers(true);
    game.passengers.setUnlocked(true);
  });
  bus.on('weather:change', (e) => bus.emit('notify', { kind: 'info', text: `Weather: ${e.label}.`, ttl: 4 }));
  bus.on('biome:change', (e) => { if (e.label) bus.emit('notify', { kind: 'info', text: `Entering ${e.label}.`, ttl: 3.4 }); });
  bus.on('save:error', () => { /* the notify is already emitted by SaveManager */ });
}

function wirePointer(canvas) {
  const wake = () => { game.audio.init(); game.audio.resume(); };
  window.addEventListener('pointerdown', wake);
  window.addEventListener('keydown', wake);
  canvas.addEventListener('click', () => {
    if (!game.booted || game.title.visible) return;
    wake();
    if (!game.panels.isOpen() && !game.photo) game.input.requestLock();
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}

boot();
