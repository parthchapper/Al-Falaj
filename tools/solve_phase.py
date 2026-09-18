#!/usr/bin/env python3
"""
Re-solve the orbit phase constants, and report what the resulting orbit does.

`geo.U0_DEG` and `geo.LON_ASC0_DEG` are not chosen — they are the unique pair
for which the descending arc puts the sub-satellite point over the AOI centre
at the midpoint of the ACTIVE segment. Change the segment layout in
`config.ORBIT_SEGMENTS` and they must be re-solved; run this, then paste the
two constants into `worker/app/geo.py` and `site/engine/geo.js`.

It also prints the ground-station contact windows, which is how the baseline
network in `config.GROUND_STATIONS` was chosen: by finding which real stations
this orbit actually sees, rather than by picking famous ones.

    python3 tools/solve_phase.py
"""
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "worker"))

from app import config, geo  # noqa: E402


def solve():
    """U0 and LON_ASC0 putting the pass centre over the AOI centre."""
    i = math.radians(config.SPACECRAFT["orbit"]["inclination_deg"])
    lat_c = config.AOI["center"]["lat"]
    lon_c = config.AOI["center"]["lon"]
    period = config.ORBIT_PERIOD_S
    t_mid = config.PASS_MID_ORBIT_S

    # Descending branch: argument of latitude in (90, 270) deg.
    u_pass = math.pi - math.asin(math.sin(math.radians(lat_c)) / math.sin(i))
    u0 = (math.degrees(u_pass) - 360.0 * (t_mid / period)) % 360.0

    dlon = math.degrees(math.atan2(math.cos(i) * math.sin(u_pass),
                                   math.cos(u_pass)))
    lon0 = (lon_c - dlon + 180.0) % 360.0 - 180.0
    return u0, lon0


def main():
    u0, lon0 = solve()
    print("Solved phase constants")
    print(f"  U0_DEG       = {u0:.6f}   (in use: {geo.U0_DEG})")
    print(f"  LON_ASC0_DEG = {lon0:.6f}   (in use: {geo.LON_ASC0_DEG})")
    drift = max(abs(u0 - geo.U0_DEG), abs(lon0 - geo.LON_ASC0_DEG))
    print(f"  max drift from the constants in geo.py: {drift:.2e} deg")

    a = geo.subsatellite_point(0.0)
    b = geo.subsatellite_point(config.LOOP_DURATION_S)
    print("\nLoop closure (frozen Earth rotation)")
    print(f"  t=0          {a['lat']:+.9f}, {a['lon']:+.9f}")
    print(f"  t=LOOP       {b['lat']:+.9f}, {b['lon']:+.9f}")
    print(f"  delta        {abs(a['lat']-b['lat']):.2e}, "
          f"{abs(a['lon']-b['lon']):.2e} deg")

    cb = geo.compression_bounds()
    print("\nTime warp")
    print(f"  loop duration   {config.LOOP_DURATION_S:.0f} s "
          f"for one {config.ORBIT_PERIOD_S:.0f} s orbit")
    print(f"  slowest (pass)  {cb['min']:.2f}x")
    print(f"  fastest (coast) {cb['max']:.2f}x")
    print(f"  ratio           {cb['max']/cb['min']:.1f}x")

    print("\nSegments")
    for s in config.TIMELINE_SEGMENTS:
        span_o = s["orbit_end_s"] - s["orbit_start_s"]
        span_l = s["end_s"] - s["start_s"]
        tag = " (egress)" if s["egress"] else ""
        print(f"  {s['mode']:11s}{tag:9s} orbit {s['orbit_start_s']:6.0f}-"
              f"{s['orbit_end_s']:6.0f}s -> loop {s['start_s']:5.2f}-"
              f"{s['end_s']:5.2f}s   {span_o/span_l:7.1f}x")

    print("\nAOI crossing")
    for k in range(0, 21):
        ot = (config.ORBIT_SEGMENTS[2]["orbit_start_s"]
              + (config.ORBIT_SEGMENTS[2]["orbit_end_s"]
                 - config.ORBIT_SEGMENTS[2]["orbit_start_s"]) * k / 20)
        p = geo.subsatellite_point_at_orbit(ot)
        mark = "  <-- in AOI" if geo.in_aoi(p["lat"], p["lon"]) else ""
        print(f"  orbit {ot:7.1f}s   {p['lat']:+7.3f}, {p['lon']:+8.3f}{mark}")

    print("\nGround-station contacts (>= "
          f"{config.MIN_ELEVATION_DEG:.0f} deg elevation)")
    for gs in config.GROUND_STATIONS:
        windows = geo.station_passes(gs)
        print(f"  {gs['id']:8s} {gs['name']}")
        if not windows:
            print("           no contact this orbit")
        for w in windows:
            l0 = config.loop_time_at_orbit(w["orbit_start_s"])
            l1 = config.loop_time_at_orbit(w["orbit_end_s"])
            print(f"           orbit {w['orbit_start_s']:6.1f}-"
                  f"{w['orbit_end_s']:6.1f}s ({w['duration_s']:5.1f}s)  "
                  f"peak {w['peak_elevation_deg']:5.2f} deg   "
                  f"loop {l0:5.2f}-{l1:5.2f}s")


if __name__ == "__main__":
    main()
