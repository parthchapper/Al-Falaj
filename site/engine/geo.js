/**
 * Geodesy and ground-track geometry — port of `worker/app/geo.py`.
 *
 * The loop covers exactly one orbital period and Earth's rotation is held
 * fixed, so the ground track is a closed great circle: the sub-satellite
 * point at the end of the loop is the point at the start, to 1e-13 degrees.
 *
 * A real sun-synchronous ground track does *not* close — Earth turns ~23.7°
 * west beneath the orbit each revolution, which is exactly how a 5-day repeat
 * cycle builds global coverage. Freezing that rotation is the one deliberate
 * simplification in the propagator, made so the demo loop has no seam. The
 * orbit itself — inclination, period, altitude, the shape of the track — is
 * unchanged, and `clock.earth_rotation` reports the simplification in every
 * frame. See docs/ARCHITECTURE.md.
 */
import {
  AOI, LOOP_DURATION_S, MIN_ELEVATION_DEG, ORBIT_PERIOD_S, SPACECRAFT,
  WARP, WARP_TABLE, warpDensity, wrapLoopT,
} from './config.js';

export const R_EARTH_KM = 6378.137;
export const MU_EARTH = 398600.4418;            // km^3 / s^2
export const EARTH_ROT_DEG_PER_MIN = 0.2506844; // reported, not applied

export const ALT_KM = SPACECRAFT.orbit.altitude_km;
export const INC_DEG = SPACECRAFT.orbit.inclination_deg;
export const PERIOD_S = ORBIT_PERIOD_S;
export const SWATH_KM = SPACECRAFT.payload.swath_km;

export const R_ORBIT_KM = R_EARTH_KM + ALT_KM;

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const round = (x, n) => Number(x.toFixed(n));

/**
 * Orbit phasing.
 *
 * Solved, not chosen: these are the two constants for which the descending
 * arc puts the sub-satellite point exactly over the AOI centre (24.6 N,
 * 54.2 E) at the midpoint of the ACTIVE segment. Change the segment layout
 * and they must be re-solved — `tools/solve_phase.py` does it.
 */
export const U0_DEG = 188.145597;        // argument of latitude at orbit t = 0
export const LON_ASC0_DEG = -129.250944; // ascending-node longitude at t = 0

// ---------------------------------------------------------------------------
// Time warp
// ---------------------------------------------------------------------------
/**
 * Orbit seconds elapsed at a given loop time — the inverse of the warp table.
 *
 * Binary search for the bracketing sample, then linear interpolation. The
 * table is monotone by construction (the density is strictly positive), so
 * the inverse is single-valued.
 */
export function orbitSeconds(loopT) {
  const t = wrapLoopT(loopT);
  const n = WARP.samples;
  const table = WARP_TABLE.loopAt;
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (table[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  const k = Math.max(1, lo);
  const t0 = table[k - 1];
  const t1 = table[k];
  const f = t1 <= t0 ? 0 : (t - t0) / (t1 - t0);
  return (PERIOD_S * ((k - 1) + f)) / n;
}

/** Orbit seconds elapsed per loop second at this point in the timeline. */
export function timeCompression(loopT) {
  const x = orbitSeconds(loopT) / PERIOD_S;
  return (PERIOD_S / LOOP_DURATION_S) * (WARP_TABLE.total / warpDensity(x));
}

/** Slowest and fastest the clock ever runs, for labelling the readout. */
export function compressionBounds() {
  const base = (PERIOD_S / LOOP_DURATION_S) * WARP_TABLE.total;
  return {
    min: round(base / warpDensity(WARP.phase_pass), 2),
    max: round(base / warpDensity(WARP.phase_pass + 0.5), 2),
  };
}

export const orbitalVelocityKms = () => Math.sqrt(MU_EARTH / R_ORBIT_KM);
export const groundSpeedKms = () => orbitalVelocityKms() * (R_EARTH_KM / R_ORBIT_KM);

const wrapLon = (lon) => (((lon + 180) % 360) + 360) % 360 - 180;

export function argumentOfLatitude(loopT) {
  return ((U0_DEG + 360.0 * (orbitSeconds(loopT) / PERIOD_S)) % 360 + 360) % 360;
}

/**
 * Geodetic sub-satellite point for a given loop time.
 *
 * A function of orbit phase alone. Because the phase advances by exactly 360°
 * over the loop and no rotation term is applied, subsatellitePoint(0) ===
 * subsatellitePoint(LOOP_DURATION_S): the track closes.
 */
export function subsatellitePointAtOrbit(orbitT) {
  const u = rad(((U0_DEG + 360.0 * (orbitT / PERIOD_S)) % 360 + 360) % 360);
  const i = rad(INC_DEG);
  const lat = deg(Math.asin(Math.sin(i) * Math.sin(u)));
  const dLon = deg(Math.atan2(Math.cos(i) * Math.sin(u), Math.cos(u)));
  return { lat, lon: wrapLon(LON_ASC0_DEG + dLon), alt_km: ALT_KM };
}

export function subsatellitePoint(loopT) {
  return subsatellitePointAtOrbit(orbitSeconds(loopT));
}

/**
 * Polyline of sub-satellite points, for drawing the orbit on the globe.
 *
 * Sampled evenly in *orbit* time rather than loop time, so the rendered track
 * has uniform spacing instead of bunching up inside the slow zone.
 */
export function groundTrack(samples = 240, spanS = LOOP_DURATION_S, startS = 0.0) {
  const out = [];
  const o0 = orbitSeconds(startS);
  const oSpan = spanS >= LOOP_DURATION_S
    ? PERIOD_S
    : orbitSeconds(startS + spanS) - o0;
  for (let k = 0; k <= samples; k += 1) {
    const ot = o0 + oSpan * (k / samples);
    const p = subsatellitePointAtOrbit(ot);
    out.push({ lat: round(p.lat, 5), lon: round(p.lon, 5) });
  }
  return out;
}

/**
 * Ground track over a span of *orbit* seconds.
 *
 * Used for the look-ahead: seven minutes of flight is the same piece of
 * geometry whether the clock is running at 4x or 124x, so a look-ahead
 * specified in loop seconds would stretch and shrink as the warp changed.
 */
export function groundTrackOrbit(samples, orbitSpanS, startOrbitS) {
  const span = Math.min(orbitSpanS, PERIOD_S);
  const out = [];
  for (let k = 0; k <= samples; k += 1) {
    const p = subsatellitePointAtOrbit(startOrbitS + span * (k / samples));
    out.push({ lat: round(p.lat, 5), lon: round(p.lon, 5) });
  }
  return out;
}

/** Instantaneous ground-track heading, degrees clockwise from north. */
export function headingDeg(loopT, dt = 0.5) {
  const ot = orbitSeconds(loopT);
  const a = subsatellitePointAtOrbit(ot - dt);
  const b = subsatellitePointAtOrbit(ot + dt);
  const dlon = rad(wrapLon(b.lon - a.lon));
  const la1 = rad(a.lat);
  const la2 = rad(b.lat);
  const y = Math.sin(dlon) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dlon);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** Great-circle destination point. */
function offset(lat, lon, bearingDeg, distKm) {
  const d = distKm / R_EARTH_KM;
  const br = rad(bearingDeg);
  const la1 = rad(lat);
  const lo1 = rad(lon);
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(br));
  const lo2 = lo1 + Math.atan2(
    Math.sin(br) * Math.sin(d) * Math.cos(la1),
    Math.cos(d) - Math.sin(la1) * Math.sin(la2),
  );
  return [deg(la2), wrapLon(deg(lo2))];
}

/** Left and right edge points of the instantaneous scan line. */
export function swathEdges(loopT) {
  const p = subsatellitePoint(loopT);
  const hdg = headingDeg(loopT);
  const half = SWATH_KM / 2;
  const [lLat, lLon] = offset(p.lat, p.lon, (hdg - 90 + 360) % 360, half);
  const [rLat, rLon] = offset(p.lat, p.lon, (hdg + 90) % 360, half);
  return {
    left: { lat: round(lLat, 5), lon: round(lLon, 5) },
    right: { lat: round(rLat, 5), lon: round(rLon, 5) },
  };
}

/**
 * Closed [lon, lat] ring covering everything imaged between two loop times.
 * Emitted GeoJSON-compatible so a UI can drop it straight into a map layer.
 */
export function swathPolygon(startS, endS, samples = 40) {
  const left = [];
  const right = [];
  for (let k = 0; k <= samples; k += 1) {
    const t = startS + (endS - startS) * (k / samples);
    const e = swathEdges(t);
    left.push([e.left.lon, e.left.lat]);
    right.push([e.right.lon, e.right.lat]);
  }
  const ring = left.concat(right.slice().reverse());
  ring.push(ring[0]);
  return ring;
}

export function greatCircleKm(lat1, lon1, lat2, lon2) {
  const la1 = rad(lat1);
  const la2 = rad(lat2);
  const dla = la2 - la1;
  const dlo = rad(lon2 - lon1);
  const a = Math.sin(dla / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dlo / 2) ** 2;
  return 2 * R_EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function inAOI(lat, lon) {
  const [w, s, e, n] = AOI.bbox;
  return lat >= s && lat <= n && lon >= w && lon <= e;
}

/** Straight-line range from the spacecraft to a point on the surface. */
export function slantRangeKm(lat, lon, targetLat, targetLon) {
  const arc = greatCircleKm(lat, lon, targetLat, targetLon) / R_EARTH_KM;
  return Math.sqrt(R_ORBIT_KM ** 2 + R_EARTH_KM ** 2
    - 2 * R_ORBIT_KM * R_EARTH_KM * Math.cos(arc));
}

/**
 * Elevation angle of the spacecraft as seen from a ground station.
 *
 *   tan(el) = (cos(gamma) - R_earth / R_orbit) / sin(gamma)
 *
 * where gamma is the central angle between station and sub-satellite point.
 * atan2 is used rather than acos because acos is even in gamma and therefore
 * reports a spacecraft on the far side of the planet as being overhead — the
 * horizon is at gamma = 22.4 deg for a 520 km orbit, and everything beyond it
 * must come back negative.
 */
export function elevationDeg(satLat, satLon, gsLat, gsLon) {
  const gamma = greatCircleKm(satLat, satLon, gsLat, gsLon) / R_EARTH_KM;
  return deg(Math.atan2(
    Math.cos(gamma) - R_EARTH_KM / R_ORBIT_KM,
    Math.sin(gamma),
  ));
}

// ---------------------------------------------------------------------------
// Acquisition / loss of signal
// ---------------------------------------------------------------------------
const PASS_STEP_S = 2.0;          // orbit seconds between visibility samples

/**
 * Every contact window with a station over one orbit, in loop time.
 *
 * Swept in orbit time at a fixed step and refined by bisection on the
 * horizon crossing, so the AOS and LOS marks are accurate to well under a
 * tenth of a loop second regardless of how the warp stretches that region.
 */
export function stationPasses(station) {
  const visible = (ot) => {
    const p = subsatellitePointAtOrbit(ot);
    return elevationDeg(p.lat, p.lon, station.lat, station.lon) >= MIN_ELEVATION_DEG;
  };
  const crossing = (a, b) => {
    let lo = a;
    let hi = b;
    for (let k = 0; k < 24; k += 1) {
      const mid = (lo + hi) / 2;
      if (visible(mid) === visible(a)) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };

  const out = [];
  let open = null;
  let prev = visible(0);
  if (prev) open = 0;
  for (let ot = PASS_STEP_S; ot <= PERIOD_S; ot += PASS_STEP_S) {
    const now = visible(ot);
    if (now && !prev) open = crossing(ot - PASS_STEP_S, ot);
    else if (!now && prev && open !== null) {
      out.push([open, crossing(ot - PASS_STEP_S, ot)]);
      open = null;
    }
    prev = now;
  }
  if (open !== null) out.push([open, PERIOD_S]);

  return out.map(([a, b]) => {
    // Peak elevation over the window.
    let peak = -90;
    let peakAt = a;
    const steps = 48;
    for (let k = 0; k <= steps; k += 1) {
      const ot = a + ((b - a) * k) / steps;
      const p = subsatellitePointAtOrbit(ot);
      const el = elevationDeg(p.lat, p.lon, station.lat, station.lon);
      if (el > peak) { peak = el; peakAt = ot; }
    }
    return {
      orbit_start_s: round(a, 1),
      orbit_end_s: round(b, 1),
      duration_s: round(b - a, 1),
      peak_elevation_deg: round(peak, 2),
      peak_orbit_s: round(peakAt, 1),
    };
  });
}
