/**
 * Ground segment: contact windows, link budget, solid-state recorder.
 * Port of `worker/app/comms.py`.
 *
 * The contact windows are not scripted. `geo.stationPasses` sweeps the real
 * propagator against each station's 10-degree horizon mask, so when the board
 * says AOS in 4 seconds, that is when the spacecraft actually rises.
 *
 * Because the radio draws 9 W whenever it transmits — including the polar
 * dumps that happen in eclipse — this module is also an input to the power
 * model, not just a display.
 */
import {
  GROUND_STATIONS, LOOP_DURATION_S, ORBIT_PERIOD_S, TIMELINE_SEGMENTS,
  wrapLoopT,
} from './config.js';
import * as geo from './geo.js';

const round = (x, n) => Number(x.toFixed(n));

/**
 * Payload data rate.
 *
 * 180 km swath at 30 m GSD is 6000 cross-track pixels; 96 bands at 12 bit,
 * read out at ground speed / GSD = 233 lines per second, is 1.61 Gbps raw.
 * At the ~4:1 the onboard compressor achieves on ocean scenes, 400 Mbps.
 */
export const PAYLOAD_RATE_MBPS = 400.0;
/** Housekeeping, ADCS, GPS and dark-frame calibration, always accumulating. */
export const HOUSEKEEPING_RATE_MBPS = 1.2;
export const RECORDER_CAPACITY_GB = 16.0;

const MBIT_TO_GB = 1 / 8000;   // megabits -> gigabytes

// ---------------------------------------------------------------------------
// Contact windows
// ---------------------------------------------------------------------------
let _passes = null;

/** Every station's contact windows over one orbit. Geometry, so cached. */
export function allPasses() {
  if (_passes) return _passes;
  _passes = GROUND_STATIONS.map((gs) => ({
    station: gs,
    windows: geo.stationPasses(gs),
  }));
  return _passes;
}

/** Total contact time per orbit, across the whole network. */
export function networkContactS() {
  return allPasses().reduce(
    (a, p) => a + p.windows.reduce((b, w) => b + w.duration_s, 0), 0,
  );
}

/**
 * Link state for one station at one orbit time.
 *
 * `next_aos_s` counts forward, wrapping the orbit, so the board always has a
 * countdown to show even when nothing is in view.
 */
export function stationLink(entry, orbitT) {
  const gs = entry.station;
  const p = geo.subsatellitePointAtOrbit(orbitT);
  const el = geo.elevationDeg(p.lat, p.lon, gs.lat, gs.lon);
  const rng = geo.slantRangeKm(p.lat, p.lon, gs.lat, gs.lon);

  const current = entry.windows.find(
    (w) => orbitT >= w.orbit_start_s && orbitT <= w.orbit_end_s,
  ) ?? null;

  // Nearest window that starts at or after now, wrapping to the next orbit.
  let next = null;
  let nextIn = Infinity;
  for (const w of entry.windows) {
    let d = w.orbit_start_s - orbitT;
    if (d < 0) d += ORBIT_PERIOD_S;
    if (d < nextIn) { nextIn = d; next = w; }
  }

  // Usable rate rolls off at low elevation: longer slant range, more
  // atmosphere, worse G/T. Full rate above 60 degrees.
  const rate = current ? round(gs.rate_mbps * Math.min(1, el / 60), 1) : 0;

  return {
    station_id: gs.id,
    name: gs.name,
    short: gs.short,
    band: gs.band,
    role: gs.role,
    lat: gs.lat,
    lon: gs.lon,
    elevation_deg: round(el, 2),
    slant_range_km: round(rng, 1),
    visible: Boolean(current),
    rate_mbps: rate,
    max_rate_mbps: gs.rate_mbps,
    pass: current ? {
      aos_orbit_s: current.orbit_start_s,
      los_orbit_s: current.orbit_end_s,
      duration_s: current.duration_s,
      peak_elevation_deg: current.peak_elevation_deg,
      elapsed_s: round(orbitT - current.orbit_start_s, 1),
      remaining_s: round(current.orbit_end_s - orbitT, 1),
      progress: round(
        (orbitT - current.orbit_start_s) / Math.max(1e-6, current.duration_s), 4,
      ),
    } : null,
    next_pass: next ? {
      in_s: round(nextIn, 1),
      duration_s: next.duration_s,
      peak_elevation_deg: next.peak_elevation_deg,
    } : null,
  };
}

/** The station currently carrying the link, or null. Highest rate wins. */
export function activeLink(links) {
  const up = links.filter((l) => l.visible && l.rate_mbps > 0);
  if (!up.length) return null;
  return up.reduce((a, b) => (b.rate_mbps > a.rate_mbps ? b : a));
}

// ---------------------------------------------------------------------------
// Solid-state recorder
// ---------------------------------------------------------------------------
const STEP_S = 0.1;

function segmentModeAt(loopT) {
  const t = wrapLoopT(loopT);
  for (const s of TIMELINE_SEGMENTS) {
    if (t >= s.start_s && t < s.end_s) return s.mode;
  }
  return TIMELINE_SEGMENTS[TIMELINE_SEGMENTS.length - 1].mode;
}

/**
 * Best available downlink rate at an orbit time, Mbps.
 *
 * The hot path: called ~70k times while the recorder and battery profiles
 * converge, so it walks the cached windows and computes one elevation per
 * visible station rather than building a link object per station per step.
 * Returns exactly what `activeLink` would pick.
 */
export function downlinkRateAtOrbit(orbitT) {
  let best = 0;
  for (const entry of allPasses()) {
    const gs = entry.station;
    for (const w of entry.windows) {
      if (orbitT >= w.orbit_start_s && orbitT <= w.orbit_end_s) {
        const p = geo.subsatellitePointAtOrbit(orbitT);
        const el = geo.elevationDeg(p.lat, p.lon, gs.lat, gs.lon);
        const rate = round(gs.rate_mbps * Math.min(1, el / 60), 1);
        if (rate > best) best = rate;
        break;
      }
    }
  }
  return best;
}

/** Downlink rate available at a loop time, Mbps — 0 when nothing is in view. */
export function downlinkRateAt(loopT) {
  return downlinkRateAtOrbit(geo.orbitSeconds(loopT));
}

/** True when the transmitter is keyed — drives the 9 W radio load. */
export function transmittingAt(loopT) {
  return downlinkRateAt(loopT) > 0;
}

let _recorder = null;

/**
 * Pre-integrated recorder fill across one loop, in gigabytes.
 *
 * Solved for the periodic steady state exactly as the battery is: an orbit
 * that ends with more data than it started with is an orbit whose recorder
 * overflows eventually, and a gauge that jumps at the wrap is a gauge nobody
 * believes. Integrated in real orbital time, so the warp does not change how
 * much data a pass produces.
 */
export function recorderProfile() {
  if (_recorder) return _recorder;
  const n = Math.floor(LOOP_DURATION_S / STEP_S) + 1;

  const integrate = (start) => {
    let gb = start;
    const out = [];
    for (let k = 0; k < n; k += 1) {
      const t = k * STEP_S;
      const realS = STEP_S * geo.timeCompression(t);
      const imaging = segmentModeAt(t) === 'ACTIVE';
      const inRate = (imaging ? PAYLOAD_RATE_MBPS : 0) + HOUSEKEEPING_RATE_MBPS;
      const outRate = downlinkRateAt(t);
      gb += (inRate - outRate) * realS * MBIT_TO_GB;
      gb = Math.max(0, Math.min(RECORDER_CAPACITY_GB, gb));
      out.push(gb);
    }
    return out;
  };

  let start = 0.4;
  let profile = integrate(start);
  for (let i = 0; i < 40; i += 1) {
    const drift = profile[profile.length - 1] - start;
    if (Math.abs(drift) < 1e-5) break;
    start = Math.max(0, Math.min(RECORDER_CAPACITY_GB, start + drift * 0.6));
    profile = integrate(start);
  }
  _recorder = profile;
  return profile;
}

export function recorderGb(loopT) {
  const profile = recorderProfile();
  const t = wrapLoopT(loopT);
  return round(profile[Math.min(Math.floor(t / STEP_S), profile.length - 1)], 4);
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------
export function commsState(loopT, mode) {
  const orbitT = geo.orbitSeconds(loopT);
  const links = allPasses().map((e) => stationLink(e, orbitT));
  const active = activeLink(links);
  const live = Boolean(active);
  const imaging = mode === 'ACTIVE';

  const gb = recorderGb(loopT);
  const inRate = (imaging ? PAYLOAD_RATE_MBPS : 0) + HOUSEKEEPING_RATE_MBPS;
  const outRate = active ? active.rate_mbps : 0;

  let state;
  if (live && imaging) state = 'LIVE DOWNLINK';
  else if (live) state = 'RECORDER DUMP';
  else if (mode === 'ECLIPSE') state = 'BEACON ONLY';
  else state = 'STANDBY';

  // Time to empty the recorder at the current rate, or fill it.
  const net = outRate - inRate;
  let drainS = null;
  if (live && net > 0) drainS = round(((gb / (net * MBIT_TO_GB))), 0);

  return {
    links,
    active_link: active ? active.station_id : null,
    active_station: active ? active.name : null,
    state,
    network_contact_s: round(networkContactS(), 0),
    network_duty_pct: round((networkContactS() / ORBIT_PERIOD_S) * 100, 1),
    downlink: {
      live,
      rate_mbps: outRate,
      modulation: live ? '8PSK 3/4 LDPC' : null,
      ber: live ? 1.8e-9 : null,
      eb_n0_db: live ? round(9.4 + active.elevation_deg / 30, 2) : null,
      elevation_deg: live ? active.elevation_deg : null,
    },
    recorder: {
      fill_gb: gb,
      capacity_gb: RECORDER_CAPACITY_GB,
      fill_pct: round((gb / RECORDER_CAPACITY_GB) * 100, 1),
      in_rate_mbps: round(inRate, 1),
      out_rate_mbps: outRate,
      net_mbps: round(outRate - inRate, 1),
      trend: outRate > inRate ? 'DRAINING' : (imaging ? 'FILLING FAST' : 'FILLING'),
      drain_eta_s: drainS,
    },
  };
}
