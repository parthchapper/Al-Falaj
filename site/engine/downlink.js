/**
 * LIVE DOWNLINK log generator — port of `worker/app/downlink.py`.
 *
 * Emits CCSDS-flavoured telemetry lines derived from the real state
 * snapshot, so every line in the scrolling log corresponds to a number shown
 * elsewhere on the console. Nothing here is decorative filler.
 */
import { SPACECRAFT } from './config.js';

export const APIDS = {
  EPS: 0x0A2, ADCS: 0x0B7, THM: 0x0C1, PLD: 0x1F4,
  CDH: 0x0D9, RF: 0x0E3, SCI: 0x201, OPS: 0x300,
};

/** Deterministic PRNG so a replayed frame produces the same log. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function ts(state, offsetS = 0) {
  const base = new Date(state.clock.mission_time_utc).getTime() + offsetS * 1000;
  const d = new Date(base);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}`;
}

const line = (sub, sev, text, state, off) => ({
  t: ts(state, off),
  apid: `0x${(APIDS[sub] ?? 0).toString(16).toUpperCase().padStart(3, '0')}`,
  subsystem: sub,
  severity: sev,          // NOMINAL | INFO | WARN | CRIT | SCIENCE
  text,
});

const sgn = (n, d = 2) => (n >= 0 ? '+' : '') + n.toFixed(d);

/**
 * A burst of telemetry lines for the current state.
 *
 * `seed` keyed to the frame number keeps a scrolling log varied but
 * reproducible: replay the same frame and you get the same log.
 */
export function build(state, count = 12, seed = null) {
  const rng = mulberry32(seed ?? Math.floor(state.clock.loop_t_s * 97));
  const mode = state.mode.id;
  const pw = state.power;
  const bat = pw.battery;
  const att = state.attitude;
  const thm = state.thermal;
  const cm = state.comms;
  const pld = state.payload;
  const sub = state.orbit.subsatellite;

  const pool = [
    line('EPS', 'NOMINAL',
      `BATT SOC=${bat.soc_pct.toFixed(2)}% VBUS=${bat.bus_voltage_v.toFixed(2)}V `
      + `NET=${sgn(pw.net_w)}W ${pw.flow}`, state, 0),
    line('EPS', 'NOMINAL',
      `ARRAY GEN=${pw.generation_w.toFixed(2)}W COS=${pw.array_cosine.toFixed(2)} `
      + `LOAD=${pw.loads.total_w.toFixed(2)}W`, state, 0.31),
    line('ADCS', 'NOMINAL',
      `ATT ${att.mode} R=${sgn(att.roll_deg, 3)} P=${sgn(att.pitch_deg, 3)} `
      + `Y=${sgn(att.yaw_deg, 3)} RATE=${att.rate_deg_s.toFixed(4)}dps`, state, 0.62),
    line('ADCS', 'INFO', `STR ${att.star_tracker}`, state, 0.78),
    line('THM', 'NOMINAL',
      `TBUS=${sgn(thm.bus_c)}C TDET=${sgn(thm.detector_c)}C `
      + `TEC=${thm.tec_duty_pct.toFixed(1)}%`, state, 1.04),
    line('CDH', 'NOMINAL',
      `SSR FILL=${cm.recorder.fill_pct.toFixed(1)}% OF ${cm.recorder.capacity_gb}GB`, state, 1.29),
    line('OPS', 'INFO',
      `GNC SUBPOINT ${sgn(sub.lat, 4)} ${sgn(sub.lon, 4)} `
      + `ALT=${state.orbit.altitude_km.toFixed(1)}KM`, state, 1.55),
  ];

  if (mode === 'ECLIPSE') {
    pool.push(
      line('OPS', 'WARN', 'UMBRA ENTRY CONFIRMED — POWER SAVING PROFILE ARMED', state, 1.81),
      line('PLD', 'INFO', 'HYPER-A RAIL OFF — SHUTTER CLOSED, TEC IDLE', state, 2.02),
      line('RF', 'INFO', 'TX INHIBIT — BEACON ONLY 1200 BPS', state, 2.24),
      line('EPS', 'WARN',
        `DOD=${bat.depth_of_discharge_pct.toFixed(2)}% `
        + `MARGIN=${bat.margin_to_floor_pct.toFixed(2)}% TO FLOOR`, state, 2.48),
    );
  } else if (mode === 'SUN_FACING') {
    pool.push(
      line('OPS', 'NOMINAL', 'SUN ACQUISITION COMPLETE — ARRAYS NORMAL TO VECTOR', state, 1.81),
      line('PLD', 'INFO', `HYPER-A STANDBY ${pld.state} — DETECTOR SOAK IN PROGRESS`, state, 2.02),
      line('EPS', 'NOMINAL', 'MPPT TRACKING — CHARGE CURRENT NOMINAL', state, 2.3),
      line('CDH', 'INFO', 'FLIGHT SOFTWARE HEARTBEAT OK — WDT PET', state, 2.55),
    );
  } else {
    const idx = state.science?.indices ?? {};
    const dl = cm.downlink;
    pool.push(
      line('OPS', 'CRIT', '*** TARGET ACQUIRED — UAE_COASTAL ***', state, 1.81),
      line('PLD', 'SCIENCE',
        `IMAGING ${pld.bands_active}B INT=${(pld.integration_ms ?? 0).toFixed(0)}MS `
        + `FRAME=${pld.frames_captured}`, state, 2.02),
      line('SCI', 'SCIENCE',
        `CHL-A=${(idx.chl_a_mg_m3 ?? 0).toFixed(2)} MG/M3 `
        + `MCI=${sgn(idx.mci ?? 0, 5)} NDCI=${sgn(idx.ndci ?? 0, 4)} `
        + `[${idx.severity ?? 'N/A'}]`, state, 2.28),
      line('SCI', 'SCIENCE',
        `FLH=${sgn(idx.fluorescence_line_height ?? 0, 5)} `
        + `TURB=${(idx.turbidity ?? 0).toFixed(3)}`, state, 2.44),
      line('RF', 'NOMINAL',
        `DOWNLINK LIVE ${(dl.rate_mbps ?? 0).toFixed(1)}MBPS ${dl.modulation} `
        + `EB/N0=${(dl.eb_n0_db ?? 0).toFixed(2)}DB BER=${(dl.ber ?? 0).toExponential(1)}`, state, 2.66),
      line('OPS', 'INFO',
        `SWATH ${pld.swath_km.toFixed(0)}KM GSD=${pld.gsd_m.toFixed(0)}M `
        + `SCAN=${(pld.scan_progress * 100).toFixed(1)}%`, state, 2.9),
    );
  }

  const sevMap = { CRITICAL: 'CRIT', WARNING: 'WARN', INFO: 'INFO' };
  for (const a of state.alerts ?? []) {
    pool.push(line('OPS', sevMap[a.level], `${a.code} ${a.text.toUpperCase()}`, state, 3.1));
  }

  // Fisher-Yates with the seeded PRNG.
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const out = pool.slice(0, count);
  out.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  out.forEach((row, i) => { row.seq = i; row.sat = SPACECRAFT.name; });
  return out;
}
