/**
 * StructureManager — everything bolted to the ground that is not terrain,
 * track or vegetation (GDD §7 StructureManager, §2.4 station layout).
 *
 * Stations are assembled from the generated station data: a building sized to
 * the station's role, platforms along each siding, industry matching what the
 * town actually produces, a scattering of houses, signals on every switchable
 * throat and buffer stops at the ends of the sidings. Landmarks come straight
 * from the world file.
 *
 * Everything is placed once and then streamed by distance, so the cost of the
 * built world is a visibility test per object per frame.
 */
import * as THREE from 'three';
import { heightAt } from '../utils/terrain.js';
import { mulberry32 } from '../utils/math.js';

const STATION_RADIUS = 5200;
const PROP_RADIUS = 1400;
const TOWN_RADIUS = 3200;

/** Which industry a station gets for each cargo it produces. */
const INDUSTRY = {
  coal: 'mine_head', ironore: 'mine_head', grain: 'grain_elevator', timber: 'warehouse',
  steel: 'foundry', parts: 'foundry', goods: 'warehouse', food: 'warehouse',
  fish: 'warehouse', fertilizer: 'silo', livestock: 'warehouse', supplies: 'warehouse',
  passengers: 'station_large',
};

export class StructureManager {
  /**
   * @param {THREE.Scene} scene
   * @param {import('./TrackNetwork.js').TrackNetwork} net
   * @param {import('./AssetManager.js').AssetManager} assets
   * @param {object[]} stations parsed stations.json
   */
  constructor(scene, net, assets, stations, opts = {}) {
    this.scene = scene;
    this.net = net;
    this.assets = assets;
    this.stations = stations || [];
    this.terrain = opts.terrain || null;

    this.group = new THREE.Group();
    this.group.name = 'structures';
    scene.add(this.group);

    /** @type {{obj:THREE.Object3D, x:number, z:number, radius:number}[]} */
    this.items = [];
    this.signals = [];
    this.platforms = [];
    this.stationGroups = new Map();
    this.visibleCount = 0;
    this.lampMat = {
      red: new THREE.MeshBasicMaterial({ color: 0x330806 }),
      yellow: new THREE.MeshBasicMaterial({ color: 0x332a06 }),
      green: new THREE.MeshBasicMaterial({ color: 0x06330f }),
      redOn: new THREE.MeshBasicMaterial({ color: 0xff2a18 }),
      yellowOn: new THREE.MeshBasicMaterial({ color: 0xffcc33 }),
      greenOn: new THREE.MeshBasicMaterial({ color: 0x35ff6a }),
    };
  }

  /** Build the whole world's structures once at load. */
  build(landmarks = []) {
    this._buildStations();
    this._buildSignalsAndBuffers();
    this._buildLandmarks(landmarks);
    return this;
  }

  groundY(x, z) {
    return this.terrain ? this.terrain.surfaceHeight(x, z) : heightAt(x, z);
  }

  _add(obj, radius = PROP_RADIUS, x = obj.position.x, z = obj.position.z) {
    this.group.add(obj);
    this.items.push({ obj, x, z, radius });
    return obj;
  }

  /* ------------------------------------------------------------- stations */
  _buildStations() {
    for (const st of this.stations) {
      const node = this.net.nodes.get(st.node);
      if (!node) continue;
      const g = new THREE.Group();
      g.name = `station_${st.id}`;
      const big = st.type === 'City Terminus' || st.type === 'Port' || (st.produces.length + st.consumes.length) > 5;
      const rand = mulberry32(hashStr(st.id));

      // --- platform + building beside the first siding (or the main line)
      const sidingBranch = this._branchForSiding(node, st);
      const fr = this._frameAt(node, sidingBranch, 26);
      if (fr) {
        const side = 1;   // platforms go on the crew's right of the siding
        const platform = this.assets.mesh('platform', this.assets.materials.paint);
        this._placeOnFrame(platform, fr, -1.0, side * 7.4);
        g.add(platform);
        this.platforms.push({ station: st.id, obj: platform, frame: fr, side });

        const building = this.assets.mesh(big ? 'station_large' : 'station_small', this.assets.materials.paint);
        this._placeOnFrame(building, fr, -2, side * (big ? 17 : 13.5));
        building.rotateY(side > 0 ? Math.PI : 0);
        g.add(building);

        // a couple of lamps and a name board on the platform
        const sign = this.assets.mesh('station_sign', this.assets.materials.paint);
        this._placeOnFrame(sign, fr, 18, side * 4.6);
        sign.scale.set(1.1, 0.8, 1.1);
        g.add(sign);
      }

      // --- buffer stops at the end of every siding
      for (const sd of st.sidings || []) {
        const seg = this.net.segments.get(sd.seg);
        if (!seg) continue;
        const endNode = this._farNode(seg, node);
        if (endNode && endNode.kind === 'buffer') {
          const stop = this.assets.mesh('buffer_stop', this.assets.materials.paint);
          const f = this._frameAtEnd(seg, endNode);
          if (f) { this._placeOnFrame(stop, f, 0, 0); g.add(stop); }
        }
        // wagons standing in the yard, so stations never look abandoned
        const parked = Math.min(sd.capacity ?? 2, 2);
        for (let i = 0; i < parked; i++) {
          if (rand() < 0.35) continue;
          const key = ['boxcar', 'hopper', 'gondola', 'tanker', 'flatbed'][Math.floor(rand() * 5)];
          const car = this.assets.mesh(`car_${key}`, this.assets.materials.paint);
          const dist = (sd.from ?? 30) + 20 + i * 17;
          const f2 = this._frameAlong(seg, node, dist);
          if (f2) { this._placeOnFrame(car, f2, 0, 0); g.add(car); }
        }
      }

      // --- industry matching what the town ships
      const seen = new Set();
      let slot = 0;
      for (const cargo of st.produces || []) {
        const key = INDUSTRY[cargo];
        if (!key || seen.has(key) || key.startsWith('station')) continue;
        seen.add(key);
        const ind = this.assets.mesh(key, this.assets.materials.paint);
        const off = this._offsetSpot(node, fr, 46 + slot * 34, slot % 2 ? -1 : 1, rand);
        if (off) {
          ind.position.copy(off.pos);
          ind.rotation.y = off.rot;
          g.add(ind);
          slot++;
        }
      }
      // --- a warehouse or two for what the town consumes
      for (let i = 0; i < Math.min(2, (st.consumes || []).length); i++) {
        const wh = this.assets.mesh(i === 0 ? 'warehouse' : 'silo', this.assets.materials.paint);
        const off = this._offsetSpot(node, fr, 40 + i * 30 + slot * 20, i % 2 ? 1 : -1, rand);
        if (off) { wh.position.copy(off.pos); wh.rotation.y = off.rot; g.add(wh); }
      }

      // --- the town itself
      this._town(g, st, node, fr, rand);

      this.group.add(g);
      this.stationGroups.set(st.id, g);
      // register every child for streaming
      g.updateMatrixWorld(true);
      for (const child of g.children) {
        const p = child.getWorldPosition(new THREE.Vector3());
        const radius = child.name === 'person' ? PROP_RADIUS : TOWN_RADIUS;
        this.items.push({ obj: child, x: p.x, z: p.z, radius, parent: g });
      }
      this.items.push({ obj: g, x: node.x, z: node.z, radius: STATION_RADIUS, isStation: true });
    }
  }

  _branchForSiding(node, st) {
    const first = st.sidings?.[0]?.seg;
    const idx = first ? node.branches.findIndex((b) => b.seg === first) : 0;
    return idx >= 0 ? idx : 0;
  }

  /** Frame `dist` metres into a branch, measured from the node. */
  _frameAt(node, branchIndex, dist) {
    const br = node.branches[branchIndex];
    if (!br) return null;
    const state = this.net.stateAtNode(node.id, branchIndex, dist);
    return this.net.frame(state, {});
  }

  _frameAlong(seg, fromNode, dist) {
    const end = seg.a === fromNode.id ? 'a' : 'b';
    const state = this.net.makeState(seg.id, end === 'a' ? 0 : 1, end === 'a' ? 1 : -1);
    this.net.advance(state, dist);
    return this.net.frame(state, {});
  }

  /** A frame just inside `seg` at `node`, facing back toward the node — so a
   *  buffer stop or a signal presents its front to an arriving train. */
  _frameAtEnd(seg, node, back = 1.5) {
    const end = seg.a === node.id ? 'a' : 'b';
    const L = seg.length;
    const u = end === 'a' ? Math.min(0.985, back / L) : Math.max(0.015, 1 - back / L);
    const state = this.net.makeState(seg.id, u, end === 'a' ? -1 : 1);
    return this.net.frame(state, {});
  }

  _farNode(seg, node) {
    return seg.a === node.id ? seg.nodeB : seg.nodeA;
  }

  /** Drop a mesh onto a track frame at a given station and lateral offset. */
  _placeOnFrame(obj, fr, along, lateral) {
    obj.position.copy(fr.position)
      .addScaledVector(fr.forward, along)
      .addScaledVector(fr.right, lateral)
      .addScaledVector(fr.up, -0.2);
    const m = new THREE.Matrix4().makeBasis(fr.localX, fr.up, fr.forward);
    obj.quaternion.setFromRotationMatrix(m);
    return obj;
  }

  /** A flat-ish spot offset from the track, for buildings. */
  _offsetSpot(node, fr, distance, side, rand) {
    for (let attempt = 0; attempt < 14; attempt++) {
      const ang = (rand() - 0.5) * 1.5;
      const d = distance * (0.75 + rand() * 0.6);
      const base = fr ? fr.position : new THREE.Vector3(node.x, node.y, node.z);
      const right = fr ? fr.right : new THREE.Vector3(1, 0, 0);
      const fwd = fr ? fr.forward : new THREE.Vector3(0, 0, 1);
      const dir = new THREE.Vector3().addScaledVector(right, side * Math.cos(ang)).addScaledVector(fwd, Math.sin(ang)).normalize();
      const x = base.x + dir.x * d, z = base.z + dir.z * d;
      const y = this.groundY(x, z);
      if (y < 0.6) continue;                       // not in the water
      if (this.net.nearestCorridor(x, z, 30)) continue;  // not on the railway
      const slope = Math.hypot(this.groundY(x + 8, z) - this.groundY(x - 8, z), this.groundY(x, z + 8) - this.groundY(x, z - 8)) / 16;
      if (slope > 0.28) continue;                  // too steep to build on
      return { pos: new THREE.Vector3(x, y - 0.3, z), rot: Math.atan2(-dir.x, -dir.z) + (rand() - 0.5) * 0.5 };
    }
    return null;
  }

  _town(g, st, node, fr, rand) {
    const size = { 'City Terminus': 26, Port: 18, 'Market Town': 12, 'Mining Camp': 6, 'Mountain Halt': 4, 'Fishing Village': 8 }[st.type] || 8;
    for (let i = 0; i < size; i++) {
      const spot = this._offsetSpot(node, fr, 60 + i * 16, i % 2 ? 1 : -1, rand);
      if (!spot) continue;
      const house = this.assets.mesh('house', this.assets.materials.paint);
      house.position.copy(spot.pos);
      house.rotation.y = spot.rot;
      const s = 0.8 + rand() * 0.5;
      house.scale.setScalar(s);
      g.add(house);
    }
    // a few people on the platform
    if (fr) {
      for (let i = 0; i < 4; i++) {
        const person = this.assets.mesh('person', this.assets.materials.paint);
        person.name = 'person';
        this._placeOnFrame(person, fr, 4 + i * 7 - rand() * 4, 5.2 + rand() * 2.4);
        person.rotation.y += rand() * 6.28;
        g.add(person);
      }
    }
  }

  /* ------------------------------------------------ signals & buffer stops */
  _buildSignalsAndBuffers() {
    for (const node of this.net.nodes.values()) {
      if (node.kind === 'buffer' && !node.station) {
        for (const br of node.branches) {
          const seg = this.net.segments.get(br.seg);
          if (!seg) continue;
          const stop = this.assets.mesh('buffer_stop', this.assets.materials.paint);
          const f = this._frameAtEnd(seg, node);
          if (f) this._placeOnFrame(stop, f, 0, 0);
          this._add(stop, PROP_RADIUS);
        }
      }
      if (!node.switchable) continue;
      for (const br of node.branches) {
        const seg = this.net.segments.get(br.seg);
        if (!seg) continue;
        // signal on the approach: 34 m before the points, on the crew's right,
        // facing back down the line at the driver
        const f = this._frameAtEnd(seg, node, 34);
        const sig = this._makeSignal();
        this._placeOnFrame(sig.group, f, 0, 3.9);
        this._add(sig.group, PROP_RADIUS);
        this.signals.push({ ...sig, node, seg, end: br.end });
      }
    }
  }

  /** A signal post whose three lamps can be lit independently. */
  _makeSignal() {
    const group = new THREE.Group();
    const post = this.assets.mesh('signal_post', this.assets.materials.paint);
    group.add(post);
    const geo = new THREE.SphereGeometry(0.2, 8, 6);
    const lamps = {};
    const spec = { red: 4.95, yellow: 5.4, green: 5.85 };
    for (const [name, y] of Object.entries(spec)) {
      const m = new THREE.Mesh(geo, this.lampMat[name]);
      m.position.set(0, y, 0.24);
      group.add(m);
      lamps[name] = m;
    }
    return { group, lamps, aspect: 'red' };
  }

  setAspect(signal, aspect) {
    if (signal.aspect === aspect) return;
    signal.aspect = aspect;
    for (const [name, m] of Object.entries(signal.lamps)) {
      m.material = name === aspect ? this.lampMat[`${name}On`] : this.lampMat[name];
    }
  }

  /** Light signals from the current switch settings and track occupancy. */
  updateSignals(occupied = () => false) {
    for (const s of this.signals) {
      const routes = this.net.routesFrom(s.node, s.seg);
      const chosen = s.node.branches[Math.max(0, Math.min(s.node.branches.length - 1, s.node.active | 0))];
      const clear = routes.length > 0 && (routes.includes(chosen) || routes.length === 1);
      const blocked = occupied(s.node, chosen?.segment);
      this.setAspect(s, blocked ? 'red' : clear ? 'green' : 'yellow');
    }
  }

  /* ------------------------------------------------------------ landmarks */
  _buildLandmarks(landmarks) {
    for (const lm of landmarks || []) {
      const key = lm.kind;
      if (!this.assets.has(key)) continue;
      const mesh = this.assets.mesh(key, this.assets.materials.paint);
      const y = lm.y != null && Number.isFinite(lm.y) ? lm.y : this.groundY(lm.x, lm.z);
      mesh.position.set(lm.x, y - 1.2, lm.z);
      mesh.rotation.y = hashStr(lm.id) % 6.28;
      mesh.name = `landmark_${lm.id}`;
      this._add(mesh, STATION_RADIUS + 3000);
      if (lm.id === 'lighthouse') this.lighthouse = mesh;
    }
  }

  /* ------------------------------------------------------------- streaming */
  update(cameraPos) {
    let visible = 0;
    for (const it of this.items) {
      const d2 = (it.x - cameraPos.x) ** 2 + (it.z - cameraPos.z) ** 2;
      const on = d2 < it.radius * it.radius;
      if (it.isStation) {
        // the station group holds the big pieces; children stream individually
        if (it.obj.visible !== on) it.obj.visible = on;
        continue;
      }
      if (it.obj.visible !== on) it.obj.visible = on;
      if (on) visible++;
    }
    this.visibleCount = visible;
  }

  /** Station world position, for the map and the HUD compass. */
  stationPosition(id) {
    const st = this.stations.find((s) => s.id === id);
    const node = st && this.net.nodes.get(st.node);
    return node ? new THREE.Vector3(node.x, node.y, node.z) : null;
  }

  dispose() {
    this.group.traverse((o) => { if (o.isMesh) o.geometry?.dispose?.(); });
    this.group.removeFromParent();
    for (const m of Object.values(this.lampMat)) m.dispose();
  }
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h);
}

export default StructureManager;
