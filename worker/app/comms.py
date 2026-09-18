"""
Ground segment: contact windows, link budget, solid-state recorder.

The contact windows are not scripted. ``geo.station_passes`` sweeps the real
propagator against each station's 10-degree horizon mask, so when the board
says AOS in 4 seconds, that is when the spacecraft actually rises.

Because the radio draws 9 W whenever it transmits — including the polar dumps
that happen in eclipse — this module is also an input to the power model, not
just a display.
"""
from functools import lru_cache
from typing import Dict, List, Optional

from . import geo
from .config import (
    GROUND_STATIONS, LOOP_DURATION_S, ORBIT_PERIOD_S, TIMELINE_SEGMENTS,
)

# Payload data rate.
#
# 180 km swath at 30 m GSD is 6000 cross-track pixels; 96 bands at 12 bit,
# read out at ground speed / GSD = 233 lines per second, is 1.61 Gbps raw. At
# the ~4:1 the onboard compressor achieves on ocean scenes, 400 Mbps.
PAYLOAD_RATE_MBPS = 400.0
# Housekeeping, ADCS, GPS and dark-frame calibration, always accumulating.
HOUSEKEEPING_RATE_MBPS = 1.2
RECORDER_CAPACITY_GB = 16.0

MBIT_TO_GB = 1 / 8000.0   # megabits -> gigabytes


# ---------------------------------------------------------------------------
# Contact windows
# ---------------------------------------------------------------------------
@lru_cache(maxsize=1)
def all_passes() -> tuple:
    """Every station's contact windows over one orbit. Geometry, so cached."""
    return tuple(
        {"station": gs, "windows": geo.station_passes(gs)}
        for gs in GROUND_STATIONS
    )


def network_contact_s() -> float:
    """Total contact time per orbit, across the whole network."""
    return sum(w["duration_s"] for e in all_passes() for w in e["windows"])


def station_link(entry: Dict, orbit_t: float) -> Dict:
    """
    Link state for one station at one orbit time.

    ``next_pass.in_s`` counts forward, wrapping the orbit, so the board always
    has a countdown to show even when nothing is in view.
    """
    gs = entry["station"]
    p = geo.subsatellite_point_at_orbit(orbit_t)
    el = geo.elevation_deg(p["lat"], p["lon"], gs["lat"], gs["lon"])
    rng = geo.slant_range_km(p["lat"], p["lon"], gs["lat"], gs["lon"])

    current = None
    for w in entry["windows"]:
        if w["orbit_start_s"] <= orbit_t <= w["orbit_end_s"]:
            current = w
            break

    # Nearest window that starts at or after now, wrapping to the next orbit.
    nxt, next_in = None, float("inf")
    for w in entry["windows"]:
        d = w["orbit_start_s"] - orbit_t
        if d < 0:
            d += ORBIT_PERIOD_S
        if d < next_in:
            next_in, nxt = d, w

    # Usable rate rolls off at low elevation: longer slant range, more
    # atmosphere, worse G/T. Full rate above 60 degrees.
    rate = round(gs["rate_mbps"] * min(1.0, el / 60.0), 1) if current else 0.0

    return {
        "station_id": gs["id"],
        "name": gs["name"],
        "short": gs["short"],
        "band": gs["band"],
        "role": gs["role"],
        "lat": gs["lat"],
        "lon": gs["lon"],
        "elevation_deg": round(el, 2),
        "slant_range_km": round(rng, 1),
        "visible": bool(current),
        "rate_mbps": rate,
        "max_rate_mbps": gs["rate_mbps"],
        "pass": ({
            "aos_orbit_s": current["orbit_start_s"],
            "los_orbit_s": current["orbit_end_s"],
            "duration_s": current["duration_s"],
            "peak_elevation_deg": current["peak_elevation_deg"],
            "elapsed_s": round(orbit_t - current["orbit_start_s"], 1),
            "remaining_s": round(current["orbit_end_s"] - orbit_t, 1),
            "progress": round(
                (orbit_t - current["orbit_start_s"])
                / max(1e-6, current["duration_s"]), 4),
        } if current else None),
        "next_pass": ({
            "in_s": round(next_in, 1),
            "duration_s": nxt["duration_s"],
            "peak_elevation_deg": nxt["peak_elevation_deg"],
        } if nxt else None),
    }


def active_link(links: List[Dict]) -> Optional[Dict]:
    """The station currently carrying the link, or None. Highest rate wins."""
    up = [l for l in links if l["visible"] and l["rate_mbps"] > 0]
    if not up:
        return None
    return max(up, key=lambda l: l["rate_mbps"])


# ---------------------------------------------------------------------------
# Solid-state recorder
# ---------------------------------------------------------------------------
_STEP_S = 0.1


def _segment_mode_at(loop_t: float) -> str:
    t = loop_t % LOOP_DURATION_S
    for s in TIMELINE_SEGMENTS:
        if s["start_s"] <= t < s["end_s"]:
            return s["mode"]
    return TIMELINE_SEGMENTS[-1]["mode"]


def downlink_rate_at_orbit(orbit_t: float) -> float:
    """
    Best available downlink rate at an orbit time, Mbps.

    The hot path: called ~70k times while the recorder and battery profiles
    converge, so it walks the cached windows and computes one elevation per
    visible station rather than building a link object per station per step.
    Returns exactly what ``active_link`` would pick.
    """
    best = 0.0
    for entry in all_passes():
        gs = entry["station"]
        for w in entry["windows"]:
            if w["orbit_start_s"] <= orbit_t <= w["orbit_end_s"]:
                p = geo.subsatellite_point_at_orbit(orbit_t)
                el = geo.elevation_deg(p["lat"], p["lon"], gs["lat"], gs["lon"])
                rate = round(gs["rate_mbps"] * min(1.0, el / 60.0), 1)
                if rate > best:
                    best = rate
                break
    return best


def downlink_rate_at(loop_t: float) -> float:
    """Downlink rate available at a loop time, Mbps — 0 with nothing in view."""
    return downlink_rate_at_orbit(geo.orbit_seconds(loop_t))


def transmitting_at(loop_t: float) -> bool:
    """True when the transmitter is keyed — drives the 9 W radio load."""
    return downlink_rate_at(loop_t) > 0


@lru_cache(maxsize=1)
def recorder_profile() -> List[float]:
    """
    Pre-integrated recorder fill across one loop, in gigabytes.

    Solved for the periodic steady state exactly as the battery is: an orbit
    that ends with more data than it started with is an orbit whose recorder
    overflows eventually, and a gauge that jumps at the wrap is a gauge nobody
    believes. Integrated in real orbital time, so the warp does not change how
    much data a pass produces.
    """
    n = int(LOOP_DURATION_S / _STEP_S) + 1

    def integrate(start: float) -> List[float]:
        gb = start
        out = []
        for k in range(n):
            t = k * _STEP_S
            real_s = _STEP_S * geo.time_compression(t)
            imaging = _segment_mode_at(t) == "ACTIVE"
            in_rate = (PAYLOAD_RATE_MBPS if imaging else 0.0) \
                + HOUSEKEEPING_RATE_MBPS
            out_rate = downlink_rate_at(t)
            gb += (in_rate - out_rate) * real_s * MBIT_TO_GB
            gb = max(0.0, min(RECORDER_CAPACITY_GB, gb))
            out.append(gb)
        return out

    start = 0.4
    profile = integrate(start)
    for _ in range(40):
        drift = profile[-1] - start
        if abs(drift) < 1e-5:
            break
        start = max(0.0, min(RECORDER_CAPACITY_GB, start + drift * 0.6))
        profile = integrate(start)
    return profile


def recorder_gb(loop_t: float) -> float:
    profile = recorder_profile()
    t = loop_t % LOOP_DURATION_S
    return round(profile[min(int(t / _STEP_S), len(profile) - 1)], 4)


# ---------------------------------------------------------------------------
# Snapshot
# ---------------------------------------------------------------------------
def comms_state(loop_t: float, mode: str) -> Dict:
    orbit_t = geo.orbit_seconds(loop_t)
    links = [station_link(e, orbit_t) for e in all_passes()]
    active = active_link(links)
    live = bool(active)
    imaging = mode == "ACTIVE"

    gb = recorder_gb(loop_t)
    in_rate = (PAYLOAD_RATE_MBPS if imaging else 0.0) + HOUSEKEEPING_RATE_MBPS
    out_rate = active["rate_mbps"] if active else 0.0

    if live and imaging:
        state = "LIVE DOWNLINK"
    elif live:
        state = "RECORDER DUMP"
    elif mode == "ECLIPSE":
        state = "BEACON ONLY"
    else:
        state = "STANDBY"

    # Time to empty the recorder at the current rate.
    net = out_rate - in_rate
    drain_s = round(gb / (net * MBIT_TO_GB), 0) if (live and net > 0) else None

    return {
        "links": links,
        "active_link": active["station_id"] if active else None,
        "active_station": active["name"] if active else None,
        "state": state,
        "network_contact_s": round(network_contact_s(), 0),
        "network_duty_pct": round(network_contact_s() / ORBIT_PERIOD_S * 100, 1),
        "downlink": {
            "live": live,
            "rate_mbps": out_rate,
            "modulation": "8PSK 3/4 LDPC" if live else None,
            "ber": 1.8e-9 if live else None,
            "eb_n0_db": (round(9.4 + active["elevation_deg"] / 30, 2)
                         if live else None),
            "elevation_deg": active["elevation_deg"] if live else None,
        },
        "recorder": {
            "fill_gb": gb,
            "capacity_gb": RECORDER_CAPACITY_GB,
            "fill_pct": round(gb / RECORDER_CAPACITY_GB * 100, 1),
            "in_rate_mbps": round(in_rate, 1),
            "out_rate_mbps": out_rate,
            "net_mbps": round(out_rate - in_rate, 1),
            "trend": ("DRAINING" if out_rate > in_rate
                      else ("FILLING FAST" if imaging else "FILLING")),
            "drain_eta_s": drain_s,
        },
    }
