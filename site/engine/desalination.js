/**
 * Desalination intake scheduler — port of `worker/app/desalination.py`.
 *
 * Turns an ocean-colour observation into the only thing a plant operator
 * actually wants: when to draw water, and when not to.
 *
 * Why it matters: harmful algal blooms clog and biofoul reverse-osmosis
 * intakes. The 2008-09 Cochlodinium polykrikoides bloom in the Gulf of Oman
 * forced Fujairah's plant into repeated shutdowns. Operators currently react
 * to blooms after intake pressure drops; a daily ocean-colour pass lets them
 * schedule around one instead.
 *
 * Scoring model (0-100, higher = better time to draw water):
 *     score = 100
 *           - 62 * bloom_risk              observed algal load at the intake
 *           - 22 * thermal_stratification  midday warm-layer bloom surfacing
 *           - 16 * tidal_slack             slack water concentrates biomass
 *           - 11 * turbidity               suspended solids on pre-filters
 *           - 14 * (1 - data_confidence)   conservatism margin for stale data
 *
 * The last term is a safety margin, not a reward: a plant acting on a
 * 90-minute-old retrieval gets a more cautious recommendation than one acting
 * on a live pass, because the scheduler is less sure what the water is doing.
 */
import { DESAL_PLANTS, SPACECRAFT } from './config.js';
import { orbitSeconds } from './geo.js';
import { bloomIndex, chlorophyllMgM3, severityLabel } from './science.js';

const round = (x, n) => Number(x.toFixed(n));
const ORBIT_PERIOD_MIN = SPACECRAFT.orbit.period_min;

// How much the current operational mode is worth as evidence.
export const MODE_CONFIDENCE = {
  ACTIVE: 0.96,        // imaging right now
  SUN_FACING: 0.71,    // payload warm, last pass still fresh
  ECLIPSE: 0.44,       // coasting on the previous daylight pass
};

export const MODE_DATA_AGE_MIN = { ACTIVE: 0.0, SUN_FACING: 47.0, ECLIPSE: 88.0 };

/**
 * 0-1. Motile dinoflagellates rise to the surface through the morning and
 * the water column stratifies under midday heating, peaking around 14:00
 * local. Night-time mixing breaks it down.
 */
function thermalStratification(hour) {
  if (hour < 6 || hour > 20) return 0;
  return Math.max(0, Math.sin((Math.PI * (hour - 6)) / 14)) ** 1.4;
}

/**
 * 0-1. Semidiurnal tide, ~12.42 h. Slack water lets biomass accumulate at
 * the intake; strong flood/ebb flushes it. Phase offset by longitude so the
 * two coasts are not in lockstep.
 */
function tidalPenalty(hour, lon) {
  const phase = 2 * Math.PI * (hour / 12.42) + lon * 0.09;
  const current = Math.abs(Math.sin(phase));   // 0 at slack, 1 at peak flow
  return round(1 - current, 4);
}

function hourScore(plant, hour, chl, turbidity, confidence) {
  const riskNow = bloomIndex(chl);
  // Blend the measured load with the basin's climatological baseline,
  // weighted by how much we trust the current observation.
  const risk = Math.min(1, confidence * riskNow + (1 - confidence) * plant.baseline_bloom_risk);

  const strat = thermalStratification(hour);
  const tide = tidalPenalty(hour, plant.lon);

  // A deeper intake sits below the surface bloom layer.
  const depthShield = Math.min(0.55, plant.intake_depth_m / 22);
  const effectiveRisk = risk * (1 - depthShield * strat);

  let score = 100
    - 62 * effectiveRisk
    - 22 * strat * risk
    - 16 * tide * risk
    - 11 * turbidity
    - 14 * (1 - confidence);
  score = Math.max(0, Math.min(100, score));

  return {
    hour: Math.floor(hour) % 24,
    score: round(score, 1),
    terms: {
      bloom_risk: round(risk, 4),
      effective_risk: round(effectiveRisk, 4),
      thermal_stratification: round(strat, 4),
      tidal_slack: tide,
      turbidity: round(turbidity, 4),
      intake_depth_shield: round(depthShield, 3),
      data_confidence: round(confidence, 3),
      stale_data_penalty: round(14 * (1 - confidence), 3),
    },
  };
}

export function classify(score) {
  if (score >= 78) {
    return { action: 'DRAW', band: 'OPTIMAL', text: 'Draw at full rate. Intake water clear.' };
  }
  if (score >= 62) {
    return { action: 'DRAW', band: 'ACCEPTABLE', text: 'Normal operations. Monitor intake differential pressure.' };
  }
  if (score >= 45) {
    return { action: 'REDUCE', band: 'CAUTION', text: 'Throttle to 70 % and increase DAF pre-treatment dosing.' };
  }
  if (score >= 30) {
    return { action: 'REDUCE', band: 'DEGRADED', text: 'Reduce to minimum sustainable rate; stage backup cartridges.' };
  }
  return { action: 'HOLD', band: 'CRITICAL', text: 'Suspend intake. Switch to stored product water.' };
}

/** Contiguous runs of hours scoring at or above a threshold. */
function windows(hours, threshold) {
  const out = [];
  let run = [];
  for (const h of hours) {
    if (h.score >= threshold) run.push(h);
    else if (run.length) { out.push(run); run = []; }
  }
  if (run.length) out.push(run);
  return out.map((r) => ({
    start_hour: r[0].hour,
    end_hour: (r[r.length - 1].hour + 1) % 24,
    duration_h: r.length,
    mean_score: round(r.reduce((a, x) => a + x.score, 0) / r.length, 1),
    peak_score: round(Math.max(...r.map((x) => x.score)), 1),
  }));
}

const fmt = (h) => `${String(((h % 24) + 24) % 24).padStart(2, '0')}:00`;

/** Current hour in Asia/Dubai (UTC+4), independent of the viewer's clock. */
export function gulfHour(now = new Date()) {
  return new Date(now.getTime() + 4 * 3600 * 1000).getUTCHours();
}

export function plantRecommendation(plant, mode, phase, startHour = gulfHour()) {
  const confidence = MODE_CONFIDENCE[mode] ?? 0.5;

  const chl = chlorophyllMgM3(plant.lat, plant.lon, phase);
  const turbidity = 0.32 + 0.4 * bloomIndex(chl);

  const hours = [];
  for (let k = 0; k < 24; k += 1) {
    const h = hourScore(plant, (startHour + k) % 24, chl, turbidity, confidence);
    h.offset_h = k;
    h.clock = fmt(startHour + k);
    hours.push(h);
  }

  const best = hours.reduce((a, b) => (b.score > a.score ? b : a));
  const worst = hours.reduce((a, b) => (b.score < a.score ? b : a));
  const current = hours[0];

  const clsNow = classify(current.score);
  const clsBest = classify(best.score);

  // Time to the next overpass of this target: the rest of this orbit.
  const nextPassMin = round(ORBIT_PERIOD_MIN - orbitSeconds(phase) / 60, 1);
  const idx = bloomIndex(chl);

  return {
    plant_id: plant.id,
    name: plant.name,
    operator: plant.operator,
    sea: plant.sea,
    location: { lat: plant.lat, lon: plant.lon },
    capacity_migd: plant.capacity_migd,
    intake: { type: plant.intake_type, depth_m: plant.intake_depth_m },
    observation: {
      chl_a_mg_m3: chl,
      bloom_index: idx,
      severity: severityLabel(idx),
      turbidity: round(turbidity, 3),
      data_age_min: MODE_DATA_AGE_MIN[mode] ?? 60,
      confidence: round(confidence, 3),
      source: 'ORBITAL SENTINEL-1 / HYPER-A ocean-colour retrieval',
    },
    now: { clock: fmt(startHour), score: current.score, ...clsNow },
    best_window: {
      label: `${fmt(best.hour)} - ${fmt(best.hour + 1)}`,
      start_hour: best.hour,
      in_hours: best.offset_h,
      score: best.score,
      ...clsBest,
    },
    avoid_window: {
      label: `${fmt(worst.hour)} - ${fmt(worst.hour + 1)}`,
      start_hour: worst.hour,
      in_hours: worst.offset_h,
      score: worst.score,
      reason: 'Peak surface bloom coincident with tidal slack water.',
    },
    draw_windows: windows(hours, 62),
    hourly: hours,
    next_overpass_min: nextPassMin,
    rationale:
      `Chl-a at the intake is ${chl.toFixed(1)} mg/m3 (${severityLabel(idx)}). `
      + `Scheduler weights the live retrieval at ${Math.round(confidence * 100)}% confidence `
      + `in ${mode} mode, corrects for a ${plant.intake_depth_m.toFixed(0)} m intake depth, `
      + 'and avoids tidal slack water.',
  };
}

export function schedule(mode, phase, startHour = gulfHour()) {
  const plants = DESAL_PLANTS.map((p) => plantRecommendation(p, mode, phase, startHour));
  const combined = round(plants.reduce((a, p) => a + p.now.score, 0) / plants.length, 1);
  return {
    generated_at: new Date().toISOString(),
    timezone: 'Asia/Dubai (UTC+04:00)',
    mode,
    network_score: combined,
    network_band: classify(combined).band,
    plants,
    model: {
      name: 'SENTINEL-DESAL v1.2',
      base: 100,
      weights: {
        bloom_risk: -62,
        thermal_stratification: -22,
        tidal_slack: -16,
        turbidity: -11,
        stale_data_conservatism: -14,
      },
      note: 'Scores are 0-100; >=62 is cleared for normal intake. '
        + 'The conservatism term is a safety margin applied when the '
        + 'observation is old, never a bonus for freshness.',
    },
  };
}
