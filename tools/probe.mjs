import { heightAt, waterAt } from '../src/utils/terrain.js';
for (const a of process.argv.slice(2)) {
  const [n, x, z] = a.split(',');
  const w = waterAt(+x, +z);
  console.log(`  ${n.padEnd(18)} ${String(x).padStart(6)},${String(z).padStart(6)}  h=${heightAt(+x, +z).toFixed(1).padStart(7)}${w ? '  WATER ' + w.name : ''}`);
}
