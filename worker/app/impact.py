"""
Water-security impact.

Every other panel answers "what is the spacecraft doing". This one answers the
question the mission exists for: how much drinking water is at risk, and how
much warning does the operator get?

The chain is short and each link is stated on the console:

    Chl-a retrieval  ->  intake score  ->  fraction of capacity at risk
                     ->  m3/day at risk  ->  people whose daily supply it is

Nothing here is a new measurement. It is the desalination scheduler's own
scores, converted into the units a utility actually makes decisions in.
"""
from typing import Dict, List, Optional

from .config import DESAL_PLANTS, M3_PER_MIGD

# UAE domestic consumption per person per day.
#
# ~550 L is the commonly cited UAE figure — among the highest in the world,
# roughly double the Western European average. Used only to express a volume as
# a number of people, never to claim those people lose supply: a plant
# throttling its intake draws down reservoir stock first.
PER_CAPITA_M3_DAY = 0.55


def risk_fraction(score: float) -> float:
    """
    Fraction of a plant's capacity a given intake score puts at risk.

    Zero at 70 and above (the scheduler's clear-to-draw band), rising linearly
    to the whole plant at 15. Deliberately linear: a threshold would imply the
    model resolves a boundary it does not, and a curve would imply a
    calibration nobody has done for these waters.
    """
    return round(max(0.0, min(1.0, (70.0 - score) / 55.0)), 4)


def lead_time_h(hourly: List[Dict]) -> Optional[float]:
    """
    Hours of warning before the intake would have found out the hard way.

    An operator without ocean colour learns about a bloom when differential
    pressure across the intake screens rises — by then the bloom is already in
    the plant. The satellite's warning is the time between now and the first
    hour the scheduler flags as unsafe.
    """
    for h in hourly:
        if h["score"] < 62:
            return h["offset_h"]
    return None


def peak_risk(plants: List[Dict], capacity_by_id: Dict[str, float]) -> Optional[Dict]:
    """
    The worst hour in the next 24, across the network.

    A scheduler that only reports "right now" is a nowcast, and a nowcast on a
    clear hour looks like a panel with nothing to say. The whole argument for
    flying this mission is that an operator can *schedule around* a bloom
    instead of reacting to one, which means the number that matters is the one
    they do not have yet: when the water goes bad, and by how much.
    """
    best = None
    n = len(plants[0].get("hourly", [])) if plants else 0
    for k in range(n):
        total = 0.0
        worst = None
        for p in plants:
            hourly = p.get("hourly", [])
            if k >= len(hourly):
                continue
            h = hourly[k]
            total += capacity_by_id[p["plant_id"]] * risk_fraction(h["score"])
            if worst is None or h["score"] < worst["score"]:
                worst = {"score": h["score"], "name": p["plant_id"]}
        if best is None or total > best["at_risk_m3_day"]:
            best = {
                "in_h": k,
                "clock": plants[0]["hourly"][k]["clock"],
                "at_risk_m3_day": round(total, 0),
                "worst_plant": worst["name"] if worst else None,
                "worst_score": worst["score"] if worst else None,
            }
    return best


def impact(schedule_state: Optional[Dict]) -> Dict:
    by_id = {d["id"]: d for d in DESAL_PLANTS}
    plants = []
    for p in (schedule_state or {}).get("plants", []):
        cfg = by_id[p["plant_id"]]
        capacity = cfg["capacity_migd"] * M3_PER_MIGD
        frac = risk_fraction(p["now"]["score"])
        at_risk = capacity * frac
        plants.append({
            "plant_id": p["plant_id"],
            "name": p["name"],
            "short": "JEBEL ALI" if p["plant_id"] == "JEBEL_ALI" else "FUJAIRAH",
            "action": p["now"]["action"],
            "score": p["now"]["score"],
            "capacity_m3_day": round(capacity, 0),
            "capacity_migd": cfg["capacity_migd"],
            "risk_fraction": frac,
            "at_risk_m3_day": round(at_risk, 0),
            "at_risk_pct": round(frac * 100.0, 1),
            "people_served": cfg["people_served"],
            "people_at_risk": round(at_risk / PER_CAPITA_M3_DAY),
            "lead_time_h": lead_time_h(p.get("hourly", [])),
            "severity": p["observation"]["severity"],
        })

    capacity = sum(p["capacity_m3_day"] for p in plants)
    at_risk = sum(p["at_risk_m3_day"] for p in plants)
    leads = [p["lead_time_h"] for p in plants if p["lead_time_h"] is not None]

    cap_by_id = {p["plant_id"]: p["capacity_m3_day"] for p in plants}
    peak = peak_risk((schedule_state or {}).get("plants", []), cap_by_id)
    if peak is not None:
        peak = {
            **peak,
            "people_at_risk": round(peak["at_risk_m3_day"] / PER_CAPITA_M3_DAY),
            "at_risk_pct": (round(peak["at_risk_m3_day"] / capacity * 100.0, 1)
                            if capacity else 0.0),
        }

    return {
        "plants": plants,
        "peak": peak,
        "total": {
            "capacity_m3_day": round(capacity, 0),
            "at_risk_m3_day": round(at_risk, 0),
            "at_risk_pct": round(at_risk / capacity * 100.0, 1) if capacity else 0.0,
            "people_served": sum(p["people_served"] for p in plants),
            "people_at_risk": round(at_risk / PER_CAPITA_M3_DAY),
            # Least warning across the network is the one that matters — the
            # network is only as early as its earliest problem.
            "lead_time_h": min(leads) if leads else None,
            "plants_clear": sum(1 for p in plants if p["action"] == "DRAW"),
            "plants_total": len(plants),
        },
        "basis": {
            "per_capita_m3_day": PER_CAPITA_M3_DAY,
            "m3_per_migd": M3_PER_MIGD,
            "clear_score": 70,
            "total_loss_score": 15,
            "note": "Capacity at risk is the fraction of rated output the "
                    "intake scheduler would not clear to draw, not an outage. "
                    "Population is that volume expressed at UAE per-capita "
                    "domestic demand.",
        },
    }
