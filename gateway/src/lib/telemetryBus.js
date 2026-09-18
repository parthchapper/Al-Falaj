import { WebSocketServer } from 'ws';
import config from '../config.js';
import worker from './workerClient.js';
import { getState } from './stateCache.js';

/**
 * Live telemetry fan-out.
 *
 * One WebSocket endpoint, four channels. A client subscribes only to what it
 * renders, so the 3D globe is not paying for spectroscopy payloads and the
 * downlink log is not paying for ground-track polylines.
 *
 *   state     — full spacecraft snapshot (heavy; throttled)
 *   map       — geometry only: subpoint, scan line, swath   (every tick)
 *   downlink  — LIVE DOWNLINK log lines                     (every tick)
 *   event     — mode transitions, alerts, transport changes (on change)
 */
export const CHANNELS = ['state', 'map', 'downlink', 'event'];

export class TelemetryBus {
  constructor(server, clock) {
    this.clock = clock;
    this.wss = new WebSocketServer({ server, path: '/ws/telemetry' });
    this.clients = new Map(); // ws -> Set(channel)
    this.log = [];            // ring buffer of downlink lines
    this.lastMode = null;
    this.lastAlertKey = '';
    this.seq = 0;
    this.busy = false;

    this.wss.on('connection', (ws, req) => this._onConnection(ws, req));
    clock.on('tick', (t) => this._onTick(t));
    clock.on('transport', (tr) => this.broadcast('event', { type: 'transport', transport: tr }));
    clock.on('slider', (s) => this.broadcast('event', { type: 'seek', ...s }));
  }

  // -------------------------------------------------------------------------
  _onConnection(ws, req) {
    const url = new URL(req.url, 'http://localhost');
    const requested = (url.searchParams.get('channels') || 'state,map,downlink,event')
      .split(',').map((c) => c.trim()).filter((c) => CHANNELS.includes(c));
    this.clients.set(ws, new Set(requested.length ? requested : CHANNELS));

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('close', () => this.clients.delete(ws));
    ws.on('error', () => this.clients.delete(ws));
    ws.on('message', (raw) => this._onMessage(ws, raw));

    this._send(ws, {
      channel: 'event',
      type: 'hello',
      channels: [...this.clients.get(ws)],
      transport: this.clock.transport(),
      backlog: this.log.slice(-40),
      serverTime: new Date().toISOString(),
    });
  }

  _onMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const subs = this.clients.get(ws);
    if (!subs) return;

    switch (msg.type) {
      case 'subscribe':
        (msg.channels || []).filter((c) => CHANNELS.includes(c)).forEach((c) => subs.add(c));
        break;
      case 'unsubscribe':
        (msg.channels || []).forEach((c) => subs.delete(c));
        break;
      case 'seek':
        this.clock.seek(msg.slider);
        break;
      case 'scrub':
        this.clock.scrub(msg.active);
        break;
      case 'transport':
        if ('playing' in msg) this.clock.setPlaying(msg.playing);
        if ('rate' in msg) this.clock.setRate(msg.rate);
        break;
      case 'ping':
        this._send(ws, { channel: 'event', type: 'pong', t: Date.now() });
        break;
      default:
        break;
    }
  }

  // -------------------------------------------------------------------------
  async _onTick({ slider, frame }) {
    // Never let a slow worker stack up ticks; drop frames instead.
    if (this.busy) return;
    this.busy = true;
    try {
      const state = await getState(slider, { schedule: true, track: true });
      const mode = state.mode.id;

      if (this.subscriberCount('map')) {
        this.broadcast('map', {
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
      }

      if (this.subscriberCount('state')) {
        this.broadcast('state', { type: 'state', slider, state });
      }

      const n = config.downlink.linesPerTick[mode] ?? 2;
      if (n > 0 && this.subscriberCount('downlink')) {
        const { lines } = await worker.downlink(slider, n, frame);
        for (const line of lines) {
          line.seq = this.seq++;
          this.log.push(line);
        }
        if (this.log.length > config.downlink.bufferSize) {
          this.log.splice(0, this.log.length - config.downlink.bufferSize);
        }
        this.broadcast('downlink', { type: 'downlink', mode, lines });
      }

      if (mode !== this.lastMode) {
        const previous = this.lastMode;
        this.lastMode = mode;
        this.broadcast('event', {
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
        this.broadcast('event', { type: 'alerts', alerts: state.alerts });
      }
    } catch (err) {
      this.broadcast('event', { type: 'error', message: String(err.message || err) });
    } finally {
      this.busy = false;
    }
  }

  // -------------------------------------------------------------------------
  subscriberCount(channel) {
    let n = 0;
    for (const subs of this.clients.values()) if (subs.has(channel)) n += 1;
    return n;
  }

  broadcast(channel, payload) {
    const frame = JSON.stringify({ channel, t: Date.now(), ...payload });
    for (const [ws, subs] of this.clients) {
      if (subs.has(channel) && ws.readyState === ws.OPEN) ws.send(frame);
    }
  }

  _send(ws, payload) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: Date.now(), ...payload }));
  }

  recentLog(limit = 80) {
    return this.log.slice(-limit);
  }

  startHeartbeat(intervalMs = 30000) {
    this._hb = setInterval(() => {
      for (const ws of this.clients.keys()) {
        if (ws.isAlive === false) { ws.terminate(); this.clients.delete(ws); continue; }
        ws.isAlive = false;
        ws.ping();
      }
    }, intervalMs);
    this._hb.unref?.();
    return this;
  }

  stats() {
    return {
      clients: this.clients.size,
      bySubscription: Object.fromEntries(CHANNELS.map((c) => [c, this.subscriberCount(c)])),
      logBuffered: this.log.length,
      sequence: this.seq,
    };
  }
}

export default TelemetryBus;
