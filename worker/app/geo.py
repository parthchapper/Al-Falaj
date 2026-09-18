"""
Geodesy and ground-track geometry.

The loop covers exactly one orbital period and Earth's rotation is held fixed,
so the ground track is a closed great circle: the sub-satellite point at the
end of the loop is the point at the start, to 1e-13 degrees.

A real sun-synchronous ground track does *not* close — Earth turns ~23.7° west
beneath the orbit each revolution, which is exactly how a 5-day repeat cycle
builds global coverage. Freezing that rotation is the one deliberate
simplification in the propagator, made so the demo loop has no seam. The orbit
itself — inclination, period, altitude, the shape of the track — is unchanged,
and ``clock.earth_rotation`` reports the simplification in every frame. See
docs/ARCHITECTURE.md.
"""
import math
from typing import Dict, List, Tuple

from .config import (
    AOI, LOOP_DURATION_S, MIN_ELEVATION_DEG, ORBIT_PERIOD_S, SPACECRAFT,
    WARP, WARP_LOOP_AT, WARP_TOTAL, warp_density,
)

R_EARTH_KM = 6378.137
MU_EARTH = 398600.4418            # km^3 / s^2
EARTH_ROT_DEG_PER_MIN = 0.2506844  # reported, not applied

ALT_KM = SPACECRAFT["orbit"]["altitude_km"]
INC_DEG = SPACECRAFT["orbit"]["inclination_deg"]
PERIOD_S = ORBIT_PERIOD_S
SWATH_KM = SPACECRAFT["payload"]["swath_km"]

R_ORBIT_KM = R_EARTH_KM + ALT_KM

# Orbit phasing.
#
# Solved, not chosen: these are the two constants for which the descending arc
# puts the sub-satellite point exactly over the AOI centre (24.6 N, 54.2 E) at
# the midpoint of the ACTIVE segment. Change the segment layout and they must
# be re-solved — ``tools/solve_phase.py`` does it.
U0_DEG = 188.145597         # argument of latitude at orbit t = 0
LON_ASC0_DEG = -129.250944  # ascending-node longitude at orbit t = 0


# ---------------------------------------------------------------------------
# Time warp
# ---------------------------------------------------------------------------
def orbit_seconds(loop_t: float) -> float:
    """
    Orbit seconds elapsed at a given loop time — the inverse of the warp table.

    Binary search for the bracketing sample, then linear interpolation. The
    table is monotone by construction (the density is strictly positive), so
    the inverse is single-valued.
    """
    t = loop_t % LOOP_DURATION_S
    n = WARP["samples"]
    table = WARP_LOOP_AT
    lo, hi = 0, n
    while lo < hi:
        mid = (lo + hi) // 2
        if table[mid] <= t:
            lo = mid + 1
        else:
            hi = mid
    k = max(1, lo)
    t0, t1 = table[k - 1], table[k]
    f = 0.0 if t1 <= t0 else (t - t0) / (t1 - t0)
    return PERIOD_S * ((k - 1) + f) / n


def time_compression(loop_t: float) -> float:
    """Orbit seconds elapsed per loop second at this point in the timeline."""
    x = orbit_seconds(loop_t) / PERIOD_S
    return (PERIOD_S / LOOP_DURATION_S) * (WARP_TOTAL / warp_density(x))


def compression_bounds() -> Dict[str, float]:
    """Slowest and fastest the clock ever runs, for labelling the readout."""
    base = (PERIOD_S / LOOP_DURATION_S) * WARP_TOTAL
    return {
        "min": round(base / warp_density(WARP["phase_pass"]), 2),
        "max": round(base / warp_density(WARP["phase_pass"] + 0.5), 2),
    }


def orbital_velocity_kms() -> float:
    return math.sqrt(MU_EARTH / R_ORBIT_KM)


def ground_speed_kms() -> float:
    return orbital_velocity_kms() * (R_EARTH_KM / R_ORBIT_KM)


def _wrap_lon(lon: float) -> float:
    return (lon + 180.0) % 360.0 - 180.0


def argument_of_latitude(loop_t: float) -> float:
    return (U0_DEG + 360.0 * (orbit_seconds(loop_t) / PERIOD_S)) % 360.0


def subsatellite_point_at_orbit(orbit_t: float) -> Dict[str, float]:
    """
    Geodetic sub-satellite point for a given *orbit* time.

    A function of orbit phase alone. Because the phase advances by exactly
    360 degrees over the loop and no rotation term is applied,
    subsatellite_point(0) == subsatellite_point(LOOP_DURATION_S): the track
    closes.
    """
    u = math.radians((U0_DEG + 360.0 * (orbit_t / PERIOD_S)) % 360.0)
    i = math.radians(INC_DEG)
    lat = math.degrees(math.asin(math.sin(i) * math.sin(u)))
    dlon = math.degrees(math.atan2(math.cos(i) * math.sin(u), math.cos(u)))
    return {"lat": lat, "lon": _wrap_lon(LON_ASC0_DEG + dlon), "alt_km": ALT_KM}


def subsatellite_point(loop_t: float) -> Dict[str, float]:
    return subsatellite_point_at_orbit(orbit_seconds(loop_t))


def ground_track(samples: int = 240, span_s: float = LOOP_DURATION_S,
                 start_s: float = 0.0) -> List[Dict[str, float]]:
    """
    Polyline of sub-satellite points, for drawing the orbit on the globe.

    Sampled evenly in *orbit* time rather than loop time, so the rendered
    track has uniform spacing instead of bunching up inside the slow zone.
    """
    out = []
    o0 = orbit_seconds(start_s)
    o_span = (PERIOD_S if span_s >= LOOP_DURATION_S
              else orbit_seconds(start_s + span_s) - o0)
    for k in range(samples + 1):
        ot = o0 + o_span * (k / samples)
        p = subsatellite_point_at_orbit(ot)
        out.append({"lat": round(p["lat"], 5), "lon": round(p["lon"], 5)})
    return out


def ground_track_orbit(samples: int, orbit_span_s: float,
                       start_orbit_s: float) -> List[Dict[str, float]]:
    """
    Ground track over a span of *orbit* seconds.

    Used for the look-ahead: seven minutes of flight is the same piece of
    geometry whether the clock is running at 4x or 124x, so a look-ahead
    specified in loop seconds would stretch and shrink as the warp changed.
    """
    span = min(orbit_span_s, PERIOD_S)
    out = []
    for k in range(samples + 1):
        p = subsatellite_point_at_orbit(start_orbit_s + span * (k / samples))
        out.append({"lat": round(p["lat"], 5), "lon": round(p["lon"], 5)})
    return out


def heading_deg(loop_t: float, dt: float = 0.5) -> float:
    """Instantaneous ground-track heading, degrees clockwise from north."""
    ot = orbit_seconds(loop_t)
    a = subsatellite_point_at_orbit(ot - dt)
    b = subsatellite_point_at_orbit(ot + dt)
    dlon = math.radians(_wrap_lon(b["lon"] - a["lon"]))
    la1 = math.radians(a["lat"])
    la2 = math.radians(b["lat"])
    y = math.sin(dlon) * math.cos(la2)
    x = (math.cos(la1) * math.sin(la2)
         - math.sin(la1) * math.cos(la2) * math.cos(dlon))
    return math.degrees(math.atan2(y, x)) % 360.0


def _offset(lat: float, lon: float, bearing_deg: float,
            dist_km: float) -> Tuple[float, float]:
    """Great-circle destination point."""
    d = dist_km / R_EARTH_KM
    br = math.radians(bearing_deg)
    la1 = math.radians(lat)
    lo1 = math.radians(lon)
    la2 = math.asin(math.sin(la1) * math.cos(d)
                    + math.cos(la1) * math.sin(d) * math.cos(br))
    lo2 = lo1 + math.atan2(math.sin(br) * math.sin(d) * math.cos(la1),
                           math.cos(d) - math.sin(la1) * math.sin(la2))
    return math.degrees(la2), _wrap_lon(math.degrees(lo2))


def swath_edges(loop_t: float) -> Dict[str, Dict[str, float]]:
    """Left and right edge points of the instantaneous scan line."""
    p = subsatellite_point(loop_t)
    hdg = heading_deg(loop_t)
    half = SWATH_KM / 2.0
    l_lat, l_lon = _offset(p["lat"], p["lon"], (hdg - 90.0) % 360.0, half)
    r_lat, r_lon = _offset(p["lat"], p["lon"], (hdg + 90.0) % 360.0, half)
    return {
        "left": {"lat": round(l_lat, 5), "lon": round(l_lon, 5)},
        "right": {"lat": round(r_lat, 5), "lon": round(r_lon, 5)},
    }


def swath_polygon(start_s: float, end_s: float,
                  samples: int = 40) -> List[List[float]]:
    """
    Closed [lon, lat] ring covering everything imaged between two loop times.
    Emitted GeoJSON-compatible so a UI can drop it straight into a map layer.
    """
    left, right = [], []
    for k in range(samples + 1):
        t = start_s + (end_s - start_s) * (k / samples)
        e = swath_edges(t)
        left.append([e["left"]["lon"], e["left"]["lat"]])
        right.append([e["right"]["lon"], e["right"]["lat"]])
    ring = left + right[::-1]
    ring.append(ring[0])
    return ring


def great_circle_km(lat1: float, lon1: float,
                    lat2: float, lon2: float) -> float:
    la1, la2 = math.radians(lat1), math.radians(lat2)
    dla = la2 - la1
    dlo = math.radians(lon2 - lon1)
    a = (math.sin(dla / 2) ** 2
         + math.cos(la1) * math.cos(la2) * math.sin(dlo / 2) ** 2)
    return 2 * R_EARTH_KM * math.asin(min(1.0, math.sqrt(a)))


def in_aoi(lat: float, lon: float) -> bool:
    w, s, e, n = AOI["bbox"]
    return s <= lat <= n and w <= lon <= e


def slant_range_km(lat: float, lon: float,
                   target_lat: float, target_lon: float) -> float:
    """Straight-line range from the spacecraft to a point on the surface."""
    arc = great_circle_km(lat, lon, target_lat, target_lon) / R_EARTH_KM
    return math.sqrt(R_ORBIT_KM ** 2 + R_EARTH_KM ** 2
                     - 2 * R_ORBIT_KM * R_EARTH_KM * math.cos(arc))


def elevation_deg(sat_lat: float, sat_lon: float,
                  gs_lat: float, gs_lon: float) -> float:
    """
    Elevation angle of the spacecraft as seen from a ground station.

        tan(el) = (cos(gamma) - R_earth / R_orbit) / sin(gamma)

    where gamma is the central angle between station and sub-satellite point.
    atan2 is used rather than acos because acos is even in gamma and therefore
    reports a spacecraft on the far side of the planet as being overhead — the
    horizon is at gamma = 22.4 deg for a 520 km orbit, and everything beyond
    it must come back negative.
    """
    gamma = great_circle_km(sat_lat, sat_lon, gs_lat, gs_lon) / R_EARTH_KM
    return math.degrees(math.atan2(math.cos(gamma) - R_EARTH_KM / R_ORBIT_KM,
                                   math.sin(gamma)))


# ---------------------------------------------------------------------------
# Acquisition / loss of signal
# ---------------------------------------------------------------------------
PASS_STEP_S = 2.0    # orbit seconds between visibility samples


def station_passes(station: Dict) -> List[Dict[str, float]]:
    """
    Every contact window with a station over one orbit, in orbit time.

    Swept in orbit time at a fixed step and refined by bisection on the
    horizon crossing, so the AOS and LOS marks are accurate to well under a
    tenth of a loop second regardless of how the warp stretches that region.
    """
    def visible(ot: float) -> bool:
        p = subsatellite_point_at_orbit(ot)
        return elevation_deg(p["lat"], p["lon"],
                             station["lat"], station["lon"]) >= MIN_ELEVATION_DEG

    def crossing(a: float, b: float) -> float:
        lo, hi = a, b
        va = visible(a)
        for _ in range(24):
            mid = (lo + hi) / 2
            if visible(mid) == va:
                lo = mid
            else:
                hi = mid
        return (lo + hi) / 2

    out: List[List[float]] = []
    open_at = None
    prev = visible(0.0)
    if prev:
        open_at = 0.0
    ot = PASS_STEP_S
    while ot <= PERIOD_S:
        now = visible(ot)
        if now and not prev:
            open_at = crossing(ot - PASS_STEP_S, ot)
        elif not now and prev and open_at is not None:
            out.append([open_at, crossing(ot - PASS_STEP_S, ot)])
            open_at = None
        prev = now
        ot += PASS_STEP_S
    if open_at is not None:
        out.append([open_at, PERIOD_S])

    windows = []
    for a, b in out:
        peak, peak_at = -90.0, a
        steps = 48
        for k in range(steps + 1):
            t = a + (b - a) * k / steps
            p = subsatellite_point_at_orbit(t)
            el = elevation_deg(p["lat"], p["lon"],
                               station["lat"], station["lon"])
            if el > peak:
                peak, peak_at = el, t
        windows.append({
            "orbit_start_s": round(a, 1),
            "orbit_end_s": round(b, 1),
            "duration_s": round(b - a, 1),
            "peak_elevation_deg": round(peak, 2),
            "peak_orbit_s": round(peak_at, 1),
        })
    return windows
