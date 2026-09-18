/**
 * Mission state assembly — port of `worker/app/mission.py`.
 *
 * One pure function, `snapshot(slider)`, turns a timeline-slider position in
 * [0, 1] into the complete state of the spacecraft at that instant. Every
 * consumer — the console panels, the 3D globe, the downlink log — reads from
 * this one object, so nothing in the system can disagree with anything else.
 */
import {
  AOI, DESAL_PLANTS, GROUND_STATIONS, LOOP_DURATION_S, MODES, ORBIT_PERIOD_S,
  PROVENANCE, SPACECRAFT, TIMELINE_SEGMENTS, loopTimeAtOrbit, wrapLoopT,
} from './config.js';
import * as geo from './geo.js';
import * as power from './power.js';
import * as science from './science.js';
import * as commsMod from './comms.js';
import { impact } from './impact.js';
import { schedule } from './desalination.js';

const round = (x, n) => Number(x.toFixed(n));
const EPOCH = Date.UTC(2026, 8, 17, 6, 30, 0);   // 2026-09-17T06:30:00Z

// ---------------------------------------------------------------------------
// Slider <-> loop time
// ---------------------------------------------------------------------------
export const sliderToLoopT = (slider) => Math.max(0, Math.min(1, Number(slider))) * LOOP_DURATION_S;
export const loopTToSlider = (loopT) => round((wrapLoopT(loopT)) / LOOP_DURATION_S, 6);

/**
 * Slider position at the centre of a mode's segment — used when the console
 * clicks a mode button instead of dragging the slider.
 */
export function modeToSlider(mode) {
  // A mode can own more than one interval (SUN_FACING runs both before and
  // after the pass). Jump to the middle of the longest one.
  const segs = TIMELINE_SEGMENTS.filter((s) => s.mode === mode);
  if (!segs.length) throw new Error(`unknown mode: ${mode}`);
  const seg = segs.reduce((a, b) => ((b.end_s - b.start_s) > (a.end_s - a.start_s) ? b : a));
  return loopTToSlider((seg.start_s + seg.end_s) / 2);
}

export function segmentProgress(loopT) {
  const seg = power.segmentFor(loopT);
  const span = seg.end_s - seg.start_s;
  const t = wrapLoopT(loopT);
  return round((t - seg.start_s) / span, 4);
}

// ---------------------------------------------------------------------------
// Subsystems
// ---------------------------------------------------------------------------
/** Commanded pointing per mode, with a small deterministic jitter. */
export function attitude(loopT, mode) {
  const j0 = Math.sin(loopT * 1.7) * 0.012;
  const j1 = Math.cos(loopT * 2.3) * 0.011;
  let base;
  if (mode === 'ECLIPSE') {
    base = { mode: 'NADIR_HOLD', roll: 0, pitch: 0, yaw: 0, target: 'NADIR' };
  } else if (mode === 'SUN_FACING') {
    base = { mode: 'SUN_POINT', roll: -14.2, pitch: 3.1, yaw: 21.7, target: 'SUN_VECTOR' };
  } else {
    const p = geo.subsatellitePoint(loopT);
    const off = geo.greatCircleKm(p.lat, p.lon, AOI.center.lat, AOI.center.lon);
    base = {
      mode: 'TARGET_TRACK',
      roll: round(Math.max(-32, Math.min(32, off / 18)), 2),
      pitch: -1.4,
      yaw: 0.6,
      target: AOI.id,
    };
  }
  return {
    ...base,
    roll_deg: round(base.roll + j0, 3),
    pitch_deg: round(base.pitch + j1, 3),
    yaw_deg: round(base.yaw + j0 * 0.5, 3),
    rate_deg_s: round(0.004 + Math.abs(j0) * 2.1, 4),
    adcs_lock: true,
    star_tracker: mode !== 'ECLIPSE' ? 'LOCK (14 stars)' : 'LOCK (9 stars)',
  };
}

/** Ground-segment state — contact windows, link budget, recorder. */
export const comms = (loopT, mode) => commsMod.commsState(loopT, mode);

export function thermal(loopT, mode) {
  const segP = segmentProgress(loopT);
  let bus;
  let det;
  if (mode === 'ECLIPSE') { bus = 8.4 - 6.1 * segP; det = -38.0 - 4.5 * segP; }
  else if (mode === 'SUN_FACING') { bus = 2.3 + 9.4 * segP; det = -42.5 + 3.0 * segP; }
  else { bus = 11.7 + 5.2 * segP; det = -39.5 + 6.8 * segP; }
  return {
    bus_c: round(bus, 2),
    battery_c: round(bus * 0.7 + 4.0, 2),
    detector_c: round(det, 2),
    detector_setpoint_c: -40.0,
    tec_duty_pct: round(Math.max(0, Math.min(100, (det + 40) * 22 + 30)), 1),
    radiator_c: round(bus - 21.0, 2),
  };
}

export function payloadState(loopT, mode) {
  const seg = power.segmentFor(loopT);
  const segP = segmentProgress(loopT);
  const imaging = mode === 'ACTIVE';
  return {
    instrument: SPACECRAFT.payload.name,
    state: seg.payload_state,
    enabled: seg.payload_state !== 'DISABLED',
    imaging,
    shutter: imaging ? 'OPEN' : 'CLOSED',
    integration_ms: imaging ? 42.0 : null,
    bands_active: imaging ? SPACECRAFT.payload.bands : 0,
    gsd_m: SPACECRAFT.payload.gsd_m,
    swath_km: SPACECRAFT.payload.swath_km,
    frames_captured: imaging ? Math.floor(1240 * segP) : 0,
    scan_progress: imaging ? round(segP, 4) : 0,
  };
}

/**
 * Everything the 3D globe needs. Pure geometry — no rendering decisions, so
 * the same payload drives the three.js module, a 2D SVG map, or any other
 * view.
 */
export function mapGeometry(loopT, mode) {
  const p = geo.subsatellitePoint(loopT);
  const edges = geo.swathEdges(loopT);
  const seg = power.segmentFor(loopT);

  let swath = null;
  if (mode === 'ACTIVE') {
    swath = {
      type: 'Feature',
      properties: { aoi: AOI.id, instrument: SPACECRAFT.payload.name },
      geometry: { type: 'Polygon', coordinates: [geo.swathPolygon(seg.start_s, loopT)] },
    };
  }

  return {
    subsatellite: { lat: round(p.lat, 5), lon: round(p.lon, 5), alt_km: p.alt_km },
    heading_deg: round(geo.headingDeg(loopT), 2),
    ground_speed_kms: round(geo.groundSpeedKms(), 4),
    orbital_velocity_kms: round(geo.orbitalVelocityKms(), 4),
    scan_line: edges,
    swath_half_width_km: SPACECRAFT.payload.swath_km / 2,
    swath_covered: swath,
    // The loop is exactly one orbit and Earth rotation is frozen, so this
    // polyline is a closed ring — the globe draws a complete orbit, not an
    // arc with two loose ends.
    ground_track: geo.groundTrack(220),
    // Look-ahead is specified in *orbit* seconds, not loop seconds: 7 minutes
    // of flight is the same piece of geometry whether the clock is running at
    // 4x or 124x. Clamped at the period so it never wraps the whole planet.
    track_ahead: geo.groundTrackOrbit(40, 420, geo.orbitSeconds(loopT)),
    aoi: {
      id: AOI.id,
      name: AOI.name,
      bbox: AOI.bbox,
      center: AOI.center,
      over_aoi: geo.inAOI(p.lat, p.lon),
      range_to_center_km: round(
        geo.greatCircleKm(p.lat, p.lon, AOI.center.lat, AOI.center.lon), 1,
      ),
    },
    markers: [
      ...DESAL_PLANTS.map((d) => ({
        id: d.id, name: d.name, lat: d.lat, lon: d.lon, kind: 'DESALINATION',
      })),
      ...GROUND_STATIONS.map((g) => ({
        id: g.id, name: g.name, lat: g.lat, lon: g.lon, kind: 'GROUND_STATION',
      })),
    ],
  };
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------
export function snapshot(slider, { includeSchedule = true, includeTrack = true, startHour } = {}) {
  const loopT = sliderToLoopT(slider);
  const seg = power.segmentFor(loopT);
  const mode = seg.mode;

  const orbitT = geo.orbitSeconds(loopT);
  const simTime = new Date(EPOCH + orbitT * 1000);
  const p = geo.subsatellitePoint(loopT);

  const state = {
    schema: 'orbital-sentinel/state@1',
    spacecraft: {
      name: SPACECRAFT.name, norad_id: SPACECRAFT.norad_id, bus: SPACECRAFT.bus,
    },
    clock: {
      slider: round(Math.max(0, Math.min(1, slider)), 6),
      loop_t_s: round(loopT, 3),
      loop_duration_s: LOOP_DURATION_S,
      mission_time_utc: simTime.toISOString(),
      orbit_elapsed_s: round(orbitT, 1),
      orbit_period_s: ORBIT_PERIOD_S,
      orbit_progress: round(orbitT / ORBIT_PERIOD_S, 5),
      time_compression: round(geo.timeCompression(loopT), 2),
      compression_bounds: geo.compressionBounds(),
      time_compression_note: 'Orbit seconds per loop second. The rate varies '
        + 'continuously — fast while coasting, near real time over the UAE.',
      earth_rotation: 'HELD FIXED',
      earth_rotation_note: 'Earth rotation is frozen so the 90 s loop closes '
        + 'on itself. A real SSO track walks ~23.7° west per revolution; '
        + 'that is what builds the 5-day repeat cycle.',
      orbit_number: 4127,
    },
    mode: {
      id: mode,
      label: seg.label,
      banner: seg.banner,
      description: seg.description,
      segment: { start_s: seg.start_s, end_s: seg.end_s },
      progress: segmentProgress(loopT),
      all_modes: MODES,
      ui_flags: {
        dim_ui: mode === 'ECLIPSE',
        payload_disabled: mode === 'ECLIPSE',
        show_solar_gauges: mode === 'SUN_FACING' || mode === 'ACTIVE',
        show_map: mode === 'ACTIVE',
        show_spectroscopy: mode === 'ACTIVE',
        show_downlink: mode === 'ACTIVE',
        flash_banner: mode === 'ACTIVE',
      },
    },
    orbit: {
      ...SPACECRAFT.orbit,
      subsatellite: { lat: round(p.lat, 5), lon: round(p.lon, 5) },
      altitude_km: p.alt_km,
      argument_of_latitude_deg: round(geo.argumentOfLatitude(loopT), 3),
      eclipsed: mode === 'ECLIPSE',
    },
    power: power.powerState(loopT),
    attitude: attitude(loopT, mode),
    thermal: thermal(loopT, mode),
    payload: payloadState(loopT, mode),
    comms: comms(loopT, mode),
    map: includeTrack ? mapGeometry(loopT, mode) : null,
  };

  if (mode === 'ACTIVE') {
    state.science = science.spectrum(p.lat, p.lon, loopT);
    state.science.water_quality = science.plantWaterQuality(loopT);
  } else {
    state.science = null;
  }

  if (includeSchedule) {
    state.desalination = schedule(mode, loopT, startHour);
    state.impact = impact(state.desalination);
  }

  state.provenance = PROVENANCE;
  state.alerts = alerts(state);
  return state;
}

export function alerts(state) {
  const out = [];
  const b = state.power.battery;
  if (b.violated) {
    out.push({ level: 'CRITICAL', code: 'EPS-01', text: `Battery below flight-rule floor (${b.soc_pct} %).` });
  } else if (b.margin_to_floor_pct < 12) {
    out.push({ level: 'WARNING', code: 'EPS-02', text: `Battery margin ${b.margin_to_floor_pct} % to floor.` });
  }
  if (state.mode.id === 'ECLIPSE') {
    out.push({ level: 'INFO', code: 'OPS-10', text: 'Payload inhibited: eclipse power-saving profile.' });
  }
  if (state.comms.recorder.fill_pct > 70) {
    out.push({
      level: 'WARNING',
      code: 'CDH-04',
      text: `Solid-state recorder at ${state.comms.recorder.fill_pct} % `
        + `(${state.comms.recorder.fill_gb} / ${state.comms.recorder.capacity_gb} GB).`,
    });
  }
  if (state.comms.downlink.live) {
    out.push({
      level: 'INFO',
      code: 'COM-07',
      text: `${state.comms.active_station} contact: `
        + `${state.comms.downlink.rate_mbps.toFixed(1)} Mbps at `
        + `${state.comms.downlink.elevation_deg}° elevation.`,
    });
  }
  const sci = state.science;
  if (sci && sci.indices.bloom_index > 0.6) {
    out.push({
      level: 'WARNING',
      code: 'SCI-21',
      text: `Bloom ${sci.indices.severity}: Chl-a ${sci.indices.chl_a_mg_m3} mg/m3 at nadir.`,
    });
  }
  for (const pl of state.desalination?.plants ?? []) {
    if (pl.now.action === 'HOLD') {
      out.push({
        level: 'CRITICAL',
        code: 'DSL-30',
        text: `${pl.name}: suspend intake (${pl.now.score}/100).`,
      });
    }
  }
  const imp = state.impact?.total;
  if (imp && imp.at_risk_m3_day > 0) {
    out.push({
      level: imp.at_risk_pct > 35 ? 'CRITICAL' : 'WARNING',
      code: 'WTR-40',
      text: `${Math.round(imp.at_risk_m3_day).toLocaleString('en-US')} m³/day `
        + `of intake capacity at risk (${imp.at_risk_pct} % of network).`,
    });
  }
  return out;
}

/**
 * Coarse profile across the whole loop — lets the console draw the slider
 * track with its real power curve and mode bands behind it.
 */
export function timeline(samples = 120) {
  const rows = [];
  for (let k = 0; k <= samples; k += 1) {
    const s = k / samples;
    const t = sliderToLoopT(s);
    const seg = power.segmentFor(t);
    const tx = commsMod.transmittingAt(t);
    rows.push({
      slider: round(s, 5),
      loop_t_s: round(t, 2),
      mode: seg.mode,
      egress: seg.egress,
      soc_pct: power.stateOfChargePct(t),
      generation_w: power.generationW(seg.mode),
      load_w: power.loadsW(seg.mode, seg.payload_state, tx).total_w,
      compression: round(geo.timeCompression(t), 1),
      recorder_pct: round((commsMod.recorderGb(t) / commsMod.RECORDER_CAPACITY_GB) * 100, 1),
      transmitting: tx,
    });
  }
  return {
    segments: TIMELINE_SEGMENTS,
    samples: rows,
    soc_envelope: power.socBounds(),
    compression_bounds: geo.compressionBounds(),
    contacts: commsMod.allPasses().map((e) => ({
      station_id: e.station.id,
      short: e.station.short,
      windows: e.windows.map((w) => ({
        ...w,
        loop_start_s: round(loopTimeAtOrbit(w.orbit_start_s), 3),
        loop_end_s: round(loopTimeAtOrbit(w.orbit_end_s), 3),
      })),
    })),
  };
}

/** Static mission definition, matching GET /api/mission/config. */
export function missionConfig() {
  return {
    spacecraft: SPACECRAFT,
    timeline: { loop_duration_s: LOOP_DURATION_S, segments: TIMELINE_SEGMENTS, modes: MODES },
    aoi: AOI,
    ground_stations: GROUND_STATIONS,
    desal_plants: DESAL_PLANTS,
    provenance: PROVENANCE,
    derived: {
      orbital_velocity_kms: round(geo.orbitalVelocityKms(), 4),
      ground_speed_kms: round(geo.groundSpeedKms(), 4),
      array_peak_w: round(power.PEAK_ARRAY_W, 2),
      soc_envelope: power.socBounds(),
      compression_bounds: geo.compressionBounds(),
      orbit_period_s: ORBIT_PERIOD_S,
      network_contact_s: round(commsMod.networkContactS(), 0),
      recorder_capacity_gb: commsMod.RECORDER_CAPACITY_GB,
      loop_closes: true,
    },
  };
}
