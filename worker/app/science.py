"""
Ocean-colour science model.

Two products:
  1. An algae-density field over UAE coastal waters (deterministic value
     noise + a physically-motivated coastal gradient).
  2. A hyperspectral remote-sensing-reflectance curve, Rrs(lambda), driven
     by that density — this is what the spectroscopy graph plots.

The spectral shape is a simplified but real bio-optical model: Chl-a
absorbs in the blue (443 nm Soret band) and red (665 nm), reflects green
(555 nm), and at high biomass produces a sun-induced fluorescence peak at
681 nm and a NIR red-edge shoulder at 709 nm. Those four features are the
standard bloom signature used by MERIS/OLCI-class instruments.
"""
from __future__ import annotations

import math
from typing import Dict, List

from .config import DESAL_PLANTS, SPECTRO


# ---------------------------------------------------------------------------
# Deterministic value-noise field
# ---------------------------------------------------------------------------
def _hash2(ix: int, iy: int, seed: int) -> float:
    h = (ix * 374761393 + iy * 668265263 + seed * 2147483647) & 0xFFFFFFFF
    h = (h ^ (h >> 13)) * 1274126177 & 0xFFFFFFFF
    return ((h ^ (h >> 16)) & 0xFFFFFFFF) / 0xFFFFFFFF


def _smooth(t: float) -> float:
    return t * t * (3.0 - 2.0 * t)


def _value_noise(x: float, y: float, seed: int) -> float:
    ix, iy = math.floor(x), math.floor(y)
    fx, fy = _smooth(x - ix), _smooth(y - iy)
    a = _hash2(ix, iy, seed)
    b = _hash2(ix + 1, iy, seed)
    c = _hash2(ix, iy + 1, seed)
    d = _hash2(ix + 1, iy + 1, seed)
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy


def _fbm(x: float, y: float, seed: int, octaves: int = 4) -> float:
    total, amp, freq, norm = 0.0, 1.0, 1.0, 0.0
    for _ in range(octaves):
        total += amp * _value_noise(x * freq, y * freq, seed)
        norm += amp
        amp *= 0.5
        freq *= 2.0
    return total / norm


# ---------------------------------------------------------------------------
# Chlorophyll-a field
# ---------------------------------------------------------------------------
# Arabian Gulf background is roughly 1-3 mg/m^3; a Cochlodinium /
# Noctiluca bloom pushes coastal water past 20 mg/m^3.
CHL_BACKGROUND = 1.4
CHL_BLOOM_MAX = 34.0

# The concentration at which the bloom index saturates.
#
# This is an *operational* ceiling, not the field's maximum. Intake fouling
# advisories for Gulf desalination plants run on a far tighter scale than the
# peak a bloom can physically reach: 3-8 mg/m3 already warrants monitoring, and
# the 2008-09 Cochlodinium event that shut Fujairah down sat in the low tens.
# Normalising against the field's 34 mg/m3 ceiling instead would rate a
# genuinely dangerous 15 mg/m3 at 0.4 and clear the plant to draw through it.
CHL_ADVISORY_MAX = 22.0


def chlorophyll_mg_m3(lat: float, lon: float, phase: float = 0.0) -> float:
    """
    Chl-a concentration at a coastal point, in mg/m^3.

    `phase` advances the field slowly so consecutive passes differ without
    the demo ever becoming non-reproducible.
    """
    n = _fbm(lon * 1.9 + phase * 0.012, lat * 1.9, seed=20260917)

    # Gulf side (west of 56 E) is shallow, warm, poorly flushed: bloom-prone.
    # Gulf of Oman side is deeper and better mixed.
    basin_gain = 1.0 if lon < 56.0 else 0.62

    # Nearshore enrichment: nutrient load falls off away from the coastline.
    coastal = math.exp(-((lat - 24.9) ** 2) / 3.4)

    # A broad seasonal forcing term: the late-summer Gulf is at its warmest
    # and most stratified, which is when the region's blooms actually occur.
    # Without it the noise field alone almost never crosses bloom threshold
    # and the instrument would have nothing to detect.
    season = 0.62

    intensity = max(0.0, (n - 0.30) / 0.70) ** 1.25
    chl = CHL_BACKGROUND + CHL_BLOOM_MAX * intensity * basin_gain * coastal * (0.55 + season)
    return round(min(CHL_BLOOM_MAX, chl), 3)


def bloom_index(chl: float) -> float:
    """
    Normalised 0-1 bloom severity on the intake-advisory scale.

    The bands used by the scheduler and the console labels:
        CLEAR     < 4.5 mg/m3    background coastal water
        ELEVATED  < 8.6          worth watching, no action
        WATCH     < 13.8         monitor intake differential pressure
        WARNING   < 18.9         throttle and increase pre-treatment
        CRITICAL  >= 18.9        suspend intake
    """
    return round(min(1.0, max(0.0, (chl - CHL_BACKGROUND)
                              / (CHL_ADVISORY_MAX - CHL_BACKGROUND))), 4)


def severity_label(idx: float) -> str:
    if idx < 0.15:
        return "CLEAR"
    if idx < 0.35:
        return "ELEVATED"
    if idx < 0.60:
        return "WATCH"
    if idx < 0.80:
        return "WARNING"
    return "CRITICAL"


# ---------------------------------------------------------------------------
# Hyperspectral reflectance
# ---------------------------------------------------------------------------
def _gauss(lam: float, centre: float, width: float) -> float:
    return math.exp(-((lam - centre) ** 2) / (2.0 * width ** 2))


def _rrs(lam: float, chl: float, turbidity: float) -> float:
    """
    Remote-sensing reflectance at one wavelength, sr^-1.

    Built from: pure-water absorption rising steeply into the NIR, a
    blue-absorbing / green-reflecting phytoplankton term scaled by Chl-a,
    a fluorescence line at 681 nm, a red-edge shoulder at 709 nm that only
    appears at high biomass, and a broadband sediment term.
    """
    c = max(0.0, chl)
    b = bloom_index(c)

    # Clear-water baseline: high in the blue, collapsing past 600 nm.
    water = 0.021 * _gauss(lam, 455.0, 62.0) + 0.006 * _gauss(lam, 520.0, 58.0)
    water *= math.exp(-max(0.0, lam - 580.0) / 68.0)

    # Phytoplankton absorption troughs (Soret + red band) and phycocyanin.
    absorb = (0.62 * b * _gauss(lam, 443.0, 26.0)
              + 0.30 * b * _gauss(lam, 620.0, 18.0)
              + 0.48 * b * _gauss(lam, 665.0, 17.0))

    # Green reflectance maximum grows with biomass.
    green = 0.0185 * (0.25 + 0.95 * b) * _gauss(lam, 557.0, 34.0)

    # Sun-induced chlorophyll fluorescence — the unambiguous "live algae" line.
    fluor = 0.0135 * (b ** 1.15) * _gauss(lam, 681.0, 9.5)

    # NIR red edge: only present when biomass is high enough to scatter.
    red_edge = 0.0122 * max(0.0, b - 0.22) * _gauss(lam, 709.0, 12.0)

    # Suspended sediment: broad, flat, slightly red-leaning.
    sediment = 0.0042 * turbidity * (0.5 + 0.5 * _gauss(lam, 640.0, 150.0))

    value = (water + green + fluor + red_edge + sediment) * (1.0 - min(0.85, absorb))
    return max(0.0, value)


def spectrum(lat: float, lon: float, phase: float = 0.0,
             bands: int | None = None) -> Dict:
    """
    Full hyperspectral sample at a surface point.

    Returns the band table the spectroscopy graph plots, plus the derived
    indices and the labelled diagnostic features so the UI can annotate
    each spike with what it physically means.
    """
    n = bands or SPECTRO["bands"]
    lo, hi = SPECTRO["lambda_min_nm"], SPECTRO["lambda_max_nm"]

    chl = chlorophyll_mg_m3(lat, lon, phase)
    idx = bloom_index(chl)
    turbidity = round(0.35 + 0.55 * _fbm(lon * 3.1, lat * 3.1, seed=771), 3)

    lambdas = [lo + (hi - lo) * (k / (n - 1)) for k in range(n)]
    values = [_rrs(l, chl, turbidity) for l in lambdas]
    peak = max(values) or 1.0

    band_rows = [
        {
            "nm": round(l, 1),
            "rrs": round(v, 6),
            "norm": round(v / peak, 4),     # 0-1, ready for bar heights
        }
        for l, v in zip(lambdas, values)
    ]

    def at(nm: float) -> float:
        return _rrs(nm, chl, turbidity)

    # Maximum-chlorophyll-index: the operational bloom detector.
    mci = at(709) - at(681) - (754 - 709) / (754 - 681) * (at(754) - at(681))
    ndci = (at(709) - at(665)) / max(1e-9, at(709) + at(665))
    fluor_height = at(681) - 0.5 * (at(665) + at(709))

    features = []
    for f in SPECTRO["features"]:
        v = at(f["nm"])
        features.append({
            **f,
            "rrs": round(v, 6),
            "norm": round(v / peak, 4),
        })

    return {
        "point": {"lat": round(lat, 4), "lon": round(lon, 4)},
        "bands": band_rows,
        "features": features,
        "peak_rrs": round(peak, 6),
        "indices": {
            "chl_a_mg_m3": chl,
            "bloom_index": idx,
            "severity": severity_label(idx),
            "turbidity": turbidity,
            "mci": round(mci, 6),
            "ndci": round(ndci, 4),
            "fluorescence_line_height": round(fluor_height, 6),
        },
        "units": {"rrs": "sr^-1", "nm": "nanometres", "chl_a": "mg m^-3"},
    }


# ---------------------------------------------------------------------------
# Per-plant water quality
# ---------------------------------------------------------------------------
def plant_water_quality(phase: float = 0.0) -> List[Dict]:
    """Current intake-water state at each desalination plant."""
    out = []
    for p in DESAL_PLANTS:
        chl = chlorophyll_mg_m3(p["lat"], p["lon"], phase)
        idx = bloom_index(chl)
        # Baseline basin risk blended with what the instrument just measured.
        risk = round(min(1.0, 0.42 * p["baseline_bloom_risk"] + 0.58 * idx), 4)
        out.append({
            "plant_id": p["id"],
            "name": p["name"],
            "operator": p["operator"],
            "sea": p["sea"],
            "lat": p["lat"],
            "lon": p["lon"],
            "capacity_migd": p["capacity_migd"],
            "chl_a_mg_m3": chl,
            "bloom_index": idx,
            "risk": risk,
            "severity": severity_label(risk),
        })
    return out
