"""
Electrical power subsystem model.

Honest physics, not theatre. A 6U CubeSat with ~0.10 m^2 of triple-junction
cells generates ~41 W in full sun; housekeeping draws 6.2 W; the payload
draws 22 W while imaging and 3.5 W in standby; the X-band radio draws 9 W
whenever it is keyed.

The radio load is driven by real contact geometry rather than by mode, so the
polar dump over Troll costs the battery 9 W *while the spacecraft is in
eclipse* — the deepest point of the orbit, and exactly the sort of thing a
power budget exists to catch.

Over a 33-minute eclipse the depth of discharge is only a few percent, which
is what a real flight profile looks like. Because a small swing is invisible
on a full-range gauge, the model also returns a recommended display window
(`gauge.min_pct`/`gauge.max_pct`) so a front end can zoom the needle
without misrepresenting the number. The raw `soc_pct` is always the truth.
"""
from __future__ import annotations

from functools import lru_cache
from typing import Dict, List

from . import geo
from .comms import transmitting_at
from .config import (
    EPS, LOOP_DURATION_S, ORBIT_PERIOD_S, SPACECRAFT, TIMELINE_SEGMENTS,
)

PAYLOAD = SPACECRAFT["payload"]

# Array-normal cosine factor per mode: sun-pointed in SUN_FACING, tipped
# off-sun while the payload slews to the target in ACTIVE, zero in eclipse.
ARRAY_COS = {"ECLIPSE": 0.0, "SUN_FACING": 0.97, "ACTIVE": 0.74}

PAYLOAD_LOAD_W = {
    "DISABLED": 0.0,
    "STANDBY_CHARGING": PAYLOAD["standby_power_w"],
    "IMAGING": PAYLOAD["peak_power_w"],
}

RADIO_TX_W = EPS["radio_tx_w"]   # transmitter keyed
RADIO_IDLE_W = 0.6               # receiver + beacon, always on

SOC_AT_LOOP_START_PCT = 94.0

PEAK_ARRAY_W = (EPS["array_area_m2"] * EPS["array_efficiency"]
                * EPS["solar_constant_w_m2"])

# Mean compression across the loop, quoted in telemetry. The instantaneous
# rate differs continuously — see geo.time_compression.
SECONDS_PER_LOOP_SECOND = ORBIT_PERIOD_S / LOOP_DURATION_S


def charge_taper(soc_pct: float) -> float:
    """
    Li-ion constant-current / constant-voltage behaviour.

    Full current up to 88 % state of charge, then tapering to zero at
    100 %. Without this the battery would slam into the ceiling and the
    gauge would flat-line for most of the sunlit arc.
    """
    if soc_pct <= 88.0:
        return 1.0
    return max(0.0, (100.0 - soc_pct) / 12.0) ** 1.35


def segment_for(loop_t: float) -> Dict:
    t = loop_t % LOOP_DURATION_S
    for seg in TIMELINE_SEGMENTS:
        if seg["start_s"] <= t < seg["end_s"]:
            return seg
    return TIMELINE_SEGMENTS[-1]


def generation_w(mode: str) -> float:
    return round(PEAK_ARRAY_W * ARRAY_COS.get(mode, 0.0), 2)


def loads_w(mode: str, payload_state: str,
            transmitting: bool = False) -> Dict[str, float]:
    bus = EPS["bus_housekeeping_w"]
    payload = PAYLOAD_LOAD_W.get(payload_state, 0.0)
    radio = RADIO_TX_W if transmitting else RADIO_IDLE_W
    return {
        "bus_w": round(bus, 2),
        "payload_w": round(payload, 2),
        "radio_w": round(radio, 2),
        "total_w": round(bus + payload + radio, 2),
    }


@lru_cache(maxsize=1)
def _soc_profile(step_s: float = 0.1) -> List[float]:
    """
    Pre-integrated state-of-charge across one loop, in percent.

    Integrated once and cached: the scripted loop is deterministic, so the
    same loop time always yields the same SoC no matter when it is queried.
    """
    capacity = EPS["battery_capacity_wh"]
    n = int(LOOP_DURATION_S / step_s) + 1

    def integrate(soc0: float):
        soc = soc0
        profile = []
        for k in range(n):
            t = k * step_s
            seg = segment_for(t)
            gen = generation_w(seg["mode"])
            load = loads_w(seg["mode"], seg["payload_state"],
                           transmitting_at(t))["total_w"]
            net_w = gen - load
            # Charge efficiency and CC/CV taper apply only when charging.
            if net_w > 0:
                net_w *= 0.93 * charge_taper(soc)
            # Integrate in real orbital time, at the local warp rate.
            real_hours = (step_s * geo.time_compression(t)) / 3600.0
            soc += (net_w * real_hours / capacity) * 100.0
            soc = min(100.0, max(0.0, soc))
            profile.append(soc)
        return profile

    # Solve for the periodic steady state: a repeating orbit must end the
    # loop at the state of charge it started with, or the gauge jumps every
    # time the timeline wraps. Converges in a handful of iterations.
    soc0 = SOC_AT_LOOP_START_PCT
    profile = integrate(soc0)
    for _ in range(40):
        drift = profile[-1] - soc0
        if abs(drift) < 1e-4:
            break
        soc0 = min(100.0, max(0.0, soc0 + drift * 0.6))
        profile = integrate(soc0)
    return profile


def state_of_charge_pct(loop_t: float, step_s: float = 0.1) -> float:
    profile = _soc_profile(step_s)
    idx = int((loop_t % LOOP_DURATION_S) / step_s)
    return round(profile[min(idx, len(profile) - 1)], 3)


def soc_bounds() -> Dict[str, float]:
    profile = _soc_profile()
    return {"min": round(min(profile), 3), "max": round(max(profile), 3)}


def power_state(loop_t: float) -> Dict:
    """Full EPS snapshot for one loop time."""
    seg = segment_for(loop_t)
    mode = seg["mode"]
    tx = transmitting_at(loop_t)
    gen = generation_w(mode)
    load = loads_w(mode, seg["payload_state"], tx)
    soc = state_of_charge_pct(loop_t)
    bounds = soc_bounds()
    net = round(gen - load["total_w"], 2)

    # Zoom the gauge to the range the mission actually uses, padded 1 %.
    g_min = max(0.0, round(bounds["min"] - 1.0, 1))
    g_max = min(100.0, round(bounds["max"] + 1.0, 1))

    margin = round(soc - EPS["battery_min_soc_pct"], 2)
    if net < 0:
        hours_to_floor = ((soc - EPS["battery_min_soc_pct"]) / 100.0
                          * EPS["battery_capacity_wh"]) / abs(net)
    else:
        hours_to_floor = None

    return {
        "mode": mode,
        "generation_w": gen,
        "array_peak_w": round(PEAK_ARRAY_W, 2),
        "array_cosine": ARRAY_COS.get(mode, 0.0),
        "loads": load,
        "transmitting": tx,
        "net_w": net,
        "flow": "CHARGING" if net > 0.05 else ("DISCHARGING" if net < -0.05 else "FLOAT"),
        "battery": {
            "soc_pct": soc,
            "stored_wh": round(EPS["battery_capacity_wh"] * soc / 100.0, 2),
            "capacity_wh": EPS["battery_capacity_wh"],
            "bus_voltage_v": round(EPS["battery_nominal_v"] * (0.92 + 0.08 * soc / 100.0), 2),
            "depth_of_discharge_pct": round(100.0 - soc, 3),
            "margin_to_floor_pct": margin,
            "hours_to_floor": round(hours_to_floor, 2) if hours_to_floor else None,
            "flight_rule_floor_pct": EPS["battery_min_soc_pct"],
            "violated": soc < EPS["battery_min_soc_pct"],
        },
        "gauge": {
            "min_pct": g_min,
            "max_pct": g_max,
            "note": "Display window zoomed to the mission's real SoC envelope; "
                    "soc_pct is the unscaled value.",
        },
    }
