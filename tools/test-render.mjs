/**
 * Headless build of the whole track renderer: catches geometry errors, counts
 * the triangle budget and times a cold build of every segment at full detail.
 */
import fs from 'node:fs';
import * as THREE from 'three';
import { TrackNetwork } from '../src/systems/TrackNetwork.js';
import { AssetManager } from '../src/systems/AssetManager.js';
import { TrackRenderer } from '../src/systems/TrackRenderer.js';

const net = new TrackNetwork(JSON.parse(fs.readFileSync(new URL('../assets/data/tracks.json', import.meta.url))));
const assets = new AssetManager();
const scene = new THREE.Scene();
const tr = new TrackRenderer(scene, net, assets, { preset: 'high' });

let fails = 0;
const ok = (c, m, x = '') => { console.log(`  ${c ? '✓' : '✗'} ${m}${x ? ' — ' + x : ''}`); if (!c) fails++; };

// force every segment to LOD2 and keep it: whole-world worst case
tr.quality.detailRadius = Infinity;
tr.quality.farRadius = Infinity;
const t0 = performance.now();
let maxTris = 0, tiles = 0;
const cam = new THREE.Vector3();
for (const seg of net.segments.values()) {
  cam.copy(seg.curve.getPoint(0.5));
  tr.update(cam, 1 / 60);
  // drain the build queue for this segment
  let guard = 0;
  tr.maxTilesPerFrame = 999; tr.minTilesPerFrame = 999;
  while (tr.queue.length && guard++ < 20) tr.update(cam, 1 / 60);
  const entry = tr.entries.get(seg.id);
  if (!entry?.group) { console.log(`  ✗ ${seg.id} produced nothing`); fails++; continue; }
  let bad = 0, tris = 0;
  entry.group.traverse((o) => {
    const geo = o.geometry;
    if (!geo) return;
    tiles++;
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      if (!Number.isFinite(pos.getX(i) + pos.getY(i) + pos.getZ(i))) { bad++; break; }
    }
    if (!geo.attributes.normal && !o.isInstancedMesh) bad++;
    const t = geo.index ? geo.index.count / 3 : pos.count / 3;
    tris += o.isInstancedMesh ? t * o.count : t;
  });
  maxTris = Math.max(maxTris, tris);
  if (bad) { console.log(`  ✗ ${seg.id}: ${bad} bad meshes`); fails++; }
}
const ms = performance.now() - t0;
const worldTris = tr.triangleCount();
console.log(`\n  built ${net.segments.size} segments · ${tiles} meshes · ${worldTris.toLocaleString()} tris if the WHOLE world were in detail range`);
console.log(`  heaviest single segment: ${Math.round(maxTris).toLocaleString()} tris`);
console.log(`  cold full-detail build of all 37 segments: ${ms.toFixed(0)} ms (${(ms / net.segments.size).toFixed(1)} ms/segment)`);
ok(fails === 0, 'every segment builds clean geometry (finite, normalled)');
ok(maxTris < 400000, 'no single segment blows the triangle budget', `${Math.round(maxTris).toLocaleString()} tris`);
ok(ms / net.segments.size < 260, 'a segment rebuild fits inside a frame budget spread over a few frames', `${(ms / net.segments.size).toFixed(0)} ms`);

// LOD1 must be far cheaper
const tr2 = new TrackRenderer(scene, net, assets, { preset: 'high' });
tr2.quality.detailRadius = 1;
tr2.quality.farRadius = 99999;
const t1 = performance.now();
for (const seg of net.segments.values()) {
  tr2.maxTilesPerFrame = 999; tr2.minTilesPerFrame = 999;
  tr2.update(seg.curve.getPoint(0.5), 1 / 60);
  let guard = 0; while (tr2.queue.length && guard++ < 20) tr2.update(seg.curve.getPoint(0.5), 1 / 60);
}
const farMs = performance.now() - t1;
console.log(`  LOD1 build of all segments: ${farMs.toFixed(0)} ms · ${tr2.triangleCount().toLocaleString()} tris`);
const farTris = tr2.triangleCount();
ok(farTris < worldTris / 6, 'LOD1 is substantially cheaper than LOD2', `${farTris.toLocaleString()} vs ${worldTris.toLocaleString()} tris`);
ok(farMs < ms / 2, 'LOD1 also builds faster', `${farMs.toFixed(0)} ms vs ${ms.toFixed(0)} ms`);
tr.dispose(); tr2.dispose();
console.log(`\n${fails ? `✗ ${fails} failed` : '✓ track renderer OK'}`);
process.exit(fails ? 1 : 0);
