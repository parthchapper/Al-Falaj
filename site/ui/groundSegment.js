/**
 * Ground segment board — acquisition and loss of signal.
 *
 * The three stations are not decoration and their timings are not scripted:
 * `engine/comms.js` sweeps the propagator against each station's 10° horizon
 * mask, so the countdown on this board is when the spacecraft actually rises.
 *
 * Countdowns are in *orbit* seconds — real mission time — not loop seconds.
 * "AOS in 07:12" means seven real minutes, which is the number an operator
 * would act on; the demo clock running at 124× is a property of the display,
 * not of the pass.
 */
const clock = (s) => {
  if (s == null) return '—';
  const v = Math.max(0, Math.round(s));
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
};

export class GroundSegment {
  constructor(root, tag) {
    this.root = root;
    this.tag = tag;
    this.rows = new Map();
    this.prevVisible = new Map();
    this.built = false;
  }

  _build(links) {
    this.root.innerHTML = '';
    for (const l of links) {
      const row = document.createElement('div');
      row.className = 'gs-row';
      row.innerHTML = `
        <div class="gs-head">
          <span class="gs-dot"></span>
          <span class="gs-name">${l.short}</span>
          <span class="spacer"></span>
          <span class="gs-state">—</span>
        </div>
        <div class="gs-bar"><div class="gs-fill"></div></div>
        <div class="gs-foot">
          <span class="gs-el">—</span>
          <span class="spacer"></span>
          <span class="gs-rate">—</span>
        </div>`;
      row.title = `${l.name} · ${l.band}-band, ${l.max_rate_mbps} Mbps\n${l.role}`;
      this.root.appendChild(row);
      this.rows.set(l.station_id, {
        row,
        dot: row.querySelector('.gs-dot'),
        state: row.querySelector('.gs-state'),
        fill: row.querySelector('.gs-fill'),
        el: row.querySelector('.gs-el'),
        rate: row.querySelector('.gs-rate'),
      });
    }
    this.built = true;
  }

  /**
   * Returns the AOS/LOS transitions that just happened, so the caller can
   * make a sound without this module needing to know about audio.
   */
  update(state) {
    const links = state.comms.links;
    if (!this.built) this._build(links);

    const events = [];
    for (const l of links) {
      const r = this.rows.get(l.station_id);
      if (!r) continue;

      const was = this.prevVisible.get(l.station_id);
      if (was !== undefined && was !== l.visible) {
        events.push({ station: l, type: l.visible ? 'AOS' : 'LOS' });
      }
      this.prevVisible.set(l.station_id, l.visible);

      r.row.classList.toggle('live', l.visible);
      r.dot.classList.toggle('on', l.visible);

      if (l.visible && l.pass) {
        r.state.textContent = `TRACKING · LOS ${clock(l.pass.remaining_s)}`;
        r.state.className = 'gs-state ok';
        r.fill.style.width = `${Math.max(0, Math.min(1, l.pass.progress)) * 100}%`;
        r.fill.classList.remove('pending');
        r.rate.textContent = `${l.rate_mbps.toFixed(0)} Mbps`;
        r.rate.className = 'gs-rate ok';
      } else {
        const n = l.next_pass;
        r.state.textContent = n ? `AOS ${clock(n.in_s)}` : 'NO CONTACT';
        r.state.className = 'gs-state';
        r.fill.style.width = '100%';
        r.fill.classList.add('pending');
        r.rate.textContent = n ? `max ${n.peak_elevation_deg.toFixed(0)}° · ${clock(n.duration_s)}` : '—';
        r.rate.className = 'gs-rate';
      }

      r.el.textContent = `EL ${l.elevation_deg.toFixed(1)}° · `
        + `${Math.round(l.slant_range_km).toLocaleString('en-US')} km`;
      r.el.className = `gs-el${l.visible ? ' ok' : ''}`;
    }

    const c = state.comms;
    this.tag.textContent = c.active_link
      ? `${c.state} · ${c.downlink.rate_mbps.toFixed(0)} Mbps`
      : `${c.network_duty_pct}% ORBIT COVERAGE`;
    this.tag.className = `tag${c.active_link ? ' ok' : ''}`;

    return events;
  }
}

export default GroundSegment;
