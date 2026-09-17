import { heightAt } from '../src/utils/terrain.js';
const [x0, x1, z0, z1] = process.argv.slice(2).map(Number);
const W = 78, H = 34;
const chars = ' .:-=+*#%@';
let lo = Infinity, hi = -Infinity;
const grid = [];
for (let iz = 0; iz < H; iz++) {
  const row = [];
  for (let ix = 0; ix < W; ix++) {
    const x = x0 + (x1 - x0) * (ix / (W - 1));
    const z = z0 + (z1 - z0) * (iz / (H - 1));
    const h = heightAt(x, z);
    row.push(h); lo = Math.min(lo, h); hi = Math.max(hi, h);
  }
  grid.push(row);
}
console.log(`x ${x0}..${x1}  z ${z0}..${z1}   h ${lo.toFixed(0)}..${hi.toFixed(0)}`);
for (const row of grid) {
  console.log(row.map((h) => {
    if (h < 0) return '~';
    const t = (h - Math.max(0, lo)) / Math.max(1, hi - Math.max(0, lo));
    return chars[Math.min(chars.length - 1, Math.floor(t * chars.length))];
  }).join(''));
}
const probe = (name, x, z) => console.log(`  ${name.padEnd(16)} ${String(x).padStart(6)},${String(z).padStart(6)}  h=${heightAt(x, z).toFixed(1)}`);
console.log('probes:');
for (const a of process.env.PROBES?.split(';') || []) { const [n, x, z] = a.split(','); if (n) probe(n, +x, +z); }
