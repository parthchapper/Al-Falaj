/**
 * @orbital-sentinel/map3d
 *
 * A three.js globe for the AL-FALAJ SAT-1 mission console, plus the
 * transport that feeds it. No UI chrome, no layout, no DOM beyond its own
 * canvas — the host application owns all of that.
 *
 * Quick start:
 *
 *   import { mount } from '/map3d/index.js';
 *   const { globe, link } = await mount(document.getElementById('globe'), {
 *     baseUrl: 'http://localhost:8800',
 *     followSatellite: false,
 *   });
 *
 * `mount` wires the socket to the globe and keeps the science overlays in
 * step with the mode. Use `OrbitalSentinelGlobe` and `SentinelLink`
 * directly if the host wants to own that wiring itself.
 */
export { OrbitalSentinelGlobe, default as Globe } from './globe.js';
export { SentinelLink } from './client.js';
export { PALETTE, MODE_THEME, BLOOM_RAMP, sampleRamp } from './palette.js';
export * as coords from './coords.js';

import { OrbitalSentinelGlobe } from './globe.js';
import { SentinelLink } from './client.js';

export async function mount(container, {
  baseUrl = window.location.origin,
  fieldResolution = [64, 32],
  refocusOnActive = true,
  ...globeOptions
} = {}) {
  const link = new SentinelLink({ baseUrl, channels: ['state', 'map', 'downlink', 'event'] });
  const globe = new OrbitalSentinelGlobe(container, globeOptions);

  const boot = await link.bootstrap();
  await globe.init(boot);

  link.on('map', (frame) => globe.applyTelemetry(frame));

  // Science overlays are only meaningful while imaging, and the field is
  // expensive, so refresh it on mode entry and then lazily during the pass.
  let lastField = 0;
  link.on('state', async ({ state }) => {
    if (state?.mode?.id !== 'ACTIVE') return;
    globe.applyScience({ water_quality: state.science?.water_quality });
    const now = Date.now();
    if (now - lastField > 2500) {
      lastField = now;
      try {
        const field = await link.field(state.clock.slider, ...fieldResolution);
        globe.applyScience({ field });
      } catch { /* a dropped overlay frame is not worth surfacing */ }
    }
  });

  link.on(':mode', ({ to }) => {
    globe.setMode(to);
    if (refocusOnActive && to === 'ACTIVE') globe.focusAOI({ distance: 2.35 });
    if (to === 'ECLIPSE') globe.resetView();
  });

  await link.connect();
  return { globe, link, bootstrap: boot };
}

export default { mount };
