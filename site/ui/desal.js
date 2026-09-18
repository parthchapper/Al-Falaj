/**
 * Desalination prediction box.
 *
 * The panel that turns the mission from "nice picture of a satellite" into a
 * product. Each plant gets a verdict, a best window, a 24-hour score strip,
 * and — on hover — the individual scoring terms, so "why 06:00?" has an
 * answer on the screen rather than in a slide deck.
 */
const ACTION_HINT = {
  DRAW: 'Intake cleared',
  REDUCE: 'Throttle intake',
  HOLD: 'Suspend intake',
};

export class DesalPanel {
  constructor(bodyEl, tagEl) {
    this.body = bodyEl;
    this.tag = tagEl;
    this.cards = new Map();
    this._built = false;
  }

  update(desal) {
    if (!desal) return;
    if (!this._built) this._build(desal);

    if (this.tag) {
      this.tag.textContent = `NETWORK ${desal.network_score.toFixed(0)}/100 · ${desal.network_band}`;
    }

    for (const p of desal.plants) {
      const c = this.cards.get(p.plant_id);
      if (!c) continue;

      c.verdict.textContent = `${p.now.action} · ${p.now.score.toFixed(0)}/100`;
      c.verdict.className = `verdict ${p.now.band}`;
      c.verdict.title = p.now.text;

      // Four rows, not seven: both plants have to be on screen together, and
      // the secondary numbers are one hover away rather than one scroll away.
      c.kv.innerHTML = `
        <dt>Action</dt><dd>${ACTION_HINT[p.now.action] ?? p.now.action}</dd>
        <dt>Best window</dt><dd class="ok">${p.best_window.label} (+${p.best_window.in_hours} h)</dd>
        <dt>Avoid</dt><dd class="warn">${p.avoid_window.label}</dd>
        <dt>Chl-a at intake</dt><dd>${p.observation.chl_a_mg_m3.toFixed(1)} mg/m³ · ${p.observation.severity}</dd>`;
      c.kv.title =
        `Intake: ${p.intake.type}, ${p.intake.depth_m} m deep\n`
        + `Observation age ${p.observation.data_age_min} min · confidence `
        + `${Math.round(p.observation.confidence * 100)} %\n`
        + `Next overpass in ${p.next_overpass_min.toFixed(0)} min\n`
        + `Source: ${p.observation.source}`;

      const best = Math.max(...p.hourly.map((h) => h.score));
      p.hourly.forEach((h, i) => {
        const bar = c.bars[i];
        bar.style.height = `${Math.max(4, h.score)}%`;
        bar.className = 'h' + (h.score === best ? ' best' : h.score < 45 ? ' bad' : h.score < 62 ? ' mid' : '');
        bar.dataset.hour = h.clock;
        bar.dataset.score = h.score.toFixed(1);
        // The full breakdown, so a sceptical viewer can take the score apart.
        const t = h.terms;
        bar.title =
          `${h.clock} — score ${h.score.toFixed(1)}/100\n`
          + `bloom risk ${(t.bloom_risk * 100).toFixed(0)} % → −${(62 * t.effective_risk).toFixed(1)}\n`
          + `stratification ${(t.thermal_stratification * 100).toFixed(0)} % → −${(22 * t.thermal_stratification * t.bloom_risk).toFixed(1)}\n`
          + `tidal slack ${(t.tidal_slack * 100).toFixed(0)} % → −${(16 * t.tidal_slack * t.bloom_risk).toFixed(1)}\n`
          + `turbidity → −${(11 * t.turbidity).toFixed(1)}\n`
          + `stale-data margin → −${t.stale_data_penalty.toFixed(1)}`;
      });

      c.rationale.textContent = p.rationale;
    }
  }

  _build(desal) {
    this.body.replaceChildren();
    this.cards.clear();

    for (const p of desal.plants) {
      const card = document.createElement('div');
      card.className = 'plant-card';

      const head = document.createElement('div');
      head.className = 'plant-head';
      head.innerHTML = `
        <div>
          <div class="plant-name">${p.name.replace(' Desalination Complex', '')}</div>
          <div class="plant-sea">${p.sea} · ${p.capacity_migd} MIGD · ${p.operator}</div>
        </div>`;
      const verdict = document.createElement('span');
      verdict.className = 'verdict';
      head.appendChild(verdict);

      const kv = document.createElement('dl');
      kv.className = 'kv plant-rows';

      const hours = document.createElement('div');
      hours.className = 'hours';
      const bars = [];
      for (let i = 0; i < 24; i += 1) {
        const b = document.createElement('div');
        b.className = 'h';
        hours.appendChild(b);
        bars.push(b);
      }

      const axis = document.createElement('div');
      axis.className = 'hours-axis';
      axis.innerHTML = '<span>now</span><span>+8 h</span><span>+16 h</span><span>+24 h</span>';

      const tip = document.createElement('div');
      tip.id = `hour-tip-${p.plant_id}`;
      tip.style.cssText = 'font-size:9px;color:var(--amber);min-height:11px;margin-top:2px';
      tip.textContent = 'hover the 24 h strip for the score breakdown';

      hours.addEventListener('mousemove', (e) => {
        const b = e.target.closest('.h');
        if (b?.dataset.hour) tip.textContent = `${b.dataset.hour} → ${b.dataset.score}/100`;
      });
      hours.addEventListener('mouseleave', () => {
        tip.textContent = 'hover the 24 h strip for the score breakdown';
      });

      const rationale = document.createElement('div');
      rationale.className = 'rationale';

      card.append(head, kv, hours, axis, tip, rationale);
      this.body.appendChild(card);
      this.cards.set(p.plant_id, { card, verdict, kv, bars, rationale });
    }

    const model = document.createElement('div');
    model.className = 'rationale';
    model.style.borderTop = '1px solid var(--line-soft)';
    model.textContent =
      `${desal.model.name} · score 100 − 62·bloom − 22·stratification − 16·tidal slack `
      + '− 11·turbidity − 14·(1−confidence). ≥62 clears normal intake.';
    model.title = desal.model.note;
    this.body.appendChild(model);

    this._built = true;
  }
}

export default DesalPanel;
