# Integrating the console UI

This backend is built to be driven by an LCARS-style console that it does
not contain. Here is the wiring.

---

## 1. Mount the globe

Two lines of import map, one call.

```html
<div id="globe" style="position:absolute; inset:0"></div>

<script type="importmap">
  { "imports": { "three": "http://localhost:8800/vendor/three.module.js" } }
</script>

<script type="module">
  import { mount } from 'http://localhost:8800/map3d/index.js';

  const { globe, link } = await mount(document.getElementById('globe'), {
    baseUrl: 'http://localhost:8800',
    followSatellite: false,     // true to chase the spacecraft
    refocusOnActive: true,      // fly to the UAE when ACTIVE begins
  });
</script>
```

`mount` connects the socket, feeds the globe, and keeps the science overlays
in step. If the host wants to own that wiring, use the pieces directly:

```js
import { OrbitalSentinelGlobe, SentinelLink } from '/map3d/index.js';

const link  = new SentinelLink({ baseUrl, channels: ['map', 'state', 'downlink', 'event'] });
const globe = new OrbitalSentinelGlobe(container, { autoRotate: true });

await globe.init(await link.bootstrap());
link.on('map', (frame) => globe.applyTelemetry(frame));
await link.connect();
```

The globe never touches the network on its own — `applyTelemetry` and
`applyScience` are the only ways data gets in.

### Globe API

| Call | Effect |
|---|---|
| `globe.applyTelemetry(mapFrame)` | Move satellite, scan line, swath, terminator |
| `globe.applyScience({ water_quality, field })` | Recolour plant markers, repaint the Chl-a overlay |
| `globe.setMode(mode)` | Ease the whole scene into that mode's treatment |
| `globe.focusAOI({ distance })` / `focusOn(lat, lon)` | Camera flight, eased |
| `globe.resetView()` | Back to the default framing |
| `globe.on('pick', ({lat, lon}) => …)` | Click-to-pick a surface point |
| `globe.on('mode', ({from, to}) => …)` | Mode-change hook |
| `globe.dispose()` | Full teardown |

A useful pattern: `globe.on('pick', ({lat, lon}) => link.spectrum({ lat, lon }))`
lets the viewer click any point on the globe and see its spectrum. For an
investor demo that is the single most convincing interaction available —
it turns the map from a picture into an instrument.

---

## 2. Drive the layout from `ui_flags`

Do not re-derive mode logic in the front end. Listen for the event and flip
classes.

```js
link.on(':mode', ({ to, banner, ui_flags }) => {
  document.body.dataset.mode = to;                        // ECLIPSE | SUN_FACING | ACTIVE
  for (const [flag, on] of Object.entries(ui_flags)) {
    document.body.classList.toggle(flag, on);             // dim_ui, show_map, ...
  }
  bannerEl.textContent = banner;                          // POWER SAVING / TARGET ACQUIRED
});
```

```css
body { transition: filter .6s ease, background-color .6s ease; }
body.dim_ui { filter: brightness(.55) saturate(.7); }

#map-panel, #spectro-panel, #downlink-panel {
  opacity: 0; transform: translateX(-24px);
  transition: opacity .45s ease, transform .45s cubic-bezier(.2,.8,.2,1);
  pointer-events: none;
}
body.show_map #map-panel,
body.show_spectroscopy #spectro-panel,
body.show_downlink #downlink-panel {
  opacity: 1; transform: none; pointer-events: auto;
}

body.flash_banner #banner { animation: alert 1.1s steps(2, end) infinite; }
@keyframes alert { 50% { opacity: .25; } }

@media (prefers-reduced-motion: reduce) {
  body, #map-panel, #spectro-panel, #downlink-panel { transition-duration: .01ms; }
  body.flash_banner #banner { animation: none; }
}
```

Transitioning `opacity` and `transform` only keeps the layout shift on the
compositor. Do not animate `width`, `height` or `display`.

---

## 3. Palette

The module exports the same three colours the console uses, so the 2D chrome
and the 3D scene cannot drift apart:

```js
import { PALETTE, MODE_THEME, sampleRamp } from '/map3d/palette.js';
// PALETTE.cyan  0x00f3ff   structure, nominal data
// PALETTE.amber 0xffaa00   energy, attention, the AOI
// PALETTE.red   0xff2d2d   alarms only
// sampleRamp(t) -> bloom severity colour, matching the globe overlay exactly
```

Map log severities straight onto it: `NOMINAL` → cyan, `INFO` → dim cyan,
`WARN` → amber, `CRIT` → red, `SCIENCE` → white.

Suggested type stack: `ui-monospace, "JetBrains Mono", "IBM Plex Mono",
"SF Mono", Menlo, Consolas, monospace`.

---

## 4. The timeline slider

```js
const slider = document.getElementById('timeline');

slider.addEventListener('pointerdown', () => link.scrub(true));
slider.addEventListener('input',  () => link.seek(Number(slider.value)));   // over the socket, not REST
slider.addEventListener('pointerup',   () => link.scrub(false));

// Mode buttons snap to a segment centre:
document.querySelectorAll('[data-mode]').forEach((b) =>
  b.addEventListener('click', () => link.setMode(b.dataset.mode)));
```

`scrub(true)` holds playback while the thumb is down; without it autoplay
fights the drag and the thumb stutters.

Draw the slider track over its real data — `GET /api/mission/timeline?samples=120`
returns mode bands *and* the SoC curve across the loop, so the track can show
the battery profile behind the thumb instead of being an empty bar. That one
detail does more for "this is a real spacecraft" than any amount of chrome.

---

## 5. The spectroscopy graph

Every band row carries `norm` in 0–1, so bars need no client-side scaling:

```js
const { bands, features, indices } = await link.spectrum({ slider });

ctx.clearRect(0, 0, W, H);
const bw = W / bands.length;
for (const [i, b] of bands.entries()) {
  // Colour by wavelength so the graph reads as a spectrum, not a bar chart.
  ctx.fillStyle = b.nm < 500 ? '#2d7dff' : b.nm < 600 ? '#00f3ff'
                : b.nm < 700 ? '#ffaa00' : '#ff2d2d';
  ctx.fillRect(i * bw, H - b.norm * H, bw - 1, b.norm * H);
}

// Annotate the diagnostic lines — this is what makes it instructive
// rather than decorative.
for (const f of features) {
  const x = ((f.nm - 400) / 500) * W;
  label(x, f.name, f.kind);          // e.g. "Sun-induced fluorescence"
}
```

Put `indices.chl_a_mg_m3`, `indices.severity` and `indices.mci` beside the
graph. The 681 nm fluorescence peak is the one to point at in a pitch: it
only appears over *live* algae, which is precisely why the measurement is
worth making from orbit.

---

## 6. The desalination prediction box

```js
const { plants } = await link.desalination(slider);

for (const p of plants) {
  render(`
    ${p.name}  ·  ${p.capacity_migd} MIGD  ·  ${p.sea}
    NOW           ${p.now.score}/100   ${p.now.action}   ${p.now.band}
                  ${p.now.text}
    BEST WINDOW   ${p.best_window.label}   (+${p.best_window.in_hours} h)
    AVOID         ${p.avoid_window.label}
    CHL-A         ${p.observation.chl_a_mg_m3} mg/m³  ${p.observation.severity}
    CONFIDENCE    ${(p.observation.confidence * 100) | 0} %   (data age ${p.observation.data_age_min} min)
    ${p.rationale}
  `);
}
```

Make `p.hourly` expandable into a 24-bar strip, and each bar's `terms`
object into a tooltip. When someone asks "why 06:00?", the answer is already
in the payload: no stratification before dawn, tide running, live retrieval.

Both plants and both seas are represented, and they disagree with each
other — which is the point. One satellite, two coasts, two different
recommendations.

---

## 7. The LIVE DOWNLINK log

```js
link.on('downlink', ({ lines }) => {
  for (const l of lines) {
    appendRow(`${l.t}  ${l.apid}  ${l.subsystem.padEnd(4)}  ${l.text}`, l.severity);
  }
  trimTo(200);          // keep the DOM small; the buffer is server-side
});

// Back-fill on load so the panel is never empty:
link.recentLog(60).then(({ lines }) => lines.forEach(render));
```

Line rate rises with mode — 1/tick in ECLIPSE, 2 in SUN_FACING, 4 in ACTIVE
— so the log visibly quickens when the payload wakes up. Every line is
derived from a value shown elsewhere on the console; none of it is filler.

---

## 8. Performance

- Subscribe only to the channels a page actually draws.
- `state` is the heavy frame. If a panel needs one field at high rate, take
  it from `map` instead.
- Cap the log DOM at a few hundred rows; the gateway keeps 400 server-side.
- The globe caps device pixel ratio at 2 (`pixelRatioCap`); drop it to 1.5
  on a projector.
- `globe.stop()` / `globe.start()` around a hidden tab saves the GPU.

---

## 9. Deployment

```bash
docker compose up --build
```

Environment variables (see `gateway/src/config.js` and `.env.example`):

| | |
|---|---|
| `GATEWAY_PORT` / `WORKER_PORT` | ports (8800 / 8811) |
| `WORKER_URL` | where the gateway finds the worker |
| `TICK_HZ` | telemetry rate (default 5) |
| `CLOCK_RATE` | loop seconds per real second |
| `AUTOPLAY` | `false` to boot paused — useful for a scripted pitch |
| `CORS_ORIGIN` | lock down before anything public |

For a live pitch: `AUTOPLAY=false`, then drive the slider by hand. Nothing
moves until you move it.
