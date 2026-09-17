/** Stream the terrain around a path across the world and check the result. */
import fs from 'node:fs';
import * as THREE from 'three';
import { TrackNetwork } from '../src/systems/TrackNetwork.js';
import { TerrainManager } from '../src/systems/TerrainManager.js';
import { heightAt, landHeight } from '../src/utils/terrain.js';
import { pointAt } from '../src/utils/spline.js';

const net = new TrackNetwork(JSON.parse(fs.readFileSync(new URL('../assets/data/tracks.json', import.meta.url))));
const scene = new THREE.Scene();
const tm = new TerrainManager(scene, net);
let fails = 0;
const ok = (c, m, x = '') => { console.log(`  ${c ? '✓' : '✗'} ${m}${x ? ' — ' + x : ''}`); if (!c) fails++; };

// teleport across the world so every chunk gets built at least once
const cam = new THREE.Vector3();
const t0 = performance.now();
let frames = 0;
for (let k = 0; k < 40; k++) {
  const x = -7000 + (k % 8) * 2000, z = -7000 + Math.floor(k / 8) * 2000;
  cam.set(x, heightAt(x, z) + 3, z);
  for (let f = 0; f < 90; f++) { tm.update(cam); frames++; }
}
// finish everything off
for (let f = 0; f < 4000 && tm.stats.queued > 0; f++) { tm.update(cam); frames++; }
const ms = performance.now() - t0;
console.log(`  ${frames} frames of streaming in ${ms.toFixed(0)} ms · ${tm.stats.built} chunks built · avg ${(tm.stats.ms).toFixed(2)} ms/frame`);
ok(tm.stats.queued === 0, 'every chunk finished building');
ok(tm.triangleCount() > 100000, 'the world has real geometry', `${tm.triangleCount().toLocaleString()} tris, ${tm.vertexCount().toLocaleString()} verts`);
ok(tm.stats.ms < 12, 'a streaming frame stays inside its budget', `${tm.stats.ms.toFixed(2)} ms`);

// geometry sanity
let bad = 0, ymin = Infinity, ymax = -Infinity;
for (const e of tm.chunks.values()) {
  const m = e.mesh; if (!m) { bad++; continue; }
  const pos = m.geometry.attributes.position;
  if (!m.geometry.attributes.normal) bad++;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (!Number.isFinite(pos.getX(i) + y + pos.getZ(i))) { bad++; break; }
    if (y < ymin) ymin = y; if (y > ymax) ymax = y;
  }
}
ok(bad === 0, 'all chunk meshes are finite and normalled', `${bad} bad`);
console.log(`  height range ${ymin.toFixed(1)} .. ${ymax.toFixed(1)} m`);
ok(ymax > 380 && ymin < -18, 'peaks and seabed are both represented');

// Where the ground is dressed to the formation, the rails must sit on it —
// not float above it and not sink into it. Tunnel mouths and bridge decks are
// deliberately left alone, so they are excluded.
let worst = 0, worstAt = null, samples = 0, skipped = 0;
const p3 = new THREE.Vector3();
for (const seg of net.segments.values()) {
  for (let i = 0; i <= 80; i++) {
    const u = i / 80;
    pointAt(seg.curve, u, p3);
    // only judge ordinary ground: bores and viaducts deliberately leave the
    // landform alone, and a hairpin can put another part of the same segment
    // within a stone's throw, which says nothing about the ground under it.
    const land = landHeight(p3.x, p3.z);
    const cover = land - p3.y;
    // also skip water crossings: there the bed is deliberately pulled down to
    // the channel level and the rail is carried over it
    const carried = seg.inRanges(u, seg.bridges) || seg.inRanges(u, seg.viaducts);
    const bored = seg.inRanges(u, seg.tunnels);
    if (carried || bored || Math.abs(cover) > 9 || heightAt(p3.x, p3.z) < land - 0.5) { skipped++; continue; }
    const d = p3.y - tm.surfaceHeight(p3.x, p3.z);
    samples++;
    if (Math.abs(d) > Math.abs(worst)) { worst = d; worstAt = `${seg.id}@${u.toFixed(2)}`; }
  }
}
console.log(`  railhead vs dressed ground over ${samples} samples (${skipped} bore/viaduct samples excluded): worst ${worst.toFixed(2)} m at ${worstAt}`);
// 3 m tolerance: where two tracks run side by side at different levels the
// ground between them can only be dressed to one of them.
ok(Math.abs(worst) < 3, 'track sits on the terrain (no floating or buried rail)');
tm.dispose();
console.log(`\n${fails ? `✗ ${fails} failed` : '✓ terrain manager OK'}`);
process.exit(fails ? 1 : 0);
