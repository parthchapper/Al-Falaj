/**
 * Electrical power subsystem — port of `worker/app/power.py`.
 *
 * Honest physics, not theatre. A 6U CubeSat with ~0.10 m^2 of triple-junction
 * cells generates ~41 W in full sun; housekeeping draws 6.2 W; the payload
 * draws 22 W while imaging and 3.5 W in standby; the X-band radio draws 9 W
 * whenever it is keyed.
 *
 * The radio load is driven by real contact geometry rather than by mode, so
 * the polar dump over Troll costs the battery 9 W *while the spacecraft is in
 * eclipse* — the deepest point of the orbit, and exactly the sort of thing a
 * power budget exists to catch.
 *
 * Over a 33-minute eclipse the depth of discharge is only a few percent,
 * which is what a real flight profile looks like. Because a small swing is
 * invisible on a full-range gauge, the model also returns a recommended
 * display window (`gauge.min_pct` / `gauge.max_pct`) so the console can zoom
 * the needle without misrepresenting the number. `soc_pct` is always truth.
 */
import {
  EPS, LOOP_DURATION_S, ORBIT_PERIOD_S, SPACECRAFT, TIMELINE_SEGMENTS,
  wrapLoopT,
} from './config.js';
import { timeCompression } from './geo.js';
import { transmittingAt } from './comms.js';

const PAYLOAD = SPACECRAFT.payload;
const round = (x, n) => Number(x.toFixed(n));

// Array-normal cosine factor per mode: sun-pointed in SUN_FACING, tipped
// off-sun while the payload slews to the target in ACTIVE, zero in eclipse.
export const ARRAY_COS = { ECLIPSE: 0.0, SUN_FACING: 0.97, ACTIVE: 0.74 };

export const PAYLOAD_LOAD_W = {
  DISABLED: 0.0,
  STANDBY_CHARGING: PAYLOAD.standby_power_w,
  IMAGING: PAYLOAD.peak_power_w,
};

export const RADIO_TX_W = EPS.radio_tx_w;   // transmitter keyed
export const RADIO_IDLE_W = 0.6;            // receiver + beacon, always on

export const SOC_AT_LOOP_START_PCT = 94.0;

export const PEAK_ARRAY_W = EPS.array_area_m2 * EPS.array_efficiency * EPS.solar_constant_w_m2;

// Mean compression across the loop, quoted in mission config. The
// instantaneous rate differs continuously — see geo.timeCompression.
export const SECONDS_PER_LOOP_SECOND = ORBIT_PERIOD_S / LOOP_DURATION_S;

export function segmentFor(loopT) {
  const t = wrapLoopT(loopT);
  for (const seg of TIMELINE_SEGMENTS) {
    if (t >= seg.start_s && t < seg.end_s) return seg;
  }
  return TIMELINE_SEGMENTS[TIMELINE_SEGMENTS.length - 1];
}

export const generationW = (mode) => round(PEAK_ARRAY_W * (ARRAY_COS[mode] ?? 0), 2);

export function loadsW(mode, payloadState, transmitting = false) {
  const bus = EPS.bus_housekeeping_w;
  const payload = PAYLOAD_LOAD_W[payloadState] ?? 0;
  const radio = transmitting ? RADIO_TX_W : RADIO_IDLE_W;
  return {
    bus_w: round(bus, 2),
    payload_w: round(payload, 2),
    radio_w: round(radio, 2),
    total_w: round(bus + payload + radio, 2),
  };
}

/**
 * Li-ion constant-current / constant-voltage behaviour.
 *
 * Full current up to 88 % state of charge, then tapering to zero at 100 %.
 * Without this the battery would slam into the ceiling and the gauge would
 * flat-line for most of the sunlit arc.
 */
export function chargeTaper(socPct) {
  if (socPct <= 88.0) return 1.0;
  return Math.max(0, (100 - socPct) / 12) ** 1.35;
}

const STEP_S = 0.1;
let _profile = null;

function integrate(soc0, n) {
  const capacity = EPS.battery_capacity_wh;
  let soc = soc0;
  const profile = [];
  for (let k = 0; k < n; k += 1) {
    const t = k * STEP_S;
    const seg = segmentFor(t);
    const gen = generationW(seg.mode);
    const load = loadsW(seg.mode, seg.payload_state, transmittingAt(t)).total_w;
    let netW = gen - load;
    // Charge efficiency and CC/CV taper apply only when charging.
    if (netW > 0) netW *= 0.93 * chargeTaper(soc);
    // Integrate in real orbital time, at the local warp rate.
    const realHours = (STEP_S * timeCompression(t)) / 3600;
    soc += ((netW * realHours) / capacity) * 100;
    soc = Math.min(100, Math.max(0, soc));
    profile.push(soc);
  }
  return profile;
}

/**
 * Pre-integrated state of charge across one loop, in percent.
 *
 * Solved for the periodic steady state: a repeating orbit must end the loop
 * at the state of charge it started with, or the gauge jumps every time the
 * timeline wraps. Converges in a handful of iterations, then is cached — the
 * scripted loop is deterministic, so the same loop time always yields the
 * same SoC no matter when it is queried.
 */
export function socProfile() {
  if (_profile) return _profile;
  const n = Math.floor(LOOP_DURATION_S / STEP_S) + 1;
  let soc0 = SOC_AT_LOOP_START_PCT;
  let profile = integrate(soc0, n);
  for (let i = 0; i < 40; i += 1) {
    const drift = profile[profile.length - 1] - soc0;
    if (Math.abs(drift) < 1e-4) break;
    soc0 = Math.min(100, Math.max(0, soc0 + drift * 0.6));
    profile = integrate(soc0, n);
  }
  _profile = profile;
  return profile;
}

export function stateOfChargePct(loopT) {
  const profile = socProfile();
  const t = wrapLoopT(loopT);
  const idx = Math.floor(t / STEP_S);
  return round(profile[Math.min(idx, profile.length - 1)], 3);
}

export function socBounds() {
  const p = socProfile();
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of p) { if (v < lo) lo = v; if (v > hi) hi = v; }
  return { min: round(lo, 3), max: round(hi, 3) };
}

/** Full EPS snapshot for one loop time. */
export function powerState(loopT) {
  const seg = segmentFor(loopT);
  const mode = seg.mode;
  const tx = transmittingAt(loopT);
  const gen = generationW(mode);
  const load = loadsW(mode, seg.payload_state, tx);
  const soc = stateOfChargePct(loopT);
  const bounds = socBounds();
  const net = round(gen - load.total_w, 2);

  // Zoom the gauge to the range the mission actually uses, padded 1 %.
  const gMin = Math.max(0, round(bounds.min - 1, 1));
  const gMax = Math.min(100, round(bounds.max + 1, 1));

  const margin = round(soc - EPS.battery_min_soc_pct, 2);
  const hoursToFloor = net < 0
    ? (((soc - EPS.battery_min_soc_pct) / 100) * EPS.battery_capacity_wh) / Math.abs(net)
    : null;

  return {
    mode,
    generation_w: gen,
    array_peak_w: round(PEAK_ARRAY_W, 2),
    array_cosine: ARRAY_COS[mode] ?? 0,
    loads: load,
    transmitting: tx,
    net_w: net,
    flow: net > 0.05 ? 'CHARGING' : (net < -0.05 ? 'DISCHARGING' : 'FLOAT'),
    battery: {
      soc_pct: soc,
      stored_wh: round((EPS.battery_capacity_wh * soc) / 100, 2),
      capacity_wh: EPS.battery_capacity_wh,
      bus_voltage_v: round(EPS.battery_nominal_v * (0.92 + (0.08 * soc) / 100), 2),
      depth_of_discharge_pct: round(100 - soc, 3),
      margin_to_floor_pct: margin,
      hours_to_floor: hoursToFloor ? round(hoursToFloor, 2) : null,
      flight_rule_floor_pct: EPS.battery_min_soc_pct,
      violated: soc < EPS.battery_min_soc_pct,
    },
    gauge: {
      min_pct: gMin,
      max_pct: gMax,
      note: "Display window zoomed to the mission's real SoC envelope; "
        + 'soc_pct is the unscaled value.',
    },
  };
}
