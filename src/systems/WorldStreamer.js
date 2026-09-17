/**
 * WorldStreamer — owns and drives every spatial system (GDD §7 WorldStreamer).
 *
 * One update call per frame fans out to terrain, track, vegetation, structures,
 * water, sky, weather and biome, in the order their outputs depend on each
 * other: the biome decides the fog base, weather composes it, the sky lights
 * the scene, and the geometry systems each spend their own slice of the frame
 * budget generating what just came into range.
 */
import * as THREE from 'three';
import { RENDER, VEGETATION_RADIUS } from '../constants.js';
import { TerrainManager } from './TerrainManager.js';
import { TrackRenderer } from './TrackRenderer.js';
import { VegetationManager } from './VegetationManager.js';
import { StructureManager } from './StructureManager.js';
import { WaterManager } from './WaterManager.js';
import { SkyManager, DayNightCycle } from './SkyManager.js';
import { WeatherManager } from './WeatherManager.js';
import { BiomeManager } from './BiomeManager.js';
import { bus } from '../utils/events.js';

export class WorldStreamer {
  /**
   * @param {object} deps {scene, renderer, net, assets, stations, landmarks, cycle}
   */
  constructor(deps = {}) {
    const { scene, renderer, net, assets, stations = [], landmarks = [] } = deps;
    this.scene = scene;
    this.renderer = renderer;
    this.net = net;
    this.assets = assets;
    this.cycle = deps.cycle || new DayNightCycle();

    this.biome = new BiomeManager(scene);
    this.terrain = new TerrainManager(scene, net);
    this.track = new TrackRenderer(scene, net, assets);
    this.vegetation = new VegetationManager(scene, net, assets, this.terrain, { radius: VEGETATION_RADIUS });
    this.structures = new StructureManager(scene, net, assets, stations, { terrain: this.terrain }).build(landmarks);
    this.water = new WaterManager(scene);
    this.sky = new SkyManager(scene, { cycle: this.cycle });
    this.weather = new WeatherManager(scene, { pixelRatio: renderer?.getPixelRatio?.() ?? 1 });

    this.frameMs = {};
    this.ready = false;
    this.progress = 0;
    this.tunnel = 0;
    this._first = true;
    this.structures.updateSignals();
  }

  /** Quality preset from the settings menu (GDD §8 performance options). */
  setQuality(preset) {
    const p = RENDER.presets[preset] || RENDER.presets.medium;
    this.track.setQuality(preset);
    this.vegetation.setDensity(p.vegetation);
    this.vegetation.setRadius(preset === 'low' ? 700 : preset === 'high' ? VEGETATION_RADIUS : 1200);
    this.terrain.timeBudget = preset === 'low' ? 3 : preset === 'high' ? 6 : 4.5;
    if (this.renderer) {
      this.renderer.shadowMap.enabled = !!p.shadows;
      this.sky.setShadowQuality(p.shadowMapSize, preset === 'high' ? 240 : preset === 'low' ? 120 : 190);
    }
    this.track.invalidate();
    bus.emit('quality:change', { preset });
    return p;
  }

  /** Where the player is, for everything that asks. */
  setTunnel(amount) { this.tunnel = Math.max(0, Math.min(1, amount)); }

  /**
   * @param {number} dt seconds
   * @param {THREE.Camera} camera
   * @param {object} opts { forcePos } — a position to stream around other than the camera
   */
  update(dt, camera, opts = {}) {
    const t = now();
    const focus = opts.forcePos || camera?.position || ORIGIN;

    let t0 = now();
    this.biome.update(focus, dt);
    this.frameMs.biome = now() - t0;

    t0 = now();
    this.weather.setBiomeFog(this.biome.fogColor, this.biome.fogDensity);
    this.weather.setTunnel(this.tunnel);
    this.weather.autoUpdate(dt, this.biome.locked);
    this.weather.update(dt, camera, this.cycle);
    this.frameMs.weather = now() - t0;

    t0 = now();
    this.sky.setWeather(this.weather.state.cloud, this.weather.state.haze + this.tunnel * 0.4);
    this.sky.setGroundColor(this.biome.groundColor);
    this.sky.update(camera, dt);
    const flash = this.weather.flashAmount();
    if (flash > 0.01) {
      this.sky.ambient.intensity += flash * 2.4;
      this.sky.hemi.intensity += flash * 3.2;
      this.sky.uniforms.uSunGlow.value += flash * 2;
    }
    this.frameMs.sky = now() - t0;

    t0 = now();
    this.terrain.update(focus);
    this.frameMs.terrain = now() - t0;

    t0 = now();
    this.track.update(focus, dt);
    this.frameMs.track = now() - t0;

    t0 = now();
    this.vegetation.update(focus);
    this.frameMs.vegetation = now() - t0;

    t0 = now();
    this.structures.update(focus);
    this.frameMs.structures = now() - t0;

    t0 = now();
    this.water.setTide(this.cycle.t);
    this.water.setWeather(this.weather.id);
    this.water.setFog(this.scene.fog?.color || this.biome.fogColor, this.scene.fog?.density ?? 0.00025);
    this.water.update(dt, camera, this.sky.sunInfo());
    this.frameMs.water = now() - t0;

    this.frameMs.total = now() - t;
    if (this._first) {
      this._first = false;
      // a couple of extra passes so the starting view is dressed before frame 1
      for (let i = 0; i < 6; i++) { this.terrain.update(focus); this.track.update(focus, dt); this.vegetation.update(focus); }
    }
    this.progress = this.terrain.stats.queued === 0 && this.track.queue.length === 0 && !this.vegetation.dirty ? 1 : 0.5;
    this.ready = this.progress === 1;
    return this.frameMs;
  }

  stats() {
    return {
      terrainTris: this.terrain.triangleCount(),
      terrainVerts: this.terrain.vertexCount(),
      terrainQueued: this.terrain.stats.queued,
      trackTris: this.track.triangleCount(),
      trackQueued: this.track.queue.length,
      trackSegments: this.track.builtSegments(),
      vegProps: this.vegetation.stats.props,
      vegTris: this.vegetation.triangleCount(),
      vegCells: this.vegetation.stats.cells,
      structures: this.structures.visibleCount,
      waterTris: this.water.triangleCount(),
      biome: this.biome.label(),
      weather: this.weather.label(),
      visibility: Math.round(this.weather.visibility()),
      ms: this.frameMs,
    };
  }

  dispose() {
    this.terrain.dispose();
    this.track.dispose();
    this.vegetation.dispose();
    this.structures.dispose();
    this.water.dispose();
    this.sky.dispose();
    this.weather.dispose();
  }
}

const ORIGIN = new THREE.Vector3();
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export default WorldStreamer;
