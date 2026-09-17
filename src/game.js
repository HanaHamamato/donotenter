/**
 * game.js — the whole simulation, with no DOM in it (GDD §12 game loop).
 *
 * `createGame()` builds every system, owns the player's career, and exposes one
 * `update(dt)` that runs a frame in the order the systems depend on each other:
 *
 *   input → economy clock → block occupancy → train physics → coupling → AI →
 *   stations → contracts → passengers → tutorial → autosave → progression →
 *   tunnel state → world streaming → signals → camera → audio → post → HUD
 *
 * The browser shell (main.js) supplies the renderer, camera, input and UI; all
 * of them are optional here, so the same object runs headless in the test
 * harness. Anything UI-shaped is touched through `game.hud`, `game.panels`,
 * `game.input`, `game.audio` and `game.postFX`, each guarded.
 */
import * as THREE from 'three';
import { RENDER, PHYS, ECONOMY, CAR_TYPES, CARGO } from './constants.js';
import { TrackNetwork } from './systems/TrackNetwork.js';
import { AssetManager } from './systems/AssetManager.js';
import { RollingStockManager } from './systems/RollingStockManager.js';
import { TrainController } from './systems/TrainController.js';
import { WorldStreamer } from './systems/WorldStreamer.js';
import { CameraManager } from './systems/CameraManager.js';
import { AudioManager } from './systems/AudioManager.js';
import { BlockSystem } from './systems/BlockSystem.js';
import { AITrainManager } from './systems/AITrainManager.js';
import { EconomyManager } from './systems/EconomyManager.js';
import { StationManager } from './systems/StationManager.js';
import { ContractManager } from './systems/ContractManager.js';
import { ProgressionManager } from './systems/ProgressionManager.js';
import { UpgradeManager } from './systems/UpgradeManager.js';
import { PassengerSystem } from './systems/PassengerSystem.js';
import { TutorialManager } from './systems/TutorialManager.js';
import { SaveManager } from './systems/SaveManager.js';
import { NotificationManager } from './systems/NotificationManager.js';
import { bus } from './utils/events.js';
import { clamp, clamp01, approach, formatMoney } from './utils/math.js';

export const SPAWN = { seg: 'p_main_2', u: 0.845, dir: 1 };   // ~400 m out from Millford

export const DEFAULT_SETTINGS = {
  quality: 'medium', post: true, bloom: true, shadows: true,
  drawDistance: 6000, vegetation: 1.0, pixelRatio: 1.0,
  sensitivity: 1, invertY: false, aiTraffic: 3, tutorial: true,
  volumes: { master: 0.85, engine: 0.9, effects: 0.85, ambient: 0.7, ui: 0.7 },
};

/**
 * @param {object} opts
 *   scene, camera, renderer (optional), net or tracks data, assets,
 *   stations/landmarks data, settings, and any of the UI hooks
 *   {input, hud, panels, title, postFX, audio}.
 */
export function createGame(opts = {}) {
  const scene = opts.scene || new THREE.Scene();
  const camera = opts.camera || new THREE.PerspectiveCamera(RENDER.fov, 16 / 9, RENDER.near, RENDER.far);
  const renderer = opts.renderer || null;
  const assets = opts.assets || new AssetManager();
  const net = opts.net || new TrackNetwork(opts.tracks);
  const stationDefs = opts.stations || [];
  const landmarks = opts.landmarks || [];

  const game = {
    scene, camera, renderer, assets, net, stationDefs, landmarks,
    settings: { ...DEFAULT_SETTINGS, ...(opts.settings || {}) },
    booted: false,
    simPaused: true,
    photo: false,
    tunnel: 0,
    fps: 60,
    deliveryTimer: 0,
    coupleTarget: null,
    input: opts.input || null,
    hud: opts.hud || null,
    panels: opts.panels || null,
    title: opts.title || null,
    postFX: opts.postFX || null,
    audio: opts.audio || (typeof AudioContext !== 'undefined' || typeof window !== 'undefined' ? new AudioManager({ enabled: false }) : null),
  };

  /* ------------------------------------------------------------- world */
  game.world = new WorldStreamer({
    scene, renderer, net, assets, stations: stationDefs, landmarks,
    cycle: opts.cycle,
  });
  Object.assign(game, {
    cycle: game.world.cycle,
    sky: game.world.sky,
    weather: game.world.weather,
    biome: game.world.biome,
    terrain: game.world.terrain,
    structures: game.world.structures,
    track: game.world.track,
    vegetation: game.world.vegetation,
    water: game.world.water,
  });
  game.notifs = opts.notifs || new NotificationManager();
  game.cameraCtl = opts.cameraCtl || new CameraManager(camera, net, {
    terrain: game.terrain, sensitivity: game.settings.sensitivity, invertY: game.settings.invertY,
  });
  game.cameraCtl.ensureCabDesk(assets);
  game.vehicleGroup = new THREE.Group();
  game.vehicleGroup.name = 'vehicles';
  scene.add(game.vehicleGroup);

  /* ------------------------------------------------------------ methods */
  game.addVehicle = (v) => {
    v.build(assets);
    if (v.group && !v.group.parent) game.vehicleGroup.add(v.group);
    return v;
  };

  game.buildGameplay = () => {
    game.ai?.dispose?.();
    game.train?.dispose?.();
    if (game.stock) {
      for (const v of game.stock.all.values()) if (v.group) v.group.removeFromParent();
      game.stock.dispose();
    }
    game.tutorial?.dispose?.();
    game.passengers?.dispose?.();
    game.save?.dispose?.();

    game.stock = new RollingStockManager(assets);
    game.blocks = new BlockSystem(net);
    game.economy = new EconomyManager();
    game.stations = new StationManager(net, stationDefs, { economy: game.economy });
    game.contracts = new ContractManager({ net, stations: game.stations, economy: game.economy });
    game.progression = new ProgressionManager({ net, stations: game.stations, economy: game.economy });
    game.upgrades = new UpgradeManager({ economy: game.economy });
    game.passengers = new PassengerSystem({ stations: game.stations, economy: game.economy });
    game.train = new TrainController(net, {
      id: 'player', isPlayer: true, bus,
      weather: () => game.weather?.id || 'clear',
    });
    game.upgrades.setTrain(game.train);
    game.passengers.setTrain(game.train);
    game.tutorial = new TutorialManager({
      train: () => game.train,
      station: () => game.stations.current,
      economy: () => game.economy,
      contracts: () => game.contracts,
    });
    game.tutorial.enabled = game.settings.tutorial;
    game.ai = new AITrainManager({
      scene, net, rollingstock: game.stock, blocks: game.blocks, assets,
      weather: game.weather, count: game.settings.aiTraffic,
    });
    game.save = new SaveManager({
      net, stock: game.stock, train: game.train, economy: game.economy,
      stations: game.stations, contracts: game.contracts, progression: game.progression,
      upgrades: game.upgrades, passengers: game.passengers, tutorial: game.tutorial,
      cycle: game.cycle, weather: game.weather, settings: game.settings,
      camera: game.cameraCtl, assets, scene, storage: opts.storage,
    });
    game.deliveryTimer = 0;
    game.coupleTarget = null;
  };

  game.spawnPlayer = (where = SPAWN) => {
    const train = game.train;
    const state = net.makeState(where.seg, where.u, where.dir);
    const loco = game.stock.loco('gp7', { number: 4417 });
    game.addVehicle(loco);
    train.couple(loco);
    for (const key of ['boxcar', 'boxcar']) {
      const v = game.stock.car(key, {});
      game.addVehicle(v);
      train.couple(v);
    }
    train.setConsist(train.vehicles, state);
    train.setReverser('n');
    train.setHeadlights(true);
    train.placeCars();
  };

  /** Loose stock standing in every yard, so there is always something to shunt. */
  game.spawnWorldStock = () => {
    const freight = Object.keys(CAR_TYPES).filter((k) => CAR_TYPES[k].freight);
    let n = 0;
    for (const st of game.stations.list) {
      st.yardCars = new Set();
      for (const sd of st.def.sidings || []) {
        const seg = net.segmentById(sd.seg);
        if (!seg) continue;
        const count = Math.min((sd.capacity || 3) - 1, 3);
        for (let i = 0; i < count; i++) {
          const dist = (sd.from || 30) + 10 + i * 19;
          if (dist + 9 > seg.length) continue;
          const cargo = st.produces.length && Math.random() < 0.55
            ? st.produces[(Math.random() * st.produces.length) | 0] : null;
          const key = cargo ? (CARGO[cargo]?.car || 'boxcar') : freight[(Math.random() * freight.length) | 0];
          if (!CAR_TYPES[key]) continue;
          const v = game.stock.car(key, {});
          if (cargo) {
            const tons = Math.round((v.capacity / 1000) * (0.6 + Math.random() * 0.4));
            v.setLoad(cargo, tons, st.id, null);
          }
          game.addVehicle(v);
          st.yardCars.add(key);
          game.stock.park(v, net.makeState(seg.id, clamp01(dist / seg.length), 1));
          // place the mesh where it stands, once, so yards look occupied
          const f = net.frame(v.state, {});
          if (v.group) {
            v.group.position.copy(f.position);
            v.group.matrix.makeBasis(f.localX, f.up, f.forward);
            v.group.quaternion.setFromRotationMatrix(v.group.matrix);
          }
          n++;
        }
      }
    }
    return n;
  };

  game.newGame = () => {
    game.buildGameplay();
    game.progression.update();
    game.spawnPlayer(SPAWN);
    const parked = game.spawnWorldStock();
    for (const id of ['millford', 'dustflats', 'coalridge']) game.contracts.rollFor(id);
    game.cameraCtl.setMode('chase', true);
    game.cameraCtl.blend = 1;
    game.cameraCtl.snap(game.train);
    game.simPaused = false;
    game.booted = true;
    bus.emit('game:new', { parked });
    bus.emit('notify', {
      kind: 'info', title: 'Millford, 08:00',
      text: 'A GP-7 on the main, two empties behind it, and a board full of work.', ttl: 9,
    });
    return game;
  };

  game.loadSave = (slot = 'auto') => {
    if (!game.save?.has?.(slot)) {
      bus.emit('notify', { kind: 'warn', text: `No save in slot ${slot}.` });
      return false;
    }
    game.buildGameplay();
    const loaded = game.save.load(slot);
    if (!loaded) return false;
    for (const v of game.stock.all.values()) game.addVehicle(v);
    game.progression.update();
    game.contracts.setPassengers(game.passengers.unlocked);
    game.cameraCtl.setMode('chase', true);
    game.cameraCtl.blend = 1;
    game.cameraCtl.snap(game.train);
    game.simPaused = false;
    game.booted = true;
    game.title?.show(false);
    bus.emit('game:loaded', { slot });
    return true;
  };

  game.toTitle = () => {
    game.save?.save?.('auto');
    game.simPaused = true;
    game.panels?.close?.();
    game.title?.show(true);
    game.cameraCtl.setMode('orbit', true);
    game.cameraCtl.orbit.auto = true;
    game.cameraCtl.orbit.dist = 130;
  };

  /* ---------------------------------------------------------- settings */
  game.applyQuality = (preset) => {
    game.settings.quality = preset;
    const p = game.world.setQuality(preset);
    game.postFX?.setQuality?.(preset);
    if (game.postFX) game.postFX.enabled = game.settings.post && !!p.post;
    if (renderer) renderer.shadowMap.enabled = !!p.shadows && game.settings.shadows;
    opts.onSettings?.(game.settings);
    return p;
  };

  game.applyPixelRatio = (v) => {
    game.settings.pixelRatio = v;
    const dpr = clamp(v * ((typeof window !== 'undefined' && window.devicePixelRatio > 1.6) ? 1.4 : 1), 0.5, 2);
    renderer?.setPixelRatio?.(dpr);
    game.postFX?.resize?.(opts.width || 1280, opts.height || 720, dpr);
    game.weather.setPixelRatio(dpr);
    opts.onSettings?.(game.settings);
  };

  game.applyDrawDistance = (v) => {
    game.settings.drawDistance = v;
    camera.far = Math.max(RENDER.far, v * 2);
    camera.updateProjectionMatrix();
    game.terrain.setDrawDistance?.(v);
    game.track.setDrawDistance?.(v);
    game.vegetation.setRadius(Math.min(v * 0.35, 2200));
    opts.onSettings?.(game.settings);
  };

  game.applySettings = () => {
    const s = game.settings;
    game.applyQuality(s.quality);
    game.applyPixelRatio(s.pixelRatio);
    game.applyDrawDistance(s.drawDistance);
    if (game.postFX) {
      game.postFX.enabled = s.post;
      if (game.postFX.bloom) game.postFX.bloom.enabled = s.bloom;
    }
    game.cameraCtl.sensitivity = s.sensitivity;
    game.cameraCtl.invertY = s.invertY;
    for (const [k, v] of Object.entries(s.volumes || {})) game.audio?.setVolume?.(k, v);
    game.ai?.setCount?.(s.aiTraffic);
    if (game.tutorial) game.tutorial.enabled = s.tutorial;
  };

  game.focusWorld = () => {
    if (!game.panels?.isOpen?.() && !game.title?.visible && !game.photo) game.input?.requestLock?.();
  };

  game.togglePhoto = () => {
    game.photo = !game.photo;
    game.hud?.show?.(!game.photo);
    if (game.photo) {
      game.input?.releaseLock?.();
      game.cameraCtl.setMode('free');
      bus.emit('notify', { kind: 'info', text: 'Photo mode — P to leave.', ttl: 5 });
    } else {
      game.cameraCtl.setMode('chase');
      game.focusWorld();
    }
  };

  /* -------------------------------------------------------------- input */
  game.handleInput = (dt) => {
    const input = game.input;
    if (!input) return;
    const train = game.train;

    if (input.pressed('pause')) {
      if (game.panels?.isOpen?.()) game.panels.close();
      else game.panels?.open?.('pause');
    }
    if (game.panels?.isOpen?.() || game.title?.visible) return;

    if (input.pressed('map')) game.panels?.toggle?.('map');
    if (input.pressed('career')) game.panels?.toggle?.('career');
    if (input.pressed('shop')) game.panels?.toggle?.('shop');
    if (input.pressed('consist')) game.panels?.toggle?.('consist');
    if (input.pressed('debug')) game.hud?.toggleDebug?.();
    if (input.pressed('save')) game.save.save(1);
    if (input.pressed('load')) game.loadSave('auto');
    if (input.pressed('photo')) game.togglePhoto();
    if (game.panels?.isOpen?.()) return;

    if (input.pressed('interact')) {
      const st = game.stations.current || game.stations.at(train)?.station;
      if (st) game.panels?.open?.('station', st.id);
      else bus.emit('notify', { kind: 'info', text: 'Nothing here — stop at a station platform first.', ttl: 3.4 });
    }

    if (train && !train.empty) {
      if (input.pressed('throttleUp')) train.notch(+1);
      if (input.pressed('throttleDown')) train.notch(-1);

      const want = input.down('brake') ? 1 : 0;
      const rate = want > train.controls.brake ? 1.5 : 1.0;
      const next = approach(train.controls.brake, want, rate * dt);
      if (Math.abs(next - train.controls.brake) > 1e-4) train.setBrake(next);

      if (input.pressed('emergency')) {
        if (train.controls.emergency) { train.controls.emergency = false; train.setBrake(0); }
        else train.emergencyBrake(true);
      }
      if (input.pressed('reverse')) train.toggleReverse();
      if (input.pressed('dynamic')) {
        const d = train.controls.dynamic > 0 ? 0 : Math.min(8, 2 + train.controls.throttle);
        train.setDynamic(d);
        bus.emit('notify', { kind: 'info', text: d ? `Dynamic brake ${d}.` : 'Dynamic brake off.', ttl: 2.2 });
      }
      train.sand(input.down('sander'));
      if (input.pressed('horn')) train.hornPress(0.85);
      else if (input.down('horn') && train.horn <= 0) train.hornPress(0.4);
      if (input.pressed('bell')) train.toggleBell();
      if (input.pressed('headlight')) train.setHeadlights(!train.headlights);
      if (input.pressed('rerail') && train.derail) {
        train.rerail();
        bus.emit('notify', { kind: 'good', text: 'Back on the rails. Check your cars before you move.' });
      }
    }

    if (input.pressed('junction')) game.cycleJunction();
    if (input.pressed('decouple')) {
      const last = input.keyDown?.('ShiftLeft');
      const idx = last ? train.vehicles.length - 2 : 0;
      if (train.vehicles.length > 1 && idx >= 0) train.decouple(idx, game.stock);
      else bus.emit('notify', { kind: 'info', text: 'Nothing to uncouple.', ttl: 2.4 });
    }

    if (input.pressed('camera')) game.cameraCtl.cycle(1);
    const modes = ['chase', 'cab', 'orbit', 'trackside', 'free'];
    for (let i = 0; i < modes.length; i++) if (input.pressed(`cam${i + 1}`)) game.cameraCtl.setMode(modes[i]);
  };

  /** Throw the points at the next switchable node along the route. */
  game.cycleJunction = () => {
    const train = game.train;
    if (!train?.state) return false;
    const look = net.scanAhead(train.state, 900, 16);
    let prevSeg = train.state.seg;
    for (const f of look) {
      if (f.type === 'segment') { prevSeg = f.seg; continue; }
      if (!f.node?.switchable || !(f.routes?.length > 1)) continue;
      const node = net.nodeById(f.node.id);
      if (!net.cycleRoute(node, prevSeg)) {
        bus.emit('notify', { kind: 'warn', text: 'Those points have only one route from here.' });
        return false;
      }
      const routes = net.routesFrom(node, prevSeg);
      const chosen = node.branches[node.active | 0];
      const destId = chosen?.segment ? (chosen.segment.a === node.id ? chosen.segment.b : chosen.segment.a) : null;
      const destNode = destId ? net.nodeById(destId) : null;
      const destSt = destNode?.station ? game.stations.get(destNode.station) : null;
      bus.emit('junction:cycle', { node: node.id, routes: routes.length });
      bus.emit('notify', {
        kind: 'info',
        text: `Points set for ${destSt ? destSt.name : destNode?.name || destId || 'the branch'} (${routes.length} routes here).`,
        ttl: 3.4,
      });
      game.structures.updateSignals((n, s) => game.blocks.occupied(n, s));
      return true;
    }
    bus.emit('notify', { kind: 'info', text: 'No junction within 900 m.', ttl: 2.4 });
    return false;
  };

  /* ----------------------------------------------------------- coupling */
  const _probe = new THREE.Vector3();
  const _ahead = new THREE.Vector3();

  game.coupleCheck = () => {
    const train = game.train;
    if (!train?.state || train.empty || train.derail) return null;
    if (train.speed > PHYS.coupleMaxSpeed) { game.coupleTarget = null; return null; }
    const forward = (train.moving || 1) > 0;
    let found = null;

    if (forward) {
      const ahead = net.cloneState(train.state);
      net.advance(ahead, 5.2);
      const pa = net.positionOf(ahead, _ahead);
      const p = net.positionOf(train.state, _probe);
      found = game.stock.looseNear(pa.x, pa.z, 9)[0] || game.stock.looseNear(p.x, p.z, 6)[0];
      if (found) found = { ...found, atFront: true };
    } else {
      const back = net.cloneState(train.state);
      const tailState = net.back(back, train.length + 5.2, train.trail);
      const p = net.positionOf(tailState, _probe);
      found = game.stock.looseNear(p.x, p.z, 9)[0];
      if (found) found = { ...found, atFront: false };
    }

    if (!found) { game.coupleTarget = null; return null; }
    game.coupleTarget = found;
    const v = found.vehicle;
    v.state.dir = forward ? train.state.dir : -train.state.dir;
    game.stock.unpark(v);
    if (!train.couple(v, found.atFront)) {
      game.stock.park(v, v.state);
      return null;
    }
    game.addVehicle(v);
    bus.emit('notify', {
      kind: 'good',
      text: `Coupled to a ${v.name}${v.cargo ? ` with ${Math.round(v.tons)} t of ${CARGO[v.cargo]?.label || v.cargo}` : ' (empty)'}.`,
      ttl: 4,
    });
    return v;
  };

  /* ---------------------------------------------------------- delivery */
  game.autoDeliver = (dt) => {
    const train = game.train;
    const st = game.stations.current;
    const hasCargo = train && train.vehicles.some((v) => v.cargo || v.riders > 0);
    if (!st || !hasCargo || train.kmh > 0.6) { game.deliveryTimer = 0; return null; }
    if (game.deliveryTimer < 0) return null;
    game.deliveryTimer += dt;
    if (game.deliveryTimer < 1.4) return null;
    game.deliveryTimer = -1;
    for (const v of train.vehicles) if (v.passenger && v.riders > 0) game.passengers.alight(v, st.id);
    const result = game.contracts.deliver(train, st.id);
    if (result?.pay > 0) bus.emit('station:sold', { station: st, pay: result.pay });
    game.progression.update();
    return result;
  };

  /** 0 in the open, 1 in a bore, faded over the last 45 m before a portal. */
  game.tunnelFactor = () => {
    const train = game.train;
    if (!train?.state) return 0;
    const seg = train.state.seg;
    const u = train.state.u;
    if (seg.inRanges(u, seg.tunnels)) return 1;
    let d = Infinity;
    for (const r of seg.tunnels || []) {
      d = Math.min(d, Math.abs(u - r.u0) * seg.length, Math.abs(u - r.u1) * seg.length);
    }
    return Number.isFinite(d) ? clamp01(1 - d / 45) * 0.92 : 0;
  };

  game.updatePrompt = () => {
    const train = game.train;
    const st = game.stations.current;
    let text = '';
    if (game.coupleTarget) text = 'Couplers touching — that car joins your consist';
    else if (train?.derail) text = 'G — re-rail when the crane arrives';
    else if (st && (train?.kmh || 0) < 3) text = `E — ${st.name} board · U — depot · T — consist`;
    else if (st) text = `${st.name} — stop to work the yard`;
    game.hud?.setPrompt?.(text);
  };

  /* -------------------------------------------------------------- frame */
  let signalTimer = 0;
  let fpsAcc = 0, fpsN = 0;

  game.update = (dt) => {
    const train = game.train;
    const live = !game.simPaused;

    game.handleInput(dt);

    if (live && train) {
      game.economy.tick(dt);
      game.blocks.begin();
      game.blocks.mark(train);
      for (const e of game.ai.trains) game.blocks.mark(e.train);

      train.step(dt);
      train.placeCars();
      game.coupleCheck();

      game.ai.update(dt, train);
      game.stations.update(dt, train, game.stock);
      game.contracts.update(dt, game.stations.current?.id, game.train);
      game.passengers.update(dt, (dt / 60) * game.economy.timeScale);
      game.tutorial.update(dt);
      game.save.update(dt);
      game.progression.update();
      game.autoDeliver(dt);
    } else if (train) {
      game.blocks.begin();
      game.blocks.mark(train);
    }

    game.tunnel = game.tunnelFactor();
    game.world.update(dt, camera, {});

    signalTimer -= dt;
    if (signalTimer <= 0) {
      signalTimer = 0.35;
      game.structures.updateSignals((n, s) => game.blocks.occupied(n, s));
    }

    // menus own the mouse: drain it so the camera does not snap when they close
    const menuOpen = !!game.panels?.isOpen?.() || !!game.title?.visible;
    if (menuOpen) game.input?.takeMouse?.();
    game.cameraCtl.update(dt, train, menuOpen ? null : game.input, { tunnel: game.tunnel });

    if (game.audio?.ready) {
      game.audio.update(dt, train, {
        weather: game.weather, tunnel: game.tunnel,
        cameraMode: game.cameraCtl.mode,
        speedFactor: clamp01((train?.kmh || 0) / 100),
      });
    }

    game.postFX?.update?.(dt, {
      flash: game.weather.flashAmount(),
      tunnel: game.tunnel,
      speed01: clamp01((train?.kmh || 0) / 120),
      cold: game.biome.snow ?? 0,
      exposure: 1.02,
      nightBoost: 1 + (game.cycle.night || 0) * 0.5,
    });

    game.notifs.update(dt);
    if (game.hud?.visible) {
      game.hud.update(dt);
      game.updatePrompt();
    }

    game.input?.endFrame?.();

    fpsAcc += dt; fpsN++;
    if (fpsAcc > 0.5) { game.fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; opts.onFps?.(game.fps); }
    return game;
  };

  game.render = () => {
    if (game.postFX?.enabled) game.postFX.render();
    else renderer?.render(scene, camera);
  };

  game.stats = () => ({
    fps: game.fps,
    world: game.world.stats(),
    trains: game.ai.trains.length,
    vehicles: game.stock.all.size,
    loose: game.stock.loose.length,
    credits: Math.round(game.economy?.credits || 0),
    contracts: game.contracts?.active?.length || 0,
  });

  game.dispose = () => {
    game.ai?.dispose?.();
    game.train?.dispose?.();
    game.stock?.dispose?.();
    game.world?.dispose?.();
    game.notifs?.dispose?.();
    game.audio?.dispose?.();
    game.tutorial?.dispose?.();
    game.passengers?.dispose?.();
    game.save?.dispose?.();
  };

  return game;
}

export default createGame;
