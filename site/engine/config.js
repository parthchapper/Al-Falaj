/**
 * Mission constants — a direct port of `worker/app/config.py`.
 *
 * The static site runs the whole mission model in the browser so it can be
 * hosted on GitHub Pages with no server at all. This file and the Python one
 * must agree exactly; `tools/parity-check.mjs` asserts that they do.
 */

export const SPACECRAFT = {
  name: 'ORBITAL SENTINEL-1',
  cospar_id: '2026-000A',
  norad_id: 99001,
  bus: '6U CubeSat',
  mass_kg: 12.0,
  // Sun-synchronous, 10:30 local time descending node — the standard
  // ocean-colour orbit (same family as Sentinel-3 / PACE).
  orbit: {
    regime: 'SSO',
    altitude_km: 520.0,
    inclination_deg: 97.49,
    period_min: 94.9,
    ltdn: '10:30',
    repeat_cycle_days: 5,
  },
  payload: {
    name: 'HYPER-A',
    type: 'Pushbroom hyperspectral imager',
    spectral_range_nm: [400, 900],
    bands: 96,
    spectral_resolution_nm: 5.2,
    gsd_m: 30.0,
    swath_km: 180.0,
    peak_power_w: 22.0,
    standby_power_w: 3.5,
  },
};

export const EPS = {
  battery_capacity_wh: 78.0,
  battery_min_soc_pct: 30.0,     // flight rule: never discharge below this
  battery_nominal_v: 16.8,
  array_area_m2: 0.10,           // 2 x deployable 3U wings, cell area
  array_efficiency: 0.298,       // triple-junction GaAs, EOL
  solar_constant_w_m2: 1361.0,
  bus_housekeeping_w: 6.2,       // OBC + ADCS + thermal, always on
  radio_tx_w: 9.0,               // X-band downlink during pass
};

// ---------------------------------------------------------------------------
// Timeline: one closed orbit in 90 seconds
// ---------------------------------------------------------------------------
export const ORBIT_PERIOD_S = SPACECRAFT.orbit.period_min * 60.0;   // 5694 s
export const LOOP_DURATION_S = 90.0;

/**
 * Where the spacecraft is, in orbit seconds, at each point in its orbit.
 *
 * The loop covers exactly one orbital period, so the ground track closes:
 * the sub-satellite point at loop t = 90 s is the point at t = 0 s.
 *
 * ECLIPSE runs 2000 s (35.1 % of the period — right for a 520 km SSO), then
 * the sunlit arc, then the 145 s UAE overpass, then a short sunlit egress in
 * which the recorder is dumped before the spacecraft re-enters the umbra.
 * The pass is deliberately *not* at the loop boundary: a climax that lands on
 * the wrap has nowhere to resolve.
 */
export const ORBIT_SEGMENTS = [
  { mode: 'ECLIPSE', orbit_start_s: 0.0, orbit_end_s: 2000.0 },
  { mode: 'SUN_FACING', orbit_start_s: 2000.0, orbit_end_s: 5100.0 },
  { mode: 'ACTIVE', orbit_start_s: 5100.0, orbit_end_s: 5245.0 },
  { mode: 'SUN_FACING', orbit_start_s: 5245.0, orbit_end_s: ORBIT_PERIOD_S, egress: true },
];

export const PASS_MID_ORBIT_S = 5172.5;

/**
 * Continuous time warp.
 *
 * A uniform 63x would flash the 145-second overpass past in 2.3 seconds while
 * the audience watched half a minute of empty eclipse. Instead the clock rate
 * varies *smoothly* over the orbit, with a slow zone centred on the pass.
 *
 * Define a density rho(x) in loop-seconds per orbit-second, where x is the
 * fraction of the orbit completed. A von Mises bump is used because it is the
 * natural periodic Gaussian: smooth, strictly positive, and identical at
 * x = 0 and x = 1, so the loop has no seam in its *rate* either — the wrap is
 * continuous in position, velocity and clock rate.
 *
 *   rho(x) = 1 + A * exp(K * (cos(2*pi*(x - phase_pass)) - 1))
 *
 * A = 25 sets the depth of the slowdown (~26x between coast and pass) and
 * K = 110 its width (half-maximum about +/- 103 orbit seconds, comfortably
 * wider than the 145-second pass so the ramp is gradual, never abrupt).
 */
export const WARP = {
  phase_pass: PASS_MID_ORBIT_S / ORBIT_PERIOD_S,
  amplitude: 25.0,
  concentration: 110.0,
  samples: 4096,
};

export function warpDensity(x) {
  const th = 2 * Math.PI * (x - WARP.phase_pass);
  return 1.0 + WARP.amplitude * Math.exp(WARP.concentration * (Math.cos(th) - 1.0));
}

/**
 * Cumulative loop time at each of `samples` evenly spaced orbit fractions.
 * Built once, by trapezoid, in the same order in both languages so the two
 * implementations agree to the last bit.
 */
function buildWarpTable() {
  const n = WARP.samples;
  const cum = [0.0];
  let acc = 0.0;
  for (let k = 1; k <= n; k += 1) {
    const x0 = (k - 1) / n;
    const x1 = k / n;
    acc += (0.5 * (warpDensity(x0) + warpDensity(x1))) / n;
    cum.push(acc);
  }
  const total = cum[n];
  return { total, loopAt: cum.map((c) => (LOOP_DURATION_S * c) / total) };
}

export const WARP_TABLE = buildWarpTable();

/** Loop seconds elapsed at a given orbit time. */
export function loopTimeAtOrbit(orbitS) {
  const n = WARP.samples;
  const x = (Math.max(0, Math.min(ORBIT_PERIOD_S, orbitS)) / ORBIT_PERIOD_S) * n;
  const k = Math.min(n - 1, Math.floor(x));
  const f = x - k;
  const a = WARP_TABLE.loopAt[k];
  return a + f * (WARP_TABLE.loopAt[k + 1] - a);
}

export const MODE_INFO = {
  ECLIPSE: {
    label: 'ECLIPSE MODE',
    banner: 'POWER SAVING',
    payload_state: 'DISABLED',
    description: "Spacecraft in Earth's umbra. Payload powered down, "
      + 'battery carries the housekeeping load.',
  },
  SUN_FACING: {
    label: 'SUN FACING MODE',
    banner: 'ARRAY GENERATION NOMINAL',
    payload_state: 'STANDBY_CHARGING',
    description: 'Sunlit arc. Arrays sun-pointed, battery recharging, '
      + 'payload thermally soaking in standby.',
  },
  ACTIVE: {
    label: 'ACTIVE MODE',
    banner: 'TARGET ACQUIRED',
    payload_state: 'IMAGING',
    description: 'UAE coastal pass. Payload imaging, spectrometer '
      + 'streaming, X-band downlink live.',
  },
};

// Loop-time segments, derived by mapping the orbit boundaries through the
// warp. Nothing hard-codes a loop timestamp — change the warp and these move.
export const TIMELINE_SEGMENTS = ORBIT_SEGMENTS.map((s) => {
  const info = MODE_INFO[s.mode];
  return {
    mode: s.mode,
    label: s.egress ? 'SUN FACING · EGRESS' : info.label,
    banner: s.egress ? 'PASS COMPLETE · DUMPING RECORDER' : info.banner,
    description: s.egress
      ? 'Imaging complete. Still sunlit, arrays recharging, solid-state '
        + 'recorder dumping to the ground segment before the next eclipse.'
      : info.description,
    payload_state: info.payload_state,
    egress: Boolean(s.egress),
    orbit_start_s: s.orbit_start_s,
    orbit_end_s: s.orbit_end_s,
    start_s: Number(loopTimeAtOrbit(s.orbit_start_s).toFixed(4)),
    end_s: s.orbit_end_s >= ORBIT_PERIOD_S
      ? LOOP_DURATION_S
      : Number(loopTimeAtOrbit(s.orbit_end_s).toFixed(4)),
  };
});

export const MODES = ['ECLIPSE', 'SUN_FACING', 'ACTIVE'];

/**
 * Python-compatible loop-time modulo.
 *
 * NOT `(t % L + L) % L`. That idiom round-trips through t + L, and for a t
 * just under L the larger magnitude has half the resolution — the value comes
 * back shifted by one unit in the last place. Divided by the 0.1 s profile
 * step that is enough to move `Math.floor` to the next index, which is how a
 * battery reading ends up 0.002 % away from the Python worker's. Python's own
 * `%` already returns a non-negative result for a positive modulus, so this
 * matches it exactly and leaves non-negative inputs untouched.
 */
export function wrapLoopT(t) {
  const m = t % LOOP_DURATION_S;
  return m < 0 ? m + LOOP_DURATION_S : m;
}


// Capacities are public design figures (MIGD = million imperial gallons/day).
export const DESAL_PLANTS = [
  {
    id: 'JEBEL_ALI',
    name: 'Jebel Ali Desalination Complex',
    operator: 'DEWA',
    lat: 25.0000,
    lon: 55.0600,
    sea: 'Arabian Gulf',
    capacity_migd: 470,
    intake_depth_m: 6.0,
    // The Arabian Gulf is shallow, warm and hypersaline — bloom-prone.
    baseline_bloom_risk: 0.62,
    intake_type: 'Open surface intake',
    // People served at the UAE domestic average of ~550 L/person/day.
    people_served: 2_100_000,
  },
  {
    id: 'FUJAIRAH',
    name: 'Fujairah F1 / F2 Desalination Complex',
    operator: 'EWEC',
    lat: 25.1100,
    lon: 56.3500,
    sea: 'Gulf of Oman',
    capacity_migd: 230,
    intake_depth_m: 10.0,
    // Deeper, cooler, better flushed — but hit by the 2008-09 Cochlodinium
    // bloom that shut the plant down. Lower baseline, higher tail risk.
    baseline_bloom_risk: 0.38,
    intake_type: 'Deep open intake',
    people_served: 1_050_000,
  },
];

// 1 million imperial gallons = 4546.09 m^3.
export const M3_PER_MIGD = 4546.09;

/**
 * Ground segment.
 *
 * Chosen by running the propagator, not by picking famous stations: each of
 * these gets a usable pass (>10 deg) somewhere in the orbit, so the AOS/LOS
 * board always has something real on it. Svalbard — the obvious choice for a
 * polar-orbiting mission — only grazes this particular orbit at 10.4 deg, so
 * it is not in the baseline network. See docs/ARCHITECTURE.md.
 */
export const GROUND_STATIONS = [
  {
    id: 'DXB_GS',
    name: 'Dubai Primary',
    short: 'DUBAI',
    lat: 25.2048,
    lon: 55.2708,
    band: 'X',
    rate_mbps: 120,
    role: 'Mission home station — acquires before the pass and holds through it.',
  },
  {
    id: 'INU_GS',
    name: 'Inuvik, Canada',
    short: 'INUVIK',
    lat: 68.3190,
    lon: -133.5490,
    band: 'X',
    rate_mbps: 310,
    role: 'High-latitude dump on the sunlit arc.',
  },
  {
    id: 'TRL_GS',
    name: 'Troll, Antarctica',
    short: 'TROLL',
    lat: -72.0117,
    lon: 2.5350,
    band: 'X',
    rate_mbps: 280,
    role: 'Polar dump during eclipse, before the spacecraft comes back into sun.',
  },
];

export const MIN_ELEVATION_DEG = 10.0;   // link acquisition threshold

export const AOI = {
  id: 'UAE_COASTAL',
  name: 'UAE Coastal Waters',
  // [W, S, E, N] — UAE coastal waters plus the southern approach the
  // swath crosses on the way in.
  bbox: [51.0, 22.0, 57.2, 26.8],
  center: { lat: 24.6, lon: 54.2 },
};

export const SPECTRO = {
  lambda_min_nm: 400.0,
  lambda_max_nm: 900.0,
  bands: 96,
  // Diagnostic features the graph is meant to show, each with a reason.
  features: [
    { nm: 443, name: 'Chl-a Soret absorption', kind: 'absorption' },
    { nm: 490, name: 'Blue reference', kind: 'reference' },
    { nm: 555, name: 'Green reflectance peak', kind: 'peak' },
    { nm: 620, name: 'Phycocyanin absorption', kind: 'absorption' },
    { nm: 665, name: 'Chl-a red absorption', kind: 'absorption' },
    { nm: 681, name: 'Sun-induced fluorescence', kind: 'peak' },
    { nm: 709, name: 'NIR red-edge peak', kind: 'peak' },
    { nm: 754, name: 'NIR reference', kind: 'reference' },
  ],
};

/**
 * Where every number on the console comes from.
 *
 * A dashboard that cannot say what produced a figure is decoration. Each
 * panel carries one of these lines verbatim.
 */
export const PROVENANCE = {
  orbit: 'Keplerian propagation · 520 km SSO, i=97.49° · Earth rotation held fixed for loop closure',
  power: 'EPS energy balance · 0.10 m² GaAs @ 29.8% EOL, 78 Wh Li-ion, CC/CV taper',
  spectro: 'HYPER-A L1B → Rrs(λ) · 96 bands, 400–900 nm @ 5.2 nm',
  science: 'MCI / NDCI / FLH retrieval · MERIS-OLCI band algebra on Rrs(λ)',
  desal: 'Intake scheduler · bloom risk × stratification × tide, MERIS-OLCI Chl-a forcing',
  comms: 'Link budget from slant range & elevation · X-band, 10° mask',
  impact: 'Capacity at risk = plant MIGD × fouling factor · 4546.09 m³ per MIGD',
  downlink: 'CCSDS Space Packet telemetry · every field mirrored from this frame',
  map: 'Natural Earth coastlines (public domain) · swath from payload FOV & attitude',
};

export default {
  SPACECRAFT, EPS, LOOP_DURATION_S, ORBIT_PERIOD_S, ORBIT_SEGMENTS, WARP,
  WARP_TABLE, TIMELINE_SEGMENTS, MODE_INFO, MODES, DESAL_PLANTS, M3_PER_MIGD,
  GROUND_STATIONS, MIN_ELEVATION_DEG, AOI, SPECTRO, PROVENANCE,
};
