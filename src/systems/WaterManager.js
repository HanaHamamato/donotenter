/**
 * WaterManager — sea, tidal inlet, river and creek (GDD §4.4, §7 WaterManager).
 *
 * One shared shader: four summed sine waves displaced on the GPU, analytic
 * normals, a bed-depth texture for shallow/deep tinting and shore foam, sun
 * specular, and three's own fog chunks so water fades into the horizon exactly
 * like the land does. The sea plane follows the camera (snapped to the wave
 * period so the swell never swims); rivers are static ribbons swept from the
 * sampled courses in utils/terrain.
 */
import * as THREE from 'three';
import { WORLD } from '../constants.js';
import { buildWaterCourses, heightAt } from '../utils/terrain.js';

const VERT = /* glsl */`
uniform float uTime;
uniform float uAmp;
uniform vec2 uSnap;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vCrest;
#include <fog_pars_vertex>

vec3 wave(vec2 p, out float crest) {
  vec2 d1 = normalize(vec2(1.0, 0.35));
  vec2 d2 = normalize(vec2(-0.42, 1.0));
  vec2 d3 = normalize(vec2(0.8, -0.6));
  float k1 = 0.021, k2 = 0.047, k3 = 0.11, k4 = 0.23;
  float a1 = 1.00 * uAmp, a2 = 0.52 * uAmp, a3 = 0.20 * uAmp, a4 = 0.09 * uAmp;
  float t = uTime;
  float p1 = dot(p, d1) * k1 + t * 0.9;
  float p2 = dot(p, d2) * k2 - t * 1.25;
  float p3 = dot(p, d3) * k3 + t * 1.9;
  float p4 = dot(p, d2) * k4 - t * 2.6;
  float h = a1 * sin(p1) + a2 * sin(p2) + a3 * sin(p3) + a4 * sin(p4);
  // analytic gradient -> normal
  vec3 g = d1 * (a1 * k1 * cos(p1)) + d2 * (a2 * k2 * cos(p2) + a4 * k4 * cos(p4))
         + d3 * (a3 * k3 * cos(p3));
  vNormal = normalize(vec3(-g.x, 1.0, -g.y));
  crest = clamp((h / max(0.001, (a1 + a2 + a3 + a4))) * 0.5 + 0.5, 0.0, 1.0);
  return vec3(p.x, h, p.y);
}

void main() {
  vec3 pos = position;
  // geometry is authored in the XZ plane at y=0, pre-snapped by the CPU
  float crest;
  vec3 w = wave(pos.xz + uSnap, crest);
  pos.y += w.y;
  vCrest = crest;
  vec4 world = modelMatrix * vec4(pos, 1.0);
  vWorld = world.xyz;
  vec4 mvPosition = viewMatrix * world;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */`
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uSky;
uniform float uOpacity;
uniform float uFoam;
uniform sampler2D uBed;
uniform vec2 uBedExtent;   // half-size of the bed texture in metres
uniform float uLevel;
uniform float uTime;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vCrest;
#include <fog_pars_fragment>

void main() {
  // bed depth from the coarse height texture
  vec2 uv = clamp(vWorld.xz / (uBedExtent * 2.0) + 0.5, 0.0, 1.0);
  float bed = texture2D(uBed, uv).r * 512.0 - 256.0;
  float depth = max(0.0, uLevel - bed);
  float shallowT = 1.0 - clamp(depth / 9.0, 0.0, 1.0);

  vec3 N = normalize(vNormal);
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 L = normalize(uSunDir);

  float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.2);
  vec3 col = mix(uDeep, uShallow, shallowT * 0.85);
  col = mix(col, uSky, clamp(fres * 0.85, 0.0, 0.9));

  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), 220.0) * 1.6 + pow(max(dot(N, H), 0.0), 28.0) * 0.18;
  col += uSunColor * spec * (1.0 - shallowT * 0.3);

  // shore foam and whitecaps
  float foam = smoothstep(0.86, 1.0, vCrest) * 0.55;
  foam += (1.0 - smoothstep(0.0, 1.6, depth)) * uFoam * (0.55 + 0.45 * sin(vWorld.x * 0.7 + uTime * 2.2) * sin(vWorld.z * 0.6 - uTime * 1.7));
  col = mix(col, vec3(0.92, 0.95, 0.96), clamp(foam, 0.0, 0.85));

  float alpha = clamp(uOpacity + fres * 0.25 + foam * 0.3, 0.0, 1.0);
  gl_FragColor = vec4(col, alpha);
  #include <fog_fragment>
}
`;

export class WaterManager {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'water';
    scene.add(this.group);

    this.bedSize = opts.bedSize || 128;
    this.bed = this._buildBedTexture(this.bedSize);
    this.level = WORLD.seaLevel;
    this.tideRange = 0.85;
    this.time = 0;
    this.amp = 1;

    this.uniforms = {
      uTime: { value: 0 },
      uAmp: { value: 0.42 },
      uSnap: { value: new THREE.Vector2(0, 0) },
      uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.3) },
      uSunColor: { value: new THREE.Color(0xfff2d8) },
      uShallow: { value: new THREE.Color(0x4f8f8a) },
      uDeep: { value: new THREE.Color(0x12303c) },
      uSky: { value: new THREE.Color(0x9dc4dd) },
      uOpacity: { value: 0.86 },
      uFoam: { value: 0.7 },
      uBed: { value: this.bed },
      uBedExtent: { value: new THREE.Vector2(WORLD.half, WORLD.half) },
      uLevel: { value: 0 },
      fogColor: { value: new THREE.Color(0xcfd8dd) },
      fogDensity: { value: 0.0003 },
      fogNear: { value: 1 },
      fogFar: { value: 6000 },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      fog: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    this.sea = this._buildSea(opts.seaSize || 26000, opts.seaSegments || 96);
    this.group.add(this.sea);
    this.courses = [];
    this._buildCourses();
    this.visible = true;
  }

  /** Coarse terrain-height texture so the shader knows how deep it is. */
  _buildBedTexture(n) {
    const data = new Uint8Array(n * n);
    const half = WORLD.half;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * half * 2 - half;
        const z = (j / (n - 1)) * half * 2 - half;
        const h = heightAt(x, z);
        data[j * n + i] = Math.max(0, Math.min(255, Math.round(((h + 256) / 512) * 255)));
      }
    }
    const tex = new THREE.DataTexture(data, n, n, THREE.RedFormat);
    tex.needsUpdate = true;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  }

  _buildSea(size, seg) {
    const geo = new THREE.PlaneGeometry(size, size, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.name = 'sea';
    mesh.renderOrder = 2;
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = true;
    return mesh;
  }

  /** River / creek / inlet ribbons, swept from the sampled courses. */
  _buildCourses() {
    const courses = buildWaterCourses(40);
    for (const c of courses) {
      const pts = c.points;
      if (pts.length < 2) continue;
      const positions = [], uvs = [], index = [];
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
        let dx = b.x - a.x, dz = b.z - a.z;
        const len = Math.hypot(dx, dz) || 1;
        dx /= len; dz /= len;
        const nx = -dz, nz = dx;
        const w = Math.max(3, p.width) * 0.5;
        positions.push(p.x + nx * w, p.y, p.z + nz * w, p.x - nx * w, p.y, p.z - nz * w);
        uvs.push(0, i / 8, 1, i / 8);
        if (i < pts.length - 1) {
          const k = i * 2;
          index.push(k, k + 1, k + 3, k, k + 3, k + 2);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geo.setIndex(index);
      geo.computeVertexNormals();
      geo.computeBoundingSphere();
      const mat = this.material.clone();
      mat.uniforms = THREE.UniformsUtils.clone(this.uniforms);
      mat.uniforms.uAmp.value = 0.06;
      mat.uniforms.uBed.value = this.bed;
      mat.uniforms.uOpacity.value = 0.9;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `water_${c.id}`;
      mesh.renderOrder = 2;
      this.group.add(mesh);
      this.courses.push({ id: c.id, mesh, mat, level: c.level ?? 0, points: pts });
    }
  }

  /** Sea level including the tide; rivers keep their own surveyed level. */
  setTide(dayFraction) {
    this.level = WORLD.seaLevel + Math.sin(dayFraction * Math.PI * 2) * this.tideRange;
    this.uniforms.uLevel.value = this.level;
    this.sea.position.y = this.level;
    for (const c of this.courses) {
      if (c.level === 0) { // tidal
        c.mesh.position.y = this.level;
        c.mat.uniforms.uLevel.value = this.level;
      } else {
        c.mat.uniforms.uLevel.value = c.level;
      }
    }
  }

  setWeather(weather) {
    const w = weather || 'clear';
    const amp = { clear: 0.34, cloudy: 0.5, rain: 0.72, storm: 1.15, fog: 0.24, snow: 0.3 }[w] ?? 0.4;
    this.uniforms.uAmp.value = amp;
    const shallow = { clear: 0x4f8f8a, cloudy: 0x4a7d80, rain: 0x3d6a70, storm: 0x2f555c, fog: 0x6d8b8b, snow: 0x7fa3a8 }[w] ?? 0x4f8f8a;
    this.uniforms.uShallow.value.setHex(shallow);
    for (const c of this.courses) { c.mat.uniforms.uAmp.value = amp * 0.16; c.mat.uniforms.uShallow.value.setHex(shallow); }
  }

  update(dt, camera, sun) {
    this.time += dt;
    this.uniforms.uTime.value = this.time;
    if (sun) {
      this.uniforms.uSunDir.value.copy(sun.direction);
      this.uniforms.uSunColor.value.copy(sun.color);
      this.uniforms.uSky.value.copy(sun.skyColor || sun.color);
    }
    // follow the camera, snapped so the swell stays put in world space
    if (camera) {
      const snap = 8;
      const sx = Math.round(camera.position.x / snap) * snap;
      const sz = Math.round(camera.position.z / snap) * snap;
      this.sea.position.x = sx;
      this.sea.position.z = sz;
      // local vertex + this offset == world position the swell is computed at
      this.uniforms.uSnap.value.set(sx, sz);
    }
    for (const c of this.courses) {
      c.mat.uniforms.uTime.value = this.time;
      if (sun) {
        c.mat.uniforms.uSunDir.value.copy(sun.direction);
        c.mat.uniforms.uSunColor.value.copy(sun.color);
        c.mat.uniforms.uSky.value.copy(sun.skyColor || sun.color);
      }
    }
  }

  setFog(color, density) {
    this.uniforms.fogColor.value.copy(color);
    this.uniforms.fogDensity.value = density;
    for (const c of this.courses) {
      c.mat.uniforms.fogColor.value.copy(color);
      c.mat.uniforms.fogDensity.value = density;
    }
  }

  /** Water surface height at a world point, or null if there is none. */
  levelAt(x, z) {
    return this.level;
  }

  triangleCount() {
    let t = 0;
    this.group.traverse((o) => { if (o.isMesh) t += (o.geometry.index?.count || 0) / 3; });
    return Math.round(t);
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.isMesh) { o.geometry.dispose(); o.material.dispose?.(); }
    });
    this.bed.dispose();
    this.material.dispose();
    this.group.removeFromParent();
  }
}

export default WaterManager;
