/**
 * SkyManager + DayNightCycle — sun, moon, stars, sky dome and the lighting rig
 * (GDD §4.1, §7 SkyManager / DayNightCycle).
 *
 * A full day takes twenty real minutes. The sun travels a fixed inclined arc,
 * and every colour in the rig — sun tint, sky gradient, horizon haze, ambient
 * bounce — is keyed off the sun's elevation so dawn and dusk get the long warm
 * light the art direction asks for, without a single texture.
 *
 * The clock the player sees is the sun's clock. Contract deadlines run on a
 * separate, slower "working minutes" accumulator (ECONOMY.timeScale) so a
 * ninety-minute delivery is still a quarter of an hour of real driving.
 */
import * as THREE from 'three';
import { ECONOMY, RENDER } from '../constants.js';
import { clamp, clamp01, smoothstep, lerp, formatTimeOfDay } from '../utils/math.js';

const SKY_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const SKY_FRAG = /* glsl */`
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunGlow;
uniform float uHaze;
varying vec3 vDir;

void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  float t = pow(clamp(1.0 - abs(h), 0.0, 1.0), 2.2);
  vec3 col = mix(uZenith, uHorizon, t);
  col = mix(col, uGround, 1.0 - smoothstep(-0.22, 0.0, h));

  float sun = max(dot(d, normalize(uSunDir)), 0.0);
  col += uSunColor * (pow(sun, 900.0) * 6.0 + pow(sun, 24.0) * uSunGlow * 0.55 + pow(sun, 4.0) * uSunGlow * 0.10);
  col = mix(col, uHorizon, uHaze * (1.0 - clamp(h * 2.4, 0.0, 1.0)));
  gl_FragColor = vec4(col, 1.0);
}
`;

/* keyframes: [elevation, sunColour, sunIntensity, zenith, horizon, ambient, exposure] */
const KEYS = [
  { el: -0.60, sun: 0x2a3a5c, i: 0.05, zen: 0x05070f, hor: 0x0b1020, amb: 0x141a2c, ai: 0.30, exp: 1.05 },
  { el: -0.14, sun: 0x4a5f8c, i: 0.20, zen: 0x0d1530, hor: 0x2b3350, amb: 0x25304d, ai: 0.42, exp: 1.05 },
  { el: -0.02, sun: 0xc86a3a, i: 0.90, zen: 0x22345c, hor: 0xc2653a, amb: 0x4a4460, ai: 0.55, exp: 1.02 },
  { el: 0.09, sun: 0xffa04a, i: 2.10, zen: 0x3d6ea8, hor: 0xe8a06a, amb: 0x7a7288, ai: 0.70, exp: 1.00 },
  { el: 0.28, sun: 0xfff0d0, i: 2.90, zen: 0x4183c8, hor: 0xbcd6e8, amb: 0x9fb6cc, ai: 0.85, exp: 0.98 },
  { el: 0.75, sun: 0xfff8ea, i: 3.30, zen: 0x2f74c4, hor: 0xa9c8e0, amb: 0xaec4d6, ai: 0.95, exp: 0.95 },
];

export class DayNightCycle {
  constructor(opts = {}) {
    this.dayMinutes = opts.dayMinutes ?? ECONOMY.dayLengthMinutes; // real minutes per day
    this.t = opts.start ?? 0.30;      // 0..1 through the day; 0.25 = sunrise
    this.workMinutes = 0;             // slow accumulator used for contracts
    this.paused = false;
    this.sunDirection = new THREE.Vector3(0, 1, 0);
    this.moonDirection = new THREE.Vector3(0, -1, 0);
    this.sunColor = new THREE.Color(0xfff4e0);
    this.skyColor = new THREE.Color(0xa9c8e0);
    this.horizonColor = new THREE.Color(0xbcd6e8);
    this.ambientColor = new THREE.Color(0x9fb6cc);
    this.sunIntensity = 3;
    this.ambientIntensity = 0.9;
    this.exposure = 1;
    this.elevation = 1;
    this.night = 0;      // 0 day, 1 full night
    this.dusk = 0;       // 0..1 how close to golden hour
  }

  /** Advance by real seconds. */
  update(dt) {
    if (!this.paused) {
      this.t = (this.t + dt / (this.dayMinutes * 60)) % 1;
      this.workMinutes += dt * ECONOMY.timeScale;
    }
    const ang = (this.t - 0.25) * Math.PI * 2;
    this.sunDirection.set(Math.cos(ang), Math.sin(ang), 0.34).normalize();
    this.moonDirection.copy(this.sunDirection).negate();
    this.moonDirection.z += 0.18;
    this.moonDirection.normalize();
    this.elevation = this.sunDirection.y;
    this.night = clamp01(smoothstep(0.06, -0.16, this.elevation));
    this.dusk = 1 - Math.min(1, Math.abs(this.elevation) / 0.22);
    this._sample();
  }

  _sample() {
    const el = this.elevation;
    let a = KEYS[0], b = KEYS[KEYS.length - 1];
    for (let i = 0; i < KEYS.length - 1; i++) {
      if (el >= KEYS[i].el && el <= KEYS[i + 1].el) { a = KEYS[i]; b = KEYS[i + 1]; break; }
    }
    if (el > KEYS[KEYS.length - 1].el) { a = b = KEYS[KEYS.length - 1]; }
    if (el < KEYS[0].el) { a = b = KEYS[0]; }
    const f = a === b ? 0 : clamp01((el - a.el) / (b.el - a.el));
    this.sunColor.setHex(a.sun).lerp(_tmp.setHex(b.sun), f);
    this.sunIntensity = lerp(a.i, b.i, f);
    this.skyColor.setHex(a.zen).lerp(_tmp.setHex(b.zen), f);
    this.horizonColor.setHex(a.hor).lerp(_tmp.setHex(b.hor), f);
    this.ambientColor.setHex(a.amb).lerp(_tmp.setHex(b.amb), f);
    this.ambientIntensity = lerp(a.ai, b.ai, f);
    this.exposure = lerp(a.exp, b.exp, f);
  }

  /** 0..24 hours as the sun sees it. */
  get hours() { return this.t * 24; }
  get clock() { return formatTimeOfDay(this.t); }
  get isNight() { return this.night > 0.55; }
  /** Label for the HUD: Dawn / Morning / Noon / Afternoon / Dusk / Night. */
  get phase() {
    const h = this.hours;
    if (h < 4.5) return 'Night';
    if (h < 7) return 'Dawn';
    if (h < 11) return 'Morning';
    if (h < 14) return 'Midday';
    if (h < 17.5) return 'Afternoon';
    if (h < 20) return 'Dusk';
    return 'Night';
  }
  setTime(t) { this.t = clamp01(t); this.update(0); }
}

const _tmp = new THREE.Color();
const _anchor = new THREE.Vector3();

export class SkyManager {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.cycle = opts.cycle || new DayNightCycle();
    this.radius = opts.radius ?? RENDER.far * 0.86;

    this.uniforms = {
      uZenith: { value: new THREE.Color(0x2f74c4) },
      uHorizon: { value: new THREE.Color(0xa9c8e0) },
      uGround: { value: new THREE.Color(0x3a3a34) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(0xfff4e0) },
      uSunGlow: { value: 1 },
      uHaze: { value: 0 },
    };
    const geo = new THREE.SphereGeometry(this.radius, 32, 20);
    this.mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    }));
    this.mesh.name = 'sky';
    this.mesh.renderOrder = -1000;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);

    // --- sun and moon discs
    this.sun = new THREE.Mesh(
      new THREE.SphereGeometry(this.radius * 0.016, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xfff6dd, fog: false }),
    );
    this.sun.renderOrder = -999;
    this.sun.frustumCulled = false;
    scene.add(this.sun);
    this.moon = new THREE.Mesh(
      new THREE.SphereGeometry(this.radius * 0.011, 14, 10),
      new THREE.MeshBasicMaterial({ color: 0xdfe6f2, fog: false }),
    );
    this.moon.renderOrder = -999;
    this.moon.frustumCulled = false;
    scene.add(this.moon);

    // --- stars
    const N = 2400;
    const pos = new Float32Array(N * 3);
    const size = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const u = Math.random() * Math.PI * 2;
      const v = Math.acos(Math.random() * 0.98 + 0.02); // upper hemisphere bias
      const r = this.radius * 0.94;
      pos[i * 3] = r * Math.sin(v) * Math.cos(u);
      pos[i * 3 + 1] = r * Math.cos(v);
      pos[i * 3 + 2] = r * Math.sin(v) * Math.sin(u);
      size[i] = 1.2 + Math.random() * 2.6;
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    sg.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    this.stars = new THREE.Points(sg, new THREE.ShaderMaterial({
      uniforms: { uOpacity: { value: 0 }, uPixelRatio: { value: 1 }, uColor: { value: new THREE.Color(0xdfe8ff) } },
      vertexShader: `attribute float aSize; uniform float uPixelRatio; varying float vTw;
        void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uPixelRatio; gl_Position = projectionMatrix * mv;
          vTw = 0.6 + 0.4 * sin(position.x * 0.01 + position.z * 0.013); }`,
      fragmentShader: `uniform float uOpacity; uniform vec3 uColor; varying float vTw;
        void main() { vec2 c = gl_PointCoord - 0.5; float d = dot(c, c);
          if (d > 0.25) discard;
          gl_FragColor = vec4(uColor, uOpacity * vTw * (1.0 - d * 3.4)); }`,
      transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending,
    }));
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -998;
    scene.add(this.stars);

    // --- lighting rig
    this.sunLight = new THREE.DirectionalLight(0xfff4e0, 3);
    this.sunLight.castShadow = true;
    const s = RENDER.shadowMapSize;
    this.sunLight.shadow.mapSize.set(s, s);
    this.shadowSpan = opts.shadowSpan ?? 190;
    const cam = this.sunLight.shadow.camera;
    cam.left = -this.shadowSpan; cam.right = this.shadowSpan;
    cam.top = this.shadowSpan; cam.bottom = -this.shadowSpan;
    cam.near = 1; cam.far = this.shadowSpan * 9;
    cam.updateProjectionMatrix();
    this.sunLight.shadow.bias = -0.0009;
    this.sunLight.shadow.normalBias = 0.55;
    scene.add(this.sunLight, this.sunLight.target);

    this.hemi = new THREE.HemisphereLight(0xa9c8e0, 0x4a4636, 0.9);
    scene.add(this.hemi);
    this.ambient = new THREE.AmbientLight(0xffffff, 0.18);
    scene.add(this.ambient);

    this.groundColor = new THREE.Color(0x4a4636);
    this.cloudCover = 0.15;
    this.haze = 0;
  }

  setShadowQuality(size, span = this.shadowSpan) {
    this.sunLight.shadow.mapSize.set(size, size);
    this.sunLight.shadow.map?.dispose();
    this.sunLight.shadow.map = null;
    this.shadowSpan = span;
    const cam = this.sunLight.shadow.camera;
    cam.left = -span; cam.right = span; cam.top = span; cam.bottom = -span;
    cam.far = span * 9;
    cam.updateProjectionMatrix();
  }

  setWeather(cover, haze) {
    this.cloudCover = clamp(cover, 0, 1);
    this.haze = clamp(haze, 0, 1);
  }

  setGroundColor(color) { this.groundColor.copy(color); }

  update(camera, dt) {
    const c = this.cycle;
    c.update(dt);

    this.uniforms.uSunDir.value.copy(c.sunDirection);
    this.uniforms.uSunColor.value.copy(c.sunColor);
    this.uniforms.uZenith.value.copy(c.skyColor).lerp(_tmp.setHex(0x6d7480), this.cloudCover * 0.72);
    this.uniforms.uHorizon.value.copy(c.horizonColor).lerp(_tmp.setHex(0x8b8f94), this.cloudCover * 0.6);
    this.uniforms.uGround.value.copy(this.groundColor).multiplyScalar(0.5);
    this.uniforms.uSunGlow.value = (1 - this.cloudCover * 0.85) * (0.55 + c.dusk * 0.9);
    this.uniforms.uHaze.value = this.haze * 0.85 + c.dusk * 0.18;

    // sky follows the camera so it never runs out
    if (camera) {
      this.mesh.position.copy(camera.position);
      this.stars.position.copy(camera.position);
      this.sun.position.copy(camera.position).addScaledVector(c.sunDirection, this.radius * 0.9);
      this.moon.position.copy(camera.position).addScaledVector(c.moonDirection, this.radius * 0.88);
    }
    this.sun.visible = c.elevation > -0.12 && this.cloudCover < 0.98;
    this.moon.visible = c.elevation < 0.12;
    this.sun.material.color.copy(c.sunColor).lerp(_tmp.setRGB(1, 1, 1), 0.45);
    this.stars.material.uniforms.uOpacity.value = c.night * (1 - this.cloudCover) * 0.95;
    this.stars.visible = this.stars.material.uniforms.uOpacity.value > 0.01;

    // lights
    const cloudDim = 1 - this.cloudCover * 0.62;
    this.sunLight.color.copy(c.sunColor);
    this.sunLight.intensity = c.sunIntensity * cloudDim;
    this.sunLight.visible = this.sunLight.intensity > 0.02;
    this.sunLight.position.copy(c.sunDirection).multiplyScalar(this.shadowSpan * 4);
    if (camera) {
      _anchor.set(camera.position.x, 0, camera.position.z);
      this.sunLight.position.add(_anchor);
      this.sunLight.target.position.copy(_anchor);
      this.sunLight.target.updateMatrixWorld();
    }
    // moonlight stands in for the sun below the horizon
    if (c.elevation < 0.05) {
      this.sunLight.position.copy(c.moonDirection).multiplyScalar(this.shadowSpan * 4);
      if (camera) this.sunLight.position.add(_anchor.set(camera.position.x, 0, camera.position.z));
      this.sunLight.color.setHex(0x93a9cc);
      this.sunLight.intensity = 0.42 * c.night * (1 - this.cloudCover * 0.7);
      this.sunLight.visible = this.sunLight.intensity > 0.02;
    }
    this.hemi.color.copy(c.skyColor).lerp(_tmp.setHex(0x8d949c), this.cloudCover * 0.6);
    this.hemi.groundColor.copy(this.groundColor);
    this.hemi.intensity = c.ambientIntensity * (1 - this.cloudCover * 0.35) + 0.12;
    this.ambient.color.copy(c.ambientColor);
    this.ambient.intensity = 0.16 + c.night * 0.10;
  }

  /** Everything the water and fog systems need from the sky this frame. */
  sunInfo() {
    return {
      direction: this.sunLight.position.clone().normalize(),
      color: this.sunLight.color,
      skyColor: this.uniforms.uHorizon.value,
      intensity: this.sunLight.intensity,
    };
  }

  dispose() {
    this.mesh.geometry.dispose(); this.mesh.material.dispose();
    this.sun.geometry.dispose(); this.sun.material.dispose();
    this.moon.geometry.dispose(); this.moon.material.dispose();
    this.stars.geometry.dispose(); this.stars.material.dispose();
    this.mesh.removeFromParent(); this.sun.removeFromParent();
    this.moon.removeFromParent(); this.stars.removeFromParent();
  }
}

export default SkyManager;
