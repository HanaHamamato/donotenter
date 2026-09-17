/**
 * PostFX — the image pipeline (GDD §7 PostProcessing, §8 quality presets).
 *
 *   render → AO (high only) → bloom → grade/vignette/grain → output
 *
 * The grade pass also carries the gameplay-flavoured effects: a lightning flash,
 * extra vignette inside a tunnel, and a touch of chromatic aberration that
 * widens with speed so 90 km/h feels faster than it looks.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { RENDER } from '../constants.js';
import { clamp, clamp01, damp } from '../utils/math.js';

export const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uExposure: { value: 1.0 },
    uSaturation: { value: 1.06 },
    uContrast: { value: 1.04 },
    uVignette: { value: 0.5 },
    uGrain: { value: 0.022 },
    uAberration: { value: 0.35 },
    uFlash: { value: 0 },
    uTunnel: { value: 0 },
    uSpeed: { value: 0 },
    uCold: { value: 0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uTime, uExposure, uSaturation, uContrast, uVignette, uGrain;
    uniform float uAberration, uFlash, uTunnel, uSpeed, uCold;
    varying vec2 vUv;
    float rand(vec2 c) { return fract(sin(dot(c, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 d = vUv - 0.5;
      float r2 = dot(d, d);
      float ab = (uAberration * 0.0035) * (1.0 + uSpeed * 2.4);
      vec3 c;
      c.r = texture2D(tDiffuse, vUv + d * ab * r2 * 6.0).r;
      c.g = texture2D(tDiffuse, vUv).g;
      c.b = texture2D(tDiffuse, vUv - d * ab * r2 * 6.0).b;

      c *= uExposure;

      // cold/blue shift in snow, warm in a flash of lightning
      c = mix(c, c * vec3(0.94, 0.99, 1.08), uCold);

      float vig = smoothstep(1.05, 0.18, r2 * 2.2);
      c *= mix(1.0, vig, clamp(uVignette + uTunnel * 0.55, 0.0, 1.0));

      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uSaturation);
      c = (c - 0.5) * uContrast + 0.5;

      c += uFlash * vec3(0.72, 0.78, 0.95);
      c += (rand(vUv * (1.0 + fract(uTime))) - 0.5) * uGrain;
      gl_FragColor = vec4(max(c, 0.0), 1.0);
    }
  `,
};

export class PostFX {
  constructor(renderer, scene, camera, opts = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.enabled = opts.enabled !== false;
    this.time = 0;
    this.flash = 0;
    this.tunnel = 0;
    this.speed = 0;
    this.cold = 0;

    const size = renderer?.getSize?.(new THREE.Vector2()) || new THREE.Vector2(1280, 720);
    this.msaa = opts.msaa ?? 4;
    const rt = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples: this.msaa,          // MSAA inside the composer chain (WebGL2)
      depthBuffer: true,
    });
    this.composer = new EffectComposer(renderer, rt);
    this.composer.setSize(size.x, size.y);
    this.composer.setPixelRatio(renderer?.getPixelRatio?.() ?? 1);

    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), RENDER.bloomStrength, RENDER.bloomRadius, RENDER.bloomThreshold);
    this.composer.addPass(this.bloom);

    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);

    this.output = new OutputPass();
    this.composer.addPass(this.output);

    this.ao = null;
    this.quality = 'medium';
  }

  setQuality(preset) {
    const p = RENDER.presets[preset] || RENDER.presets.medium;
    this.quality = preset;
    this.bloom.strength = p.bloom;
    this.bloom.enabled = p.bloom > 0.001;
    // MSAA is worth its cost only on medium and up
    const want = preset === 'low' ? 0 : 4;
    if (want !== this.msaa) {
      this.msaa = want;
      for (const target of [this.composer.renderTarget1, this.composer.renderTarget2]) {
        if (target) { target.samples = want; target.dispose?.(); }
      }
    }
    this.grade.uniforms.uGrain.value = preset === 'high' ? 0.02 : preset === 'low' ? 0.035 : 0.022;
    this.grade.uniforms.uAberration.value = preset === 'low' ? 0 : 0.35;

    // AO is expensive and only worth it on high
    if (p.ssao && !this.ao) {
      try {
        const size = this.renderer.getSize(new THREE.Vector2());
        this.ao = new GTAOPass(this.scene, this.camera, size.x, size.y);
        this.ao.output = GTAOPass.OUTPUT.Default;
        this.composer.insertPass(this.ao, 1);
      } catch (err) {
        console.warn('[PostFX] AO unavailable:', err?.message);
        this.ao = null;
      }
    } else if (!p.ssao && this.ao) {
      this.composer.removePass(this.ao);
      this.ao.dispose?.();
      this.ao = null;
    }
    return p;
  }

  resize(w, h, pixelRatio) {
    this.composer.setPixelRatio(pixelRatio ?? this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
    this.ao?.setSize?.(w, h);
  }

  /** Per-frame effect drivers. */
  setFlash(v) { this.flash = clamp01(v); }
  setTunnel(v) { this.tunnel = clamp01(v); }
  setSpeed01(v) { this.speed = clamp01(v); }
  setCold(v) { this.cold = clamp01(v); }
  setExposure(v) { this.grade.uniforms.uExposure.value = v; }

  update(dt, env = {}) {
    this.time += dt;
    const u = this.grade.uniforms;
    u.uTime.value = this.time;
    if (env.flash !== undefined) this.flash = env.flash;
    if (env.tunnel !== undefined) this.tunnel = env.tunnel;
    if (env.speed01 !== undefined) this.speed = env.speed01;
    if (env.cold !== undefined) this.cold = env.cold;
    u.uFlash.value = damp(u.uFlash.value, this.flash, 14, dt);
    u.uTunnel.value = damp(u.uTunnel.value, this.tunnel, 5, dt);
    u.uSpeed.value = damp(u.uSpeed.value, this.speed, 3, dt);
    u.uCold.value = damp(u.uCold.value, this.cold, 1.4, dt);
    // bloom tightens at night so signals and headlights read as points of light
    u.uExposure.value = env.exposure ?? u.uExposure.value;
    this.bloom.strength = clamp((RENDER.presets[this.quality]?.bloom ?? 0.5) * (env.nightBoost ?? 1), 0, 2);
  }

  render() {
    if (this.enabled) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.ao?.dispose?.();
    this.bloom.dispose?.();
    this.grade.dispose?.();
    this.composer.dispose?.();
  }
}

export default PostFX;
