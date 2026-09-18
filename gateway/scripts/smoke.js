/**
 * End-to-end smoke test.
 *
 * Exercises every REST route and the telemetry socket against a running
 * stack, and asserts the things that would actually embarrass a demo:
 * the three modes appear in the right places on the slider, the battery
 * drains in eclipse and recovers in sun, the swath only exists in ACTIVE,
 * and the desalination scores move when the mode does.
 *
 *   node scripts/smoke.js [baseUrl]
 */
import { WebSocket } from 'ws';

const BASE = process.argv[2] ?? process.env.BASE_URL ?? 'http://127.0.0.1:8800';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  ok   ${name}`); }
  else { failed += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const get = async (p) => {
  const r = await fetch(`${BASE}${p}`);
  if (!r.ok) throw new Error(`${p} -> ${r.status}`);
  return r.json();
};
const post = async (p, body) => {
  const r = await fetch(`${BASE}${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${p} -> ${r.status}`);
  return r.json();
};

async function main() {
  console.log(`\nORBITAL SENTINEL smoke test -> ${BASE}\n`);

  // --- health --------------------------------------------------------------
  console.log('health');
  const h = await get('/health');
  check('gateway reports ok', h.status === 'ok', h.status);
  check('worker reachable', h.worker.reachable === true, h.worker.error ?? '');

  // --- config --------------------------------------------------------------
  console.log('\nmission config');
  const cfg = await get('/api/mission/config');
  check('three modes defined', cfg.timeline.modes.length === 3, cfg.timeline.modes.join(','));
  check('90 s loop', cfg.timeline.loop_duration_s === 90);
  check('loop is exactly one orbital period', cfg.derived.loop_closes === true);
  check('clock rate varies by more than 10x across the orbit',
    cfg.derived.compression_bounds.max / cfg.derived.compression_bounds.min > 10,
    `${cfg.derived.compression_bounds.min}x - ${cfg.derived.compression_bounds.max}x`);
  check('three ground stations in the network', cfg.ground_stations.length === 3,
    cfg.ground_stations.map((g) => g.id).join(','));
  check('network has real contact time', cfg.derived.network_contact_s > 600,
    `${cfg.derived.network_contact_s} s`);
  check('every panel has a provenance line',
    Object.keys(cfg.provenance ?? {}).length >= 8);
  check('array peak power plausible (25-60 W)',
    cfg.derived.array_peak_w > 25 && cfg.derived.array_peak_w < 60, `${cfg.derived.array_peak_w} W`);
  check('orbital velocity ~7.6 km/s',
    Math.abs(cfg.derived.orbital_velocity_kms - 7.6) < 0.1, cfg.derived.orbital_velocity_kms);

  // --- modes across the slider --------------------------------------------
  console.log('\nmode segmentation');
  const probes = [
    [0.05, 'ECLIPSE'], [0.15, 'ECLIPSE'],
    [0.25, 'SUN_FACING'], [0.50, 'SUN_FACING'],
    [0.60, 'ACTIVE'], [0.70, 'ACTIVE'], [0.80, 'ACTIVE'],
    [0.95, 'SUN_FACING'],
  ];
  const states = {};
  for (const [s, expect] of probes) {
    const st = await get(`/api/mission/state?slider=${s}`);
    states[s] = st;
    check(`slider ${s} -> ${expect}`, st.mode.id === expect, st.mode.id);
  }

  // --- ui flags ------------------------------------------------------------
  console.log('\nui flags');
  check('ECLIPSE dims + disables payload',
    states[0.05].mode.ui_flags.dim_ui && states[0.05].mode.ui_flags.payload_disabled);
  check('ECLIPSE banner is POWER SAVING', states[0.05].mode.banner === 'POWER SAVING');
  check('SUN_FACING shows solar gauges', states[0.25].mode.ui_flags.show_solar_gauges);
  check('SUN_FACING payload standby-charging',
    states[0.25].payload.state === 'STANDBY_CHARGING');
  check('ACTIVE banner is TARGET ACQUIRED', states[0.60].mode.banner === 'TARGET ACQUIRED');
  check('ACTIVE shows map + spectroscopy + downlink',
    states[0.60].mode.ui_flags.show_map &&
    states[0.60].mode.ui_flags.show_spectroscopy &&
    states[0.60].mode.ui_flags.show_downlink);

  // --- power ---------------------------------------------------------------
  console.log('\npower model');
  check('eclipse generation is zero', states[0.05].power.generation_w === 0);
  check('eclipse is discharging', states[0.05].power.flow === 'DISCHARGING');
  check('battery drains across eclipse',
    states[0.15].power.battery.soc_pct < states[0.05].power.battery.soc_pct,
    `${states[0.05].power.battery.soc_pct} -> ${states[0.15].power.battery.soc_pct}`);
  check('sun-facing generates power', states[0.25].power.generation_w > 30);
  check('battery recovers in sun',
    states[0.50].power.battery.soc_pct > states[0.25].power.battery.soc_pct,
    `${states[0.25].power.battery.soc_pct} -> ${states[0.50].power.battery.soc_pct}`);
  check('never violates the flight-rule floor',
    Object.values(states).every((s) => !s.power.battery.violated));
  check('gauge window is zoomed to the real envelope',
    states[0.05].power.gauge.max_pct - states[0.05].power.gauge.min_pct < 40);

  // --- geometry ------------------------------------------------------------
  console.log('\nmap geometry');
  const active = states[0.80];
  check('ACTIVE subpoint is over the AOI', active.map.aoi.over_aoi === true,
    `${active.map.subsatellite.lat}, ${active.map.subsatellite.lon}`);
  check('swath polygon present in ACTIVE', Boolean(active.map.swath_covered));
  check('no swath polygon in ECLIPSE', states[0.05].map.swath_covered === null);
  check('scan line spans ~180 km', (() => {
    const a = active.map.scan_line.left; const b = active.map.scan_line.right;
    const d = Math.hypot((a.lat - b.lat) * 111, (a.lon - b.lon) * 111 * Math.cos(a.lat * Math.PI / 180));
    return Math.abs(d - 180) < 12;
  })());
  check('ground track is continuous', active.map.ground_track.length > 100);

  const gj = await get('/api/map/geojson?slider=0.70');
  check('geojson is a valid FeatureCollection',
    gj.type === 'FeatureCollection' && gj.features.length >= 5, `${gj.features?.length} features`);
  const boot = await get('/api/map/bootstrap');
  check('bootstrap carries markers + track',
    boot.markers.length >= 4 && boot.ground_track.length > 200);

  // --- science -------------------------------------------------------------
  console.log('\nscience');
  check('no science outside ACTIVE', states[0.25].science === null);
  const sci = active.science;
  check('96 spectral bands', sci.bands.length === 96, sci.bands.length);
  check('bands span 400-900 nm',
    sci.bands[0].nm === 400 && sci.bands[sci.bands.length - 1].nm === 900);
  check('normalised bands in [0,1]', sci.bands.every((b) => b.norm >= 0 && b.norm <= 1.0001));
  check('diagnostic features labelled', sci.features.length === 8);
  check('chl-a in a physical range',
    sci.indices.chl_a_mg_m3 > 0 && sci.indices.chl_a_mg_m3 < 40, sci.indices.chl_a_mg_m3);
  check('severity label assigned', typeof sci.indices.severity === 'string');

  const field = await get('/api/science/field?slider=0.70&nx=32&ny=16');
  check('field grid sized correctly', field.values.length === 32 * 16, field.values.length);

  // --- desalination --------------------------------------------------------
  console.log('\ndesalination scheduler');
  const desal = active.desalination;
  check('both plants present', desal.plants.length === 2,
    desal.plants.map((p) => p.plant_id).join(','));
  check('Jebel Ali and Fujairah named',
    desal.plants.some((p) => p.plant_id === 'JEBEL_ALI') &&
    desal.plants.some((p) => p.plant_id === 'FUJAIRAH'));
  check('24-hour schedule per plant', desal.plants.every((p) => p.hourly.length === 24));
  check('best window carries an action',
    desal.plants.every((p) => ['DRAW', 'REDUCE', 'HOLD'].includes(p.best_window.action)));
  check('scores bounded 0-100',
    desal.plants.every((p) => p.hourly.every((h) => h.score >= 0 && h.score <= 100)));
  check('confidence rises with mode quality',
    active.desalination.plants[0].observation.confidence >
    states[0.05].desalination.plants[0].observation.confidence,
    `${states[0.05].desalination.plants[0].observation.confidence} -> ${active.desalination.plants[0].observation.confidence}`);
  check('rationale text is non-trivial',
    desal.plants.every((p) => p.rationale.length > 60));

  // --- ground segment ------------------------------------------------------
  console.log('\nground segment');
  const links = active.comms.links;
  check('three stations reported', links.length === 3,
    links.map((l) => l.station_id).join(','));
  check('a station is in view during the pass', links.some((l) => l.visible));
  check('every station has a next-pass countdown',
    links.every((l) => l.next_pass && l.next_pass.in_s >= 0));
  check('elevations are physical (-90 to 90)',
    links.every((l) => l.elevation_deg >= -90 && l.elevation_deg <= 90));
  check('a station below the horizon reports negative elevation',
    Object.values(states).some((st) => st.comms.links.some((l) => l.elevation_deg < 0)));
  check('recorder is within capacity',
    active.comms.recorder.fill_gb >= 0
    && active.comms.recorder.fill_gb <= active.comms.recorder.capacity_gb,
    `${active.comms.recorder.fill_gb} GB`);
  check('radio draws transmit power only when keyed',
    Object.values(states).every(
      (st) => (st.power.transmitting ? st.power.loads.radio_w > 5
        : st.power.loads.radio_w < 5)));

  // --- the closed loop and the warp ---------------------------------------
  console.log('\nclosed loop + time warp');
  const first = await get('/api/mission/state?slider=0&schedule=false');
  const last = await get('/api/mission/state?slider=1&schedule=false');
  const dLat = Math.abs(first.map.subsatellite.lat - last.map.subsatellite.lat);
  const dLon = Math.abs(first.map.subsatellite.lon - last.map.subsatellite.lon);
  check('ground track closes on itself', dLat < 1e-6 && dLon < 1e-6,
    `d=${Math.max(dLat, dLon).toExponential(2)} deg`);
  check('Earth rotation disclosed in every frame',
    first.clock.earth_rotation === 'HELD FIXED');
  check('clock slows into the pass',
    states[0.70].clock.time_compression < states[0.05].clock.time_compression / 5,
    `${states[0.05].clock.time_compression}x -> ${states[0.70].clock.time_compression}x`);

  // --- water-security impact ----------------------------------------------
  console.log('\nwater security');
  const imp = active.impact;
  check('impact present with both plants', imp.plants.length === 2);
  check('24-hour peak forecast present', imp.peak != null && imp.peak.in_h >= 0);
  check('capacity at risk never exceeds rated capacity',
    imp.total.at_risk_m3_day <= imp.total.capacity_m3_day + 1);
  check('at-risk volume is consistent with the stated per-capita basis',
    Math.abs(imp.total.people_at_risk * imp.basis.per_capita_m3_day
      - imp.total.at_risk_m3_day) < 1,
    `${imp.total.people_at_risk} people`);
  check('impact basis is stated, not implied',
    imp.basis.note.length > 40 && imp.basis.m3_per_migd > 4000);

  // --- control -------------------------------------------------------------
  console.log('\ncontrol surface');
  const m = await post('/api/mission/mode', { mode: 'ACTIVE' });
  check('mode POST snaps the slider', m.mode.id === 'ACTIVE', m.mode.id);
  const sl = await post('/api/mission/slider', { slider: 0.1 });
  check('slider POST moves the clock', Math.abs(sl.slider - 0.1) < 1e-6, sl.slider);
  check('slider 0.1 is ECLIPSE', sl.mode.id === 'ECLIPSE');
  const tr = await post('/api/mission/transport', { playing: false });
  check('transport pause accepted', tr.playing === false);
  await post('/api/mission/transport', { playing: true });

  // --- telemetry socket ----------------------------------------------------
  console.log('\ntelemetry websocket');
  await new Promise((resolve) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws/telemetry?channels=state,map,downlink,event`);
    const seen = new Set();
    let hello = false;
    let lines = 0;

    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      check('hello frame received', hello);
      check('map frames streaming', seen.has('map'));
      check('state frames streaming', seen.has('state'));
      check('downlink lines streaming', lines > 0, `${lines} lines`);
      ws.close();
      resolve();
    };

    const timer = setTimeout(done, 6000);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'hello') hello = true;
      if (msg.channel) seen.add(msg.channel);
      if (msg.channel === 'downlink') lines += msg.lines?.length ?? 0;
      if (hello && seen.has('map') && seen.has('state') && lines > 0) {
        clearTimeout(timer);
        done();
      }
    });
    ws.on('error', (e) => { check('websocket connects', false, e.message); clearTimeout(timer); resolve(); });
  });

  // --- determinism ---------------------------------------------------------
  console.log('\ndeterminism');
  const a = await get('/api/mission/state?slider=0.70&schedule=false');
  const b = await get('/api/mission/state?slider=0.70&schedule=false');
  check('same slider -> identical state',
    JSON.stringify(a.map) === JSON.stringify(b.map) &&
    JSON.stringify(a.science?.indices) === JSON.stringify(b.science?.indices));

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\nsmoke test aborted:', err.message, '\n');
  process.exit(2);
});
