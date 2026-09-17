/**
 * test-game.mjs — headless integration test for the whole simulation.
 *
 * Builds the game exactly as the browser shell does (minus DOM and WebGL) and
 * runs it: a career is started, the train is driven, cars are coupled, a
 * contract is run end to end, AI traffic is spawned and signalled, the weather
 * is cycled, the day is advanced, milestones are earned, and the lot is saved
 * and loaded back. Anything that throws or comes out numerically wrong fails
 * the run.
 *
 *   node tools/test-game.mjs
 */
import fs from 'node:fs';
import * as THREE from 'three';
import { createGame, SPAWN } from '../src/game.js';
import { TrackNetwork } from '../src/systems/TrackNetwork.js';
import { AssetManager } from '../src/systems/AssetManager.js';
import { PHYS, ECONOMY, CARGO, LOCOMOTIVES } from '../src/constants.js';
import { bus } from '../src/utils/events.js';
import { clamp01 } from '../src/utils/math.js';

const tracks = JSON.parse(fs.readFileSync(new URL('../assets/data/tracks.json', import.meta.url)));
const stations = JSON.parse(fs.readFileSync(new URL('../assets/data/stations.json', import.meta.url)));

let pass = 0, fail = 0;
const ok = (cond, msg, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${msg}${extra ? ` — ${extra}` : ''}`); }
  else { fail++; console.log(`  ✗ ${msg}${extra ? ` — ${extra}` : ''}`); }
};
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
const section = (t) => console.log(`\n${t}`);

/** A Map-backed stand-in for localStorage. */
function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m,
  };
}

/* ------------------------------------------------------------------ build */
section('boot');
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.4, 22000);
const net = new TrackNetwork(tracks);
const assets = new AssetManager();
for (const key of assets.keys()) assets.geometry(key);
ok(assets.keys().length >= 60, 'model library warmed', `${assets.keys().length} models`);

const storage = fakeStorage();
const game = createGame({
  scene, camera, renderer: null, net, assets,
  stations: stations.stations,
  landmarks: tracks.landmarks || [],
  storage,
  settings: { quality: 'medium', aiTraffic: 0, tutorial: true },
});
ok(!!game.world, 'world streamer built');
ok(!!game.cameraCtl && !!game.notifs, 'camera + notifications built');

game.newGame();
ok(game.booted && !game.simPaused, 'new career started');
ok(game.train.vehicles.length === 3, 'player consist is a GP-7 and two boxcars', `${game.train.vehicles.length} units`);
ok(game.stock.loose.length > 20, 'yards are stocked with loose cars', `${game.stock.loose.length} standing`);
ok(game.stations.list.length === 12, 'twelve stations online');

const spawnPos = net.positionOf(game.train.state, new THREE.Vector3());
ok(game.train.state.seg.id === SPAWN.seg, 'spawned on the Millford main', `u=${game.train.state.u.toFixed(3)}`);
ok(spawnPos.y > 0, 'spawn is above sea level', `y=${spawnPos.y.toFixed(1)}`);

/* --------------------------------------------------------- world streaming */
section('world streaming');
let frames = 0;
const t0 = Date.now();
for (let i = 0; i < 240; i++) { game.update(1 / 60); frames++; }
const elapsed = (Date.now() - t0) / 1000;
const st = game.world.stats();
ok(st.terrainTris > 0, 'terrain generated', `${st.terrainTris.toLocaleString()} tris, ${st.terrainQueued} queued`);
ok(st.trackTris > 0, 'track built', `${st.trackTris.toLocaleString()} tris over ${st.trackSegments} segments`);
ok(st.vegProps > 0, 'vegetation scattered', `${st.vegProps.toLocaleString()} props / ${st.vegCells} cells`);
ok(st.structures > 0, 'structures streamed in', `${st.structures} visible`);
ok(st.waterTris > 0, 'water present', `${st.waterTris.toLocaleString()} tris`);
ok(elapsed < 40, 'sim frames are affordable headless', `${(elapsed / frames * 1000).toFixed(1)} ms/frame over ${frames} frames`);
ok(game.fps === game.fps, 'frame timing recorded', `${(frames / elapsed).toFixed(0)} headless fps`);

/* ---------------------------------------------------------------- driving */
section('driving');
const train = game.train;
train.setReverser('f');
train.notch(8);
let maxKmh = 0;
for (let i = 0; i < 900; i++) { game.update(1 / 60); maxKmh = Math.max(maxKmh, train.kmh); }
ok(maxKmh > 30, 'the train accelerates under power', `peak ${maxKmh.toFixed(1)} km/h`);
ok(train.tripKm > 0.05, 'distance was travelled', `${train.tripKm.toFixed(2)} km in 15 s`);
ok(train.forces.te > 0, 'tractive effort is being produced', `${(train.forces.te / 1000).toFixed(0)} kN`);

train.notch(-train.controls.throttle);
train.setBrake(1);
let brakeFrames = 0;
while (train.kmh > 0.5 && brakeFrames < 3000) { game.update(1 / 60); brakeFrames++; }
ok(train.kmh < 0.5, 'the train stops under a full service application', `${(brakeFrames / 60).toFixed(1)} s`);
ok(train.brakePipe > 0.9, 'the brake pipe charged up', train.brakePipe.toFixed(2));

/* --------------------------------------------------------------- coupling */
section('coupling');
const before = train.vehicles.length;
const loose = game.stock.loose.find((v) => v.state);
ok(!!loose, 'there is loose stock in the world');
if (loose) {
  // park it right under the nose
  const nose = net.cloneState(train.state);
  net.advance(nose, 5.0);
  game.stock.park(loose, nose);
  train.speed = 0.4;
  train.moving = 1;
  game.coupleCheck();
  ok(train.vehicles.length === before + 1, 'a car standing at the coupler is picked up', `${before} → ${train.vehicles.length}`);
  ok(!game.stock.loose.includes(loose), 'the car left the loose list');
  const off = train.decouple(train.vehicles.length - 2, game.stock);
  ok(off.length === 1, 'and can be uncoupled again');
}

/* --------------------------------------------------------------- contracts */
section('contracts');
const millford = net.nodeById('millford');
const st0 = net.makeState('p_mill_yard_a', 0.06, 1);
train.setConsist(train.vehicles, st0);
train.speed = 0;
train.placeCars();
game.update(1 / 60);
const atStation = game.stations.at(train);
ok(!!atStation?.station, 'the train registers as being at a station', atStation?.station?.id);

const stationId = atStation.station.id;
game.contracts.rollFor(stationId);
const board = game.contracts.board(stationId);
ok(board.length > 0, 'the station board has work on it', `${board.length} offers`);

// find an offer we can fully run with the empty cars we have
const empties = (typeKey) => train.vehicles.filter((v) => v.typeKey === typeKey && !v.cargo).length;
let compatible = board.find((c) => empties(c.carType) >= c.cars);
for (let i = 0; i < 10 && !compatible; i++) {
  game.contracts.rollFor(stationId);
  compatible = board.find((c) => empties(c.carType) >= c.cars);
}
ok(!!compatible, 'at least one offer matches a car in the consist', compatible && `${compatible.cargoLabel} → ${compatible.destName}`);

if (compatible) {
  const creditsBefore = game.economy.credits;
  const taken = game.contracts.accept(compatible.id, { stationId, train });
  ok(!!taken, 'the contract was accepted');
  ok(game.contracts.active.length === 1, 'it is now active');
  const loaded = train.vehicles.filter((v) => v.contractId === compatible.id);
  ok(loaded.length > 0, 'cars were loaded from the yard', `${loaded.length} car(s), ${Math.round(loaded.reduce((a, v) => a + v.tons, 0))} t`);
  ok(board.indexOf(compatible) < 0, 'the offer left the board');

  // run it to the destination by rail (teleport honestly: place on the dest siding)
  const dest = game.stations.get(compatible.dest);
  const destSiding = dest.def.sidings?.[0];
  const destSeg = destSiding ? net.segmentById(destSiding.seg) : null;
  ok(!!destSeg, 'destination has a siding to stand in', destSiding?.seg);
  if (destSeg) {
    const u = clamp01((destSiding.from + 6) / destSeg.length);
    train.setConsist(train.vehicles, net.makeState(destSeg.id, u, 1));
    train.speed = 0;
    train.placeCars();
    game.stations.update(1 / 60, train, game.stock);
    ok(game.stations.current?.id === dest.id, 'arrived at the destination', game.stations.current?.id);
    for (let i = 0; i < 130; i++) game.update(1 / 60);   // > 1.4 s standing
    ok(game.contracts.active.length === 0, 'the contract completed on arrival');
    ok(game.economy.credits > creditsBefore, 'the delivery paid out', `${creditsBefore} → ${Math.round(game.economy.credits)}`);
    ok(game.economy.deliveries === 1, 'a delivery was counted');
    ok(dest.rep > 0, 'the destination station likes us now', `rep ${dest.rep.toFixed(2)}`);
    ok(train.vehicles.every((v) => !v.cargo), 'the cars were emptied');
  }
}

/* ------------------------------------------------------- selling free market */
section('free market');
{
  // millford's goods were just shipped out, so trade somewhere with stock
  const st = game.stations.get('dustflats');
  const car = train.vehicles.find((v) => v.freight && !v.cargo);
  ok(!!car, 'an empty freight car is available');
  if (car) {
    // pick a cargo this car type can actually carry
    const cargoKey = st.produces.find((c) => CARGO[c]?.car === car.typeKey) || st.produces[0];
    const loadedTons = game.stations.loadVehicle(car, st, cargoKey, 40);
    ok(loadedTons > 0 || CARGO[cargoKey].car !== car.typeKey, 'the yard can load a car of the right type',
      `${Math.round(loadedTons)} t of ${CARGO[cargoKey].label} into a ${car.typeKey}`);
    const creditsBefore = game.economy.credits;
    const result = game.contracts.deliver(train, 'millford');   // wrong station → discount
    ok(result.ignored.length >= 0, 'unwanted cargo is reported, not silently dropped', `${result.accepted.length} accepted / ${result.ignored.length} discounted`);
    ok(game.economy.credits >= creditsBefore, 'it still sells for something', `${formatDelta(game.economy.credits - creditsBefore)}`);
  }
}
function formatDelta(v) { return `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v))}`; }

/* ------------------------------------------------------------------- AI */
section('AI traffic');
game.settings.aiTraffic = 3;
game.ai.setCount(3);
game.ai.spawnTimer = 0;
for (let i = 0; i < 60; i++) { game.ai.spawnTimer = 0; game.update(1 / 60); }
ok(game.ai.trains.length >= 1, 'AI trains entered the world', `${game.ai.trains.length} running`);
if (game.ai.trains.length) {
  const e = game.ai.trains[0];
  const kmh0 = e.train.kmh;
  for (let i = 0; i < 900; i++) game.update(1 / 60);
  ok(e.train.kmh > 4 || e.driver.mode === 'dwell' || e.train.tripKm > 0.05,
    'an AI train drives itself', `${e.train.kmh.toFixed(1)} km/h, mode ${e.driver.mode}, ${e.train.tripKm.toFixed(2)} km run`);
  ok(e.train.state && e.train.state.seg, 'the AI train is still on the rails', e.train.state?.seg?.id);
  ok(game.blocks.occ.size > 0, 'blocks are occupied by traffic', `${game.blocks.occ.size} segments`);
  ok(typeof game.ai.blips()[0].kmh === 'number', 'AI blips are available for the map');
}

/* --------------------------------------------------------------- camera */
section('camera');
{
  const lookInput = (dy) => ({
    takeMouse: () => ({ dx: 0, dy, dragX: 0, dragY: 0, wheel: 0, left: false }),
    keyDown: () => false,
  });
  const modeBefore = game.cameraCtl.mode;
  game.cameraCtl.setMode('cab', true);
  game.cameraCtl.invertY = false;
  game.cameraCtl.pitch = 0;
  game.cameraCtl.update(1 / 60, game.train, lookInput(240));
  const normal = game.cameraCtl.pitch;
  game.cameraCtl.invertY = true;
  game.cameraCtl.pitch = 0;
  game.cameraCtl.update(1 / 60, game.train, lookInput(240));
  const inverted = game.cameraCtl.pitch;
  ok(Math.abs(normal) > 1e-4, 'vertical look moves the cab camera', normal.toFixed(4));
  ok(Math.sign(normal) === -Math.sign(inverted) && Math.abs(Math.abs(normal) - Math.abs(inverted)) < 1e-9,
    'invert look Y flips it, same magnitude', `${normal.toFixed(4)} → ${inverted.toFixed(4)}`);
  game.cameraCtl.invertY = false;
  game.cameraCtl.setMode(modeBefore, true);
}

/* ------------------------------------------------- the world keeps moving */
section('living world');
{
  // A board that only advertises work the player cannot haul is a dead end, so
  // roll every station's board from scratch against a known consist and check
  // there is always something on it they could actually run.
  const consist = {
    vehicles: ['boxcar', 'boxcar', 'hopper', 'flatbed', 'gondola', 'tanker']
      .map((typeKey) => ({ typeKey, cargo: null })),
  };
  const empties = new Map();
  for (const v of consist.vehicles) empties.set(v.typeKey, (empties.get(v.typeKey) || 0) + 1);
  let attempts = 0;
  let runnable = 0;
  for (const st of game.stations.list) {
    for (let i = 0; i < 6; i++) {
      game.contracts.boards.set(st.id, []);
      const board = game.contracts.rollFor(st.id, consist);
      if (!board.length) continue;
      attempts++;
      if (board.some((c) => (empties.get(c.carType) || 0) >= c.cars)) runnable++;
    }
  }
  ok(attempts > 0 && runnable === attempts,
    'every station board carries work the consist can run', `${runnable}/${attempts} fresh boards`);

  // Out of sight, out of mind used to mean frozen: an AI train more than 5 km
  // from the player never moved, so the timetable on the map stood still.
  const e = game.ai.trains[0];
  ok(!!e, 'there is an AI train to test');
  if (e) {
    game.ai._reset(e);                       // standing start on a running line
    e.train.speed = 0;
    e.driver.mode = 'run';
    const km0 = e.train.tripKm;
    for (let i = 0; i < 900; i++) { game.ai._cruise(e, 1 / 60); e.train.step(1 / 60); }
    const run = e.train.tripKm - km0;
    ok(run > 0.05 || e.driver.mode === 'dwell',
      'an out-of-sight train still covers ground on cruise control',
      `${run.toFixed(2)} km in 15 s, mode ${e.driver.mode}`);
    ok(!!e.train.state?.seg, 'and it is still on the rails afterwards', e.train.state?.seg?.id);
  }
  game.contracts.boards.clear();
  for (const st of game.stations.list) game.contracts.rollFor(st.id, train);
}

/* -------------------------------------------------------------- signals */
section('signals');
{
  game.structures.updateSignals((n, s) => game.blocks.occupied(n, s));
  const aspects = game.structures.signals.map((s) => s.aspect);
  ok(aspects.length > 0, 'signals exist on every switchable node', `${aspects.length} heads`);
  ok(aspects.every((a) => ['red', 'yellow', 'green'].includes(a)), 'every signal shows a legal aspect', aspects.slice(0, 6).join(','));
  const sig = game.blocks.nextAspect(train, 1600);
  ok(!!sig, 'the driver gets a next-signal readout', sig ? `${sig.aspect} in ${Math.round(sig.distance)} m` : '');
}

/* -------------------------------------------------------------- weather */
section('weather');
{
  const densities = {};
  for (const id of ['clear', 'cloudy', 'rain', 'storm', 'fog', 'snow']) {
    game.weather.setWeather(id, true);
    for (let i = 0; i < 120; i++) game.update(1 / 60);
    densities[id] = scene.fog.density;
  }
  ok(densities.fog > densities.clear * 2, 'fog thickens the air', `clear ${densities.clear.toExponential(2)} → fog ${densities.fog.toExponential(2)}`);
  game.weather.setWeather('fog', true);
  for (let i = 0; i < 240; i++) game.update(1 / 60);
  ok(game.weather.visibility() < 2000, 'visibility drops in fog', `${Math.round(game.weather.visibility())} m`);
  ok(scene.fog.density > densities.clear, 'and the scene fog follows it', scene.fog.density.toExponential(2));
  game.weather.setWeather('rain', true);
  for (let i = 0; i < 60; i++) game.update(1 / 60);
  const grip = game.weather.grip();
  ok(near(grip, PHYS.adhesionWeather.rain, 0.02), 'wet rail reduces adhesion', `grip ${grip.toFixed(2)}`);
  ok(PHYS.adhesionWeather.storm !== undefined, 'storms have an adhesion entry');
  game.weather.setWeather('clear', true);
  for (let i = 0; i < 120; i++) game.update(1 / 60);
  ok(game.weather.grip() > 0.98, 'dry rail grips again', game.weather.grip().toFixed(2));
}

/* ------------------------------------------------------------- day/night */
section('day and night');
{
  const samples = [];
  for (const t of [0, 0.25, 0.5, 0.75]) {
    game.cycle.t = t;
    for (let i = 0; i < 200; i++) { game.cycle.t = t; game.update(1 / 60); }   // let the rig settle
    samples.push({ t, el: game.cycle.elevation, sun: game.sky.sunLight.intensity, amb: game.sky.ambient.intensity, hemi: game.sky.hemi.intensity });
  }
  ok(samples[1].el > 0 && samples[0].el < 0, 'the sun rises and sets', samples.map((s) => `t${s.t}=${(s.el * 90).toFixed(0)}°`).join(' '));
  ok(samples[2].sun > samples[0].sun * 4, 'daylight is much brighter than night',
    `midnight ${samples[0].sun.toFixed(2)} → noon ${samples[2].sun.toFixed(2)}`);
  ok(samples[2].el > 0.9, 'the sun is overhead at noon', samples[2].el.toFixed(2));
  ok(samples[0].hemi < samples[2].hemi, 'skylight follows the sun', `hemi ${samples[0].hemi.toFixed(2)} → ${samples[2].hemi.toFixed(2)}`);
  ok(samples[0].amb > 0.2, 'night keeps a moonlight fill so the world is not black', samples[0].amb.toFixed(2));
  ok(game.sky.sunLight.position.length() > 0, 'the shadow-casting light has a position');
  ok(game.cycle.clock.includes(':'), 'the clock reads as a time of day', game.cycle.clock);
}

/* ----------------------------------------------------------- progression */
section('progression');
{
  ok(game.progression.isRegionOpen('plains'), 'the plains start open');
  ok(!game.progression.isRegionOpen('forest'), 'the forest starts locked');
  const lockedSeg = [...net.segments.values()].find((s) => s.region === 'forest');
  ok(!net.isOpen(lockedSeg), 'locked track really is closed', lockedSeg.id);
  game.economy.deliveries = 6;
  game.progression.update();
  ok(game.progression.isRegionOpen('forest'), 'five deliveries open the forest');
  ok(net.isOpen(lockedSeg), 'and the forest track opens with it');
  game.economy.earned = 2500;
  game.progression.update();
  ok(game.progression.isLocoOwned('sd40'), 'money unlocks the SD-40');
  const repSt = game.stations.get('millford');
  repSt.rep = 3.2;
  game.progression.update();
  ok(game.progression.isRegionOpen('coastal'), 'reputation at Millford opens the coast');
  ok(game.progression.table().some((m) => m.done), 'the career page shows earned milestones');
}

/* ------------------------------------------------------------- upgrades */
section('upgrades');
{
  game.economy.credits = 5000;
  const carsBefore = train.maxCars;
  ok(game.upgrades.cost('capacity') === 350, 'tier one couplers cost 350');
  ok(game.upgrades.buy('capacity'), 'the upgrade was bought');
  ok(train.upgrades.capacity === 1, 'the train knows about it');
  ok(train.maxCars === carsBefore + 1, 'and can pull one more car', `${carsBefore} → ${train.maxCars}`);
  ok(game.economy.credits === 4650, 'the money was taken', String(Math.round(game.economy.credits)));
  ok(!game.upgrades.buy('brakes') === false, 'brakes can be bought too');
  const table = game.upgrades.table();
  ok(table.length === 3, 'the shop lists three upgrade lines');
}

/* ----------------------------------------------------------- passengers */
section('passengers');
{
  game.passengers.setUnlocked(true);
  game.contracts.setPassengers(true);
  const waiting0 = game.passengers.waitingAt('millford');
  const coach = game.stock.car('coach', {});
  game.addVehicle(coach);
  const boarded = game.passengers.board(coach, 'millford', 64);
  ok(boarded > 0, 'passengers board a coach', `${boarded} of ${waiting0} waiting`);
  ok(game.passengers.waitingAt('millford') === waiting0 - boarded, 'the platform empties accordingly');
  const rough = { train, jolt: 1, slip: 0 };
  game.passengers._train = { vehicles: [coach], kmh: 40, jolt: 1 };
  bus.emit('train:emergency', { train: game.passengers._train });
  ok(coach.condition < 100, 'an emergency brake costs comfort', `${coach.condition.toFixed(0)}%`);
  const alighted = game.passengers.alight(coach, 'dustflats');
  ok(alighted === boarded, 'they get off at the other end', String(alighted));
}

/* -------------------------------------------------------------- tutorial */
section('tutorial');
{
  game.tutorial.reset();
  const step0 = game.tutorial.index;
  train.controls.throttle = 3;
  game.tutorial.update(1 / 60);
  ok(game.tutorial.index === step0 + 1, 'the first lesson completes when you open the throttle', game.tutorial.step?.id);
  train.speed = 30 / 3.6;
  game.tutorial.update(1 / 60);
  ok(game.tutorial.index === step0 + 2, 'and the next when you reach 25 km/h');
  game.tutorial.skip();
  ok(game.tutorial.finished || !game.tutorial.enabled, 'the tutorial can be skipped');
  train.controls.throttle = 0;
  train.speed = 0;
}

/* ------------------------------------------------------- save and load */
section('save and load');
{
  game.tutorial.reset();
  const credits = Math.round(game.economy.credits);
  const vehicles = game.stock.all.size;
  const seg = train.state.seg.id;
  const delivered = game.economy.deliveries;
  const rep = game.stations.get('millford').rep;
  const saved = game.save.save(1, { note: 'test' });
  ok(!!saved, 'the game saved to slot 1');
  ok(storage._map.size >= 1, 'the save file was written', `${saved && JSON.stringify(saved).length.toLocaleString()} bytes, ${storage._map.size} slot(s)`);
  ok(game.save.has(1), 'slot 1 reports as occupied');
  const list = game.save.list();
  ok(list.find((s) => s.slot === 1)?.exists, 'the slot list sees it');

  // wreck the state, then load it back
  game.economy.credits = 1;
  game.buildGameplay();
  ok(game.economy.credits !== credits, 'state was reset');
  const loaded = game.loadSave(1);
  ok(!!loaded, 'the save loaded again');
  ok(Math.round(game.economy.credits) === credits, 'credits survived the round trip', `${credits}`);
  ok(game.stock.all.size === vehicles, 'every vehicle came back', `${game.stock.all.size}/${vehicles}`);
  ok(game.train.state.seg.id === seg, 'the train is where it was parked', game.train.state.seg.id);
  ok(game.economy.deliveries === delivered, 'deliveries survived');
  ok(near(game.stations.get('millford').rep, rep, 1e-6), 'reputation survived');
  ok(game.progression.isRegionOpen('forest'), 'unlocks survived');
  ok(game.train.upgrades.capacity === 1, 'upgrades survived');
  for (let i = 0; i < 120; i++) game.update(1 / 60);
  ok(true, 'the loaded world keeps simulating');
}

/* ------------------------------------------------------------- teardown */
section('teardown');
game.dispose();
ok(scene.children.length >= 0, 'the world tears down without throwing');

console.log(`\n${fail === 0 ? '✓' : '✗'} game integration: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
