# AL-FALAJ SAT-1

A mission-control console for a 6U hyperspectral CubeSat that watches UAE
coastal waters for algal blooms and tells desalination plants when to draw
water.

The console in `site/` is a **static site** — push it to GitHub Pages and it
runs: orbital mechanics, power model, hyperspectral retrieval, ground-station
contact windows, intake scheduler and a three.js globe, all in the browser,
with no server, no build step and no API keys.

```bash
npm run serve     # http://127.0.0.1:4173
npm run check     # parity harness + headless console check
```

**Publishing:** Settings → Pages → Source: GitHub Actions, then push.
[`docs/HOSTING.md`](docs/HOSTING.md) covers the alternatives.

---

## The idea

A 6U CubeSat in a 520 km sun-synchronous orbit carries a 96-band hyperspectral
imager. Once a day it crosses UAE coastal waters and measures chlorophyll-a.

Harmful algal blooms clog reverse-osmosis intakes — the 2008–09 *Cochlodinium*
bloom in the Gulf of Oman forced Fujairah's plant into repeated shutdowns.
Operators find out when intake pressure drops. A daily ocean-colour pass lets
them schedule around a bloom instead of reacting to one.

So the console's modes are not screens. They are one spacecraft at points in
its orbit, and **everything on the page is a function of where the timeline
slider sits.**

| Orbit | Mode | What is physically true |
|---|---|---|
| 0 – 2000 s | **ECLIPSE** | In Earth's umbra. Zero generation, payload rail off, battery on housekeeping. Troll station rises mid-eclipse and the recorder dumps — so the transmitter's 9 W lands at the deepest point of the orbit. The console dims. |
| 2000 – 5100 s | **SUN_FACING** | Arrays sun-pointed, ~39 W in, battery recharging through a CC/CV taper, detector cooling to −40 °C. Inuvik contact on the way up. |
| 5100 – 5245 s | **ACTIVE** | UAE overpass. Shutter open, 96 bands streaming, Dubai holding the link, swath map sliding in, spectroscopy and intake schedule live. |
| 5245 – 5694 s | **SUN_FACING · egress** | Imaging done, still sunlit, recorder dumping before the next eclipse. |

---

## The loop closes

The timeline covers **exactly one 94.9-minute orbital period in 90 seconds**,
and the sub-satellite point at the end of the loop is the point at the start —
to 0.0 degrees, asserted in the parity harness, the smoke test and the headless
console check.

Getting there needs one deliberate simplification, and the console states it in
every telemetry frame (`clock.earth_rotation: "HELD FIXED"`) and in the
timeline footer: **Earth's rotation is frozen.** A real sun-synchronous ground
track walks ~23.7° west per revolution — that drift is precisely what builds
the 5-day repeat cycle. Freezing it is what lets the demo loop seamlessly. The
orbit itself is untouched: real inclination, real period, real great-circle
ground track, phase constants *solved* rather than chosen so that the descending
arc puts the sub-satellite point over the AOI centre at the midpoint of the pass
(`tools/solve_phase.py` re-solves them if the segment layout changes).

## The clock slows down where it matters

A uniform 63× would flash the 145-second overpass past in 2.3 seconds while the
audience watched half a minute of empty eclipse. Instead the clock rate varies
**continuously** over the orbit:

```
rho(x) = 1 + 25 * exp(110 * (cos(2*pi*(x - x_pass)) - 1))
```

A von Mises bump — the natural periodic Gaussian. Smooth, strictly positive, and
identical at x = 0 and x = 1, so the wrap is continuous in position, velocity
*and* clock rate; there is no seam to hide. Integrated by trapezoid into a 4096-
sample table and inverted by binary search.

The result runs at **124× coasting and 4.8× through the pass** — a 26× swing,
drawn as the amber curve behind the timeline slider and reported in every frame
as `clock.time_compression`.

---

## What's on the console

- **3D globe** — vector-coastline Earth, the orbit as a closed ring, spacecraft,
  scanning swath, and the chlorophyll field draped over the AOI. Drag to rotate,
  scroll to zoom, **click any point to sample its spectrum**.
- **2D swath map** — appears in ACTIVE. Scan line, everything covered so far this
  pass, plant markers coloured by live bloom risk.
- **Power** — generation → battery → loads as a live diagram, gauges on a *zoomed*
  scale with the unscaled percentage printed beside them.
- **Ground segment** — Dubai, Inuvik and Troll with live AOS/LOS countdowns,
  elevation, slant range and link rate. The windows are swept from the propagator
  against each station's 10° horizon mask, not scripted, and the transmitter's
  9 W feeds straight back into the power budget.
- **Spectroscopy** — 96 bands coloured by their own wavelength, with the eight
  diagnostic features labelled: Chl-a absorption at 443 and 665 nm, green peak at
  555, sun-induced fluorescence at 681, NIR red edge at 709. Hover any band.
- **Desalination schedule** — Jebel Ali and Fujairah, each with a draw/reduce/hold
  verdict, a best window, and a 24-hour strip whose every bar carries its full
  scoring breakdown on hover.
- **Water security** — capacity at risk now and the 24-hour peak, in m³/day and
  in people's daily supply. The reason the mission exists, in the unit a water
  authority decides in.
- **Live downlink** — CCSDS-tagged telemetry where every number is a value shown
  elsewhere on the console.
- **Mission score** — a pipe organ (additive partials, not a sawtooth) through a
  convolution reverb whose impulse response is *generated in a loop*, plus a
  minimalist arpeggio ostinato. Fully synthesised with the Web Audio API: no
  audio files, no CDN, nothing to 404. The chord changes with operating mode,
  and the ticking pulse is one tick per 60 seconds of **orbit** time — so it
  audibly decelerates as the console slows into the pass, because it is driven
  by `clock.time_compression` rather than by a timer of its own.
- **Opening gate** — the console asks for the volume before it starts, which
  also supplies the user gesture browsers require before audio may play. There
  is a "continue without sound" path, and `prefers-reduced-motion` mutes it
  outright.
- **Guided tour** — eleven steps that drive the timeline themselves, opening a
  few seconds after the gate is answered so a viewer sees the console working
  first.

Every panel has a **`?`** that says what you are looking at and why it matters,
and a **SOURCE** line naming the model or measurement behind its numbers.

---

## Two implementations, one model

This repository contains the console twice over, on purpose.

```
site/engine/     the mission model in JavaScript — what GitHub Pages runs
worker/app/      the same model in Python (FastAPI) — the real backend
gateway/         Node API gateway: mission clock, cache, telemetry WebSocket
map3d/           the three.js globe module (shared; copied into site/)
tools/           parity harness, phase solver, static server, headless checks
docs/            API, architecture, integration, hosting
```

The static site exists so the console can be *seen* without infrastructure. The
Python worker and Node gateway exist because that is what a real ground segment
looks like, and because the science belongs somewhere a scientist can edit it.

**Two implementations of one model drift silently**, so one doesn't:

```bash
npm run check
```

`tools/dump_reference.py` imports the Python model directly and dumps its
outputs; `tools/parity-check.mjs` asserts the browser engine reproduces every
one. Currently **27,694 values** — full state at 21 slider positions chosen to
straddle every mode boundary and every AOS/LOS crossing, the warp curve itself,
the loop-closure delta, all three stations' contact windows, 96 spectral bands,
288 cells of the chlorophyll field, both plants' 24-hour schedules, the impact
model, and the value-noise hash underneath all of it.

The site check drives the real page in headless Chromium — all four segments,
every interaction, the tour, a phone viewport — and screenshots each. The
backend smoke test runs 78 end-to-end assertions against the live API.

---

## Honesty notes

Things a technical advisor might reasonably ask, answered before they ask:

- **Earth's rotation is frozen.** Stated above, stated in `clock.earth_rotation`,
  stated in the timeline footer. It is the one simplification, and it exists so
  the loop closes.
- **The demo loop is scripted.** 90 seconds representing one orbit, phased so
  the UAE pass always lands in the ACTIVE segment. The geometry inside is real;
  only the clock rate is staged, and it is reported every frame.
- **The clock rate is deliberately uneven**, and continuously so — see above.
- **The battery only moves ~6 %.** That is what a real orbit does. Rather than
  fake a bigger swing, `power.gauge` returns a display window zoomed to the
  mission's real envelope while `soc_pct` stays the unscaled truth, and the
  panel says so.
- **The algae field is synthetic**, generated from deterministic value noise
  shaped by basin depth, a coastal nutrient gradient and season. The *reflectance
  model applied to it is real*, and MCI, NDCI and FLH are computed the way
  MERIS/OLCI-class processors compute them.
- **The bloom index is scaled to intake advisories, not to the field.** It
  saturates at 22 mg/m³ — roughly where Gulf desalination operators act — rather
  than at the 34 mg/m³ the field can physically reach. Normalising against the
  field's own ceiling rated a genuinely dangerous 15 mg/m³ at 0.4 and cleared the
  plant to draw straight through it.
- **"Capacity at risk" is not an outage.** It is the fraction of rated output the
  scheduler would not clear; a plant throttling its intake draws reservoir stock
  first. The population figure is that volume at the UAE domestic average of
  550 L/person/day, and the panel says so.
- **Svalbard is not in the ground network** even though it is the obvious station
  for a polar-orbiting mission — this particular orbit only grazes it at 10.4°.
  The three stations that are there were chosen by running the propagator.
- **Nothing in the downlink log is filler.** Every line is derived from the same
  snapshot the gauges read.

---

## Running the real backend

```bash
./scripts/start.sh          # Python worker + Node gateway
cd gateway && npm run smoke # 78 end-to-end assertions
```

| | |
|---|---|
| REST + WebSocket gateway | <http://127.0.0.1:8800> |
| Python mission worker | <http://127.0.0.1:8811> |
| API index | <http://127.0.0.1:8800/api> |

Docker: `docker compose up --build`.

---

## Documentation

| | |
|---|---|
| [`docs/HOSTING.md`](docs/HOSTING.md) | publishing to Pages, local preview, verification |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | every derivation — loop closure, the warp curve, orbit phasing, the power solver, the bio-optical model, the scheduler, the impact chain |
| [`docs/API.md`](docs/API.md) | the backend's REST and WebSocket contracts |
| [`docs/INTEGRATION.md`](docs/INTEGRATION.md) | wiring a front end to the backend |
| [`docs/screenshots/`](docs/screenshots) | reference captures from the last verified run |

---

## Licence and credits

three.js r170 is vendored under `site/vendor/` (MIT, licence included).
Coastlines and country outlines are derived from Natural Earth (public domain)
via `world-atlas`. The entire score — organ, ostinato, ticking pulse and the
cathedral reverb's impulse response — is synthesised at runtime; no sound files
ship, and the headless check asserts the page requests no media at all.

Built by team **Al-Falaj**. A *falaj* is the UAE's 3,000-year-old channel system
for moving water to where it is needed; this one watches the sea that feeds it.
