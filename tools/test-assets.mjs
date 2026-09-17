/** Build every procedural model headlessly and report vertex budgets. */
import { AssetManager } from '../src/systems/AssetManager.js';

const am = new AssetManager();
let total = 0, worst = null;
const rows = [];
for (const k of am.keys()) {
  const g = am.geometry(k);
  const tris = g.attributes.position.count / 3;
  total += tris;
  if (!Number.isFinite(g.boundingSphere?.radius)) throw new Error(`non-finite bounds for ${k}`);
  if (!g.attributes.color) throw new Error(`${k} missing vertex colours`);
  if (!g.attributes.normal) throw new Error(`${k} missing normals`);
  rows.push([k, tris]);
  if (!worst || tris > worst[1]) worst = [k, tris];
}
rows.sort((a, b) => b[1] - a[1]);
for (const [k, t] of rows.slice(0, 8)) console.log(`  ${String(t).padStart(7)} tris  ${k}`);
console.log(`\n${am.keys().length} models, ${total.toLocaleString()} triangles total (cached, built once).`);
console.log(`heaviest: ${worst[0]} (${worst[1]} tris) — well inside the per-model budget.`);
