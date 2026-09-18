import * as THREE from 'three';
import { MODE_THEME, PALETTE } from './palette.js';
import { EARTH_RADIUS, llaToVec3, vec3ToLatLon } from './coords.js';
import EarthLayer from './layers/earth.js';
import SatelliteLayer from './layers/satellite.js';
import SwathLayer from './layers/swath.js';
import MarkerLayer from './layers/markers.js';
import BloomFieldLayer from './layers/bloomField.js';

/**
 * OrbitalSentinelGlobe — the 3D map.
 *
 * Renders only. It owns no mission state, fetches nothing, and draws no UI
 * chrome; a host application feeds it telemetry and it draws the
 * consequences. That separation is what lets the same module sit behind an
 * LCARS console, a bare debug page, or an automated screenshot test.
 *
 *   const globe = new OrbitalSentinelGlobe(container);
 *   await globe.init(bootstrapPayload);
 *   globe.applyTelemetry(mapFrame);    // every tick
 *   globe.setMode('ACTIVE');           // on mode change
 *
 * Mode changes are eased, never snapped: `_theme` chases `_targetTheme`
 * every frame, which is the 3D equivalent of a CSS transition and stops the
 * scene popping when the timeline slider crosses a segment boundary.
 */
export class OrbitalSentinelGlobe {
  constructor(container, options = {}) {
    if (!container) throw new Error('OrbitalSentinelGlobe: container element required');
    this.container = container;
    this.options = {
      autoRotate: true,
      autoRotateSpeed: 0.012,
      followSatellite: false,
      cameraDistance: 3.1,
      pixelRatioCap: 2,
      ...options,
    };

    this.mode = 'SUN_FACING';
    this._theme = { ...MODE_THEME.SUN_FACING };
    this._targetTheme = { ...MODE_THEME.SUN_FACING };
    this._clock = new THREE.Clock();
    this._elapsed = 0;
    this._running = false;
    this._listeners = new Map();

    this._initRenderer();
    this._initScene();
  }

  // -- setup ----------------------------------------------------------------
  _initRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true, alpha: false, powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.options.pixelRatioCap));
    this.renderer.setClearColor(PALETTE.void, 1);
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.container.appendChild(this.renderer.domElement);
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.scene.fog = null;

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.01, 100);
    this.camera.position.set(0, 0.9, this.options.cameraDistance);

    this.world = new THREE.Group();
    this.scene.add(this.world);

    this.earth = new EarthLayer();
    this.satellite = new SatelliteLayer();
    this.swath = new SwathLayer();
    this.markers = new MarkerLayer();
    this.bloom = new BloomFieldLayer();

    this.world.add(this.satellite.group, this.swath.group, this.markers.group, this.bloom.group);
    this._addStarfield();

    this._orbit = { theta: 0.6, phi: 1.15, radius: this.options.cameraDistance };
    this._bindInteraction();
    this._bindResize();
  }

  _addStarfield(count = 1400) {
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      const v = new THREE.Vector3(
        Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1,
      ).normalize().multiplyScalar(40 + Math.random() * 20);
      pos.set([v.x, v.y, v.z], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.stars = new THREE.Points(g, new THREE.PointsMaterial({
      color: PALETTE.white, size: 0.09, sizeAttenuation: true,
      transparent: true, opacity: 0.55,
    }));
    this.stars.name = 'starfield';
    this.scene.add(this.stars);
  }

  /** Feed the payload from GET /api/map/bootstrap. */
  async init(bootstrap = {}) {
    await this.earth.build();
    this.world.add(this.earth.group);

    if (bootstrap.ground_track) this.satellite.setGroundTrack(bootstrap.ground_track);
    if (bootstrap.markers) this.markers.setMarkers(bootstrap.markers);
    if (bootstrap.aoi?.bbox) {
      this.markers.setAOI(bootstrap.aoi.bbox);
      this.bloom.setBBox(bootstrap.aoi.bbox);
      this.aoiCenter = bootstrap.aoi.center;
    }
    if (bootstrap.payload?.swath_km) this.swath.setWidthKm(bootstrap.payload.swath_km);
    if (bootstrap.initial) {
      this.setMode(bootstrap.initial.mode, { immediate: true });
      if (bootstrap.initial.subsatellite) this.satellite.update(bootstrap.initial.subsatellite);
    }
    this.resize();
    this.start();
    return this;
  }

  // -- state in -------------------------------------------------------------
  /**
   * Apply one `map` frame from the telemetry WebSocket (or the equivalent
   * REST payload). Everything is optional — partial frames are fine.
   */
  applyTelemetry(frame = {}) {
    if (frame.mode && frame.mode !== this.mode) this.setMode(frame.mode);
    if (frame.subsatellite) this.satellite.update(frame.subsatellite, 0.34);
    if (frame.scan_line) this.swath.updateScan(frame.scan_line, this.satellite.position);
    if (frame.track_ahead) this.satellite.setTrackAhead(frame.track_ahead);
    if ('swath_covered' in frame) this.swath.updateCovered(frame.swath_covered);
    if (frame.slider != null) this.earth.setSunFromSlider(frame.slider);
    if (frame.over_aoi != null) this._overAOI = frame.over_aoi;
    return this;
  }

  /** Apply the science payload (water quality + Chl-a field). */
  applyScience({ water_quality: wq, field } = {}) {
    if (wq) this.markers.applyWaterQuality(wq);
    if (field) this.bloom.setField(field);
    return this;
  }

  /** Switch operational mode. Eased unless `immediate`. */
  setMode(mode, { immediate = false } = {}) {
    const theme = MODE_THEME[mode];
    if (!theme) return this;
    const previous = this.mode;
    this.mode = mode;
    this._targetTheme = { ...theme };
    if (immediate) this._theme = { ...theme };
    this._emit('mode', { from: previous, to: mode });
    return this;
  }

  // -- camera ---------------------------------------------------------------
  /** Fly the camera to look at a lat/lon. Used when ACTIVE mode starts. */
  focusOn(lat, lon, { distance = 2.1, duration = 1200 } = {}) {
    const target = llaToVec3(lat, lon, 0).normalize();
    const phi = Math.acos(target.y);
    const theta = Math.atan2(target.z, -target.x);
    this._cameraTween = {
      from: { ...this._orbit },
      to: { theta, phi, radius: distance },
      start: performance.now(),
      duration,
    };
    return this;
  }

  focusAOI(opts) {
    if (this.aoiCenter) this.focusOn(this.aoiCenter.lat, this.aoiCenter.lon, opts);
    return this;
  }

  resetView({ duration = 900 } = {}) {
    this._cameraTween = {
      from: { ...this._orbit },
      to: { theta: 0.6, phi: 1.15, radius: this.options.cameraDistance },
      start: performance.now(),
      duration,
    };
    return this;
  }

  _bindInteraction() {
    const el = this.renderer.domElement;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    const down = (e) => {
      dragging = true;
      this._cameraTween = null;
      lastX = e.clientX ?? e.touches?.[0]?.clientX ?? 0;
      lastY = e.clientY ?? e.touches?.[0]?.clientY ?? 0;
    };
    const move = (e) => {
      if (!dragging) return;
      const x = e.clientX ?? e.touches?.[0]?.clientX ?? 0;
      const y = e.clientY ?? e.touches?.[0]?.clientY ?? 0;
      this._orbit.theta -= (x - lastX) * 0.005;
      this._orbit.phi = Math.max(0.12, Math.min(Math.PI - 0.12, this._orbit.phi - (y - lastY) * 0.005));
      lastX = x; lastY = y;
      this._userInteracted = true;
    };
    const up = () => { dragging = false; };

    el.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this._cameraTween = null;
      this._orbit.radius = Math.max(1.28, Math.min(8, this._orbit.radius + e.deltaY * 0.0016));
    }, { passive: false });

    // Click-to-pick: returns a lat/lon so a host can request a spectrum there.
    el.addEventListener('click', (e) => {
      const rect = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, this.camera);
      const hit = ray.intersectObject(this.earth.sphere, false)[0];
      if (hit) this._emit('pick', vec3ToLatLon(hit.point));
    });

    this._cleanupInteraction = () => {
      el.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }

  _bindResize() {
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(this.container);
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    return this;
  }

  // -- loop -----------------------------------------------------------------
  start() {
    if (this._running) return this;
    this._running = true;
    this._clock.start();
    const loop = () => {
      if (!this._running) return;
      this._raf = requestAnimationFrame(loop);
      this._frame();
    };
    loop();
    return this;
  }

  stop() {
    this._running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    return this;
  }

  _frame() {
    const dt = Math.min(0.1, this._clock.getDelta());
    this._elapsed += dt;

    this._easeTheme(dt);
    this._updateCamera(dt);

    const camDist = this.camera.position.length();
    this.satellite.setScreenScale(camDist);
    this.markers.setScreenScale(camDist);

    this.earth.setTheme(this._theme);
    this.satellite.setTheme(this._theme, this._elapsed);
    this.swath.setTheme(this._theme, this._elapsed);
    this.markers.setTheme(this._theme, this._elapsed);
    this.bloom.setTheme(this._theme, this._elapsed);
    if (this.stars) this.stars.material.opacity = 0.25 + 0.4 * this._theme.exposure;

    this.renderer.render(this.scene, this.camera);
  }

  /** Exponential smoothing: the 3D analogue of a CSS ease-out transition. */
  _easeTheme(dt) {
    const k = 1 - Math.exp(-dt * 3.2);
    for (const key of ['exposure', 'terminatorGlow', 'swathOpacity', 'trackOpacity', 'pulseHz']) {
      this._theme[key] += (this._targetTheme[key] - this._theme[key]) * k;
    }
    this._theme.satelliteColor = this._targetTheme.satelliteColor;
    this._theme.key = this._targetTheme.key;
    this._theme.accent = this._targetTheme.accent;
  }

  _updateCamera(dt) {
    if (this._cameraTween) {
      const { from, to, start, duration } = this._cameraTween;
      const t = Math.min(1, (performance.now() - start) / duration);
      const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;   // easeInOutQuad
      this._orbit.theta = from.theta + (to.theta - from.theta) * e;
      this._orbit.phi = from.phi + (to.phi - from.phi) * e;
      this._orbit.radius = from.radius + (to.radius - from.radius) * e;
      if (t >= 1) this._cameraTween = null;
    } else if (this.options.followSatellite && this.satellite.position.lengthSq() > 0) {
      const ll = vec3ToLatLon(this.satellite.position);
      const target = llaToVec3(ll.lat, ll.lon, 0).normalize();
      const phi = Math.acos(target.y);
      const theta = Math.atan2(target.z, -target.x);
      const k = 1 - Math.exp(-dt * 1.4);
      this._orbit.theta += (theta - this._orbit.theta) * k;
      this._orbit.phi += (phi - this._orbit.phi) * k;
    } else if (this.options.autoRotate && !this._userInteracted) {
      this._orbit.theta += dt * this.options.autoRotateSpeed;
    }

    const { theta, phi, radius } = this._orbit;
    this.camera.position.set(
      -radius * Math.sin(phi) * Math.cos(theta),
      radius * Math.cos(phi),
      radius * Math.sin(phi) * Math.sin(theta),
    );
    this.camera.lookAt(0, 0, 0);
  }

  // -- events ---------------------------------------------------------------
  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this._listeners.get(event)?.delete(fn);
  }

  _emit(event, payload) {
    for (const fn of this._listeners.get(event) ?? []) fn(payload);
  }

  dispose() {
    this.stop();
    this._ro?.disconnect();
    this._cleanupInteraction?.();
    this.earth.dispose();
    this.satellite.dispose();
    this.swath.dispose();
    this.markers.dispose();
    this.bloom.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

export const EARTH_R = EARTH_RADIUS;
export default OrbitalSentinelGlobe;
