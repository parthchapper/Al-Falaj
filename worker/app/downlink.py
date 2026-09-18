"""
LIVE DOWNLINK log generator.

Emits CCSDS-flavoured telemetry lines derived from the real state snapshot,
so every line in the scrolling log corresponds to a number shown elsewhere
on the console. Nothing here is decorative filler.
"""
from __future__ import annotations

import random
from datetime import datetime, timedelta, timezone
from typing import Dict, List

from .config import SPACECRAFT

APIDS = {
    "EPS": 0x0A2, "ADCS": 0x0B7, "THM": 0x0C1, "PLD": 0x1F4,
    "CDH": 0x0D9, "RF": 0x0E3, "SCI": 0x201, "OPS": 0x300,
}


def _ts(state: Dict, offset_s: float = 0.0) -> str:
    base = datetime.fromisoformat(state["clock"]["mission_time_utc"])
    return (base + timedelta(seconds=offset_s)).strftime("%H:%M:%S.%f")[:-3]


def _line(sub: str, sev: str, text: str, state: Dict, off: float) -> Dict:
    return {
        "t": _ts(state, off),
        "apid": f"0x{APIDS.get(sub, 0x000):03X}",
        "subsystem": sub,
        "severity": sev,      # NOMINAL | INFO | WARN | CRIT | SCIENCE
        "text": text,
    }


def build(state: Dict, count: int = 12, seed: int | None = None) -> List[Dict]:
    """
    A burst of telemetry lines for the current state.

    `seed` keyed to the frame number keeps a scrolling log varied but
    reproducible: replay the same frame and you get the same log.
    """
    rng = random.Random(seed if seed is not None else int(state["clock"]["loop_t_s"] * 97))
    mode = state["mode"]["id"]
    pw, bat = state["power"], state["power"]["battery"]
    att, thm = state["attitude"], state["thermal"]
    cm, pld = state["comms"], state["payload"]
    sub = state["orbit"]["subsatellite"]

    pool: List[Dict] = [
        _line("EPS", "NOMINAL",
              f"BATT SOC={bat['soc_pct']:.2f}% VBUS={bat['bus_voltage_v']:.2f}V "
              f"NET={pw['net_w']:+.2f}W {pw['flow']}", state, 0),
        _line("EPS", "NOMINAL",
              f"ARRAY GEN={pw['generation_w']:.2f}W COS={pw['array_cosine']:.2f} "
              f"LOAD={pw['loads']['total_w']:.2f}W", state, 0.31),
        _line("ADCS", "NOMINAL",
              f"ATT {att['mode']} R={att['roll_deg']:+.3f} P={att['pitch_deg']:+.3f} "
              f"Y={att['yaw_deg']:+.3f} RATE={att['rate_deg_s']:.4f}dps", state, 0.62),
        _line("ADCS", "INFO", f"STR {att['star_tracker']}", state, 0.78),
        _line("THM", "NOMINAL",
              f"TBUS={thm['bus_c']:+.2f}C TDET={thm['detector_c']:+.2f}C "
              f"TEC={thm['tec_duty_pct']:.1f}%", state, 1.04),
        _line("CDH", "NOMINAL",
              f"SSR FILL={cm['recorder']['fill_pct']:.1f}% OF "
              f"{cm['recorder']['capacity_gb']}GB", state, 1.29),
        _line("OPS", "INFO",
              f"GNC SUBPOINT {sub['lat']:+.4f} {sub['lon']:+.4f} "
              f"ALT={state['orbit']['altitude_km']:.1f}KM", state, 1.55),
    ]

    if mode == "ECLIPSE":
        pool += [
            _line("OPS", "WARN", "UMBRA ENTRY CONFIRMED — POWER SAVING PROFILE ARMED",
                  state, 1.81),
            _line("PLD", "INFO", "HYPER-A RAIL OFF — SHUTTER CLOSED, TEC IDLE",
                  state, 2.02),
            _line("RF", "INFO", "TX INHIBIT — BEACON ONLY 1200 BPS", state, 2.24),
            _line("EPS", "WARN",
                  f"DOD={bat['depth_of_discharge_pct']:.2f}% "
                  f"MARGIN={bat['margin_to_floor_pct']:.2f}% TO FLOOR", state, 2.48),
        ]
    elif mode == "SUN_FACING":
        pool += [
            _line("OPS", "NOMINAL", "SUN ACQUISITION COMPLETE — ARRAYS NORMAL TO VECTOR",
                  state, 1.81),
            _line("PLD", "INFO",
                  f"HYPER-A STANDBY {pld['state']} — DETECTOR SOAK IN PROGRESS",
                  state, 2.02),
            _line("EPS", "NOMINAL", "MPPT TRACKING — CHARGE CURRENT NOMINAL", state, 2.3),
            _line("CDH", "INFO", "FLIGHT SOFTWARE HEARTBEAT OK — WDT PET", state, 2.55),
        ]
    else:
        sci = state.get("science") or {}
        idx = sci.get("indices", {})
        dl = cm["downlink"]
        pool += [
            _line("OPS", "CRIT", "*** TARGET ACQUIRED — UAE_COASTAL ***", state, 1.81),
            _line("PLD", "SCIENCE",
                  f"IMAGING {pld['bands_active']}B INT={pld['integration_ms']:.0f}MS "
                  f"FRAME={pld['frames_captured']}", state, 2.02),
            _line("SCI", "SCIENCE",
                  f"CHL-A={idx.get('chl_a_mg_m3', 0):.2f} MG/M3 "
                  f"MCI={idx.get('mci', 0):+.5f} NDCI={idx.get('ndci', 0):+.4f} "
                  f"[{idx.get('severity', 'N/A')}]", state, 2.28),
            _line("SCI", "SCIENCE",
                  f"FLH={idx.get('fluorescence_line_height', 0):+.5f} "
                  f"TURB={idx.get('turbidity', 0):.3f}", state, 2.44),
            _line("RF", "NOMINAL",
                  f"DOWNLINK LIVE {dl['rate_mbps']:.1f}MBPS {dl['modulation']} "
                  f"EB/N0={dl['eb_n0_db']:.2f}DB BER={dl['ber']:.1e}", state, 2.66),
            _line("OPS", "INFO",
                  f"SWATH {pld['swath_km']:.0f}KM GSD={pld['gsd_m']:.0f}M "
                  f"SCAN={pld['scan_progress'] * 100:.1f}%", state, 2.9),
        ]

    for a in state.get("alerts", []):
        sev = {"CRITICAL": "CRIT", "WARNING": "WARN", "INFO": "INFO"}[a["level"]]
        pool.append(_line("OPS", sev, f"{a['code']} {a['text'].upper()}", state, 3.1))

    rng.shuffle(pool)
    out = pool[:count]
    out.sort(key=lambda x: x["t"])
    for i, row in enumerate(out):
        row["seq"] = i
        row["sat"] = SPACECRAFT["name"]
    return out
