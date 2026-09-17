/**
 * WeatherManager — sky state, fog, precipitation and rail adhesion
 * (GDD §4.5, §5.2.1 adhesion table, §7 WeatherManager).
 *
 * Six states, each a bundle of numbers: cloud cover, haze, fog density, wind,
 * precipitation kind and rate, and how much grip the rails have. Weather drifts
 * on its own over a run — a clear morning can turn to rain on the coast — and
 * the alpine turns any rain to snow above the line. Everything transitions
 * smoothly, so the player watches the light change rather than a switch flip.
 *
 * Rain and snow are GPU particles in a camera-following box: no CPU work per
 * frame beyond a handful of uniform writes.
 */
import * as THREE from 'three';
import { PHYS } from '../constants.js';
import { clamp, clamp01, lerp, damp } from '../utils/math.js';
import { bus } from '../utils/events.js';

export const WEATHERS = {
  clear: {
    label: 'Clear', cloud: 0.10, haze: 0.06, fogMul: 0.55, fogAdd: 0.000012,
    wind: 2.2, precip: 0, kind: 'none', grip: 1.0, skyDim: 1.0,
  },
  cloudy: {
    label: 'Overcast', cloud: 0.62, haze: 0.20, fogMul: 0.95, fogAdd: 0.000035,
    wind: 4.0, precip: 0, kind: 'none', grip: 0.98, skyDim: 0.82,
  },
  rain: {
    label: 'Rain', cloud: 0.88, haze: 0.42, fogMul: 1.55, fogAdd: 0.00013,
    wind: 7.0, precip: 0.85, kind: 'rain', grip: PHYS.adhesionWeather.rain, skyDim: 0.6,
  },
  storm: {
    label: 'Thunderstorm', cloud: 1.0, haze: 0.55, fogMul: 1.75, fogAdd: 0.00018,
    wind: 12.5, precip: 1.0, kind: 'rain', grip: 0.66, skyDim: 0.44, lightning: true,
  },
  fog: {
    label: 'Fog', cloud: 0.45, haze: 0.9, fogMul: 3.4, fogAdd: 0.00075,
    wind: 1.1, precip: 0, kind: 'none', grip: PHYS.adhesionWeather.fog, skyDim: 0.78,
  },
  snow: {
    label: 'Snow', cloud: 0.82, haze: 0.55, fogMul: 1.9, fogAdd: 0.00026,
    wind: 5.0, precip: 0.8, kind: 'snow', grip: PHYS.adhesionWeather.snow, skyDim: 0.7,
  },
};

const PRECIP_VERT = /* glsl */`
uniform float uTime;
uniform vec3 uWind;
uniform float uFall;
uniform float uSize;
uniform float uPixelRatio;
uniform float uSpan;
attribute float aSeed;
varying float vA;
void main() {
  vec3 p = position;
  float half_ = uSpan * 0.5;
  p.y = mod(p.y - uTime * uFall * (0.72 + aSeed * 0.56), uSpan);
  p.x = mod(p.x + uTime * uWind.x * (0.5 + aSeed) + half_, uSpan) - half_;
  p.z = mod(p.z + uTime * uWind.z * (0.5 + aSeed) + half_, uSpan) - half_;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = uSize * uPixelRatio * (34.0 / max(1.0, -mv.z));
  gl_Position = projectionMatrix * mv;
  vA = 0.30 + 0.70 * aSeed;
}
`;

const RAIN_FRAG = /* glsl */`
uniform vec3 uColor; uniform float uOpacity;
varying float vA;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float streak = smoothstep(0.5, 0.06, abs(c.x) * 4.0) * smoothstep(0.5, 0.02, abs(c.y));
  if (streak < 0.02) discard;
  gl_FragColor = vec4(uColor, uOpacity * vA * streak);
}
`;

const SNOW_FRAG = /* glsl */`
uniform vec3 uColor; uniform float uOpacity;
varying float vA;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = dot(c, c);
  if (d > 0.22) discard;
  float a = (1.0 - d * 4.4) * uOpacity * vA;
  gl_FragColor = vec4(uColor, a);
}
`;

export class WeatherManager {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.id = 'clear';
    this.state = { ...WEATHERS.clear };
    this.target = { ...WEATHERS.clear };
    this.time = 0;
    this.countdown = opts.firstChange ?? 260;   // seconds until the next shift
    this.auto = opts.auto !== false;
    this.flash = 0;
    this.flashDecay = 0;
    this.nextThunder = 0;
    this.count = opts.particles ?? 9000;
    this.span = opts.span ?? 130;
    this.pixelRatio = opts.pixelRatio ?? 1;

    if (scene && !scene.fog) scene.fog = new THREE.FogExp2(0xcfd8dd, 0.00025);
    this.fog = scene?.fog || null;

    this.group = new THREE.Group();
    this.group.name = 'weather';
    this.group.frustumCulled = false;
    scene?.add(this.group);
    this._buildParticles();

    this.biomeFog = { color: new THREE.Color(0xcfd8dd), density: 0.00025 };
    this.tunnelFactor = 0;
    this.listeners = [];
  }

  _buildParticles() {
    const n = this.count;
    const pos = new Float32Array(n * 3);
    const seed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() - 0.5) * this.span;
      pos[i * 3 + 1] = Math.random() * this.span;
      pos[i * 3 + 2] = (Math.random() - 0.5) * this.span;
      seed[i] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), this.span);

    const base = {
      uTime: { value: 0 },
      uWind: { value: new THREE.Vector3(1, 0, 0.4) },
      uFall: { value: 26 },
      uSize: { value: 2.2 },
      uPixelRatio: { value: this.pixelRatio },
      uSpan: { value: this.span },
      uColor: { value: new THREE.Color(0xcfe0ee) },
      uOpacity: { value: 0 },
    };
    this.rainMat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(base),
      vertexShader: PRECIP_VERT, fragmentShader: RAIN_FRAG,
      transparent: true, depthWrite: false, fog: false,
    });
    this.rainMat.uniforms.uSize.value = 2.6;
    this.snowMat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(base),
      vertexShader: PRECIP_VERT, fragmentShader: SNOW_FRAG,
      transparent: true, depthWrite: false, fog: false,
    });
    this.snowMat.uniforms.uSize.value = 4.4;
    this.snowMat.uniforms.uFall.value = 3.2;
    this.snowMat.uniforms.uColor.value.setHex(0xffffff);

    this.rain = new THREE.Points(geo, this.rainMat);
    this.snow = new THREE.Points(geo, this.snowMat);
    for (const p of [this.rain, this.snow]) {
      p.frustumCulled = false;
      p.visible = false;
      p.renderOrder = 5;
      this.group.add(p);
    }
  }

  setPixelRatio(r) {
    this.pixelRatio = r;
    this.rainMat.uniforms.uPixelRatio.value = r;
    this.snowMat.uniforms.uPixelRatio.value = r;
  }

  /** Switch weather, optionally instantly (used by the settings menu / saves). */
  setWeather(id, immediate = false) {
    if (!WEATHERS[id]) id = 'clear';
    if (id === this.id && !immediate) return;
    this.id = id;
    this.target = { ...WEATHERS[id] };
    if (immediate) this.state = { ...this.target };
    this.countdown = 180 + Math.random() * 420;
    bus.emit('weather:change', { id, label: this.target.label, immediate });
  }

  /** Let the weather drift on its own, biased by biome and season. */
  autoUpdate(dt, biome) {
    if (!this.auto) return;
    this.countdown -= dt;
    if (this.countdown > 0) return;
    const table = biome === 'alpine'
      ? [['clear', 3], ['cloudy', 3], ['snow', 5], ['fog', 3], ['rain', 1], ['storm', 1]]
      : biome === 'coastal'
        ? [['clear', 3], ['cloudy', 4], ['rain', 4], ['fog', 4], ['storm', 2], ['snow', 0]]
        : biome === 'forest'
          ? [['clear', 4], ['cloudy', 4], ['rain', 3], ['fog', 2], ['storm', 1], ['snow', 0]]
          : [['clear', 6], ['cloudy', 4], ['rain', 2], ['fog', 1], ['storm', 1], ['snow', 0]];
    const total = table.reduce((a, r) => a + r[1], 0);
    let r = Math.random() * total;
    for (const [id, w] of table) { r -= w; if (r <= 0) { this.setWeather(id); return; } }
    this.setWeather('clear');
  }

  /** Grip multiplier the physics uses (GDD §5.2.1). */
  grip() { return this.state.grip ?? 1; }
  label() { return this.state.label; }
  /** How far the player can see, in metres — for the HUD and the AI. */
  visibility() {
    const d = this.fog?.density ?? 0.00025;
    return d < 1e-7 ? 20000 : clamp(2.6 / d, 60, 20000);
  }

  setBiomeFog(color, density) {
    this.biomeFog.color.copy(color);
    this.biomeFog.density = density;
  }

  /** 0 in the open, 1 in a tunnel — kills precipitation and thickens the air. */
  setTunnel(t) { this.tunnelFactor = clamp01(t); }

  update(dt, camera, cycle) {
    this.time += dt;
    const s = this.state, t = this.target;
    const k = 1 - Math.exp(-dt / 12);   // ~12 s to settle
    for (const key of ['cloud', 'haze', 'fogMul', 'fogAdd', 'wind', 'precip', 'grip', 'skyDim']) {
      s[key] = lerp(s[key] ?? 0, t[key] ?? 0, k);
    }
    s.kind = t.kind;
    s.lightning = t.lightning;

    // --- precipitation
    const kind = s.kind;
    const rate = s.precip * (1 - this.tunnelFactor);
    this.rain.visible = kind === 'rain' && rate > 0.02;
    this.snow.visible = kind === 'snow' && rate > 0.02;
    if (this.rain.visible || this.snow.visible) {
      const mat = kind === 'rain' ? this.rainMat : this.snowMat;
      const other = kind === 'rain' ? this.snowMat : this.rainMat;
      other.uniforms.uOpacity.value = 0;
      mat.uniforms.uTime.value = this.time;
      mat.uniforms.uOpacity.value = rate * (kind === 'rain' ? 0.42 : 0.7);
      const dir = cycle ? Math.cos(cycle.t * Math.PI * 2) : 0.4;
      mat.uniforms.uWind.value.set(Math.cos(this.time * 0.07) * s.wind * 0.6 + dir, 0, Math.sin(this.time * 0.05) * s.wind * 0.6);
      mat.uniforms.uFall.value = kind === 'rain' ? 34 + s.wind : 2.6 + s.wind * 0.22;
      mat.uniforms.uColor.value.setHex(kind === 'rain' ? 0xbcd2e2 : 0xffffff);
      const active = kind === 'rain' ? this.rain : this.snow;
      if (camera) active.position.set(camera.position.x, camera.position.y - this.span * 0.32, camera.position.z);
      active.rotation.y = this.time * 0.006;
    }

    // --- fog: biome base, thickened by weather, thinned by altitude
    if (this.fog) {
      const dens = this.biomeFog.density * s.fogMul + s.fogAdd;
      this.fog.density = damp(this.fog.density, dens, 0.6, dt);
      const wet = kind === 'rain' ? 0x6d7a80 : kind === 'snow' ? 0xd7e2ea : 0x9aa4a8;
      this.fog.color.copy(this.biomeFog.color).lerp(_wet.setHex(wet), clamp01(s.haze * 0.72));
      this.fog.color.lerp(_night, cycle ? cycle.night * 0.55 * (1 - s.cloud * 0.4) : 0);
      if (this.scene) this.scene.background = null; // the sky dome is the background
    }

    // --- lightning
    if (s.lightning && rate > 0.1) {
      this.nextThunder -= dt;
      if (this.nextThunder <= 0) {
        this.nextThunder = 6 + Math.random() * 26;
        if (Math.random() < 0.75) {
          this.flash = 1;
          bus.emit('weather:lightning', { delay: 0.4 + Math.random() * 2.6, strength: 0.5 + Math.random() * 0.5 });
        }
      }
    }
    this.flash = Math.max(0, this.flash - dt * 3.4);
  }

  /** Additive light from lightning, applied to the sky rig. */
  flashAmount() { return this.flash * (this.state.lightning ? 1 : 0); }

  dispose() {
    this.rain.geometry.dispose();
    this.rainMat.dispose();
    this.snowMat.dispose();
    this.group.removeFromParent();
  }
}

const _wet = new THREE.Color();
const _night = new THREE.Color(0x0a1020);

export default WeatherManager;
