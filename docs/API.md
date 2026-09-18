# API reference

Base URL: `http://localhost:8800`. Everything is JSON. CORS is open by
default (`CORS_ORIGIN` to restrict).

The slider is the only input. Every read endpoint accepts `?slider=0..1`;
omit it and the gateway uses the live mission clock.

---

## Health and index

### `GET /health`

```json
{ "status": "ok", "service": "gateway", "version": "1.0.0",
  "worker": { "url": "...", "reachable": true, "error": null },
  "clock": { "playing": true, "rate": 1, "slider": 0.41, "frame": 1204 },
  "telemetry": { "clients": 2, "bySubscription": {...} },
  "cache": { "entries": 900, "hitRate": 0.97 } }
```

Returns 503 when the Python worker is unreachable, so a load balancer or a
demo-day pre-flight check catches a half-started stack.

### `GET /api`
Machine-readable index of every route.

---

## Mission

### `GET /api/mission/config`
Static definition, fetched once at boot: spacecraft, orbit, payload, EPS,
timeline segments, AOI, ground stations, desalination plants, spectroscopy
feature list, plus derived values (orbital velocity, array peak power, SoC
envelope).

### `GET /api/mission/state?slider=&schedule=&track=`
The whole spacecraft. This is the payload the console is built from.

```jsonc
{
  "schema": "orbital-sentinel/state@1",
  "clock":   { "slider", "loop_t_s", "mission_time_utc", "orbit_elapsed_s",
               "time_compression", "orbit_number" },
  "mode":    { "id", "label", "banner", "description", "progress",
               "ui_flags": { "dim_ui", "payload_disabled", "show_solar_gauges",
                             "show_map", "show_spectroscopy", "show_downlink",
                             "flash_banner" } },
  "orbit":   { "altitude_km", "inclination_deg", "subsatellite", "eclipsed" },
  "power":   { "generation_w", "loads", "net_w", "flow",
               "battery": { "soc_pct", "stored_wh", "bus_voltage_v",
                            "depth_of_discharge_pct", "margin_to_floor_pct",
                            "hours_to_floor", "violated" },
               "gauge":   { "min_pct", "max_pct", "note" } },
  "attitude":{ "mode", "roll_deg", "pitch_deg", "yaw_deg", "star_tracker" },
  "thermal": { "bus_c", "battery_c", "detector_c", "tec_duty_pct" },
  "payload": { "state", "imaging", "shutter", "bands_active",
               "frames_captured", "scan_progress" },
  "comms":   { "links": [...], "state", "downlink": { "live", "rate_mbps",
               "modulation", "eb_n0_db", "ber" }, "recorder" },
  "map":     { /* see Map */ },
  "science": null | { /* see Science */ },
  "desalination": { /* see Desalination */ },
  "alerts":  [ { "level", "code", "text" } ]
}
```

`schedule=false` drops the desalination block, `track=false` drops the map
block. Use both for a light poll.

### `GET /api/mission/timeline?samples=60`
The slider track's own data: mode bands plus the power curve across the
whole loop, so the slider can be drawn over its real SoC profile rather
than an empty bar.

### `POST /api/mission/slider` — `{ "slider": 0.42 }`
### `POST /api/mission/mode` — `{ "mode": "ECLIPSE" | "SUN_FACING" | "ACTIVE" }`
Snaps the slider to the centre of that mode's segment.
### `GET|POST /api/mission/transport` — `{ "playing", "rate", "scrubbing" }`
`rate` is loop seconds per real second (0–20). Set `scrubbing: true` while a
user drags so playback holds, `false` on release.

---

## Science

### `GET /api/science/spectrum?slider=&lat=&lon=&bands=96`
The hyperspectral sample behind the spectroscopy graph. Defaults to the
sub-satellite point.

```jsonc
{
  "point": { "lat", "lon" },
  "bands": [ { "nm": 400.0, "rrs": 0.0041, "norm": 0.16 }, ... ],  // norm is 0-1, ready for bar heights
  "features": [ { "nm": 443, "name": "Chl-a Soret absorption",
                  "kind": "absorption", "rrs", "norm" }, ... ],
  "indices": { "chl_a_mg_m3", "bloom_index", "severity", "turbidity",
               "mci", "ndci", "fluorescence_line_height" },
  "units": { "rrs": "sr^-1", "nm": "nanometres", "chl_a": "mg m^-3" }
}
```

`features` is what lets the graph label its spikes instead of just drawing
them: each named wavelength carries what it means physically.

### `GET /api/science/field?slider=&nx=48&ny=24`
Gridded Chl-a over the AOI as a flat row-major array plus its bbox — the
data behind a heat overlay. South-to-north row order.

### `GET /api/science/water-quality?slider=`
Per-plant intake state: Chl-a, bloom index, blended risk, severity.

---

## Desalination

### `GET /api/science/desalination?slider=`

```jsonc
{
  "timezone": "Asia/Dubai (UTC+04:00)",
  "network_score": 75.7, "network_band": "ACCEPTABLE",
  "plants": [ {
    "plant_id": "JEBEL_ALI", "name", "operator", "sea", "capacity_migd",
    "intake": { "type", "depth_m" },
    "observation": { "chl_a_mg_m3", "bloom_index", "severity",
                     "data_age_min", "confidence", "source" },
    "now":         { "clock", "score", "action", "band", "text" },
    "best_window": { "label": "06:00 - 07:00", "in_hours", "score", "action", "text" },
    "avoid_window":{ "label", "score", "reason" },
    "draw_windows":[ { "start_hour", "end_hour", "duration_h", "mean_score" } ],
    "hourly":      [ { "clock", "score", "terms": { ... } } ],   // 24 entries
    "next_overpass_min": 12.4,
    "rationale": "Chl-a at the intake is 7.8 mg/m3 (ELEVATED). ..."
  } ],
  "model": { "name": "SENTINEL-DESAL v1.2", "base": 100, "weights": {...}, "note" }
}
```

`action` is one of `DRAW` / `REDUCE` / `HOLD`; `band` is
`OPTIMAL` / `ACCEPTABLE` / `CAUTION` / `DEGRADED` / `CRITICAL`.

Every `hourly[].terms` object carries the individual contributions, so the
prediction box can be expanded into a breakdown on click rather than
asking the viewer to trust a bare number.

The recommendation genuinely changes with the slider: in ECLIPSE the
observation is 88 minutes old and the scheduler applies its conservatism
margin, which can move a plant from `DRAW` to `REDUCE`.

---

## Map

### `GET /api/map/bootstrap?slider=`
Everything the globe needs at boot in one round trip: AOI, markers, a
360-point ground track, orbit and payload parameters, and the initial state.

### `GET /api/map/geometry?slider=`

```jsonc
{
  "subsatellite": { "lat", "lon", "alt_km" },
  "heading_deg", "ground_speed_kms", "orbital_velocity_kms",
  "scan_line": { "left": {"lat","lon"}, "right": {"lat","lon"} },
  "swath_half_width_km": 90,
  "swath_covered": null | { /* GeoJSON Polygon Feature */ },
  "ground_track": [ {"lat","lon"}, ... ],
  "track_ahead":  [ {"lat","lon"}, ... ],
  "aoi": { "bbox", "center", "over_aoi", "range_to_center_km" },
  "markers": [ { "id", "name", "lat", "lon", "kind" } ]
}
```

`swath_covered` is `null` outside ACTIVE — the covered ribbon only exists
while the shutter is open.

### `GET /api/map/geojson?slider=`
The same geometry as a GeoJSON `FeatureCollection`, for dropping into
Mapbox, Leaflet, deck.gl or a 2D SVG without any conversion.

### `GET /api/map/groundtrack?samples=240`

---

## Telemetry

### `GET /api/telemetry/log?limit=80`
Recent LIVE DOWNLINK lines from the gateway's ring buffer — used to
back-fill the log panel on page load so it is never empty.

### `WS /ws/telemetry?channels=state,map,downlink,event`

On connect the server sends:

```json
{ "channel": "event", "type": "hello", "channels": [...],
  "transport": {...}, "backlog": [ /* last 40 log lines */ ] }
```

Then, per tick (5 Hz by default):

```jsonc
{ "channel": "map",      "type": "map",      "subsatellite", "scan_line", "swath_covered", "track_ahead" }
{ "channel": "state",    "type": "state",    "slider", "state": { /* full snapshot */ } }
{ "channel": "downlink", "type": "downlink", "lines": [ { "t", "apid", "subsystem", "severity", "text", "seq" } ] }
```

And on change only:

```jsonc
{ "channel": "event", "type": "mode",   "from": "SUN_FACING", "to": "ACTIVE", "banner": "TARGET ACQUIRED", "ui_flags": {...} }
{ "channel": "event", "type": "alerts", "alerts": [...] }
{ "channel": "event", "type": "transport", "transport": {...} }
```

Client → server:

```jsonc
{ "type": "subscribe",   "channels": ["map"] }
{ "type": "unsubscribe", "channels": ["state"] }
{ "type": "seek",        "slider": 0.72 }      // low-latency drag
{ "type": "scrub",       "active": true }      // hold playback while dragging
{ "type": "transport",   "playing": false, "rate": 2 }
{ "type": "ping" }
```

`severity` on a log line is `NOMINAL` / `INFO` / `WARN` / `CRIT` /
`SCIENCE`, which maps directly onto the three-colour palette: cyan, amber,
red, and white for science.

Downlink line rate is mode-dependent — 1 line per tick in ECLIPSE, 2 in
SUN_FACING, 4 in ACTIVE — so the log visibly quickens when the payload wakes
up. That is a deliberate tactile cue, configured in `gateway/src/config.js`.
