import config from '../config.js';

/**
 * Thin, retrying HTTP client for the Python mission worker.
 *
 * The worker is pure and stateless, so retrying a GET is always safe.
 */
class WorkerError extends Error {
  constructor(message, { status = 502, cause } = {}) {
    super(message);
    this.name = 'WorkerError';
    this.status = status;
    this.cause = cause;
  }
}

async function once(path, { method = 'GET', body, signal } = {}) {
  const url = new URL(path, config.worker.baseUrl);
  const res = await fetch(url, {
    method,
    signal,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new WorkerError(`worker ${method} ${path} -> ${res.status} ${text.slice(0, 200)}`, {
      status: res.status >= 400 && res.status < 500 ? res.status : 502,
    });
  }
  return res.json();
}

export async function call(path, opts = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= config.worker.retries; attempt += 1) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), config.worker.timeoutMs);
    try {
      return await once(path, { ...opts, signal: ac.signal });
    } catch (err) {
      lastErr = err;
      // Client errors are deterministic — do not burn retries on them.
      if (err instanceof WorkerError && err.status < 500) throw err;
      if (attempt < config.worker.retries) {
        await new Promise((r) => setTimeout(r, 120 * (attempt + 1)));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw new WorkerError(`mission worker unreachable at ${config.worker.baseUrl}`, {
    status: 503,
    cause: lastErr,
  });
}

export const worker = {
  health: () => call('/health'),
  config: () => call('/mission/config'),
  state: (slider, { schedule = true, track = true } = {}) =>
    call(`/mission/state?slider=${slider}&schedule=${schedule}&track=${track}`),
  mode: (mode) => call('/mission/mode', { method: 'POST', body: { mode } }),
  timeline: (samples = 60) => call(`/mission/timeline?samples=${samples}`),
  spectrum: (slider, { lat, lon, bands = 96 } = {}) => {
    const q = new URLSearchParams({ slider: String(slider), bands: String(bands) });
    if (lat != null) q.set('lat', String(lat));
    if (lon != null) q.set('lon', String(lon));
    return call(`/science/spectrum?${q}`);
  },
  field: (slider, nx = 48, ny = 24) =>
    call(`/science/field?slider=${slider}&nx=${nx}&ny=${ny}`),
  waterQuality: (slider) => call(`/science/water-quality?slider=${slider}`),
  desalination: (slider) => call(`/desalination/schedule?slider=${slider}`),
  downlink: (slider, count, frame) =>
    call(`/telemetry/downlink?slider=${slider}&count=${count}&frame=${frame}`),
  mapGeometry: (slider) => call(`/map/geometry?slider=${slider}`),
  groundTrack: (samples = 240) => call(`/map/groundtrack?samples=${samples}`),
};

export { WorkerError };
export default worker;
