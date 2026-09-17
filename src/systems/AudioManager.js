/**
 * AudioManager — a fully procedural sound engine (GDD §7 AudioManager).
 *
 * No audio files ship with the game. Everything is synthesised:
 *
 *   diesel      two detuned saws through a lowpass, plus a "chuff" LFO whose
 *               rate follows wheel speed and whose depth follows the notch
 *   turbo       a bandpassed noise whistle that spins up with the throttle
 *   rumble      looped noise through a bandpass — the rails themselves
 *   squeal      flange noise on the outer rail when lateral acceleration builds
 *   wind/rain   weather beds
 *   horn        a three-note chord of squares with a slow attack
 *   bell        a struck partial set with an exponential decay
 *   hiss/clank  brake application and coupler work
 *   thunder     a filtered noise burst, delayed from the lightning flash
 *
 * A short feedback-delay "tunnel reverb" fades in inside bores, which does more
 * for the feeling of being underground than any visual effect.
 */
import { bus } from '../utils/events.js';

const noiseBuffer = (ctx, seconds = 2) => {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.02 * white) / 1.02;     // lightly pink-ish
    d[i] = last * 3.2 + white * 0.35;
  }
  return buf;
};

export class AudioManager {
  constructor(opts = {}) {
    this.ctx = null;
    this.ready = false;
    this.muted = false;
    this.volumes = { master: 0.85, engine: 0.9, effects: 0.85, ambient: 0.7, ui: 0.7 };
    this.nodes = {};
    this.tunnel = 0;
    this._lastHorn = 0;
    this._thunderQueue = [];
    this.on = opts.enabled !== false;
    this._wireBus();
  }

  _wireBus() {
    this.off = [];
    const on = (ev, fn) => { bus.on(ev, fn); this.off.push([ev, fn]); };
    on('train:horn', () => this.horn());
    on('train:bell', (e) => this.setBell(!!e.on));
    on('train:coupled', () => this.clank(0.7));
    on('train:decoupled', () => this.clank(0.45));
    on('train:buffer', (e) => { this.clank(1); this.thud(Math.min(1, e.speed / 6)); });
    on('train:derail', () => { this.thud(1); this.clank(1); });
    on('train:slip', () => this.squeal(0.7, 0.35));
    on('train:emergency', () => this.hiss(0.9, 1.4));
    on('weather:lightning', (e) => this._thunderQueue.push({ at: performance.now() / 1000 + (e.delay || 1), strength: e.strength || 1 }));
    on('ui:click', () => this.click());
    on('ui:back', () => this.click(0.7));
    on('contract:accepted', () => this.chime([523, 659, 784]));
    on('contract:complete', () => this.chime([523, 659, 784, 1046], 0.5));
    on('contract:failed', () => this.chime([392, 330, 262], 0.4));
    on('station:arrive', () => this.chime([659, 880], 0.25));
    on('milestone:reached', () => this.chime([523, 659, 784, 1046, 1318], 0.7));
  }

  /** Must be called from a user gesture. */
  init() {
    if (this.ctx) { this.resume(); return this.ctx; }
    if (!this.on) return null;
    const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return null;
    const ctx = new AC();
    this.ctx = ctx;

    const master = ctx.createGain();
    master.gain.value = this.volumes.master;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 22; comp.ratio.value = 5;
    comp.attack.value = 0.004; comp.release.value = 0.22;
    master.connect(comp).connect(ctx.destination);

    // tunnel reverb: two feedback delays, wet gain rises inside a bore
    const wet = ctx.createGain(); wet.gain.value = 0;
    const d1 = ctx.createDelay(1.0); d1.delayTime.value = 0.062;
    const d2 = ctx.createDelay(1.0); d2.delayTime.value = 0.113;
    const fb = ctx.createGain(); fb.gain.value = 0.62;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2200;
    d1.connect(d2).connect(lp).connect(fb).connect(d1);
    d1.connect(wet); d2.connect(wet);
    wet.connect(master);

    const dry = ctx.createGain(); dry.gain.value = 1; dry.connect(master);
    this.nodes = { master, comp, wet, dry, d1, d2 };

    this.noise = noiseBuffer(ctx, 3);
    this._buildEngine();
    this._buildRumble();
    this._buildWind();
    this._buildRain();
    this.ready = true;
    return ctx;
  }

  resume() { if (this.ctx?.state === 'suspended') this.ctx.resume(); }
  suspend() { if (this.ctx?.state === 'running') this.ctx.suspend(); }

  setVolume(kind, v) {
    this.volumes[kind] = v;
    if (!this.ctx) return;
    if (kind === 'master') this.nodes.master.gain.value = this.muted ? 0 : v;
    this._applyGains();
  }

  setMuted(m) {
    this.muted = !!m;
    if (this.ctx) this.nodes.master.gain.value = this.muted ? 0 : this.volumes.master;
  }

  _applyGains() { /* per-bus gains are applied where the chains are built */ }

  /* ------------------------------------------------------------- engines */
  _buildEngine() {
    const ctx = this.ctx;
    const g = ctx.createGain(); g.gain.value = 0;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 620; lp.Q.value = 3.2;
    const shaper = ctx.createWaveShaper();
    shaper.curve = this._softCurve(2.4);

    const o1 = ctx.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 42;
    const o2 = ctx.createOscillator(); o2.type = 'sawtooth'; o2.frequency.value = 63.4;
    const o3 = ctx.createOscillator(); o3.type = 'square'; o3.frequency.value = 21;
    const g1 = ctx.createGain(); g1.gain.value = 0.5;
    const g2 = ctx.createGain(); g2.gain.value = 0.32;
    const g3 = ctx.createGain(); g3.gain.value = 0.28;
    o1.connect(g1); o2.connect(g2); o3.connect(g3);
    g1.connect(lp); g2.connect(lp); g3.connect(lp);
    lp.connect(shaper).connect(g);
    g.connect(this.nodes.dry); g.connect(this.nodes.d1);

    // chuff: an LFO gating a noise burst, rate = wheel revolutions
    const chuffGain = ctx.createGain(); chuffGain.gain.value = 0;
    const chuffSrc = ctx.createBufferSource(); chuffSrc.buffer = this.noise; chuffSrc.loop = true;
    const chuffBp = ctx.createBiquadFilter(); chuffBp.type = 'bandpass'; chuffBp.frequency.value = 180; chuffBp.Q.value = 1.1;
    const chuffLfo = ctx.createOscillator(); chuffLfo.type = 'sine'; chuffLfo.frequency.value = 3;
    const lfoDepth = ctx.createGain(); lfoDepth.gain.value = 0.5;
    const lfoOffset = ctx.createConstantSource(); lfoOffset.offset.value = 0.5;
    chuffLfo.connect(lfoDepth).connect(chuffGain.gain);
    lfoOffset.connect(chuffGain.gain);
    chuffSrc.connect(chuffBp).connect(chuffGain);
    chuffGain.connect(this.nodes.dry); chuffGain.connect(this.nodes.d1);

    // turbo whistle
    const turbo = ctx.createGain(); turbo.gain.value = 0;
    const tSrc = ctx.createBufferSource(); tSrc.buffer = this.noise; tSrc.loop = true;
    const tBp = ctx.createBiquadFilter(); tBp.type = 'bandpass'; tBp.frequency.value = 1400; tBp.Q.value = 9;
    tSrc.connect(tBp).connect(turbo).connect(this.nodes.dry);

    for (const o of [o1, o2, o3, chuffLfo, lfoOffset, chuffSrc, tSrc]) { try { o.start(); } catch { /* already started */ } }
    this.eng = { g, lp, shaper, o1, o2, o3, g1, g2, g3, chuffGain, chuffLfo, lfoDepth, turbo, tBp };
  }

  _softCurve(amount) {
    const n = 1024, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * amount) / Math.tanh(amount);
    }
    return curve;
  }

  _buildRumble() {
    const ctx = this.ctx;
    const src = ctx.createBufferSource(); src.buffer = this.noise; src.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 90; bp.Q.value = 0.8;
    const g = ctx.createGain(); g.gain.value = 0;
    src.connect(bp).connect(g);
    g.connect(this.nodes.dry); g.connect(this.nodes.d1);
    src.start();
    this.rumble = { g, bp, src };
  }

  _buildWind() {
    const ctx = this.ctx;
    const src = ctx.createBufferSource(); src.buffer = this.noise; src.loop = true;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 420;
    const g = ctx.createGain(); g.gain.value = 0;
    src.connect(hp).connect(g).connect(this.nodes.dry);
    src.start();
    this.wind = { g, hp };
  }

  _buildRain() {
    const ctx = this.ctx;
    const src = ctx.createBufferSource(); src.buffer = this.noise; src.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2600; bp.Q.value = 0.5;
    const g = ctx.createGain(); g.gain.value = 0;
    src.connect(bp).connect(g).connect(this.nodes.dry);
    src.start();
    this.rain = { g, bp };
  }

  /* -------------------------------------------------------------- mixing */
  /**
   * @param {number} dt
   * @param {object} train TrainController (may be null)
   * @param {object} env { weather, tunnel, speedFactor, cameraMode }
   */
  update(dt, train, env = {}) {
    if (!this.ready || !this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const e = this.eng;

    // --- tunnel reverb
    const targetTunnel = env.tunnel || 0;
    this.tunnel += (targetTunnel - this.tunnel) * Math.min(1, dt * 3.4);
    this.nodes.wet.gain.setTargetAtTime(this.tunnel * 0.55 * this.volumes.ambient, t, 0.12);

    const running = !!train && !train.empty && !train.derail;
    const notch = running ? train.controls.throttle : 0;
    const kmh = running ? train.kmh : 0;
    const idle = running && train.locomotives.length > 0;
    const load = running ? clamp01(train.forces.te / Math.max(1, train.forces.adhesion)) : 0;

    // --- diesel
    const baseHz = idle ? 34 + notch * 4.6 + kmh * 0.055 : 0;
    e.o1.frequency.setTargetAtTime(baseHz, t, 0.16);
    e.o2.frequency.setTargetAtTime(baseHz * 1.505, t, 0.16);
    e.o3.frequency.setTargetAtTime(baseHz * 0.5, t, 0.2);
    e.lp.frequency.setTargetAtTime(340 + notch * 190 + kmh * 3.4, t, 0.2);
    const engineLevel = idle ? (0.10 + notch * 0.021 + load * 0.05) * this.volumes.engine : 0;
    e.g.gain.setTargetAtTime(this.muted ? 0 : engineLevel, t, 0.22);

    // --- chuff: rate follows the wheels, depth and level follow the notch.
    // The gain is driven entirely by connected inputs (an LFO plus a constant
    // offset) so it pulses rather than sitting at a fixed level.
    const wheelHz = clamp(1.4 + kmh * 0.085, 0, 14);
    e.chuffLfo.frequency.setTargetAtTime(wheelHz, t, 0.1);
    e.lfoDepth.gain.setTargetAtTime(idle ? 0.022 + notch * 0.010 + load * 0.022 : 0, t, 0.2);
    e.lfoOffset.offset.setTargetAtTime(idle ? 0.026 + notch * 0.012 + load * 0.02 : 0, t, 0.25);

    // --- turbo
    e.tBp.frequency.setTargetAtTime(900 + notch * 240 + kmh * 6, t, 0.3);
    e.turbo.gain.setTargetAtTime(idle ? (0.004 + notch * 0.0035 + load * 0.012) * this.volumes.engine : 0, t, 0.35);

    // --- rail rumble
    const rumble = clamp01(kmh / 90) * (0.16 + env.speedFactor * 0.1) * this.volumes.ambient;
    this.rumble.bp.frequency.setTargetAtTime(70 + kmh * 1.5, t, 0.25);
    this.rumble.g.gain.setTargetAtTime(running ? rumble : 0, t, 0.3);

    // --- wind
    const windBase = (env.weather?.state?.wind || 2) * 0.004 + clamp01(kmh / 120) * 0.05;
    this.wind.g.gain.setTargetAtTime(windBase * this.volumes.ambient * (env.cameraMode === 'cab' ? 0.5 : 1), t, 0.5);

    // --- rain / snow bed
    const precip = env.weather?.state?.precip || 0;
    const isSnow = env.weather?.state?.kind === 'snow';
    this.rain.bp.frequency.setTargetAtTime(isSnow ? 900 : 2600, t, 0.6);
    this.rain.g.gain.setTargetAtTime(precip * (isSnow ? 0.035 : 0.075) * (1 - this.tunnel * 0.85) * this.volumes.ambient, t, 0.7);

    // --- curve squeal from unbalanced lateral acceleration
    if (running && train.frame) {
      const aLat = train.frame.unbalancedAt?.(train.speed) || 0;
      if (aLat > 0.45 && kmh > 18) this.squeal(clamp01((aLat - 0.45) / 1.1), 0.08);
    }

    // --- queued thunder
    const nowS = performance.now() / 1000;
    while (this._thunderQueue.length && this._thunderQueue[0].at <= nowS) {
      const q = this._thunderQueue.shift();
      this.thunder(q.strength);
    }
  }

  /* ------------------------------------------------------------ one-shots */
  _env(gain, t, a, d, peak) {
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(peak, t + a);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }

  _noise(dur) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.start();
    src.stop(ctx.currentTime + dur + 0.05);
    return src;
  }

  horn(duration = 0.85) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const g = ctx.createGain();
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1500;
    g.connect(lp).connect(this.nodes.dry); g.connect(this.nodes.d1);
    const freqs = [196, 246.9, 293.7];
    for (const f of freqs) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = f;
      const og = ctx.createGain(); og.gain.value = 0.3;
      o.connect(og).connect(g);
      o.start(t); o.stop(t + duration + 0.25);
    }
    this._env(g, t, 0.035, duration + 0.18, 0.30 * this.volumes.effects);
  }

  setBell(on) {
    if (!this.ready || this.muted) return;
    if (on && !this._bellTimer) {
      this._bellTimer = setInterval(() => this.bell(), 1100);
      this.bell();
    } else if (!on && this._bellTimer) {
      clearInterval(this._bellTimer);
      this._bellTimer = null;
    }
  }

  bell() {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const g = ctx.createGain(); g.connect(this.nodes.dry);
    for (const [f, a] of [[988, 0.5], [1480, 0.28], [2210, 0.16], [3100, 0.08]]) {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
      const og = ctx.createGain(); og.gain.value = a;
      o.connect(og).connect(g);
      o.start(t); o.stop(t + 1.2);
    }
    this._env(g, t, 0.004, 0.85, 0.24 * this.volumes.effects);
  }

  squeal(amount = 0.6, dur = 0.3) {
    if (!this.ready || this.muted || this._squealLock > performance.now()) return;
    this._squealLock = performance.now() + 120;
    const ctx = this.ctx, t = ctx.currentTime;
    const g = ctx.createGain();
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2100 + amount * 900; bp.Q.value = 14;
    const src = this._noise(dur + 0.2);
    src.connect(bp).connect(g).connect(this.nodes.dry);
    this._env(g, t, 0.05, dur, 0.055 * amount * this.volumes.effects);
  }

  hiss(amount = 0.5, dur = 0.7) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const g = ctx.createGain();
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1800;
    const src = this._noise(dur + 0.2);
    src.connect(hp).connect(g).connect(this.nodes.dry);
    this._env(g, t, 0.02, dur, 0.09 * amount * this.volumes.effects);
  }

  clank(amount = 0.6) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const g = ctx.createGain();
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 420; bp.Q.value = 2.4;
    const src = this._noise(0.4);
    src.connect(bp).connect(g);
    g.connect(this.nodes.dry); g.connect(this.nodes.d1);
    this._env(g, t, 0.004, 0.3, 0.28 * amount * this.volumes.effects);
    // metallic ring
    const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = 168 + amount * 40;
    const og = ctx.createGain(); og.gain.value = 0.14 * amount;
    o.connect(og).connect(this.nodes.dry);
    o.start(t); o.stop(t + 0.4);
    this._env(og, t, 0.003, 0.32, 0.14 * amount * this.volumes.effects);
  }

  thud(amount = 0.7) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.45);
    const g = ctx.createGain();
    o.connect(g); g.connect(this.nodes.dry); g.connect(this.nodes.d1);
    o.start(t); o.stop(t + 0.6);
    this._env(g, t, 0.006, 0.5, 0.42 * amount * this.volumes.effects);
  }

  thunder(strength = 1) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const dur = 1.8 + strength * 1.6;
    const g = ctx.createGain();
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, t);
    lp.frequency.exponentialRampToValueAtTime(120, t + dur);
    const src = this._noise(dur);
    src.connect(lp).connect(g);
    g.connect(this.nodes.dry); g.connect(this.nodes.d1);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.42 * strength * this.volumes.effects, t + 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }

  click(amount = 1) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = 1250;
    const g = ctx.createGain();
    o.connect(g).connect(this.nodes.dry);
    o.start(t); o.stop(t + 0.06);
    this._env(g, t, 0.001, 0.045, 0.05 * amount * this.volumes.ui);
  }

  chime(freqs = [659, 880], dur = 0.3) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    freqs.forEach((f, i) => {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
      const g = ctx.createGain();
      o.connect(g).connect(this.nodes.dry);
      o.start(t + i * 0.075); o.stop(t + i * 0.075 + dur + 0.4);
      this._env(g, t + i * 0.075, 0.008, dur + 0.3, 0.14 * this.volumes.ui);
    });
  }

  /** A station announcement blip when the player pulls into a platform. */
  stationChime() { this.chime([784, 1046], 0.22); }

  dispose() {
    for (const [ev, fn] of this.off || []) bus.off(ev, fn);
    if (this._bellTimer) clearInterval(this._bellTimer);
    if (this.ctx) { try { this.ctx.close(); } catch { /* noop */ } }
    this.ready = false;
  }
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

export default AudioManager;
