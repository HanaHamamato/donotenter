/**
 * Headless verification of the track graph + a 1-D physics smoke test.
 * Runs in Node (three.js math classes work fine outside a browser).
 *   npm test
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TrackNetwork } from '../src/systems/TrackNetwork.js';
import * as THREE from 'three';
import { PHYS, LOCOMOTIVES, CAR_TYPES } from '../src/constants.js';
import { mulberry32 } from '../src/utils/math.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/data/tracks.json'), 'utf8'));
const stations = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/data/stations.json'), 'utf8')).stations;

let failures = 0;
const ok = (cond, msg) => { if (!cond) { failures++; console.log('  ✗ ' + msg); } else console.log('  ✓ ' + msg); };

const net = new TrackNetwork(data);
net.setRegions(['plains', 'forest', 'alpine', 'coastal']);
net.openBranch('summitloop');

console.log(`\nIRONBOUND network: ${net.segments.size} segments, ${net.nodes.size} nodes, `
  + `${(net.totalLength / 1000).toFixed(1)} km, ${net.corridor.length} corridor samples`);

console.log('\n[1] geometry sanity');
{
  let bad = 0, maxGrade = 0, maxKappa = 0, minLen = Infinity, maxLen = 0;
  let gradeWhere = '', curveWhere = '';
  for (const seg of net.segments.values()) {
    minLen = Math.min(minLen, seg.length); maxLen = Math.max(maxLen, seg.length);
    if (!isFinite(seg.length) || seg.length < 20) bad++;
    for (let i = 0; i <= 40; i++) {
      const u = i / 40;
      const st = net.makeState(seg.id, u, i % 2 ? 1 : -1);
      const f = net.frame(st);
      if (!isFinite(f.position.x + f.position.y + f.position.z)) bad++;
      if (!isFinite(f.grade) || !isFinite(f.kappa)) bad++;
      if (Math.abs(f.grade) > maxGrade) { maxGrade = Math.abs(f.grade); gradeWhere = `${seg.id}@${u.toFixed(2)}`; }
      if (f.kappa > maxKappa) { maxKappa = f.kappa; curveWhere = `${seg.id}@${u.toFixed(2)}`; }
    }
  }
  ok(bad === 0, `all sampled frames finite (${bad} bad)`);
  console.log(`    segment length ${minLen.toFixed(0)}–${maxLen.toFixed(0)} m · max grade ${(maxGrade * 100).toFixed(2)}% (${gradeWhere}) · min curve R ${(1 / maxKappa).toFixed(0)} m (${curveWhere})`);
  ok(maxGrade < 0.085, 'no grade steeper than 8.5%');
  ok(1 / maxKappa > 55, 'no curve tighter than R=55 m');
}

console.log('\n[2] graph traversal');
{
  // BFS over the node graph using resolveNode semantics (all routes forced).
  const stationNodes = stations.map((s) => s.node);
  const reach = new Map();
  for (const startId of stationNodes) {
    const start = net.nodes.get(startId);
    if (!start) { failures++; console.log(`  ✗ station node ${startId} missing`); continue; }
    const seen = new Set([startId]);
    const queue = [startId];
    while (queue.length) {
      const nid = queue.shift();
      const node = net.nodes.get(nid);
      for (const br of node.branches) {
        const seg = br.segment;
        if (!net.isOpen(seg)) continue;
        const otherId = seg.a === nid ? seg.b : seg.a;
        if (!seen.has(otherId)) { seen.add(otherId); queue.push(otherId); }
      }
    }
    reach.set(startId, seen);
  }
  let all = true;
  for (const a of stationNodes) {
    for (const b of stationNodes) {
      if (!reach.get(a)?.has(b)) { all = false; console.log(`  ✗ ${a} cannot reach ${b}`); }
    }
  }
  ok(all, `every station reaches every other station (${stationNodes.length}×${stationNodes.length})`);
}

console.log('\n[3] driving the network (advance + junction routing)');
{
  // Drive every segment end to end in both directions: the strongest possible
  // check on advance(), because a random walk never sees most sidings.
  const p0 = new THREE.Vector3(), p1 = new THREE.Vector3();
  let driven = 0, teleports = 0, shortRuns = 0, blockedEnds = 0;
  for (const seg of net.segments.values()) {
    for (const dir of [1, -1]) {
      const st = net.makeState(seg.id, dir > 0 ? 0 : 1, dir);
      let travelled = 0, maxJump = 0;
      net.positionOf(st, p0);
      for (let i = 0; i < 4000; i++) {
        const moved = net.advance(st, 4);
        travelled += Math.abs(moved);
        net.positionOf(st, p1);
        maxJump = Math.max(maxJump, p0.distanceTo(p1));
        p0.copy(p1);
        if (st.blocked) { blockedEnds++; break; }
        if (st.seg !== seg) break;   // ran on past the far node — fine
        if (!Number.isFinite(st.u) || st.u < -1e-6 || st.u > 1 + 1e-6) { failures++; console.log(`  ✗ u out of range on ${seg.id}: ${st.u}`); break; }
      }
      driven += travelled;
      if (maxJump > 12) { teleports++; console.log(`  ✗ ${seg.id} dir ${dir}: ${maxJump.toFixed(1)} m jump`); }
      if (travelled < seg.length * 0.9 && travelled < 200) shortRuns++;
    }
  }
  console.log(`    drove every segment both ways: ${(driven / 1000).toFixed(1)} km, ${blockedEnds} buffer/lock stops`);
  ok(teleports === 0, 'no discontinuities while driving');
  ok(shortRuns === 0, 'every segment can be driven along its whole length');

  // seeded random walk exercises junction routing decisions
  const rand = mulberry32(12345);
  const start = net.stateAtNode('dustflats', 2, 0); // toward Millford
  let dist = 0, hops = 0, lastSeg = start.seg.id;
  let prevSeg = start.seg;
  const seen = new Set([lastSeg]);
  for (let i = 0; i < 60000; i++) {
    const before = start.seg;
    const moved = net.advance(start, 5);
    dist += moved;
    if (start.blocked) { hops++; start.dir = -start.dir; start.blocked = null; net.advance(start, 5); continue; }
    if (start.seg.id !== lastSeg) {
      seen.add(start.seg.id); lastSeg = start.seg.id; hops++;
      const node = start.node;
      prevSeg = before;
      if (node) {
        const opts = net.routesFrom(node, prevSeg).filter((o) => net.isOpen(o.segment));
        if (opts.length > 1) {
          const pick = opts[Math.floor(rand() * opts.length)];
          net.setRouteIndex(node, node.branches.indexOf(pick));
        }
      }
    }
  }
  console.log(`    seeded random walk: ${(dist / 1000).toFixed(1)} km, ${hops} hops, visited ${seen.size}/${net.segments.size} segments`);
  ok(seen.size >= net.segments.size * 0.55, `random walk explored ${seen.size}/${net.segments.size} segments`);
  // every siding must actually be enterable from its station throat
  let sidingOk = 0, sidingTotal = 0;
  for (const st of stations) {
    for (const sd of st.sidings) {
      sidingTotal++;
      const node = net.nodes.get(st.node);
      const idx = node.branches.findIndex((b) => b.seg === sd.seg);
      if (idx < 0) continue;
      net.setRouteIndex(node, idx);
      const probe = net.makeState(node.branches[idx].seg, node.branches[idx].end === 'a' ? 0 : 1, node.branches[idx].end === 'a' ? 1 : -1);
      net.advance(probe, 40);
      if (probe.seg.id === sd.seg) sidingOk++;
    }
  }
  console.log(`    sidings reachable from their station throat: ${sidingOk}/${sidingTotal}`);
  ok(sidingOk === sidingTotal, 'every siding is enterable');
}

console.log('\n[4] physics: GP-7 on the ruling grade');
{
  const loco = LOCOMOTIVES.gp7;
  // GP-7 + 4 loaded boxcars: the starter consist from GDD §3.4
  const mass = loco.mass + 4 * CAR_TYPES.boxcar.massLoaded;
  const run = (grade, notch, secs) => {
    let v = 0;
    const dt = PHYS.fixedStep;
    for (let t = 0; t < secs; t += dt) {
      const P = loco.powerHP * 745.7;
      let te = (notch / 8) * Math.min(loco.teStart, P / Math.max(v, PHYS.minSpeedForPower));
      te = Math.min(te, PHYS.adhesionCoeff * mass * PHYS.gravity);
      const drag = mass * (PHYS.rollA + PHYS.rollB * v + PHYS.rollC * v * v);
      const gradeF = mass * PHYS.gravity * grade;
      const a = (te - drag - gradeF) / mass;
      v = Math.max(0, v + a * dt);
      v = Math.min(v, loco.maxSpeed / 3.6);
    }
    return v * 3.6;
  };
  const flat = run(0, 8, 240);
  const hill = run(0.045, 8, 240);
  const idle = run(0, 0, 600);
  console.log(`    ${(mass / 1000).toFixed(0)} t consist — notch 8 level: ${flat.toFixed(1)} km/h · notch 8 @4.5%: ${hill.toFixed(1)} km/h · coast to rest: ${idle.toFixed(2)} km/h`);
  ok(flat > 60 && flat <= loco.maxSpeed + 0.1, 'reaches a plausible top speed on the level');
  ok(hill < flat * 0.75, 'grades bite');
  ok(idle < 0.05, 'coasting train rolls to a stop');

  // stopping distance with full service brakes from 80 km/h
  let v = 80 / 3.6, d = 0;
  const dt = PHYS.fixedStep;
  while (v > 0.02 && d < 20000) {
    const a = PHYS.brakeCoeff * PHYS.gravity + PHYS.rollA;
    v = Math.max(0, v - a * dt); d += v * dt;
  }
  console.log(`    stopping distance from 80 km/h (full service): ${d.toFixed(0)} m`);
  ok(d > 150 && d < 1200, 'stopping distance is in a playable band');
}

console.log('\n[5] region gating');
{
  const gated = new TrackNetwork(data);
  gated.setRegions(['plains']);
  const open = [...gated.segments.values()].filter((s) => gated.isOpen(s)).length;
  const st = gated.stateAtNode('dustflats', 0, 0);
  let blocked = null;
  for (let i = 0; i < 4000; i++) { gated.advance(st, 5); if (st.blocked) { blocked = st.blocked; break; } }
  console.log(`    plains-only: ${open}/${gated.segments.size} segments open; leaving the region → ${blocked}`);
  ok(open > 4 && open < gated.segments.size, 'some segments open, some locked');
  ok(blocked !== null, 'the train is stopped at the region border');
}

console.log(failures ? `\n✗ ${failures} FAILURE(S)` : '\n✓ all network tests passed');
process.exit(failures ? 1 : 0);
