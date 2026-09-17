/**
 * Headless check of the consist + physics layer:
 * articulated car placement, throttle/brake response, reverse running,
 * coupler work and derailment detection.
 */
import fs from 'node:fs';
import { TrackNetwork } from '../src/systems/TrackNetwork.js';
import { AssetManager } from '../src/systems/AssetManager.js';
import { RollingStockManager } from '../src/systems/RollingStockManager.js';
import { TrainController } from '../src/systems/TrainController.js';
import { CAR_GAP } from '../src/constants.js';
import * as THREE from 'three';

const net = new TrackNetwork(JSON.parse(fs.readFileSync(new URL('../assets/data/tracks.json', import.meta.url))));
net.setRegions(['plains', 'forest', 'coastal', 'alpine']);
const assets = new AssetManager();
const rs = new RollingStockManager(assets);

let fails = 0;
const ok = (cond, msg, extra = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}${extra ? ' — ' + extra : ''}`);
  if (!cond) fails++;
};

function buildTrain(locoType, cars, station, offset = 60) {
  const vehicles = [rs.loco(locoType)];
  for (const c of cars) vehicles.push(rs.car(c));
  const t = new TrainController(net, { weather: () => 'clear' });
  t.setConsist(vehicles, net.stateAtNode(station, 0, offset));
  for (const v of t.vehicles) v.build(assets);
  t.placeCars();
  return t;
}

console.log('\n[1] consist geometry');
{
  const t = buildTrain('gp7', ['boxcar', 'hopper', 'tanker', 'flatbed'], 'dustflats');
  ok(t.vehicles.length === 5, 'consist has 5 vehicles');
  console.log(`    mass ${Math.round(t.tonnes)} t · length ${t.length.toFixed(1)} m · ${Math.round(t.powerW / 746)} hp · TE ${Math.round(t.teStart / 1000)} kN`);
  ok(Math.abs(t.length - (17 + 15 + 13 + 14 + 16 + 4 * CAR_GAP)) < 0.01, 'length sums bodies + coupler gaps', `${t.length.toFixed(1)} m`);
  // car spacing must match the sum of half-lengths + gap
  let bad = 0, minGap = Infinity;
  for (let i = 1; i < t.vehicles.length; i++) {
    const a = t.vehicles[i - 1].group.position, b = t.vehicles[i].group.position;
    const d = a.distanceTo(b);
    const want = t.vehicles[i - 1].length / 2 + CAR_GAP + t.vehicles[i].length / 2;
    // placement is exact in ARC length; a straight-line measure reads short
    // where the consist straddles a diverging turnout, so allow for that.
    const straddles = t.vehicles[i - 1].state.seg !== t.vehicles[i].state.seg;
    const tol = straddles ? 0.05 * want : 0.05;
    if (Math.abs(d - want) > tol) bad++;
    minGap = Math.min(minGap, d - (t.vehicles[i - 1].length + t.vehicles[i].length) / 2);
    for (const v of [a, b]) if (!Number.isFinite(v.x + v.y + v.z)) bad++;
  }
  ok(bad === 0, 'every car sits the right distance behind the one ahead');
  ok(minGap > 0.2, 'no car overlaps its neighbour', `min gap ${minGap.toFixed(2)} m`);
  for (const v of t.vehicles) {
    const q = v.group.quaternion;
    if (![q.x, q.y, q.z, q.w].every(Number.isFinite)) throw new Error(`non-finite orientation on ${v.id}`);
  }
  ok(true, 'all cars have finite orientations');
  // drive 1.5 km and re-check spacing (articulation through curves + junctions)
  t.controls.reverser = 'f'; t.controls.throttle = 8; t.controls.brake = 0;
  for (let i = 0; i < 900; i++) { t.step(1 / 60); }
  let bad2 = 0;
  for (let i = 1; i < t.vehicles.length; i++) {
    const d = t.vehicles[i - 1].group.position.distanceTo(t.vehicles[i].group.position);
    const want = t.vehicles[i - 1].length / 2 + CAR_GAP + t.vehicles[i].length / 2;
    const straddles = t.vehicles[i - 1].state.seg !== t.vehicles[i].state.seg;
    if (Math.abs(d - want) > (straddles ? 0.05 * want : 0.08)) bad2++;
  }
  ok(bad2 === 0, 'consist stays articulated while rolling', `${t.kmh.toFixed(1)} km/h after 15 s`);
  ok(t.trail.length > 5, 'path history is being recorded', `${t.trail.length} samples`);
  t.controls.throttle = 0; t.controls.brake = 1;
  let guard = 0;
  while (t.speed > 0.05 && guard++ < 6000) t.step(1 / 60);
  ok(t.speed < 0.06, 'full service brake brings the train to rest', `${(guard / 60).toFixed(1)} s`);
}

console.log('\n[2] throttle and brake feel');
{
  const t = buildTrain('gp7', ['boxcar', 'boxcar', 'boxcar', 'boxcar'], 'millford');
  t.controls.reverser = 'f';
  const samples = [];
  for (let s = 0; s < 8; s++) {
    t.controls.throttle = s === 0 ? 0 : s;
    t.controls.brake = 0;
    const v0 = t.kmh;
    for (let i = 0; i < 300; i++) t.step(1 / 60);
    samples.push([s, v0, t.kmh]);
  }
  for (const [n, v0, v1] of samples) console.log(`    notch ${n}: ${v0.toFixed(1)} → ${v1.toFixed(1)} km/h`);
  ok(samples[8 - 1][2] > samples[3][2], 'higher notches accelerate harder');
  ok(samples[0][2] === 0 || samples[0][2] < 0.2, 'notch 0 does not move the train');
  // braking distance from ~60 km/h
  t.controls.throttle = 0;
  for (let i = 0; i < 600 && t.kmh < 55; i++) t.step(1 / 60);
  const km0 = t.tripKm, v0 = t.kmh;
  t.controls.brake = 1;
  let g = 0;
  while (t.speed > 0.05 && g++ < 6000) t.step(1 / 60);
  const dist = (t.tripKm - km0) * 1000;
  console.log(`    stop from ${v0.toFixed(0)} km/h in ${dist.toFixed(0)} m (${(g / 60).toFixed(1)} s)`);
  ok(dist > 150 && dist < 900, 'stopping distance is in a playable band');
}

console.log('\n[3] reverse / shunting');
{
  const t = buildTrain('gp7', ['boxcar'], 'coalridge');
  t.controls.reverser = 'r'; t.controls.throttle = 8;
  const p0 = net.positionOf(t.state).clone();
  for (let i = 0; i < 60 * 40; i++) t.step(1 / 60);
  const p1 = net.positionOf(t.state).clone();
  console.log(`    reversed ${p0.distanceTo(p1).toFixed(0)} m, top speed ${t.kmh.toFixed(1)} km/h`);
  ok(t.kmh <= 25.6, 'shunting is capped near 25 km/h', `${t.kmh.toFixed(1)} km/h`);
  ok(t.moving === -1, 'reverser keeps the nose pointing backwards');
  const f = net.frame(t.state);
  const toP0 = p0.clone().sub(p1).normalize();
  ok(f.forward.dot(toP0) > 0.5 || t.state.blocked, 'the nose faces away from the direction of travel');
  t.controls.throttle = 0; t.controls.brake = 1;
  for (let i = 0; i < 3000 && t.speed > 0.05; i++) t.step(1 / 60);
  t.setReverser('f');
  ok(t.controls.reverser === 'f', 'reverser can be restored once stopped');
}

console.log('\n[4] coupling and decoupling');
{
  const t = buildTrain('gp7', ['boxcar', 'boxcar'], 'cedarmill');
  const spare = rs.car('hopper');
  t.placeCars();
  const tailState = t.vehicles[2].state;
  rs.park(spare, net.back(tailState, t.vehicles[2].length / 2 + CAR_GAP + spare.length / 2));
  spare.build(assets);
  ok(t.couple(spare), 'a loose car can be coupled on');
  ok(t.vehicles.length === 4, 'consist grew to 4');
  const rear = t.decouple(1, rs);
  ok(rear.length === 2, 'decoupling splits the consist behind the chosen car', rear.map((v) => v.typeKey).join(','));
  ok(rs.loose.includes(rear[0]) && rs.loose.includes(rear[1]), 'the split cars are parked as loose stock');
  ok(t.vehicles.length === 2, 'the train kept its head end');
  t.controls.reverser = 'f'; t.controls.throttle = 4;
  for (let i = 0; i < 300; i++) t.step(1 / 60);
  ok(t.speed > 0.5, 'the shortened train still drives');
}

console.log('\n[5] safety systems');
{
  const t = buildTrain('sd40', ['hopper', 'hopper'], 'ironvale');
  t.controls.reverser = 'f'; t.controls.throttle = 8; t.controls.brake = 0;
  let derailed = null;
  const off = (e) => { derailed = e; };
  t.bus.on('train:derail', off);
  for (let i = 0; i < 60 * 300 && !derailed; i++) t.step(1 / 60);
  ok(!!derailed, 'sustained over-speed eventually derails the train', derailed ? `${derailed.reason} at ${Math.round(derailed.speed * 3.6)} km/h` : '');
  ok(t.speed === 0, 'a derailed train cannot move');
  t.rerail();
  ok(!t.derail, 're-railing clears the derailment');
  t.controls.throttle = 6;
  for (let i = 0; i < 600; i++) t.step(1 / 60);
  ok(t.speed > 1, 'the train drives away after re-railing');
}

console.log('\n[6] brake application event');
{
  const t = buildTrain('gp7', ['boxcar'], 'ironvale');
  let events = 0;
  const onBrake = () => { events++; };
  t.bus.on('train:brakeApplied', onBrake);
  t.setBrake(0);
  for (let i = 0; i < 60; i++) t.setBrake(0.6);       // a held application, one second
  ok(events === 1, 'applying the brake announces itself exactly once', `${events} event(s)`);
  t.setBrake(0);
  t.setBrake(0.02);                                    // below the threshold: no event
  ok(events === 1, 'a breath on the brake does not count', `${events} event(s)`);
  t.setBrake(0);
  t.setBrake(0.35);
  ok(events === 2, 'the next application does', `${events} event(s)`);
  t.bus.off('train:brakeApplied', onBrake);
}

console.log(`\n${fails ? `✗ ${fails} check(s) failed` : '✓ rolling stock + train physics OK'}`);
process.exit(fails ? 1 : 0);
