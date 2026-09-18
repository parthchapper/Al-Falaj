/**
 * SentinelLink — the browser-side transport.
 *
 * One object that owns the REST calls and the telemetry WebSocket, with
 * reconnect backoff and a small event API. A host application never has to
 * think about socket lifecycle, only about the data.
 *
 *   const link = new SentinelLink({ baseUrl: 'http://localhost:8800' });
 *   link.on('map', (f) => globe.applyTelemetry(f));
 *   link.on('downlink', ({ lines }) => log.push(...lines));
 *   await link.connect();
 */
export class SentinelLink {
  constructor({
    baseUrl = window.location.origin,
    channels = ['state', 'map', 'downlink', 'event'],
    autoReconnect = true,
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.channels = channels;
    this.autoReconnect = autoReconnect;
    this.ws = null;
    this.connected = false;
    this._listeners = new Map();
    this._backoff = 500;
  }

  // -- REST -----------------------------------------------------------------
  async _get(path) {
    const res = await fetch(`${this.baseUrl}${path}`);
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
    return res.json();
  }

  async _post(path, body) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
    return res.json();
  }

  health() { return this._get('/health'); }
  missionConfig() { return this._get('/api/mission/config'); }
  bootstrap(slider) { return this._get(`/api/map/bootstrap${slider != null ? `?slider=${slider}` : ''}`); }
  state(slider) { return this._get(`/api/mission/state${slider != null ? `?slider=${slider}` : ''}`); }
  timeline(samples = 90) { return this._get(`/api/mission/timeline?samples=${samples}`); }
  spectrum(opts = {}) {
    const q = new URLSearchParams(Object.entries(opts).filter(([, v]) => v != null));
    return this._get(`/api/science/spectrum?${q}`);
  }
  field(slider, nx = 64, ny = 32) {
    return this._get(`/api/science/field?slider=${slider ?? ''}&nx=${nx}&ny=${ny}`);
  }
  desalination(slider) {
    return this._get(`/api/science/desalination${slider != null ? `?slider=${slider}` : ''}`);
  }
  geojson(slider) { return this._get(`/api/map/geojson${slider != null ? `?slider=${slider}` : ''}`); }
  recentLog(limit = 80) { return this._get(`/api/telemetry/log?limit=${limit}`); }

  // -- control --------------------------------------------------------------
  setSlider(slider) { return this._post('/api/mission/slider', { slider }); }
  setMode(mode) { return this._post('/api/mission/mode', { mode }); }
  setTransport(opts) { return this._post('/api/mission/transport', opts); }

  /** Low-latency slider updates while a user drags: send over the socket. */
  seek(slider) { this._send({ type: 'seek', slider }); }
  scrub(active) { this._send({ type: 'scrub', active }); }

  // -- WebSocket ------------------------------------------------------------
  connect() {
    return new Promise((resolve, reject) => {
      const wsUrl = `${this.baseUrl.replace(/^http/, 'ws')}/ws/telemetry?channels=${this.channels.join(',')}`;
      let settled = false;

      try {
        this.ws = new WebSocket(wsUrl);
      } catch (err) {
        reject(err);
        return;
      }

      this.ws.onopen = () => {
        this.connected = true;
        this._backoff = 500;
        this._emit('open', { url: wsUrl });
        if (!settled) { settled = true; resolve(this); }
      };

      this.ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        this._emit(msg.channel ?? 'event', msg);
        if (msg.type) this._emit(`:${msg.type}`, msg);
      };

      this.ws.onclose = () => {
        this.connected = false;
        this._emit('close', {});
        if (this.autoReconnect) {
          setTimeout(() => this.connect().catch(() => {}), this._backoff);
          this._backoff = Math.min(8000, this._backoff * 1.8);
        }
        if (!settled) { settled = true; reject(new Error('telemetry socket closed')); }
      };

      this.ws.onerror = (err) => this._emit('error', err);
    });
  }

  disconnect() {
    this.autoReconnect = false;
    this.ws?.close();
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  // -- events ---------------------------------------------------------------
  /** Channels: state | map | downlink | event | open | close | error.
   *  Message types: prefix with ':' e.g. on(':mode', fn). */
  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this._listeners.get(event)?.delete(fn);
  }

  _emit(event, payload) {
    for (const fn of this._listeners.get(event) ?? []) {
      try { fn(payload); } catch (err) { console.error('[SentinelLink]', event, err); }
    }
  }
}

export default SentinelLink;
