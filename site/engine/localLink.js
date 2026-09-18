/**
 * LocalLink — the in-browser replacement for the Node gateway.
 *
 * Exposes the same surface as `map3d/src/client.js`'s SentinelLink (the same
 * channels, the same event names, the same method signatures), but instead of
 * a WebSocket it runs the ported mission engine directly on a local clock.
 * That is what lets the whole console be a static site on GitHub Pages while
 * the 3D globe module stays completely unaware of where its data comes from.
 *
 * Channels: state | map | downlink | event   (plus ':mode', ':alerts', …)
 */
import * as mission from './mission.js';
import * as downlink from './downlink.js';
import { algaeField } from './science.js';
import { AOI, LOOP_DURATION_S } from './config.js';

const LINES_PER_TICK = { ECLIPSE: 1, SUN_FACING: 2, ACTIVE: 4 };

export class LocalLink {
  constructor({ tickHz = 5, rate = 1, playing = true, logBuffer = 400 } = {}) {
    this.tickHz = tickHz;
    this.rate = rate;
    this.playing = playing;
    this.loopDurationS = LOOP_DURATION_S;
    this.loopT = 0;
    this.frame = 0;
    this.seq = 0;
    this.log = [];
    this.logBuffer = logBuffer;
    this.lastMode = null;
    this.lastAlertKey = '';
    this.connected = false;
    this._scrubbing = false;
    this._listeners = new Map();
    this._timer = null;
    this._cache = new Map();          // quantised slider -> snapshot
    this._quantum = 1 / 900;
    this._lastRealMs = 0;
  }

  get slider() {
    return Number((this.loopT / this.loopDurationS).toFixed(6));
  }

  // -- state access ---------------------------------------------------------
  /**
   * Memoised snapshot.
   *
   * The engine is a pure function of the slider, so a quantised slider value
   * is a perfect cache key with no invalidation problem. Scrubbing back and
   * forth in front of an audience costs nothing after the first pass.
   *
   * The desalination schedule is excluded from the cache key deliberately —
   * it depends on the wall clock hour, not the slider — so it is recomputed
   * on the snapshots that need it.
   */
  snapshot(slider = this.slider, opts = {}) {
    const key = `${Math.round(slider / this._quantum)}:${opts.includeSchedule === false ? 0 : 1}`;
    const hit = this._cache.get(key);
    if (hit) return hit;
    const value = mission.snapshot(slider, opts);
    this._cache.set(key, value);
    if (this._cache.size > 1400) this._cache.delete(this._cache.keys().next().value);
    return value;
  }

  // -- REST-shaped helpers (same names as SentinelLink) ----------------------
  async health() {
    return { status: 'ok', service: 'browser-engine', version: '1.0.0', offline: true };
  }

  async missionConfig() { return mission.missionConfig(); }

  async bootstrap(slider = this.slider) {
    const cfg = mission.missionConfig();
    const state = this.snapshot(slider, { includeSchedule: false });
    return {
      aoi: cfg.aoi,
      markers: state.map.markers,
      ground_track: state.map.ground_track,
      orbit: cfg.spacecraft.orbit,
      payload: cfg.spacecraft.payload,
      modes: cfg.timeline,
      initial: {
        slider,
        mode: state.mode.id,
        subsatellite: state.map.subsatellite,
        scan_line: state.map.scan_line,
      },
    };
  }

  async state(slider = this.slider) { return this.snapshot(slider); }
  async timeline(samples = 90) { return mission.timeline(samples); }

  async spectrum({ lat, lon, slider = this.slider, bands = 96 } = {}) {
    const loopT = mission.sliderToLoopT(slider);
    if (lat == null || lon == null) {
      const s = this.snapshot(slider, { includeSchedule: false });
      ({ lat, lon } = s.map.subsatellite);
    }
    const { spectrum } = await import('./science.js');
    return spectrum(lat, lon, loopT, bands);
  }

  async field(slider = this.slider, nx = 64, ny = 32) {
    return algaeField(AOI.bbox, mission.sliderToLoopT(slider), nx, ny);
  }

  async desalination(slider = this.slider) { return this.snapshot(slider).desalination; }
  async recentLog(limit = 80) { return { lines: this.log.slice(-limit) }; }

  // -- control --------------------------------------------------------------
  seek(slider) {
    this.loopT = Math.max(0, Math.min(1, Number(slider))) * this.loopDurationS;
    this._emit('event', { channel: 'event', type: 'seek', slider: this.slider });
    this._tickNow();
    return this.slider;
  }

  setSlider(slider) { return this.seek(slider); }

  setMode(mode) {
    const s = mission.modeToSlider(mode);
    this.seek(s);
    return { mode, slider: s };
  }

  scrub(active) {
    this._scrubbing = Boolean(active);
    this._emit('event', { channel: 'event', type: 'transport', transport: this.transport() });
  }

  setTransport({ playing, rate } = {}) {
    if (playing !== undefined) this.playing = Boolean(playing);
    if (rate !== undefined) this.rate = Math.max(0, Math.min(20, Number(rate) || 0));
    this._emit('event', { channel: 'event', type: 'transport', transport: this.transport() });
    return this.transport();
  }

  transport() {
    return {
      playing: this.playing,
      scrubbing: this._scrubbing,
      rate: this.rate,
      tickHz: this.tickHz,
      slider: this.slider,
      loopT: Number(this.loopT.toFixed(3)),
      loopDurationS: this.loopDurationS,
      frame: this.frame,
    };
  }

  // -- loop -----------------------------------------------------------------
  async connect() {
    this.connected = true;
    this._emit('event', {
      channel: 'event',
      type: 'hello',
      channels: ['state', 'map', 'downlink', 'event'],
      transport: this.transport(),
      backlog: this.log.slice(-40),
      engine: 'in-browser',
    });
    this._lastRealMs = performance.now();
    this._timer = setInterval(() => this._tick(), 1000 / this.tickHz);
    this._tickNow();
    return this;
  }

  disconnect() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this.connected = false;
  }

  _tick() {
    const now = performance.now();
    const dt = Math.min(0.5, (now - this._lastRealMs) / 1000);
    this._lastRealMs = now;
    if (this.playing && !this._scrubbing) {
      this.loopT = (this.loopT + dt * this.rate) % this.loopDurationS;
    }
    this.frame += 1;
    this._publish();
  }

  /** Publish immediately without advancing the clock (used after a seek). */
  _tickNow() {
    this.frame += 1;
    this._publish();
  }

  _publish() {
    const slider = this.slider;
    const state = this.snapshot(slider);
    const mode = state.mode.id;

    this._emit('map', {
      channel: 'map',
      type: 'map',
      slider,
      mode,
      subsatellite: state.map.subsatellite,
      heading_deg: state.map.heading_deg,
      scan_line: state.map.scan_line,
      swath_covered: state.map.swath_covered,
      track_ahead: state.map.track_ahead,
      over_aoi: state.map.aoi.over_aoi,
      range_to_center_km: state.map.aoi.range_to_center_km,
    });

    this._emit('state', { channel: 'state', type: 'state', slider, state });

    const n = LINES_PER_TICK[mode] ?? 2;
    if (n > 0) {
      const lines = downlink.build(state, n, this.frame);
      for (const l of lines) { l.seq = this.seq++; this.log.push(l); }
      if (this.log.length > this.logBuffer) {
        this.log.splice(0, this.log.length - this.logBuffer);
      }
      this._emit('downlink', { channel: 'downlink', type: 'downlink', mode, lines });
    }

    if (mode !== this.lastMode) {
      const previous = this.lastMode;
      this.lastMode = mode;
      this._emit('event', {
        channel: 'event',
        type: 'mode',
        from: previous,
        to: mode,
        label: state.mode.label,
        banner: state.mode.banner,
        ui_flags: state.mode.ui_flags,
      });
    }

    const alertKey = state.alerts.map((a) => a.code).join('|');
    if (alertKey !== this.lastAlertKey) {
      this.lastAlertKey = alertKey;
      this._emit('event', { channel: 'event', type: 'alerts', alerts: state.alerts });
    }
  }

  // -- events ---------------------------------------------------------------
  /** Channels: state | map | downlink | event. Message types prefix with ':'. */
  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this._listeners.get(event)?.delete(fn);
  }

  _emit(channel, payload) {
    const frame = { t: Date.now(), ...payload };
    for (const fn of this._listeners.get(channel) ?? []) {
      try { fn(frame); } catch (err) { console.error('[LocalLink]', channel, err); }
    }
    if (frame.type) {
      for (const fn of this._listeners.get(`:${frame.type}`) ?? []) {
        try { fn(frame); } catch (err) { console.error('[LocalLink]', frame.type, err); }
      }
    }
  }
}

export default LocalLink;
