/**
 * AL-FALAJ SAT-1 palette.
 *
 * The 3D scene is the only place this module makes visual decisions, and it
 * makes them with the same three colours as the console: neon cyan for
 * structure and nominal data, solar amber for energy and attention, warning
 * red for alarms. Everything else is value, not hue.
 */
export const PALETTE = {
  cyan: 0x00f3ff,
  cyanDim: 0x0a5f68,
  amber: 0xffaa00,
  amberDim: 0x6b4a08,
  red: 0xff2d2d,
  redDim: 0x5c1212,
  white: 0xd8fbff,
  void: 0x00060a,
  ocean: 0x021a24,
  land: 0x063843,
  grid: 0x0d3f49,
};

/** Per-mode scene treatment. Drives the CSS-transition-style easing in globe.js. */
export const MODE_THEME = {
  ECLIPSE: {
    key: PALETTE.cyanDim,
    accent: PALETTE.amberDim,
    exposure: 0.42,          // dim everything — the UI dims with it
    terminatorGlow: 0.15,
    swathOpacity: 0.0,
    satelliteColor: PALETTE.cyanDim,
    trackOpacity: 0.28,
    pulseHz: 0.35,
  },
  SUN_FACING: {
    key: PALETTE.cyan,
    accent: PALETTE.amber,
    exposure: 0.85,
    terminatorGlow: 0.55,
    swathOpacity: 0.0,
    satelliteColor: PALETTE.amber,
    trackOpacity: 0.6,
    pulseHz: 0.7,
  },
  ACTIVE: {
    key: PALETTE.cyan,
    accent: PALETTE.amber,
    exposure: 1.0,
    terminatorGlow: 0.9,
    swathOpacity: 0.34,
    satelliteColor: PALETTE.white,
    trackOpacity: 1.0,
    pulseHz: 2.1,
  },
};

/** Severity ramp for the algae overlay: clear water -> critical bloom. */
export const BLOOM_RAMP = [
  [0.0, 0x013640],
  [0.25, 0x00f3ff],
  [0.5, 0x7ce86b],
  [0.75, 0xffaa00],
  [1.0, 0xff2d2d],
];

export function sampleRamp(t, ramp = BLOOM_RAMP) {
  const x = Math.max(0, Math.min(1, t));
  for (let i = 1; i < ramp.length; i += 1) {
    if (x <= ramp[i][0]) {
      const [t0, c0] = ramp[i - 1];
      const [t1, c1] = ramp[i];
      const f = (x - t0) / (t1 - t0 || 1);
      const lerp = (s, e) => Math.round(s + (e - s) * f);
      return (
        (lerp((c0 >> 16) & 255, (c1 >> 16) & 255) << 16) |
        (lerp((c0 >> 8) & 255, (c1 >> 8) & 255) << 8) |
        lerp(c0 & 255, c1 & 255)
      );
    }
  }
  return ramp[ramp.length - 1][1];
}

export default PALETTE;
