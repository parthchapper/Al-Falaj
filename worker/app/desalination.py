"""
Desalination intake scheduler.

Turns an ocean-colour observation into the only thing a plant operator
actually wants: when to draw water, and when not to.

Why it matters: harmful algal blooms clog and biofoul reverse-osmosis
intakes. The 2008-09 Cochlodinium polykrikoides bloom in the Gulf of Oman
forced Fujairah's plant into repeated shutdowns. Operators currently react
to blooms after intake pressure drops; a daily ocean-colour pass lets them
schedule around one instead.

Scoring model (0-100, higher = better time to draw water):
    score = 100
          - 62 * bloom_risk              observed algal load at the intake
          - 22 * thermal_stratification  midday warm-layer bloom surfacing
          - 16 * tidal_slack             slack water concentrates biomass
          - 11 * turbidity               suspended solids load on pre-filters
          - 14 * (1 - data_confidence)   conservatism margin for stale data

The last term is a safety margin, not a reward: a plant acting on a
90-minute-old retrieval gets a more cautious recommendation than one acting
on a live pass, because the scheduler is less sure what the water is doing.
Every term is returned alongside the score, so any number on the panel can
be taken apart and defended.
"""
from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from typing import Dict, List

from . import geo
from .config import DESAL_PLANTS, SPACECRAFT
from .science import chlorophyll_mg_m3, bloom_index, severity_label

GULF_TZ = timezone(timedelta(hours=4))          # Asia/Dubai
ORBIT_PERIOD_MIN = SPACECRAFT["orbit"]["period_min"]

# How much the current operational mode is worth as evidence.
MODE_CONFIDENCE = {
    "ACTIVE": 0.96,        # imaging right now
    "SUN_FACING": 0.71,    # payload warm, last pass still fresh
    "ECLIPSE": 0.44,       # coasting on the previous daylight pass
}

MODE_DATA_AGE_MIN = {"ACTIVE": 0.0, "SUN_FACING": 47.0, "ECLIPSE": 88.0}


def _thermal_stratification(hour: float) -> float:
    """
    0-1. Motile dinoflagellates rise to the surface through the morning and
    the water column stratifies under midday heating, peaking around 14:00
    local. Night-time mixing breaks it down.
    """
    return max(0.0, math.sin(math.pi * (hour - 6.0) / 14.0)) ** 1.4 if 6.0 <= hour <= 20.0 else 0.0


def _tidal_penalty(hour: float, lon: float) -> float:
    """
    0-1. Semidiurnal tide, ~12.42 h. Slack water lets biomass accumulate at
    the intake; strong flood/ebb flushes it. Phase offset by longitude so
    the two coasts are not in lockstep.
    """
    phase = 2 * math.pi * (hour / 12.42) + lon * 0.09
    current = abs(math.sin(phase))          # 0 at slack, 1 at peak flow
    return round(1.0 - current, 4)


def _hour_score(plant: Dict, hour: float, chl: float, turbidity: float,
                confidence: float) -> Dict:
    risk_now = bloom_index(chl)
    # Blend the measured load with the basin's climatological baseline,
    # weighted by how much we trust the current observation.
    risk = min(1.0, confidence * risk_now + (1 - confidence) * plant["baseline_bloom_risk"])

    strat = _thermal_stratification(hour)
    tide = _tidal_penalty(hour, plant["lon"])

    # A deeper intake sits below the surface bloom layer.
    depth_shield = min(0.55, plant["intake_depth_m"] / 22.0)
    effective_risk = risk * (1.0 - depth_shield * strat)

    score = (100.0
             - 62.0 * effective_risk
             - 22.0 * strat * risk
             - 16.0 * tide * risk
             - 11.0 * turbidity
             - 14.0 * (1.0 - confidence))
    score = max(0.0, min(100.0, score))

    return {
        "hour": int(hour) % 24,
        "score": round(score, 1),
        "terms": {
            "bloom_risk": round(risk, 4),
            "effective_risk": round(effective_risk, 4),
            "thermal_stratification": round(strat, 4),
            "tidal_slack": tide,
            "turbidity": round(turbidity, 4),
            "intake_depth_shield": round(depth_shield, 3),
            "data_confidence": round(confidence, 3),
            "stale_data_penalty": round(14.0 * (1.0 - confidence), 3),
        },
    }


def _classify(score: float) -> Dict[str, str]:
    if score >= 78:
        return {"action": "DRAW", "band": "OPTIMAL",
                "text": "Draw at full rate. Intake water clear."}
    if score >= 62:
        return {"action": "DRAW", "band": "ACCEPTABLE",
                "text": "Normal operations. Monitor intake differential pressure."}
    if score >= 45:
        return {"action": "REDUCE", "band": "CAUTION",
                "text": "Throttle to 70 % and increase DAF pre-treatment dosing."}
    if score >= 30:
        return {"action": "REDUCE", "band": "DEGRADED",
                "text": "Reduce to minimum sustainable rate; stage backup cartridges."}
    return {"action": "HOLD", "band": "CRITICAL",
            "text": "Suspend intake. Switch to stored product water."}


def _windows(hours: List[Dict], threshold: float) -> List[Dict]:
    """Contiguous runs of hours scoring at or above a threshold."""
    out, run = [], []
    for h in hours:
        if h["score"] >= threshold:
            run.append(h)
        elif run:
            out.append(run)
            run = []
    if run:
        out.append(run)
    return [
        {
            "start_hour": r[0]["hour"],
            "end_hour": (r[-1]["hour"] + 1) % 24,
            "duration_h": len(r),
            "mean_score": round(sum(x["score"] for x in r) / len(r), 1),
            "peak_score": round(max(x["score"] for x in r), 1),
        }
        for r in out
    ]


def _fmt(h: int) -> str:
    return f"{h % 24:02d}:00"


def plant_recommendation(plant: Dict, mode: str, phase: float,
                         now: datetime | None = None) -> Dict:
    now = now or datetime.now(GULF_TZ)
    confidence = MODE_CONFIDENCE.get(mode, 0.5)

    chl = chlorophyll_mg_m3(plant["lat"], plant["lon"], phase)
    turbidity = 0.32 + 0.4 * bloom_index(chl)

    start_hour = now.hour
    hours = [
        _hour_score(plant, (start_hour + k) % 24, chl, turbidity, confidence)
        for k in range(24)
    ]
    # Re-key to real clock hours ahead of now, so index 0 is "this hour".
    for k, h in enumerate(hours):
        h["offset_h"] = k
        h["clock"] = _fmt(start_hour + k)

    best = max(hours, key=lambda h: h["score"])
    worst = min(hours, key=lambda h: h["score"])
    current = hours[0]

    cls_now = _classify(current["score"])
    cls_best = _classify(best["score"])

    # Time to the next overpass of this target: the rest of this orbit.
    next_pass_min = round(ORBIT_PERIOD_MIN - geo.orbit_seconds(phase) / 60.0, 1)

    return {
        "plant_id": plant["id"],
        "name": plant["name"],
        "operator": plant["operator"],
        "sea": plant["sea"],
        "location": {"lat": plant["lat"], "lon": plant["lon"]},
        "capacity_migd": plant["capacity_migd"],
        "intake": {"type": plant["intake_type"], "depth_m": plant["intake_depth_m"]},
        "observation": {
            "chl_a_mg_m3": chl,
            "bloom_index": bloom_index(chl),
            "severity": severity_label(bloom_index(chl)),
            "turbidity": round(turbidity, 3),
            "data_age_min": MODE_DATA_AGE_MIN.get(mode, 60.0),
            "confidence": round(confidence, 3),
            "source": "AL-FALAJ SAT-1 / HYPER-A ocean-colour retrieval",
        },
        "now": {
            "clock": _fmt(start_hour),
            "score": current["score"],
            **cls_now,
        },
        "best_window": {
            "label": f"{_fmt(best['hour'])} - {_fmt(best['hour'] + 1)}",
            "start_hour": best["hour"],
            "in_hours": best["offset_h"],
            "score": best["score"],
            **cls_best,
        },
        "avoid_window": {
            "label": f"{_fmt(worst['hour'])} - {_fmt(worst['hour'] + 1)}",
            "start_hour": worst["hour"],
            "in_hours": worst["offset_h"],
            "score": worst["score"],
            "reason": "Peak surface bloom coincident with tidal slack water.",
        },
        "draw_windows": _windows(hours, 62.0),
        "hourly": hours,
        "next_overpass_min": next_pass_min,
        "rationale": (
            f"Chl-a at the intake is {chl:.1f} mg/m3 "
            f"({severity_label(bloom_index(chl))}). Scheduler weights the live "
            f"retrieval at {confidence:.0%} confidence in {mode} mode, corrects "
            f"for a {plant['intake_depth_m']:.0f} m intake depth, and avoids "
            f"tidal slack water."
        ),
    }


def schedule(mode: str, phase: float, now: datetime | None = None) -> Dict:
    plants = [plant_recommendation(p, mode, phase, now) for p in DESAL_PLANTS]
    combined = round(sum(p["now"]["score"] for p in plants) / len(plants), 1)
    return {
        "generated_at": (now or datetime.now(GULF_TZ)).isoformat(),
        "timezone": "Asia/Dubai (UTC+04:00)",
        "mode": mode,
        "network_score": combined,
        "network_band": _classify(combined)["band"],
        "plants": plants,
        "model": {
            "name": "SENTINEL-DESAL v1.2",
            "base": 100,
            "weights": {
                "bloom_risk": -62, "thermal_stratification": -22,
                "tidal_slack": -16, "turbidity": -11,
                "stale_data_conservatism": -14,
            },
            "note": "Scores are 0-100; >=62 is cleared for normal intake. "
                    "The conservatism term is a safety margin applied when "
                    "the observation is old, never a bonus for freshness.",
        },
    }
