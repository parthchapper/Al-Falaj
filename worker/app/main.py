"""
ORBITAL SENTINEL — Python mission worker.

The physics, science and scheduling authority. Stateless and pure: every
endpoint is a function of the slider position, so the Node gateway can
call it at any rate, in any order, and cache freely.
"""
from __future__ import annotations

import os
from typing import List, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from . import comms, downlink, geo, mission, power, science
from .config import (AOI, DESAL_PLANTS, EPS, GROUND_STATIONS, LOOP_DURATION_S,
                     MIN_ELEVATION_DEG, MODES, ORBIT_PERIOD_S, PROVENANCE,
                     SPACECRAFT, SPECTRO, TIMELINE_SEGMENTS, loop_time_at_orbit)
from .desalination import schedule

app = FastAPI(
    title="Orbital Sentinel Mission Worker",
    version="1.0.0",
    description="Scripted-loop orbital mechanics, ocean-colour science and "
                "desalination scheduling for the ORBITAL SENTINEL console.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)


# ---------------------------------------------------------------------------
class ModeRequest(BaseModel):
    mode: str


@app.get("/health")
def health():
    return {"status": "ok", "service": "worker", "loop_s": LOOP_DURATION_S}


@app.get("/mission/config")
def mission_config():
    """Static mission definition — fetched once by a client at boot."""
    return {
        "spacecraft": SPACECRAFT,
        "eps": EPS,
        "timeline": {
            "loop_duration_s": LOOP_DURATION_S,
            "segments": TIMELINE_SEGMENTS,
            "modes": MODES,
        },
        "aoi": AOI,
        "ground_stations": GROUND_STATIONS,
        "desal_plants": DESAL_PLANTS,
        "spectroscopy": SPECTRO,
        "provenance": PROVENANCE,
        "derived": {
            "orbital_velocity_kms": round(geo.orbital_velocity_kms(), 4),
            "ground_speed_kms": round(geo.ground_speed_kms(), 4),
            "array_peak_w": round(power.PEAK_ARRAY_W, 2),
            "time_compression": round(power.SECONDS_PER_LOOP_SECOND, 2),
            "compression_bounds": geo.compression_bounds(),
            "orbit_period_s": ORBIT_PERIOD_S,
            "soc_envelope": power.soc_bounds(),
            "network_contact_s": round(comms.network_contact_s(), 0),
            "recorder_capacity_gb": comms.RECORDER_CAPACITY_GB,
            "min_elevation_deg": MIN_ELEVATION_DEG,
            "loop_closes": True,
        },
    }


@app.get("/mission/state")
def mission_state(
    slider: float = Query(0.0, ge=0.0, le=1.0),
    schedule_: bool = Query(True, alias="schedule"),
    track: bool = Query(True),
):
    """Complete spacecraft state at a slider position."""
    return mission.snapshot(slider, include_schedule=schedule_, include_track=track)


@app.post("/mission/mode")
def mission_mode(req: ModeRequest):
    """Translate a mode button press into the slider position that selects it."""
    mode = req.mode.upper()
    if mode not in MODES:
        raise HTTPException(400, f"unknown mode {mode!r}; expected one of {MODES}")
    s = mission.mode_to_slider(mode)
    return {"mode": mode, "slider": s, "state": mission.snapshot(s)}


@app.get("/mission/timeline")
def timeline(samples: int = Query(60, ge=4, le=600)):
    """
    Coarse profile across the whole loop — lets a UI draw the slider track
    with its real power curve and mode bands behind it.
    """
    rows = []
    for k in range(samples + 1):
        s = k / samples
        t = mission.slider_to_loop_t(s)
        seg = power.segment_for(t)
        tx = comms.transmitting_at(t)
        rows.append({
            "slider": round(s, 5),
            "loop_t_s": round(t, 2),
            "mode": seg["mode"],
            "egress": seg["egress"],
            "soc_pct": power.state_of_charge_pct(t),
            "generation_w": power.generation_w(seg["mode"]),
            "load_w": power.loads_w(seg["mode"], seg["payload_state"], tx)["total_w"],
            "compression": round(geo.time_compression(t), 1),
            "recorder_pct": round(
                comms.recorder_gb(t) / comms.RECORDER_CAPACITY_GB * 100.0, 1),
            "transmitting": tx,
        })
    return {
        "segments": TIMELINE_SEGMENTS,
        "samples": rows,
        "soc_envelope": power.soc_bounds(),
        "compression_bounds": geo.compression_bounds(),
        "contacts": [
            {
                "station_id": e["station"]["id"],
                "short": e["station"]["short"],
                "windows": [
                    {**w,
                     "loop_start_s": round(loop_time_at_orbit(w["orbit_start_s"]), 3),
                     "loop_end_s": round(loop_time_at_orbit(w["orbit_end_s"]), 3)}
                    for w in e["windows"]
                ],
            }
            for e in comms.all_passes()
        ],
    }


# ---------------------------------------------------------------------------
@app.get("/science/spectrum")
def spectrum(
    lat: Optional[float] = None,
    lon: Optional[float] = None,
    slider: float = Query(0.0, ge=0.0, le=1.0),
    bands: int = Query(96, ge=16, le=512),
):
    """Hyperspectral sample. Defaults to the current sub-satellite point."""
    t = mission.slider_to_loop_t(slider)
    if lat is None or lon is None:
        p = geo.subsatellite_point(t)
        lat, lon = p["lat"], p["lon"]
    return science.spectrum(lat, lon, phase=t, bands=bands)


@app.get("/science/field")
def algae_field(
    slider: float = Query(0.0, ge=0.0, le=1.0),
    nx: int = Query(48, ge=4, le=256),
    ny: int = Query(24, ge=4, le=256),
):
    """
    Gridded Chl-a field over the AOI — the data behind a heat overlay on
    the globe or a 2D map. Returned as a flat row-major array plus its
    bounding box, which is what a texture uploader wants.
    """
    t = mission.slider_to_loop_t(slider)
    w, s, e, n = AOI["bbox"]
    values, peak = [], 0.0
    for j in range(ny):
        lat = s + (n - s) * (j / (ny - 1))
        for i in range(nx):
            lon = w + (e - w) * (i / (nx - 1))
            v = science.chlorophyll_mg_m3(lat, lon, t)
            peak = max(peak, v)
            values.append(round(v, 3))
    return {
        "bbox": AOI["bbox"], "nx": nx, "ny": ny, "order": "row-major, south-to-north",
        "units": "mg m^-3", "max": round(peak, 3),
        "values": values,
    }


@app.get("/science/water-quality")
def water_quality(slider: float = Query(0.0, ge=0.0, le=1.0)):
    return {"plants": science.plant_water_quality(mission.slider_to_loop_t(slider))}


# ---------------------------------------------------------------------------
@app.get("/desalination/schedule")
def desal_schedule(slider: float = Query(0.0, ge=0.0, le=1.0)):
    t = mission.slider_to_loop_t(slider)
    return schedule(power.segment_for(t)["mode"], t)


# ---------------------------------------------------------------------------
@app.get("/telemetry/downlink")
def telemetry_downlink(
    slider: float = Query(0.0, ge=0.0, le=1.0),
    count: int = Query(12, ge=1, le=64),
    frame: int = Query(0, ge=0),
):
    state = mission.snapshot(slider, include_schedule=True, include_track=False)
    return {"lines": downlink.build(state, count=count, seed=frame),
            "mode": state["mode"]["id"]}


# ---------------------------------------------------------------------------
@app.get("/map/geometry")
def map_geometry(slider: float = Query(0.0, ge=0.0, le=1.0)):
    t = mission.slider_to_loop_t(slider)
    return mission.map_geometry(t, power.segment_for(t)["mode"])


@app.get("/map/groundtrack")
def groundtrack(samples: int = Query(240, ge=16, le=2000)):
    return {"track": geo.ground_track(samples=samples),
            "period_min": SPACECRAFT["orbit"]["period_min"]}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0",
                port=int(os.environ.get("WORKER_PORT", 8811)), reload=False)
