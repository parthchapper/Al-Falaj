import config from '../config.js';
import worker from './workerClient.js';

/**
 * Memoised access to worker state.
 *
 * The worker is a pure function of the slider, so a quantised slider value
 * is a perfect cache key. At 5 Hz broadcast with a 1/900 quantum, a full
 * loop warms in one pass and every subsequent pass is served from memory —
 * which is what keeps the console smooth while someone scrubs the slider
 * back and forth in front of an audience.
 */
class QuantisedCache {
  constructor({ quantum, maxEntries }) {
    this.quantum = quantum;
    this.maxEntries = maxEntries;
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  key(slider, suffix = '') {
    return `${Math.round(slider / this.quantum)}${suffix}`;
  }

  async get(slider, suffix, loader) {
    const k = this.key(slider, suffix);
    if (this.map.has(k)) {
      this.hits += 1;
      const v = this.map.get(k);
      this.map.delete(k);
      this.map.set(k, v); // refresh LRU position
      return v;
    }
    this.misses += 1;
    const value = await loader();
    this.map.set(k, value);
    if (this.map.size > this.maxEntries) {
      this.map.delete(this.map.keys().next().value);
    }
    return value;
  }

  clear() {
    this.map.clear();
  }

  stats() {
    const total = this.hits + this.misses;
    return {
      entries: this.map.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total ? Number((this.hits / total).toFixed(4)) : 0,
    };
  }
}

export const stateCache = new QuantisedCache(config.cache);

export const getState = (slider, opts = {}) => {
  const suffix = `:s${opts.schedule === false ? 0 : 1}:t${opts.track === false ? 0 : 1}`;
  return stateCache.get(slider, suffix, () => worker.state(slider, opts));
};

export const getMapGeometry = (slider) =>
  stateCache.get(slider, ':map', () => worker.mapGeometry(slider));

export const getSpectrum = (slider, opts = {}) =>
  stateCache.get(slider, `:spec:${opts.lat ?? 'n'}:${opts.lon ?? 'n'}:${opts.bands ?? 96}`,
    () => worker.spectrum(slider, opts));

export const getDesalination = (slider) =>
  stateCache.get(slider, ':desal', () => worker.desalination(slider));

export const getField = (slider, nx, ny) =>
  stateCache.get(slider, `:field:${nx}x${ny}`, () => worker.field(slider, nx, ny));

export default stateCache;
