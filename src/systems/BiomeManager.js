/**
 * BiomeManager — where the player is, and what that looks and sounds like
 * (GDD §4.3, §7 BiomeManager).
 *
 * Biomes are blended, not tiled: `biomeWeights` returns a smooth 4-way mix, so
 * fog colour, fog density, ambient tint and the ground bounce colour all move
 * continuously as a train runs from the plains into the foothills. A discrete
 * `current` biome is still published (with hysteresis) for the HUD, the map,
 * audio beds and the region-unlock rules.
 */
import * as THREE from 'three';
import { BIOMES, REGION_OF_BIOME } from '../constants.js';
import { biomeWeights, biomeAt, heightAt, snowCover } from '../utils/terrain.js';
import { clamp01 } from '../utils/math.js';
import { bus } from '../utils/events.js';

const KEYS = ['alpine', 'forest', 'plains', 'coastal'];

export class BiomeManager {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.weights = { alpine: 0, forest: 0, plains: 0, coastal: 0 };
    this.fogColor = new THREE.Color(BIOMES.plains.fogColor);
    this.groundColor = new THREE.Color(BIOMES.plains.ground);
    this.ambientColor = new THREE.Color(BIOMES.plains.ambient);
    this.fogDensity = BIOMES.plains.fogDensity;
    this.current = 'plains';
    this.region = 'plains';
    this.locked = this.current;   // debounced, what the HUD shows
    this.snow = 0;
    this.altitude = 0;
    this.coastal = 0;            // 0 inland, 1 out at sea
    this._last = null;
    this._hold = 0;
  }

  /** Sample at a world position. Cheap enough to call every frame. */
  update(cameraPos, dt = 0.016) {
    const x = cameraPos.x, z = cameraPos.z;
    biomeWeights(x, z, this.weights);
    this.altitude = cameraPos.y;
    this.snow = snowCover(x, z);
    this.coastal = clamp01((-heightAt(x, z) + 4) / 12) * this.weights.coastal + clamp01((z - 5200) / 2600) * 0.6;

    // blend fog + tints across the four biomes
    let r = 0, g = 0, b = 0, gr = 0, gg = 0, gb = 0, ar = 0, ag = 0, ab = 0, dens = 0, sum = 0;
    for (const k of KEYS) {
      const w = this.weights[k];
      if (w < 0.002) continue;
      const B = BIOMES[k];
      _fog.setHex(B.fogColor); _gnd.setHex(B.ground); _amb.setHex(B.ambient);
      r += _fog.r * w; g += _fog.g * w; b += _fog.b * w;
      gr += _gnd.r * w; gg += _gnd.g * w; gb += _gnd.b * w;
      ar += _amb.r * w; ag += _amb.g * w; ab += _amb.b * w;
      dens += B.fogDensity * w;
      sum += w;
    }
    if (sum > 0) {
      this.fogColor.setRGB(r / sum, g / sum, b / sum);
      this.groundColor.setRGB(gr / sum, gg / sum, gb / sum);
      this.ambientColor.setRGB(ar / sum, ag / sum, ab / sum);
      this.fogDensity = dens / sum;
    }
    // higher ground is thinner, colder air; snow brightens the haze
    const alt = clamp01((this.altitude - 220) / 500);
    this.fogDensity *= 1 - alt * 0.45;
    this.fogColor.lerp(_snowTint, this.snow * 0.5);
    this.groundColor.lerp(_snowTint, this.snow * 0.6);

    const dominant = biomeAt(x, z);
    if (dominant !== this.current) {
      this.current = dominant;
      this.region = REGION_OF_BIOME[dominant] || dominant;
      this._hold = 0;
    } else {
      this._hold += dt;
    }
    if (this._hold > 1.6 && this.locked !== this.current) {
      this.locked = this.current;
      bus.emit('biome:change', { biome: this.current, region: this.region, label: BIOMES[this.current]?.label });
    }
    return this;
  }

  /** Convenience for the HUD/map. */
  label() { return BIOMES[this.locked]?.label || '—'; }
  dominantWeight() { return Math.max(...KEYS.map((k) => this.weights[k])); }

  /** A one-line description used by the tutorial and the map tooltip. */
  describe() {
    const parts = [];
    for (const k of KEYS) if (this.weights[k] > 0.22) parts.push(BIOMES[k].label);
    return parts.join(' / ') || BIOMES[this.locked].label;
  }
}

const _fog = new THREE.Color();
const _gnd = new THREE.Color();
const _amb = new THREE.Color();
const _snowTint = new THREE.Color(0xdfe8f0);

export default BiomeManager;
