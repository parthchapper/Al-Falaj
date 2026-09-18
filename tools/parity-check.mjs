/**
 * JS / Python parity harness.
 *
 * The static site runs a JavaScript port of the Python mission worker so it
 * can be hosted with no server at all. Two implementations of one model is a
 * standing invitation to drift, so this compares them value by value across
 * the whole slider range and fails on any disagreement beyond floating-point
 * noise.
 *
 *   python3 tools/dump_reference.py     # regenerate after changing worker/app/
 *   node    tools/parity-check.mjs
 *
 * No server and no dependencies on either side — the reference is a JSON
 * file produced by importing the Python model directly, which means this
 * runs in CI without installing FastAPI or starting anything.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as mission from '../site/engine/mission.js';
import * as power from '../site/engine/power.js';
import * as science from '../site/engine/science.js';
import * as geo from '../site/engine/geo.js';
import * as comms from '../site/engine/comms.js';
import { TIMELINE_SEGMENTS, LOOP_DURATION_S } from '../site/engine/config.js';
import { schedule } from '../site/engine/desalination.js';
import { impact } from '../site/engine/impact.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REF_PATH = process.argv[2] ?? resolve(__dirname, 'reference.json');

const TOL = 1e-6;          // absolute tolerance
const REL_TOL = 1e-9;      // relative tolerance for large magnitudes

let checks = 0;
const failures = [];

function near(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number') return a === b;
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  const diff = Math.abs(a - b);
  return diff <= TOL || diff <= Math.abs(b) * REL_TOL;
}

/** Recursive comparison that reports the exact path of any mismatch. */
function compare(path, js, py, skip = new Set()) {
  if (skip.has(path)) return;
  checks += 1;

  if (py === null || py === undefined) {
    if (js !== null && js !== undefined) failures.push(`${path}: js=${JSON.stringify(js)} py=${py}`);
    return;
  }
  if (typeof py === 'number') {
    if (!near(js, py)) failures.push(`${path}: js=${js} py=${py} (Δ=${Math.abs(js - py)})`);
    return;
  }
  if (typeof py === 'string' || typeof py === 'boolean') {
    // ISO-8601 timestamps serialise differently on the two sides: Python
    // writes "+00:00" and microseconds, JS writes "Z" and milliseconds.
    // Compare the instant, not the spelling, allowing 1 ms for the fact that
    // a JS Date has no sub-millisecond resolution.
    if (typeof py === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(py)) {
      const a = Date.parse(js);
      const b = Date.parse(py);
      if (!Number.isNaN(a) && !Number.isNaN(b)) {
        if (Math.abs(a - b) > 1) failures.push(`${path}: js=${js} py=${py}`);
        return;
      }
    }
    if (js !== py) failures.push(`${path}: js=${JSON.stringify(js)} py=${JSON.stringify(py)}`);
    return;
  }
  if (Array.isArray(py)) {
    if (!Array.isArray(js) || js.length !== py.length) {
      failures.push(`${path}: length js=${js?.length} py=${py.length}`);
      return;
    }
    py.forEach((v, i) => compare(`${path}[${i}]`, js[i], v, skip));
    return;
  }
  if (typeof py === 'object') {
    for (const k of Object.keys(py)) compare(`${path}.${k}`, js?.[k], py[k], skip);
  }
}

const section = (name, fn) => {
  const mark = failures.length;
  fn();
  const delta = failures.length - mark;
  console.log(`  ${delta ? 'MISMATCH' : 'match   '}  ${name}`);
};

// Wall-clock fields that legitimately differ between a dump and a live run.
const SKIP = new Set(['desalination.generated_at']);

function main() {
  const ref = JSON.parse(readFileSync(REF_PATH, 'utf8'));
  console.log(`\nJS / Python parity check`);
  console.log(`reference: ${REF_PATH}\n`);

  section('derived constants + power envelope', () => {
    compare('derived.orbital_velocity_kms',
      Number(geo.orbitalVelocityKms().toFixed(4)), ref.derived.orbital_velocity_kms);
    compare('derived.ground_speed_kms',
      Number(geo.groundSpeedKms().toFixed(4)), ref.derived.ground_speed_kms);
    compare('derived.array_peak_w',
      Number(power.PEAK_ARRAY_W.toFixed(2)), ref.derived.array_peak_w);
    compare('derived.soc_envelope', power.socBounds(), ref.derived.soc_envelope);
    compare('derived.compression_bounds', geo.compressionBounds(),
      ref.derived.compression_bounds);
    compare('derived.network_contact_s',
      Number(comms.networkContactS().toFixed(0)), ref.derived.network_contact_s);
  });

  // The timeline is now derived from the warp rather than hard-coded, so a
  // change to the warp silently moves every mode boundary. Check them.
  section(`timeline segments (${ref.segments.length})`, () => {
    compare('segments', TIMELINE_SEGMENTS, ref.segments);
  });

  // The whole point of the redesign: the ground track has to close.
  section('loop closure', () => {
    const a = geo.subsatellitePoint(0);
    const b = geo.subsatellitePoint(LOOP_DURATION_S);
    compare('closure.start.lat', Number(a.lat.toFixed(9)), ref.closure.start.lat);
    compare('closure.start.lon', Number(a.lon.toFixed(9)), ref.closure.start.lon);
    compare('closure.end.lat', Number(b.lat.toFixed(9)), ref.closure.end.lat);
    compare('closure.end.lon', Number(b.lon.toFixed(9)), ref.closure.end.lon);
    const delta = Math.max(Math.abs(a.lat - b.lat), Math.abs(a.lon - b.lon));
    checks += 1;
    if (delta > 1e-9) {
      failures.push(`closure: track does not close, delta=${delta} deg`);
    }
  });

  // A table-driven inverse is easy to get subtly wrong (off-by-one in the
  // binary search, different interpolation). Sample the curve directly.
  section(`time warp (${ref.warp.length} samples)`, () => {
    for (const row of ref.warp) {
      compare(`warp@${row.loop_t_s}.orbit_s`,
        Number(geo.orbitSeconds(row.loop_t_s).toFixed(6)), row.orbit_s);
      compare(`warp@${row.loop_t_s}.compression`,
        Number(geo.timeCompression(row.loop_t_s).toFixed(6)), row.compression);
    }
  });

  section(`ground-station contacts (${ref.contacts.length} stations)`, () => {
    const js = comms.allPasses().map((e) => ({
      station_id: e.station.id, windows: e.windows,
    }));
    compare('contacts', js, ref.contacts);
  });

  // The value-noise hash is the single easiest thing to port incorrectly:
  // Python does exact big-integer arithmetic, JS needs Math.imul and a
  // rewritten seed term. If this passes, the field is bit-for-bit right.
  section(`chlorophyll field (${ref.field.values.length} cells)`, () => {
    const js = science.algaeField(ref.field.bbox, mission.sliderToLoopT(0.70),
      ref.field.nx, ref.field.ny);
    compare('field.max', js.max, ref.field.max);
    compare('field.values', js.values, ref.field.values);
  });

  for (const s of ref.sliders) {
    const py = ref.states[String(s)];
    section(`state @ slider ${String(s).padEnd(6)} ${py.mode.id}`, () => {
      const js = mission.snapshot(s, { includeSchedule: false });
      compare('state', js, py, SKIP);
    });
  }

  section(`spectrum (${ref.spectrum.bands.length} bands + ${ref.spectrum.features.length} features)`, () => {
    const t = mission.sliderToLoopT(0.70);
    const p = geo.subsatellitePoint(t);
    compare('spectrum', science.spectrum(p.lat, p.lon, t, 96), ref.spectrum);
  });

  let jsSchedule = null;
  section('desalination (2 plants x 24 h)', () => {
    const t = mission.sliderToLoopT(0.70);
    jsSchedule = schedule('ACTIVE', t, ref.pinned_hour);
    compare('desalination.plants', jsSchedule.plants, ref.desalination.plants, SKIP);
    compare('desalination.network_score', jsSchedule.network_score,
      ref.desalination.network_score);
    compare('desalination.network_band', jsSchedule.network_band,
      ref.desalination.network_band);
  });

  section('water-security impact', () => {
    compare('impact', impact(jsSchedule), ref.impact);
  });

  console.log(`\n${checks.toLocaleString()} values compared`);
  if (failures.length) {
    console.log(`\n${failures.length} MISMATCHES:\n`);
    for (const f of failures.slice(0, 40)) console.log(`  ${f}`);
    if (failures.length > 40) console.log(`  … and ${failures.length - 40} more`);
    console.log('');
    process.exit(1);
  }
  console.log('the browser engine and the Python worker agree everywhere\n');
}

main();
