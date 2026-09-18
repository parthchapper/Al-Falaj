# Architecture and derivations

Why the system is shaped the way it is, and where each number comes from.

---

## 1. One input

The timeline slider is the only control in the system. Mode, battery state,
attitude, thermal, the ground track, the swath polygon, the spectrum, the
desalination schedule and the downlink log are all pure functions of it.

That single decision buys most of the properties the console needs:

- **Scrubbing works.** Dragging backwards is not "rewinding" anything; it is
  evaluating the same function at a different argument.
- **Nothing can disagree.** The globe, the gauges and the log all read one
  snapshot, so the map cannot show the satellite over the Gulf while the
  panel says `ECLIPSE`.
- **It is cacheable.** The gateway memoises by quantised slider value
  (1/900 of the loop). A demo that runs for an hour serves almost entirely
  from memory.
- **It is testable.** `smoke.js` asserts specific slider positions produce
  specific states. A regression in the power model fails a test rather than
  surfacing in front of an audience.

`worker/app/mission.py::snapshot(slider)` is that function. Everything else
is transport.

---

## 2. The closed loop

The timeline covers **exactly one orbital period — 5694 s — in 90 s of loop
time**, and the sub-satellite point at the end of the loop is the point at the
start. Not approximately: `subsatellite_point(0)` and
`subsatellite_point(LOOP_DURATION_S)` return bit-identical floats, because the
argument of latitude advances by exactly 360° and nothing else enters.

That "nothing else" is the cost. A real sun-synchronous ground track does not
close — Earth turns ~23.7° west beneath the orbit each revolution, and that
drift is precisely the mechanism that builds a 5-day global repeat cycle. To
make the loop seamless, **Earth's rotation is held fixed**.

This is the one deliberate simplification in the propagator, and it is declared
rather than buried:

- `clock.earth_rotation` reads `"HELD FIXED"` in every telemetry frame
- `clock.earth_rotation_note` explains the trade in the frame itself
- the timeline footer prints `EARTH SPIN HELD FIXED` on screen
- the README, this document and the panel tooltip all say so

Everything else is untouched: real inclination, real period, real altitude, a
real great-circle track. `EARTH_ROT_DEG_PER_MIN` is still in `geo.py`, still
correct, and deliberately unused — it is reported, not applied.

The closure is asserted in three places, because a property this load-bearing
should not depend on anyone remembering to look: `tools/parity-check.mjs`
(`closure` section), `gateway/scripts/smoke.js` ("ground track closes on
itself"), and `tools/site-check.mjs` (both the sub-satellite point and the
*drawn* polyline, which is a separate code path and could close in the model
while the renderer still draws an arc with two loose ends).

---

## 3. The time warp

A uniform 63× would flash the 145-second overpass past in 2.3 seconds while the
audience watched half a minute of empty eclipse. So the clock rate varies over
the orbit — but **continuously**, not in steps.

Define a density ρ(x) in loop-seconds per orbit-second, where x is the fraction
of the orbit completed:

```
rho(x) = 1 + A · exp(K · (cos(2π(x − x_pass)) − 1))
```

This is a von Mises kernel: the natural periodic Gaussian. It was chosen over a
plain Gaussian or a piecewise ramp for one reason — it is **identical at x = 0
and x = 1, along with all its derivatives.** The loop therefore has no seam in
its *rate* either. Position, velocity and clock rate are all continuous across
the wrap, so there is nothing for a viewer to catch.

| | | |
|---|---|---|
| `A` | 25 | depth: ~26× between coast and pass |
| `K` | 110 | width: half-maximum at ±103 orbit seconds, comfortably wider than the 145 s pass, so the ramp is gradual |
| `x_pass` | 5172.5 / 5694 | centred on the middle of the ACTIVE segment |

Integrated by trapezoid into a 4096-sample cumulative table, in the same order
in both languages so the two tables agree to the last bit (they do — verified).
`geo.orbit_seconds(loop_t)` inverts it by binary search plus linear
interpolation; the table is monotone by construction because ρ is strictly
positive, so the inverse is single-valued.

The result:

| Segment | Orbit time | Loop time | Rate |
|---|---|---|---|
| ECLIPSE | 0–2000 s | 0.00–16.19 s | 123.5× |
| SUN_FACING | 2000–5100 s | 16.19–50.12 s | 91.4× mean |
| ACTIVE | 5100–5245 s | 50.12–77.54 s | **5.3× mean, 4.75× at the centre** |
| SUN_FACING · egress | 5245–5694 s | 77.54–90.00 s | 36.0× mean |

Note that the pass is deliberately **not** at the loop boundary. A climax that
lands on the wrap has nowhere to resolve; the short sunlit egress afterwards is
both physically correct (the spacecraft is still in daylight for another seven
minutes) and gives the sequence somewhere to land.

`TIMELINE_SEGMENTS` is *derived* by mapping the orbit boundaries through the
warp — no loop timestamp is hard-coded anywhere. Change the warp and every mode
boundary, every contact marker and the timeline canvas all move together. The
parity harness compares the derived segments for exactly that reason.

`geo.time_compression(loop_t)` is the local rate, which the power and recorder
integrators use so energy and data accumulate in real orbital seconds rather
than loop seconds.

---

## 4. Solving the ground track phase

Requirement: the mid-point of the ACTIVE segment must put the sub-satellite
point on the AOI centre, 24.6 °N 54.2 °E.

For a circular orbit of inclination *i* and argument of latitude *u*, with
Earth rotation held fixed:

```
lat  = asin(sin i · sin u)
Δlon = atan2(cos i · sin u, cos u)
lon  = lon_asc0 + Δlon
```

With *i* = 97.49°, target latitude 24.6°, on the **descending** arc (the 10:30
LTDN daylight pass, so *u* ∈ (90°, 270°)):

```
sin u = sin(24.6°) / sin(97.49°) = 0.4163 / 0.99147 = 0.41986
u     = 180° − asin(0.41986) = 155.18°
Δlon  = atan2(cos(97.49°)·sin(155.18°), cos(155.18°))
      = atan2(−0.054805, −0.90759) = −176.544°
```

The ACTIVE mid-point is orbit *t* = 5172.5 s:

```
u(orbit_t) = u₀ + 360°·(orbit_t / P),  P = 5694 s
  → u₀      = 155.18° − 360°·(5172.5/5694) = 188.1456°
  → lon_asc0 = 54.2° + 176.544° = 230.744° → −129.2509°
```

Those two constants are `U0_DEG` and `LON_ASC0_DEG` in `geo.py` and
`geo.js`. **They are solved, not chosen**, and `tools/solve_phase.py`
re-derives them — change `ORBIT_SEGMENTS` and run it, then paste the result
into both files. It also prints the AOI crossing and the ground-station
contact windows, which is how the network in section 5 was picked.

The tests assert the result rather than the derivation: the subpoint must be
inside the AOI bounding box during the pass.

Other geometry from the same module:

```
r      = 6378.137 + 520 = 6898.137 km
v      = √(μ/r) = √(398600.4418 / 6898.137) = 7.602 km/s
v_grnd = v · (R⊕/r) = 7.029 km/s
```

Swath edges are great-circle offsets of ±90 km perpendicular to the
instantaneous heading; the covered-area polygon is the left edge forward
plus the right edge reversed, which is a closed ring **and** a strip the
renderer can triangulate without an earcut pass.

---

## 5. The ground segment

Three stations, and they were not picked for recognisability. `station_passes`
sweeps the propagator in 2-second steps against each station's 10° horizon mask
and refines every crossing by 24 rounds of bisection; `tools/solve_phase.py`
prints the result for any candidate list.

| Station | Contact | Peak elevation | Role |
|---|---|---|---|
| Dubai Primary | orbit 4933–5388 s (455 s) | 78.6° | acquires before the pass and holds through it |
| Inuvik, Canada | orbit 3586–4010 s (424 s) | 37.2° | high-latitude dump on the sunlit arc |
| Troll, Antarctica | orbit 898–1314 s (416 s) | 33.8° | polar dump during eclipse |

**Svalbard is absent** even though it is the obvious station for a
polar-orbiting mission: this orbit only grazes it at 10.4° peak elevation for
87 seconds. Leaving it in would have put a station on the board that never does
anything; leaving it out and saying why is the more useful answer.

Two consequences fall out of doing this properly rather than scripting it:

**The radio load becomes a function of geometry.** `power.loads_w` takes a
`transmitting` flag fed by `comms.transmitting_at(loop_t)`, so the 9 W
transmitter draws during the Troll dump — which happens *in eclipse*, at the
deepest point of the power profile. That is exactly the kind of interaction a
power budget exists to catch, and it would have been invisible under the old
mode-keyed radio model.

**The elevation formula had to be fixed.** The original used
`acos(R_orbit · sin γ / range)`, which is even in γ and therefore reports a
spacecraft on the *far side of the planet* as being overhead. The horizon sits
at γ = 22.4° for a 520 km orbit; everything beyond it must come back negative:

```
tan(el) = (cos γ − R⊕/r) / sin γ        el = atan2(cos γ − R⊕/r, sin γ)
```

The smoke test now asserts that some station, somewhere in the orbit, reports a
negative elevation — a check that would have failed against the old formula.

### Solid-state recorder

Sized from the payload rather than assumed: 180 km swath at 30 m GSD is 6000
cross-track pixels; 96 bands at 12 bit read out at *v_grnd*/GSD = 233 lines/s is
1.61 Gbps raw, and ~4:1 onboard compression on ocean scenes gives **400 Mbps**.
Housekeeping, ADCS, GPS and dark-frame calibration add 1.2 Mbps continuously.

The fill is integrated across the loop in real orbital seconds and solved for
the **periodic steady state** — the same treatment the battery gets, for the
same reason: an orbit that ends with more data than it started with is an orbit
whose recorder eventually overflows, and a gauge that jumps at the wrap is a
gauge nobody believes.

---
## 6. Power, and why the gauge is zoomed

```
Array:     0.10 m² × 0.298 (GaAs, EOL) × 1361 W/m² = 40.6 W peak
Loads:     bus 6.2 W  |  payload 22 W imaging / 3.5 W standby  |  radio 9 W TX
Battery:   78 Wh, 16.8 V nominal, flight-rule floor 30 % SoC
```

Eclipse drain: 6.2 W over 2100 s = 3.6 Wh = **4.6 % of capacity**.

That is the honest answer, and it is a problem for a demo: a 4.6 % swing on
a 0–100 % gauge is a needle that does not move. Two dishonest fixes were
available — shrink the battery, or scale the number. Instead:

- `battery.soc_pct` is the unscaled truth.
- `power.gauge` returns `{min_pct, max_pct}`, the mission's real SoC
  envelope padded by 1 %, so the front end can zoom the *display* while the
  underlying number stays real, and `gauge.note` says so in the payload.
- `depth_of_discharge_pct`, `margin_to_floor_pct` and `hours_to_floor` are
  also returned, because those are the numbers a power engineer actually
  watches.

Two more details that matter:

**CC/CV taper.** Charging at full current up to 88 % SoC, then tapering to
zero at 100 %. Without it the battery slams into the ceiling and flat-lines
for most of the sunlit arc.

**Periodic steady state.** The loop repeats, so it must end at the SoC it
started with or the gauge jumps every time the timeline wraps. `_soc_profile`
integrates, measures the drift, corrects the starting SoC and re-integrates
until `|drift| < 10⁻⁴`. The solved loop runs 93.7 % → 98.8 % → 93.7 %.

---

## 7. The science model

**The field is synthetic. The optics are not.**

*Chl-a field* (`science.chlorophyll_mg_m3`): deterministic value-noise fBm,
shaped by three physical terms — a basin gain (the shallow, hypersaline
Arabian Gulf is bloom-prone; the deeper, better-flushed Gulf of Oman is
less so), a coastal nutrient gradient peaking near 24.9 °N, and a seasonal
forcing term for the late-summer stratified Gulf. Background 1.4 mg/m³,
ceiling 34 mg/m³ — the range the region actually spans between clear water
and a Cochlodinium event.

*Reflectance* (`science._rrs`): a simplified bio-optical model returning
Rrs(λ) in sr⁻¹ from 400–900 nm, built from

| Feature | λ | Physics |
|---|---|---|
| Chl-a Soret band | 443 nm | Pigment absorption, deepens with biomass |
| Green maximum | 555 nm | Backscatter, rises with biomass |
| Phycocyanin | 620 nm | Cyanobacterial pigment absorption |
| Chl-a red band | 665 nm | Absorption |
| Fluorescence | 681 nm | Sun-induced — unambiguously *live* algae |
| NIR red edge | 709 nm | Only appears above ~0.22 bloom index |
| Pure-water absorption | >580 nm | Exponential collapse into the NIR |

Derived indices are computed the way operational ocean-colour processors
compute them:

```
MCI  = Rrs(709) − Rrs(681) − (754−709)/(754−681) · (Rrs(754) − Rrs(681))
NDCI = (Rrs(709) − Rrs(665)) / (Rrs(709) + Rrs(665))
FLH  = Rrs(681) − ½·(Rrs(665) + Rrs(709))
```

Each band row carries `norm` (0–1 against the sample's own peak), so a bar
chart or canvas graph needs no client-side scaling, and `features[]` carries
the labelled diagnostic wavelengths so the graph can annotate its spikes
with what they mean instead of just drawing them.

---

## 8. The scheduler

```
score = 100
      − 62 · bloom_risk               observed algal load, depth-corrected
      − 22 · thermal_stratification   midday warm layer brings motile cells up
      − 16 · tidal_slack              slack water concentrates biomass
      − 11 · turbidity                pre-filter loading
      − 14 · (1 − data_confidence)    conservatism margin for a stale retrieval
```

Design points worth defending:

- **The confidence term is a penalty, not a reward.** A plant acting on a
  90-minute-old retrieval gets a *more cautious* recommendation, because the
  scheduler is less sure what the water is doing. Framing it as a bonus for
  freshness would make "the satellite is awake" appear to improve the water,
  which is nonsense.
- **Intake depth shields against stratification.** Fujairah's 10 m intake
  sits below a surface bloom layer; Jebel Ali's 6 m open intake does not.
  `depth_shield = min(0.55, depth/22)`, applied against the stratification
  term only.
- **Tide uses the M2 period** (12.42 h) with a longitude phase offset, so
  the Gulf and Gulf-of-Oman coasts are not in lockstep — which they are not.
- **Every term is returned per hour.** The prediction box can expand into a
  breakdown; nothing asks the viewer to trust a bare score.

Bands: `≥78 OPTIMAL`, `≥62 ACCEPTABLE`, `≥45 CAUTION`, `≥30 DEGRADED`,
else `CRITICAL` (suspend intake). Each carries operator-language text
("Throttle to 70 % and increase DAF pre-treatment dosing"), not a colour
name.

---

## 9. Gateway responsibilities

The worker is pure; the gateway is where time and connections live.

**MissionClock** owns one number and emits `tick` at 5 Hz. `scrub(true)`
holds playback while a user drags — without it, a dragged slider fights the
autoplay and the thumb stutters.

**TelemetryBus** fans out on four channels and counts subscribers before
building a payload, so a client that only wants `map` never causes a
spectrum to be computed. It also drops frames rather than queueing them if
a tick is still in flight: a slow frame should make the console briefly
coarse, never make it drift behind real time.

**stateCache** memoises by quantised slider with an LRU. Because worker
state is pure, this is a total cache with no invalidation problem — the
hardest cache to get wrong.

---

## 10. What the 3D module does and does not do

`map3d` renders. It holds no mission state, fetches nothing on its own
(`mount()` wires `SentinelLink` to it as a convenience, but `globe.js` has
no network code), and adds nothing to the DOM but its own canvas.

Mode changes are **eased, not snapped**: `_theme` chases `_targetTheme` with
exponential smoothing each frame — the 3D equivalent of a CSS transition, so
crossing a segment boundary while scrubbing does not pop.

The Earth is drawn from baked vector coastlines rather than a texture: no
image assets, works offline, stays sharp at any zoom, and looks like a
mission console rather than a photo. Gulf states are drawn brighter and the
UAE brighter still, because that is the operating theatre.

Two scale decisions worth noting. The spacecraft mesh is a **symbol** — a
real 6U is sub-pixel at globe scale — so it and the surface markers are
rescaled with camera distance to hold a constant apparent size. And the
Chl-a overlay paints into a fixed 512×256 canvas via a scratch canvas,
rather than resizing the canvas the live WebGL texture is bound to; that
resize is exactly the kind of thing that works on one driver and silently
misaligns on another, which is how the overlay originally shipped a
quarter-sized, mispositioned texture until the headless render check caught
it.

---

## 11. Water security: the last link in the chain

Every other panel answers *what is the spacecraft doing*. This one answers the
question the mission exists for, and it does so without inventing a
measurement. The chain is four steps, and each is printed on the console:

```
Chl-a retrieval → intake score → fraction of rated capacity not cleared
                → m³/day → people's daily supply
```

`impact.risk_fraction(score)` is the only new function, and it is deliberately
**linear**: zero at 70 (the scheduler's clear-to-draw band) rising to the whole
plant at 15. A threshold would imply the model resolves a boundary it does not;
a curve would imply a calibration nobody has done for these waters.

Conversions: 1 MIGD = 4546.09 m³/day; population uses the UAE domestic average
of 550 L/person/day, among the highest in the world. The panel states that
"at risk" is **capacity an operator would hold back, not an outage** — a plant
throttling its intake draws reservoir stock first.

### Why the panel forecasts rather than nowcasts

The first version reported only the current hour, and on a clear hour it read
`NONE` — which made a forecasting tool look inert precisely when a forecast is
worth the most. `impact.peak_risk` now scans all 24 scheduled hours across both
plants and reports the worst, so the panel always carries the number an
operator does not already have. The headless check asserts this: for every hour
of the day, either the nowcast or the peak must be non-zero.

### A calibration bug worth recording

The bloom index originally normalised against `CHL_BLOOM_MAX` (34 mg/m³, the
field's physical ceiling). That rated a genuinely dangerous 15 mg/m³ at 0.4,
which the scheduler cleared to draw through — and across 24 hours × 8 slider
positions × 2 plants, **384 out of 384 verdicts came back DRAW.** The console's
entire thesis never fired.

The fix was to separate the two scales. `CHL_BLOOM_MAX` still bounds the field;
a new `CHL_ADVISORY_MAX` (22 mg/m³) bounds the *index*, because intake fouling
advisories run on a far tighter scale than the peak a bloom can reach — 3–8
mg/m³ already warrants monitoring, and the 2008–09 Cochlodinium event that shut
Fujairah down sat in the low tens. The scheduler now swings between DRAW and
REDUCE with hour and position, and the two plants disagree in the way the real
geography says they should: shallow, poorly flushed Jebel Ali moves in and out
of a throttle recommendation while Fujairah's deeper Gulf of Oman intake stays
clear.

---

## 12. The score

Synthesised at runtime with the Web Audio API. **No audio files ship**, which
is what keeps the console a genuinely self-contained static site: nothing to
bundle, nothing to fetch, nothing to 404 on a Pages subpath. The headless check
asserts the page requests no media at all.

Three pieces do most of the work:

**A convolution reverb with a generated impulse response.** `ConvolverNode`
fed a 4.2-second buffer of exponentially decaying noise, decorrelated between
channels, with a short build before the decay so it reads as a room rather than
a gate. This single node is most of what separates "synth pad" from "organ in a
large stone building", and it costs nothing to ship because the impulse is
computed in a loop at startup.

**Additive organ voices rather than a sawtooth.** A sawtooth has every
harmonic; a pipe organ's principal stop has the fundamental plus the octave,
twelfth and fifteenth, falling away sharply. Each note is built from partials
at ×1, ×2, ×3, ×4, ×6 and ×8 with gains 1.00, 0.46, 0.26, 0.18, 0.08 and 0.05,
doubled and detuned a few cents for chorus. A slow tremulant on the pad bus
makes a held chord breathe.

**A lookahead scheduler.** Notes are queued against `ctx.currentTime` about
180 ms ahead on a 30 ms timer, rather than fired from the timer directly.
`setInterval` drifts, and a drifting ostinato is immediately audible; the timer
decides only *what* to queue, and the audio clock decides when it sounds.

### Why the ticking earns its place

In *Interstellar* the ticking pulse is time dilation made audible. This console
already has a clock that dilates: `clock.time_compression` runs at ~124× while
the spacecraft coasts and ~4.8× through the overpass. So the tick is **one tick
per 60 seconds of orbit time**, clamped to a musical 0.4–2.6 s, which means the
pulse decelerates as the console slows into the pass.

That is not an effect layered on top of the mission — it is the same number the
timeline's amber curve draws and the top bar prints, rendered in a third
medium. The headless check asserts it: seek to the coast, seek to the pass, and
the derived tick interval must more than double.

The chord voicing changes with operating mode (A minor low and sparse in
eclipse, an added ninth and a faster cell over the UAE), the pad's filter opens
with the same normalised "slowness" figure the sweep used to use, and telemetry
blips are pitched to notes of the current chord so a burst of downlink lines
reads as texture rather than bleeping over the music.

### The opening gate

Browsers will not start audio without a user gesture. Rather than fade the
score in at some arbitrary later moment — whenever the viewer happened to click
something — the console opens with a card asking them to turn the volume up.
The click that dismisses it *is* the gesture, so the score starts at full from
the first frame with the mission's opening chord.

It carries a "continue without sound" path, `prefers-reduced-motion` mutes
everything outright, and `?nogate` skips it for a direct link. The headless
check deliberately clicks the real button rather than using `?nogate`: the gate
is the first thing every visitor meets, and an untested first screen is the one
that breaks.

---

## 13. Extension points

- **Real orbital mechanics.** Replace `geo.subsatellite_point` with an SGP4
  propagator over a real TLE (`satellite.js`, `sgp4`, or `skyfield`). The
  time warp becomes a scrub over real epoch time; nothing downstream changes
  because everything already reads `snapshot(slider)`.
- **Real ocean colour.** Replace `science.chlorophyll_mg_m3` with a Sentinel-3
  OLCI or PACE retrieval. The reflectance model and every index already
  match the real product definitions.
- **More targets.** Add to `DESAL_PLANTS` in `config.py`; the scheduler,
  markers, alerts and water-quality endpoint all pick them up with no other
  change.
- **Persistence.** Nothing is stateful today. A run log would attach at the
  gateway, which is already the only component that knows what time it is.


---

## 14. The browser port

`site/engine/` is the mission model rewritten in JavaScript so the console can
be hosted as a static site. It is a port, not a reimplementation: same
constants, same formulas, same rounding, same field.

Three things needed care.

**The value-noise hash.** Python does exact big-integer arithmetic; JavaScript
numbers lose precision above 2^53. `seed * 2147483647` overflows that range
before the `& 0xFFFFFFFF` can be applied, so the JS side rewrites the term as
`(seed & 1) * 2^31 - seed` (exact, because `2^31 * seed mod 2^32` depends only
on the low bit of `seed`) and uses `Math.imul` for the other products, which
gives exact 32-bit multiplication. Get this wrong and the chlorophyll field
looks plausible but is a different field — the kind of bug that survives a
demo and dies in a due-diligence session.

**Rounding.** Python's `round()` is banker's rounding; `Number.toFixed()` is
not. The parity harness compares with a 1e-6 absolute tolerance rather than
demanding identical strings, which is the right test: the models agree on the
numbers, and the last decimal place of a display value is not a model.

**Timestamps.** Python writes `+00:00` and microseconds; JavaScript writes `Z`
and milliseconds. The harness compares the instant, allowing 1 ms for the fact
that a JS `Date` has no sub-millisecond resolution.

**Loop-time modulo.** `(t % L + L) % L` is the usual JavaScript idiom for a
non-negative remainder, and it is wrong here. It round-trips through `t + L`,
and for a `t` just under `L` the larger magnitude has half the resolution — the
value comes back shifted by one unit in the last place. Divided by the 0.1 s
profile step, that is enough to move `Math.floor` to the next index, which is
how a battery reading ended up 0.002 % away from the Python worker's. Python's
own `%` already returns a non-negative result for a positive modulus, so
`config.wrapLoopT` matches it exactly and leaves non-negative inputs untouched.
The parity harness found this; nothing else would have.

The two are kept honest by `tools/parity-check.mjs`, which compares 27,694
values and runs in CI before the site is allowed to publish. The Python worker
remains the reference implementation — it is where the science is edited, and
`tools/dump_reference.py` regenerates the fixture from it.

### What the browser engine replaces

The gateway's responsibilities do not vanish; they move into
`site/engine/localLink.js`, which presents the same interface the WebSocket
client did:

| Gateway | Browser |
|---|---|
| `MissionClock` at 5 Hz | `setInterval` on the same cadence |
| 4-channel WebSocket fan-out | an event emitter with the same channel names |
| quantised state cache | the same quantised memoisation, same 1/900 quantum |
| downlink ring buffer | the same, in memory |

Because the interface matches, the three.js globe module is unchanged between
the two deployments. It never knew where its data came from, which was the
point of building it that way.
