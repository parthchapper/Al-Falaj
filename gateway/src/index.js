import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';

import config from './config.js';
import MissionClock from './lib/missionClock.js';
import TelemetryBus from './lib/telemetryBus.js';
import worker, { WorkerError } from './lib/workerClient.js';
import stateCache from './lib/stateCache.js';
import { missionRoutes } from './routes/mission.js';
import { scienceRoutes } from './routes/science.js';
import { mapRoutes } from './routes/map.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: config.cors.origin }));
app.use(express.json({ limit: '256kb' }));

const clock = new MissionClock();
const server = http.createServer(app);
const bus = new TelemetryBus(server, clock);

// --- routes -----------------------------------------------------------------
app.get('/health', async (_req, res) => {
  let workerOk = false;
  let workerErr = null;
  try { workerOk = (await worker.health()).status === 'ok'; }
  catch (e) { workerErr = String(e.message || e); }
  res.status(workerOk ? 200 : 503).json({
    status: workerOk ? 'ok' : 'degraded',
    service: 'gateway',
    version: '1.0.0',
    worker: { url: config.worker.baseUrl, reachable: workerOk, error: workerErr },
    clock: clock.transport(),
    telemetry: bus.stats(),
    cache: stateCache.stats(),
    uptime_s: Math.round(process.uptime()),
  });
});

app.use('/api/mission', missionRoutes(clock));
app.use('/api/science', scienceRoutes(clock));
app.use('/api/map', mapRoutes(clock));

app.get('/api/telemetry/log', (req, res) => {
  res.json({ lines: bus.recentLog(Number(req.query.limit) || 80) });
});

/** Serve the 3D map module so a front end can import it over HTTP. */
app.use('/map3d', express.static(path.resolve(__dirname, '../../map3d/src')));

/**
 * Serve three.js from the map3d module's own node_modules, so a host page
 * can resolve the bare `three` specifier with a two-line import map and
 * without its own bundler:
 *
 *   <script type="importmap">
 *     { "imports": { "three": "/vendor/three.module.js" } }
 *   </script>
 */
app.use('/vendor', express.static(
  path.resolve(__dirname, '../../map3d/node_modules/three/build'),
  { fallthrough: true },
));

app.get('/api', (_req, res) => {
  res.json({
    name: 'Orbital Sentinel Gateway',
    websocket: '/ws/telemetry?channels=state,map,downlink,event',
    rest: [
      'GET  /health',
      'GET  /api/mission/config',
      'GET  /api/mission/state?slider=0..1',
      'GET  /api/mission/timeline?samples=60',
      'POST /api/mission/slider   { slider }',
      'POST /api/mission/mode     { mode: ECLIPSE|SUN_FACING|ACTIVE }',
      'GET|POST /api/mission/transport',
      'GET  /api/science/spectrum?slider=&lat=&lon=&bands=',
      'GET  /api/science/field?slider=&nx=&ny=',
      'GET  /api/science/water-quality?slider=',
      'GET  /api/science/desalination?slider=',
      'GET  /api/map/bootstrap',
      'GET  /api/map/geometry?slider=',
      'GET  /api/map/groundtrack?samples=',
      'GET  /api/map/geojson?slider=',
      'GET  /api/telemetry/log?limit=80',
      'GET  /map3d/*  (ES modules for the three.js globe)',
    ],
  });
});

// --- errors -----------------------------------------------------------------
app.use((_req, res) => res.status(404).json({ error: 'not found' }));

app.use((err, _req, res, _next) => {
  const status = err instanceof WorkerError ? err.status : 500;
  if (status >= 500) console.error('[gateway]', err);
  res.status(status).json({ error: err.message || 'internal error' });
});

// --- boot -------------------------------------------------------------------
clock.start();
bus.startHeartbeat();

server.listen(config.port, config.host, () => {
  console.log(`[gateway] listening on http://${config.host}:${config.port}`);
  console.log(`[gateway] worker     ${config.worker.baseUrl}`);
  console.log(`[gateway] websocket  ws://${config.host}:${config.port}/ws/telemetry`);
  console.log(`[gateway] clock      ${config.clock.tickHz} Hz, ${clock.playing ? 'playing' : 'paused'}`);
});

const shutdown = (sig) => {
  console.log(`[gateway] ${sig} — shutting down`);
  clock.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export { app, server, clock, bus };
