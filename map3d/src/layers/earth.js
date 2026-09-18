import * as THREE from 'three';
import { PALETTE } from '../palette.js';
import { EARTH_RADIUS, llaToVec3 } from '../coords.js';

const DATA_BASE = new URL('../data/', import.meta.url);

async function loadJSON(name) {
  const res = await fetch(new URL(name, DATA_BASE));
  if (!res.ok) throw new Error(`map3d: cannot load ${name} (${res.status})`);
  return res.json();
}

/**
 * The globe itself: a dark ocean sphere, wireframe coastlines, a graticule,
 * an atmospheric rim, and a day/night terminator driven by a sun direction.
 *
 * No image textures — the coastlines are vector data baked into the module,
 * so the whole thing works offline and stays sharp at any zoom.
 */
export class EarthLayer {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'earth';
    this.uniforms = {
      uSunDir: { value: new THREE.Vector3(1, 0.2, 0.3).normalize() },
      uTerminator: { value: 0.6 },
      uOcean: { value: new THREE.Color(PALETTE.ocean) },
      uLand: { value: new THREE.Color(PALETTE.land) },
      uRim: { value: new THREE.Color(PALETTE.cyan) },
      uExposure: { value: 1.0 },
    };
  }

  async build() {
    this._buildSphere();
    this._buildGraticule();
    this._buildAtmosphere();
    await this._buildCoastlines();
    return this.group;
  }

  _buildSphere() {
    const geo = new THREE.SphereGeometry(EARTH_RADIUS * 0.999, 96, 64);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        varying vec3 vNormalW;
        void main() {
          vNormalW = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uSunDir; uniform vec3 uOcean; uniform vec3 uRim;
        uniform float uTerminator; uniform float uExposure;
        varying vec3 vNormalW;
        void main() {
          float ndl = dot(normalize(vNormalW), normalize(uSunDir));
          // Soft terminator: a hard line looks like a bug, not a planet.
          float day = smoothstep(-0.14, 0.26, ndl);
          vec3 night = uOcean * 0.32;
          vec3 lit = uOcean * (0.55 + 0.85 * day);
          vec3 col = mix(night, lit, day * uTerminator + (1.0 - uTerminator) * 0.35);
          // Grazing-angle cyan wash at the limb.
          float limb = pow(1.0 - abs(ndl), 3.0);
          col += uRim * limb * 0.06;
          gl_FragColor = vec4(col * uExposure, 1.0);
        }`,
    });
    this.sphere = new THREE.Mesh(geo, mat);
    this.sphere.name = 'earth-surface';
    this.group.add(this.sphere);
  }

  _buildAtmosphere() {
    const geo = new THREE.SphereGeometry(EARTH_RADIUS * 1.035, 64, 48);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      side: THREE.BackSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        varying vec3 vNormalW; varying vec3 vViewDir;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vNormalW = normalize(mat3(modelMatrix) * normal);
          vViewDir = normalize(cameraPosition - wp.xyz);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uRim; uniform vec3 uSunDir; uniform float uExposure;
        varying vec3 vNormalW; varying vec3 vViewDir;
        void main() {
          float rim = pow(1.0 - abs(dot(vNormalW, vViewDir)), 2.4);
          float sun = smoothstep(-0.5, 0.6, dot(vNormalW, normalize(uSunDir)));
          gl_FragColor = vec4(uRim * rim * (0.25 + 0.75 * sun) * uExposure, rim * 0.85);
        }`,
    });
    this.atmosphere = new THREE.Mesh(geo, mat);
    this.atmosphere.name = 'atmosphere';
    this.group.add(this.atmosphere);
  }

  _buildGraticule(stepDeg = 15) {
    const pts = [];
    const push = (a, b) => { pts.push(a.x, a.y, a.z, b.x, b.y, b.z); };
    const v = (lat, lon) => llaToVec3(lat, lon, 4);

    for (let lat = -75; lat <= 75; lat += stepDeg) {
      for (let lon = -180; lon < 180; lon += 5) push(v(lat, lon), v(lat, lon + 5));
    }
    for (let lon = -180; lon < 180; lon += stepDeg) {
      for (let lat = -85; lat < 85; lat += 5) push(v(lat, lon), v(lat + 5, lon));
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.graticule = new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({
        color: PALETTE.grid, transparent: true, opacity: 0.22, depthWrite: false,
      }),
    );
    this.graticule.name = 'graticule';
    this.group.add(this.graticule);
  }

  async _buildCoastlines() {
    const [coast, gulf] = await Promise.all([
      loadJSON('coastlines.json'),
      loadJSON('gulf-countries.json'),
    ]);

    const toSegments = (rings, altKm) => {
      const pts = [];
      for (const ring of rings) {
        for (let i = 1; i < ring.length; i += 1) {
          const [lon0, lat0] = ring[i - 1];
          const [lon1, lat1] = ring[i];
          if (Math.abs(lon1 - lon0) > 170) continue;   // antimeridian wrap
          const a = llaToVec3(lat0, lon0, altKm);
          const b = llaToVec3(lat1, lon1, altKm);
          pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      return g;
    };

    this.coastlines = new THREE.LineSegments(
      toSegments(coast.rings, 6),
      new THREE.LineBasicMaterial({ color: PALETTE.cyan, transparent: true, opacity: 0.55 }),
    );
    this.coastlines.name = 'coastlines';
    this.group.add(this.coastlines);

    // Gulf states drawn brighter: this is the mission's operating theatre.
    const gulfRings = [];
    const uaeRings = [];
    for (const [code, entry] of Object.entries(gulf.countries || {})) {
      (code === 'ARE' ? uaeRings : gulfRings).push(...entry.rings);
    }
    this.gulfBorders = new THREE.LineSegments(
      toSegments(gulfRings, 9),
      new THREE.LineBasicMaterial({ color: PALETTE.cyan, transparent: true, opacity: 0.35 }),
    );
    this.gulfBorders.name = 'gulf-borders';
    this.group.add(this.gulfBorders);

    this.uaeOutline = new THREE.LineSegments(
      toSegments(uaeRings, 13),
      new THREE.LineBasicMaterial({ color: PALETTE.amber, transparent: true, opacity: 0.95 }),
    );
    this.uaeOutline.name = 'uae-outline';
    this.group.add(this.uaeOutline);
  }

  /** Sun direction from the loop phase — drives the terminator sweep. */
  setSunFromSlider(slider) {
    const a = slider * Math.PI * 2;
    this.uniforms.uSunDir.value.set(Math.cos(a), 0.34, Math.sin(a)).normalize();
  }

  setTheme(theme) {
    this.uniforms.uExposure.value = theme.exposure;
    this.uniforms.uTerminator.value = theme.terminatorGlow;
    if (this.coastlines) this.coastlines.material.opacity = 0.18 + 0.42 * theme.exposure;
    if (this.uaeOutline) this.uaeOutline.material.opacity = 0.35 + 0.6 * theme.exposure;
    if (this.graticule) this.graticule.material.opacity = 0.08 + 0.18 * theme.exposure;
  }

  dispose() {
    this.group.traverse((o) => {
      o.geometry?.dispose?.();
      o.material?.dispose?.();
    });
  }
}

export default EarthLayer;
