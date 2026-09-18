/**
 * Water-security impact strip.
 *
 * The rest of the console reports a spacecraft. This reports the reason the
 * spacecraft exists, in the units the decision is actually made in: cubic
 * metres per day of intake capacity the scheduler will not clear.
 *
 * It shows *now* and *peak in the next 24 hours* side by side, because the
 * argument for flying the mission is not that it can see today's water — an
 * operator finds that out eventually, when pressure across the intake screens
 * rises. It is that they can schedule around tomorrow's. A panel that only
 * reported the current hour would go blank every time the water happened to
 * be clear, which is exactly when the forecast is worth the most.
 *
 * It is deliberately the widest, plainest thing on the page. A number a water
 * authority would recognise should not have to compete with a gauge.
 */
const int = (v) => Math.round(v).toLocaleString('en-US');

const compact = (v) => {
  const n = Math.round(v);
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  return int(n);
};

export class ImpactStrip {
  constructor(root) {
    this.root = root;
    this.built = false;
  }

  _build(plants) {
    this.root.innerHTML = `
      <div class="imp-block">
        <span class="imp-k">AT RISK NOW</span>
        <div class="imp-figure">
          <span class="imp-num" id="imp-m3">—</span>
          <span class="imp-unit">m³/day</span>
        </div>
        <span class="imp-n">
          <b id="imp-pct">—</b> of capacity · <b id="imp-people">—</b> people
        </span>
      </div>

      <div class="imp-block peak">
        <span class="imp-k">PEAK · NEXT 24 h</span>
        <div class="imp-figure">
          <span class="imp-num alt" id="imp-peak">—</span>
          <span class="imp-unit">m³/day</span>
        </div>
        <span class="imp-n" id="imp-peak-when">—</span>
      </div>

      <div class="imp-plants">
        ${plants.map((p) => `
          <div class="imp-plant" data-id="${p.plant_id}">
            <div class="imp-plant-top">
              <span class="imp-plant-name">${p.short}</span>
              <span class="imp-plant-act">—</span>
            </div>
            <div class="imp-plant-bar"><div class="imp-plant-fill"></div></div>
            <div class="imp-plant-foot">
              <span class="imp-plant-m3">—</span>
              <span class="imp-plant-cap">${p.capacity_migd} MIGD</span>
            </div>
          </div>`).join('')}
      </div>`;
    this.built = true;
  }

  update(impact) {
    if (!impact) return;
    if (!this.built) this._build(impact.plants);
    const t = impact.total;
    const clear = t.at_risk_m3_day <= 0;

    this.root.classList.toggle('clear', clear);
    this.root.classList.toggle('severe', t.at_risk_pct > 35);

    this.root.querySelector('#imp-m3').textContent =
      clear ? 'NONE' : compact(t.at_risk_m3_day);
    this.root.querySelector('#imp-m3').title =
      clear ? 'Every monitored plant is cleared to draw at full rate.'
        : `${int(t.at_risk_m3_day)} m³/day of ${int(t.capacity_m3_day)} m³/day rated`;
    this.root.querySelector('#imp-pct').textContent = `${t.at_risk_pct.toFixed(1)}%`;
    this.root.querySelector('#imp-people').textContent = compact(t.people_at_risk);

    const pk = impact.peak;
    const pkEl = this.root.querySelector('#imp-peak');
    const whenEl = this.root.querySelector('#imp-peak-when');
    if (pk && pk.at_risk_m3_day > 0) {
      pkEl.textContent = compact(pk.at_risk_m3_day);
      pkEl.title = `${int(pk.at_risk_m3_day)} m³/day · ${int(pk.people_at_risk)} people`;
      whenEl.innerHTML = pk.in_h === 0
        ? `<b>now</b> · worst intake score ${pk.worst_score}`
        : `in <b>${pk.in_h} h</b> at <b>${pk.clock}</b> · score falls to ${pk.worst_score}`;
    } else {
      pkEl.textContent = 'NONE';
      pkEl.title = 'No hour in the next 24 falls below the clear-to-draw band.';
      whenEl.textContent = 'clear for the full 24-hour forecast';
    }

    for (const p of impact.plants) {
      const el = this.root.querySelector(`.imp-plant[data-id="${p.plant_id}"]`);
      if (!el) continue;
      el.dataset.action = p.action;
      el.querySelector('.imp-plant-act').textContent = p.action;
      el.querySelector('.imp-plant-fill').style.width =
        `${Math.max(0, Math.min(1, p.risk_fraction)) * 100}%`;
      el.querySelector('.imp-plant-m3').textContent =
        p.at_risk_m3_day > 0 ? `${compact(p.at_risk_m3_day)} m³/d` : 'clear';
      el.title = `${p.name}\n${p.severity} · intake score ${p.score}/100\n`
        + `${p.at_risk_pct}% of ${int(p.capacity_m3_day)} m³/day rated output`
        + (p.lead_time_h != null ? `\nNext unclear hour: +${p.lead_time_h} h` : '');
    }
  }
}

export default ImpactStrip;
