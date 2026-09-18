const env = process.env;

export const config = {
  port: Number(env.GATEWAY_PORT ?? 8800),
  host: env.GATEWAY_HOST ?? '0.0.0.0',

  worker: {
    baseUrl: env.WORKER_URL ?? 'http://127.0.0.1:8811',
    timeoutMs: Number(env.WORKER_TIMEOUT_MS ?? 5000),
    retries: Number(env.WORKER_RETRIES ?? 2),
  },

  clock: {
    // Broadcast cadence for the telemetry WebSocket.
    tickHz: Number(env.TICK_HZ ?? 5),
    // Loop seconds advanced per real second when playing.
    defaultRate: Number(env.CLOCK_RATE ?? 1),
    loopDurationS: Number(env.LOOP_DURATION_S ?? 90),
    autoplay: (env.AUTOPLAY ?? 'true') !== 'false',
  },

  downlink: {
    // Log lines emitted per broadcast tick, per mode.
    linesPerTick: { ECLIPSE: 1, SUN_FACING: 2, ACTIVE: 4 },
    bufferSize: Number(env.DOWNLINK_BUFFER ?? 400),
  },

  cache: {
    // State is a pure function of the slider, so it is safe to memoise by a
    // quantised slider value. 1/900 of the loop = 0.2 s of loop time.
    quantum: Number(env.STATE_QUANTUM ?? 1 / 900),
    maxEntries: Number(env.STATE_CACHE_MAX ?? 1200),
  },

  cors: {
    origin: env.CORS_ORIGIN ?? '*',
  },
};

export default config;
