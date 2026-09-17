/**
 * CameraManager — every way to look at a train (GDD §6.3 camera modes).
 *
 *   chase     a dolly behind the consist, lifting with speed
 *   cab       the engineer's seat, with free-look out of the windows
 *   orbit     drag to circle the train, wheel to dolly in and out
 *   trackside a fixed tripod out on the right-of-way; the train runs past it
 *   free      fly anywhere — photo mode and spotting
 *
 * Mode changes blend over half a second instead of cutting. Speed adds a little
 * FOV, impacts and wheel slip add shake, and the camera never sinks into the
 * terrain.
 */
import * as THREE from 'three';
import { RENDER, LOCOMOTIVES } from '../constants.js';
import { clamp, clamp01, damp, lerp } from '../utils/math.js';
import { bus } from '../utils/events.js';

export const CAMERA_MODES = ['chase', 'cab', 'orbit', 'trackside', 'free'];

/** Cab seat position per locomotive, as a fraction of its body length. */
const CAB = {
  gp7: { z: 0.27, y: 2.62, x: 0.62 },
  sd40: { z: 0.29, y: 2.72, x: 0.66 },
  funit: { z: 0.30, y: 2.55, x: 0.62 },
  ac9: { z: 0.01, y: 2.86, x: 0.72 },
};

const _m = new THREE.Matrix4();
const _frame = {};
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _right = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _e = new THREE.Euler();

export class CameraManager {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {import('./TrackNetwork.js').TrackNetwork} net
   */
  constructor(camera, net, opts = {}) {
    this.camera = camera;
    this.net = net;
    this.terrain = opts.terrain || null;
    this.mode = opts.mode || 'chase';
    this.prevMode = this.mode;
    this.blend = 1;
    this.blendFrom = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), fov: RENDER.fov };

    this.yaw = 0; this.pitch = 0;              // cab / free look
    this.orbit = { az: 0.6, el: 0.24, dist: 46, auto: true };
    this.free = { pos: new THREE.Vector3(0, 120, 0), yaw: 0, pitch: -0.1, speed: 0 };
    this.chase = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), init: false };
    this.trackside = { pos: new THREE.Vector3(), set: false, timer: 0, side: 1 };
    this.shake = { amount: 0, roll: 0, t: 0 };
    this.fovBase = RENDER.fov;
    this.fov = RENDER.fov;
    this.dolly = 1;
    this.sensitivity = opts.sensitivity ?? 1;
    /** Flip vertical look (setting: "Invert look Y"). Applied to every mode. */
    this.invertY = !!opts.invertY;
    /** True while the free-look key is held: cab look stops springing forward. */
    this.holdLook = false;
    this.cabDesk = null;
    this._rough = 0;
  }

  setMode(mode, quiet = false) {
    if (!CAMERA_MODES.includes(mode) || mode === this.mode) return;
    this.blendFrom.pos.copy(this.camera.position);
    this.blendFrom.quat.copy(this.camera.quaternion);
    this.blendFrom.fov = this.camera.fov;
    this.prevMode = this.mode;
    this.mode = mode;
    this.blend = 0;
    if (mode === 'free' && !this.free.init) {
      this.free.pos.copy(this.camera.position);
      this.free.init = true;
    }
    if (mode === 'trackside') this.trackside.set = false;
    if (!quiet) bus.emit('camera:mode', { mode });
  }

  cycle(dir = 1) {
    const i = CAMERA_MODES.indexOf(this.mode);
    this.setMode(CAMERA_MODES[(i + dir + CAMERA_MODES.length) % CAMERA_MODES.length]);
  }

  /** The desk/gauge panel shown in cab view, parented to the lead locomotive. */
  ensureCabDesk(assets) {
    if (this.cabDesk || !assets) return this.cabDesk;
    const g = new THREE.Group();
    g.name = 'cabDesk';
    const desk = assets.mesh('cab_desk', assets.materials.paint, false);
    g.add(desk);
    g.visible = false;
    this.cabDesk = g;
    return g;
  }

  update(dt, train, input, opts = {}) {
    const cam = this.camera;
    const mouse = input?.takeMouse?.() || { dx: 0, dy: 0, dragX: 0, dragY: 0, wheel: 0, left: false };
    const look = { dx: (mouse.dx || 0) + (mouse.dragX || 0), dy: (mouse.dy || 0) + (mouse.dragY || 0) };
    if (this.invertY) look.dy = -look.dy;   // one place, so cab/orbit/free all agree

    // ---- speed feel
    const kmh = train ? train.kmh : 0;
    const speedT = clamp01(kmh / 110);
    this.fov = this.fovBase + speedT * RENDER.fovSpeedBoost - (opts.tunnel ? 2.5 : 0);

    // ---- shake: impacts, wheel slip, rough track at speed
    const jolt = train?.jolt || 0;
    const slip = train?.slip || 0;
    this._rough = damp(this._rough, speedT * 0.5 + slip * 1.6 + jolt * 3, 6, dt);
    this.shake.t += dt * (14 + this._rough * 22);
    const s = this._rough * 0.055;
    const ox = Math.sin(this.shake.t * 2.1) * s + Math.sin(this.shake.t * 5.7) * s * 0.4;
    const oy = Math.sin(this.shake.t * 1.7 + 1.2) * s * 0.8 + Math.sin(this.shake.t * 6.3) * s * 0.3;
    const oroll = Math.sin(this.shake.t * 1.3) * s * 0.5;

    // V held: the driver is looking around, so the cab view must not spring back
    this.holdLook = !!opts.freeLook;

    let placed = false;
    if (train && !train.empty) {
      switch (this.mode) {
        case 'cab': placed = this._updateCab(dt, train, look, ox, oy, oroll); break;
        case 'chase': placed = this._updateChase(dt, train, ox * 0.5, oy * 0.5, oroll * 0.5); break;
        case 'orbit': placed = this._updateOrbit(dt, train, look, mouse.wheel); break;
        case 'trackside': placed = this._updateTrackside(dt, train); break;
        default: placed = this._updateFree(dt, input, look); break;
      }
    } else {
      placed = this._updateFree(dt, input, look);
    }
    if (!placed) this._updateFree(dt, input, look);

    // ---- blend between modes
    if (this.blend < 1) {
      this.blend = clamp01(this.blend + dt / 0.45);
      const e = this.blend * this.blend * (3 - 2 * this.blend);
      cam.position.lerpVectors(this.blendFrom.pos, cam.position, e);
      cam.quaternion.slerpQuaternions(this.blendFrom.quat, cam.quaternion, e);
      cam.fov = lerp(this.blendFrom.fov, cam.fov, e);
    }
    if (Math.abs(cam.fov - this.fov) > 0.01 && this.blend >= 1) {
      cam.fov = damp(cam.fov, this.fov, 4, dt);
      cam.updateProjectionMatrix();
    } else if (this.blend < 1) {
      cam.updateProjectionMatrix();
    }

    // ---- cab desk visibility (parented to the locomotive the crew is in)
    if (this.cabDesk) {
      const unit = train?.cabUnit || train?.head;
      if (unit?.group) {
        if (this.cabDesk.parent !== unit.group) unit.group.add(this.cabDesk);
        const c = CAB[unit.typeKey] || CAB.gp7;
        this.cabDesk.position.set(0, c.y - 1.0, c.z * unit.length + 0.72);
        this.cabDesk.visible = this.mode === 'cab';
      } else {
        this.cabDesk.visible = false;
      }
    }
    return cam;
  }

  /* ------------------------------------------------------------------ modes */
  _headFrame(train) {
    return train.frame && train.frame.forward ? train.frame : this.net.frame(train.state, {});
  }

  _updateCab(dt, train, look, ox, oy, oroll) {
    const cam = this.camera;
    // ride in the locomotive, even when shoving a wagon leads the consist
    const unit = train.cabUnit || train.head;
    const f = unit?.state ? this.net.frame(unit.state, _frame) : this._headFrame(train);
    const c = CAB[unit?.typeKey] || CAB.gp7;
    const len = unit?.length || 17;

    this.yaw = clamp(this.yaw - look.dx * 0.0022 * this.sensitivity, -1.25, 1.25);
    this.pitch = clamp(this.pitch - look.dy * 0.0022 * this.sensitivity, -0.75, 0.62);
    // spring back to forward when the mouse is idle (unless V is held)
    if (!look.dx && !look.dy && !this.holdLook) {
      this.yaw = damp(this.yaw, 0, 1.1, dt);
      this.pitch = damp(this.pitch, 0, 1.1, dt);
    }

    _v.copy(f.position)
      .addScaledVector(f.up, c.y)
      .addScaledVector(f.localX, c.x)
      .addScaledVector(f.forward, c.z * len);
    cam.position.copy(_v);

    // orientation: the banked track basis, then the driver's look offsets
    _m.makeBasis(f.localX, f.up, f.forward);
    _q.setFromRotationMatrix(_m);
    _right.set(1, 0, 0).applyQuaternion(_q);
    const yawQ = _q1.setFromAxisAngle(UP, this.yaw);
    const pitchQ = _q2.setFromAxisAngle(_right, this.pitch);
    const rollQ = _q3.setFromAxisAngle(f.forward, oroll * 0.4);
    cam.quaternion.copy(_q).multiply(yawQ).premultiply(pitchQ).multiply(rollQ);
    cam.position.x += ox * 0.3; cam.position.y += oy * 0.3;
    cam.up.copy(f.up);
    return true;
  }

  _updateChase(dt, train, ox, oy, oroll) {
    const cam = this.camera;
    const f = this._headFrame(train);
    const back = 20 + clamp(train.kmh * 0.16, 0, 22) * this.dolly;
    const up = 7.4 + clamp(train.kmh * 0.022, 0, 3);
    _v.copy(f.position).addScaledVector(f.forward, -back).addScaledVector(f.up, up);
    if (this.terrain) {
      const g = this.terrain.surfaceHeight(_v.x, _v.z) + 2.2;
      if (_v.y < g) _v.y = g;
    }
    if (!this.chase.init) { this.chase.pos.copy(_v); this.chase.init = true; }
    this.chase.pos.x = damp(this.chase.pos.x, _v.x, 5.5, dt);
    this.chase.pos.y = damp(this.chase.pos.y, _v.y, 4.2, dt);
    this.chase.pos.z = damp(this.chase.pos.z, _v.z, 5.5, dt);
    cam.position.copy(this.chase.pos).add(_v2.set(ox, oy, 0));
    // look at a point well ahead of the train so the whole consist stays in shot
    _v2.copy(f.position).addScaledVector(f.forward, 26 + train.length * 0.18).addScaledVector(f.up, 2.4);
    cam.up.set(0, 1, 0);
    cam.lookAt(_v2);
    cam.rotateZ(oroll * 0.3);
    return true;
  }

  _updateOrbit(dt, train, look, wheel) {
    const cam = this.camera;
    const f = this._headFrame(train);
    const o = this.orbit;
    if (look.dx || look.dy) { o.auto = false; o.az -= look.dx * 0.005 * this.sensitivity; o.el = clamp(o.el + look.dy * 0.004 * this.sensitivity, -0.28, 1.35); }
    else if (o.auto) o.az += dt * 0.06;
    if (wheel) o.dist = clamp(o.dist * (1 + wheel * 0.12), 8, 260);
    const centre = _v.copy(f.position).addScaledVector(f.up, 3.2);
    const ce = Math.cos(o.el), se = Math.sin(o.el);
    _v2.set(Math.sin(o.az) * ce, se, Math.cos(o.az) * ce).multiplyScalar(o.dist);
    cam.position.copy(centre).add(_v2);
    if (this.terrain) {
      const g = this.terrain.surfaceHeight(cam.position.x, cam.position.z) + 1.6;
      if (cam.position.y < g) cam.position.y = g;
    }
    cam.up.set(0, 1, 0);
    cam.lookAt(centre);
    return true;
  }

  _updateTrackside(dt, train) {
    const cam = this.camera;
    const ts = this.trackside;
    const headPos = this.net.positionOf(train.state, _v2);
    ts.timer -= dt;
    if (!ts.set || ts.timer <= 0) {
      // plant the tripod ahead of the train, on the outside of the curve
      const ahead = 90 + train.kmh * 1.6;
      const probe = this.net.cloneState(train.state);
      this.net.advance(probe, ahead * (train.moving || 1));
      const f = this.net.frame(probe, {});
      const side = f.kappa > 1e-5 ? Math.sign(f.bank || 1) || 1 : (Math.random() < 0.5 ? -1 : 1);
      ts.side = side;
      const dist = 18 + Math.random() * 14;
      _v.copy(f.position).addScaledVector(f.right, side * dist).addScaledVector(f.up, 2.6 + Math.random() * 4.5);
      if (this.terrain) {
        const g = this.terrain.surfaceHeight(_v.x, _v.z) + 1.7;
        if (_v.y < g) _v.y = g;
      }
      ts.pos.copy(_v);
      ts.set = true;
      ts.timer = 14;
    }
    cam.position.copy(ts.pos);
    cam.up.set(0, 1, 0);
    // pan with the train a little ahead of itself, like an operator leading it
    const target = _v.copy(headPos).addScaledVector(this.net.tangentOf(train.state, _v2), 14).addScaledVector(UP, 2);
    cam.lookAt(target);
    const d = cam.position.distanceTo(headPos);
    if (d < 26 && train.kmh > 4) ts.timer = Math.min(ts.timer, 2.2);  // let it run past
    return true;
  }

  _updateFree(dt, input, look) {
    const cam = this.camera;
    const f = this.free;
    f.yaw -= (look.dx || 0) * 0.0022 * this.sensitivity;
    f.pitch = clamp(f.pitch - (look.dy || 0) * 0.0022 * this.sensitivity, -1.5, 1.5);
    cam.quaternion.setFromEuler(_e.set(f.pitch, f.yaw, 0, 'YXZ'));
    _v.set(0, 0, 0);
    const k = (code) => !!input?.keyDown?.(code);
    if (k('KeyW') || k('ArrowUp')) _v.z += 1;
    if (k('KeyS') || k('ArrowDown')) _v.z -= 1;
    if (k('KeyA') || k('ArrowLeft')) _v.x -= 1;
    if (k('KeyD') || k('ArrowRight')) _v.x += 1;
    if (k('Space')) _v.y += 1;
    if (k('ShiftLeft') || k('KeyC')) _v.y -= 1;
    if (_v.lengthSq() > 0) {
      const boost = k('ShiftLeft') ? 0.35 : 1;   // shift is also 'down', so keep it gentle
      const speed = (k('KeyR') ? 220 : 46) * boost;
      _v.normalize().applyQuaternion(cam.quaternion).multiplyScalar(speed * dt);
      f.pos.add(_v);
    }
    f.pos.y = Math.max(f.pos.y, (this.terrain?.surfaceHeight(f.pos.x, f.pos.z) ?? 0) + 1.4);
    cam.position.copy(f.pos);
    return true;
  }

  /** Snap straight to a mode with no blend (used on load / teleport). */
  snap(train) {
    this.blend = 1;
    this.chase.init = false;
    this.trackside.set = false;
    if (train && !train.empty) this.update(1 / 60, train, null, {});
    this.blend = 1;
  }

  dispose() { }
}

const UP = new THREE.Vector3(0, 1, 0);

export default CameraManager;
