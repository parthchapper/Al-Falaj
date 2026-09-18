/**
 * Water-security impact — port of `worker/app/impact.py`.
 *
 * Every other panel answers "what is the spacecraft doing". This one answers
 * the question the mission exists for: how much drinking water is at risk, and
 * how much warning does the operator get?
 *
 * The chain is short and each link is stated on the console:
 *
 *   Chl-a retrieval  ->  intake score  ->  fraction of capacity at risk
 *                    ->  m3/day at risk  ->  people whose daily supply it is
 *
 * Nothing here is a new measurement. It is the desalination scheduler's own
 * scores, converted into the units a utility actually makes decisions in.
 */
import { DESAL_PLANTS, M3_PER_MIGD } from './config.js';

const round = (x, n) => Number(x.toFixed(n));

/**
 * UAE domestic consumption per person per day.
 *
 * ~550 L is the commonly cited UAE figure — among the highest in the world,
 * roughly double the Western European average. Used only to express a volume
 * as a number of people, never to claim those people lose supply: a plant
 * throttling its intake draws down reservoir stock first.
 */
export const PER_CAPITA_M3_DAY = 0.55;

/**
 * Fraction of a plant's capacity a given intake score puts at risk.
 *
 * Zero at 70 and above (the scheduler's clear-to-draw band), rising linearly
 * to the whole plant at 15. Deliberately linear: a threshold would imply the
 * model resolves a boundary it does not, and a curve would imply a calibration
 * nobody has done for these waters.
 */
export function riskFraction(score) {
  return round(Math.max(0, Math.min(1, (70 - score) / 55)), 4);
}

/**
 * Hours of warning before the intake would have found out the hard way.
 *
 * An operator without ocean colour learns about a bloom when differential
 * pressure across the intake screens rises — by then the bloom is already in
 * the plant. The satellite's warning is the time between now and the first
 * hour the scheduler flags as unsafe.
 */
export function leadTimeH(hourly) {
  for (const h of hourly) {
    if (h.score < 62) return h.offset_h;
  }
  return null;
}

/**
 * The worst hour in the next 24, across the network.
 *
 * A scheduler that only reports "right now" is a nowcast, and a nowcast on a
 * clear hour looks like a panel with nothing to say. The whole argument for
 * flying this mission is that an operator can *schedule around* a bloom
 * instead of reacting to one, which means the number that matters is the one
 * they do not have yet: when the water goes bad, and by how much.
 */
export function peakRisk(plants, capacityById) {
  let best = null;
  const n = plants[0]?.hourly?.length ?? 0;
  for (let k = 0; k < n; k += 1) {
    let total = 0;
    let worst = null;
    for (const p of plants) {
      const h = p.hourly[k];
      if (!h) continue;
      const m3 = capacityById.get(p.plant_id) * riskFraction(h.score);
      total += m3;
      if (!worst || h.score < worst.score) worst = { score: h.score, name: p.plant_id };
    }
    if (!best || total > best.at_risk_m3_day) {
      best = {
        in_h: k,
        clock: plants[0].hourly[k].clock,
        at_risk_m3_day: round(total, 0),
        worst_plant: worst?.name ?? null,
        worst_score: worst?.score ?? null,
      };
    }
  }
  return best;
}

export function impact(scheduleState) {
  const plants = (scheduleState?.plants ?? []).map((p) => {
    const cfg = DESAL_PLANTS.find((d) => d.id === p.plant_id);
    const capacity = cfg.capacity_migd * M3_PER_MIGD;
    const frac = riskFraction(p.now.score);
    const atRisk = capacity * frac;
    return {
      plant_id: p.plant_id,
      name: p.name,
      short: p.plant_id === 'JEBEL_ALI' ? 'JEBEL ALI' : 'FUJAIRAH',
      action: p.now.action,
      score: p.now.score,
      capacity_m3_day: round(capacity, 0),
      capacity_migd: cfg.capacity_migd,
      risk_fraction: frac,
      at_risk_m3_day: round(atRisk, 0),
      at_risk_pct: round(frac * 100, 1),
      people_served: cfg.people_served,
      people_at_risk: Math.round(atRisk / PER_CAPITA_M3_DAY),
      lead_time_h: leadTimeH(p.hourly ?? []),
      severity: p.observation.severity,
    };
  });

  const capacity = plants.reduce((a, p) => a + p.capacity_m3_day, 0);
  const atRisk = plants.reduce((a, p) => a + p.at_risk_m3_day, 0);
  const leads = plants.map((p) => p.lead_time_h).filter((h) => h !== null);

  const capById = new Map(plants.map((p) => [p.plant_id, p.capacity_m3_day]));
  const peak = peakRisk(scheduleState?.plants ?? [], capById);

  return {
    plants,
    peak: peak ? {
      ...peak,
      people_at_risk: Math.round(peak.at_risk_m3_day / PER_CAPITA_M3_DAY),
      at_risk_pct: round(capacity > 0 ? (peak.at_risk_m3_day / capacity) * 100 : 0, 1),
    } : null,
    total: {
      capacity_m3_day: round(capacity, 0),
      at_risk_m3_day: round(atRisk, 0),
      at_risk_pct: round(capacity > 0 ? (atRisk / capacity) * 100 : 0, 1),
      people_served: plants.reduce((a, p) => a + p.people_served, 0),
      people_at_risk: Math.round(atRisk / PER_CAPITA_M3_DAY),
      // Least warning across the network is the one that matters — the
      // network is only as early as its earliest problem.
      lead_time_h: leads.length ? Math.min(...leads) : null,
      plants_clear: plants.filter((p) => p.action === 'DRAW').length,
      plants_total: plants.length,
    },
    basis: {
      per_capita_m3_day: PER_CAPITA_M3_DAY,
      m3_per_migd: M3_PER_MIGD,
      clear_score: 70,
      total_loss_score: 15,
      note: 'Capacity at risk is the fraction of rated output the intake '
        + 'scheduler would not clear to draw, not an outage. Population is '
        + 'that volume expressed at UAE per-capita domestic demand.',
    },
  };
}
