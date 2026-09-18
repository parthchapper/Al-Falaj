/**
 * Ocean-colour science — port of `worker/app/science.py`.
 *
 * Two products:
 *   1. An algae-density field over UAE coastal waters (deterministic value
 *      noise + a physically-motivated coastal gradient).
 *   2. A hyperspectral remote-sensing-reflectance curve, Rrs(lambda), driven
 *      by that density — this is what the spectroscopy graph plots.
 *
 * The spectral shape is a simplified but real bio-optical model: Chl-a
 * absorbs in the blue (443 nm Soret band) and red (665 nm), reflects green
 * (555 nm), and at high biomass produces a sun-induced fluorescence peak at
 * 681 nm and a NIR red-edge shoulder at 709 nm. Those four features are the
 * standard bloom signature used by MERIS/OLCI-class instruments.
 */
import { DESAL_PLANTS, SPECTRO } from './config.js';

const round = (x, n) => Number(x.toFixed(n));

// ---------------------------------------------------------------------------
// Deterministic value-noise field
// ---------------------------------------------------------------------------
// Math.imul gives exact 32-bit multiplication, which is what keeps this
// bit-identical to the Python implementation. The seed term is rewritten as
// (seed & 1) * 2^31 - seed because seed * (2^31 - 1) overflows the exact
// integer range of a JS number before the modulo can be applied.
function hash2(ix, iy, seed) {
  const seedTerm = (((seed & 1) ? 0x80000000 : 0) - seed) >>> 0;
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + seedTerm) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 0xFFFFFFFF;
}

const smooth = (t) => t * t * (3 - 2 * t);

function valueNoise(x, y, seed) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = smooth(x - ix);
  const fy = smooth(y - iy);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

function fbm(x, y, seed, octaves = 4) {
  let total = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i += 1) {
    total += amp * valueNoise(x * freq, y * freq, seed);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return total / norm;
}

// ---------------------------------------------------------------------------
// Chlorophyll-a field
// ---------------------------------------------------------------------------
// Arabian Gulf background is roughly 1-3 mg/m^3; a Cochlodinium /
// Noctiluca bloom pushes coastal water past 20 mg/m^3.
export const CHL_BACKGROUND = 1.4;
export const CHL_BLOOM_MAX = 34.0;

/**
 * The concentration at which the bloom index saturates.
 *
 * This is an *operational* ceiling, not the field's maximum. Intake fouling
 * advisories for Gulf desalination plants run on a far tighter scale than the
 * peak a bloom can physically reach: 3-8 mg/m3 already warrants monitoring,
 * and the 2008-09 Cochlodinium event that shut Fujairah down sat in the low
 * tens. Normalising against the field's 34 mg/m3 ceiling instead would rate a
 * genuinely dangerous 15 mg/m3 at 0.4 and clear the plant to draw through it.
 */
export const CHL_ADVISORY_MAX = 22.0;

/**
 * Chl-a concentration at a coastal point, in mg/m^3.
 *
 * `phase` advances the field slowly so consecutive passes differ without
 * the demo ever becoming non-reproducible.
 */
export function chlorophyllMgM3(lat, lon, phase = 0) {
  const n = fbm(lon * 1.9 + phase * 0.012, lat * 1.9, 20260917);

  // Gulf side (west of 56 E) is shallow, warm, poorly flushed: bloom-prone.
  // Gulf of Oman side is deeper and better mixed.
  const basinGain = lon < 56.0 ? 1.0 : 0.62;

  // Nearshore enrichment: nutrient load falls off away from the coastline.
  const coastal = Math.exp(-((lat - 24.9) ** 2) / 3.4);

  // A broad seasonal forcing term: the late-summer Gulf is at its warmest
  // and most stratified, which is when the region's blooms actually occur.
  const season = 0.62;

  const intensity = Math.max(0, (n - 0.30) / 0.70) ** 1.25;
  const chl = CHL_BACKGROUND
    + CHL_BLOOM_MAX * intensity * basinGain * coastal * (0.55 + season);
  return round(Math.min(CHL_BLOOM_MAX, chl), 3);
}

/**
 * Normalised 0-1 bloom severity on the intake-advisory scale.
 *
 * The bands below are the ones the scheduler and the console labels use:
 *   CLEAR     < 4.5 mg/m3    background coastal water
 *   ELEVATED  < 8.6          worth watching, no action
 *   WATCH     < 13.8         monitor intake differential pressure
 *   WARNING   < 18.9         throttle and increase pre-treatment
 *   CRITICAL  >= 18.9        suspend intake
 */
export function bloomIndex(chl) {
  return round(Math.min(1, Math.max(0,
    (chl - CHL_BACKGROUND) / (CHL_ADVISORY_MAX - CHL_BACKGROUND))), 4);
}

export function severityLabel(idx) {
  if (idx < 0.15) return 'CLEAR';
  if (idx < 0.35) return 'ELEVATED';
  if (idx < 0.60) return 'WATCH';
  if (idx < 0.80) return 'WARNING';
  return 'CRITICAL';
}

// ---------------------------------------------------------------------------
// Hyperspectral reflectance
// ---------------------------------------------------------------------------
const gauss = (lam, centre, width) => Math.exp(-((lam - centre) ** 2) / (2 * width ** 2));

/**
 * Remote-sensing reflectance at one wavelength, sr^-1.
 *
 * Built from: pure-water absorption rising steeply into the NIR, a
 * blue-absorbing / green-reflecting phytoplankton term scaled by Chl-a, a
 * fluorescence line at 681 nm, a red-edge shoulder at 709 nm that only
 * appears at high biomass, and a broadband sediment term.
 */
export function rrs(lam, chl, turbidity) {
  const c = Math.max(0, chl);
  const b = bloomIndex(c);

  // Clear-water baseline: high in the blue, collapsing past 600 nm.
  let water = 0.021 * gauss(lam, 455, 62) + 0.006 * gauss(lam, 520, 58);
  water *= Math.exp(-Math.max(0, lam - 580) / 68);

  // Phytoplankton absorption troughs (Soret + red band) and phycocyanin.
  const absorb = 0.62 * b * gauss(lam, 443, 26)
    + 0.30 * b * gauss(lam, 620, 18)
    + 0.48 * b * gauss(lam, 665, 17);

  // Green reflectance maximum grows with biomass.
  const green = 0.0185 * (0.25 + 0.95 * b) * gauss(lam, 557, 34);

  // Sun-induced chlorophyll fluorescence — the unambiguous "live algae" line.
  const fluor = 0.0135 * (b ** 1.15) * gauss(lam, 681, 9.5);

  // NIR red edge: only present when biomass is high enough to scatter.
  const redEdge = 0.0122 * Math.max(0, b - 0.22) * gauss(lam, 709, 12);

  // Suspended sediment: broad, flat, slightly red-leaning.
  const sediment = 0.0042 * turbidity * (0.5 + 0.5 * gauss(lam, 640, 150));

  const value = (water + green + fluor + redEdge + sediment) * (1 - Math.min(0.85, absorb));
  return Math.max(0, value);
}

/**
 * Full hyperspectral sample at a surface point.
 *
 * Returns the band table the spectroscopy graph plots, plus the derived
 * indices and the labelled diagnostic features so the UI can annotate each
 * spike with what it physically means.
 */
export function spectrum(lat, lon, phase = 0, bands = null) {
  const n = bands || SPECTRO.bands;
  const lo = SPECTRO.lambda_min_nm;
  const hi = SPECTRO.lambda_max_nm;

  const chl = chlorophyllMgM3(lat, lon, phase);
  const idx = bloomIndex(chl);
  const turbidity = round(0.35 + 0.55 * fbm(lon * 3.1, lat * 3.1, 771), 3);

  const lambdas = [];
  for (let k = 0; k < n; k += 1) lambdas.push(lo + (hi - lo) * (k / (n - 1)));
  const values = lambdas.map((l) => rrs(l, chl, turbidity));
  const peak = Math.max(...values) || 1;

  const bandRows = lambdas.map((l, i) => ({
    nm: round(l, 1),
    rrs: round(values[i], 6),
    norm: round(values[i] / peak, 4),     // 0-1, ready for bar heights
  }));

  const at = (nm) => rrs(nm, chl, turbidity);

  // Maximum-chlorophyll-index: the operational bloom detector.
  const mci = at(709) - at(681) - ((754 - 709) / (754 - 681)) * (at(754) - at(681));
  const ndci = (at(709) - at(665)) / Math.max(1e-9, at(709) + at(665));
  const fluorHeight = at(681) - 0.5 * (at(665) + at(709));

  const features = SPECTRO.features.map((f) => {
    const v = at(f.nm);
    return { ...f, rrs: round(v, 6), norm: round(v / peak, 4) };
  });

  return {
    point: { lat: round(lat, 4), lon: round(lon, 4) },
    bands: bandRows,
    features,
    peak_rrs: round(peak, 6),
    indices: {
      chl_a_mg_m3: chl,
      bloom_index: idx,
      severity: severityLabel(idx),
      turbidity,
      mci: round(mci, 6),
      ndci: round(ndci, 4),
      fluorescence_line_height: round(fluorHeight, 6),
    },
    units: { rrs: 'sr^-1', nm: 'nanometres', chl_a: 'mg m^-3' },
  };
}

/** Current intake-water state at each desalination plant. */
export function plantWaterQuality(phase = 0) {
  return DESAL_PLANTS.map((p) => {
    const chl = chlorophyllMgM3(p.lat, p.lon, phase);
    const idx = bloomIndex(chl);
    // Baseline basin risk blended with what the instrument just measured.
    const risk = round(Math.min(1, 0.42 * p.baseline_bloom_risk + 0.58 * idx), 4);
    return {
      plant_id: p.id,
      name: p.name,
      operator: p.operator,
      sea: p.sea,
      lat: p.lat,
      lon: p.lon,
      capacity_migd: p.capacity_migd,
      chl_a_mg_m3: chl,
      bloom_index: idx,
      risk,
      severity: severityLabel(risk),
    };
  });
}

/** Gridded Chl-a over a bounding box — the data behind the heat overlay. */
export function algaeField(bbox, phase = 0, nx = 48, ny = 24) {
  const [w, s, e, n] = bbox;
  const values = [];
  let peak = 0;
  for (let j = 0; j < ny; j += 1) {
    const lat = s + (n - s) * (j / (ny - 1));
    for (let i = 0; i < nx; i += 1) {
      const lon = w + (e - w) * (i / (nx - 1));
      const v = chlorophyllMgM3(lat, lon, phase);
      if (v > peak) peak = v;
      values.push(round(v, 3));
    }
  }
  return {
    bbox, nx, ny,
    order: 'row-major, south-to-north',
    units: 'mg m^-3',
    max: round(peak, 3),
    values,
  };
}
