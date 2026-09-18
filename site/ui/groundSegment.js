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
/**
 * Countdown formatter.
 *
 * mm:ss stops being readable past an hour — a next-pass countdown of "68:01"
 * looks like 68 seconds at a glance, which is wrong by two orders of
 * magnitude. Over an hour it switches to h m, and the caller always pairs it
 * with a label so the unit is never inferred.
 */
const clock = (s) => {
  if (s == null) return '—';
  const v = Math.max(0, Math.round(s));
  if (v >= 3600) return `${Math.floor(v / 3600)}h ${String(Math.floor((v % 3600) / 60)).padStart(2, '0')}m`;
  return `${String(Math.floor(v / 60)).padStart(2, '0')}m ${String(v % 60).padStart(2, '0')}s`;
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
        r.state.textContent = `TRACKING · LOS in ${clock(l.pass.remaining_s)}`;
        r.state.className = 'gs-state ok';
        r.fill.style.width = `${Math.max(0, Math.min(1, l.pass.progress)) * 100}%`;
        r.fill.classList.remove('pending');
        r.rate.textContent = `${l.rate_mbps.toFixed(0)} Mbps`;
        r.rate.className = 'gs-rate ok';
      } else {
        const n = l.next_pass;
        r.state.textContent = n ? `AOS in ${clock(n.in_s)}` : 'NO CONTACT';
        r.state.className = 'gs-state';
        r.fill.style.width = '100%';
        r.fill.classList.add('pending');
        // Just the peak here — the row is ~240 px wide and the pass duration
        // was truncating the range readout next to it. Full detail is in the
        // row tooltip, which is where secondary numbers belong.
        r.rate.textContent = n ? `peak ${n.peak_elevation_deg.toFixed(0)}°` : '—';
        r.rate.className = 'gs-rate';
      }

      r.el.textContent = `${l.elevation_deg.toFixed(1)}° el · `
        + `${Math.round(l.slant_range_km).toLocaleString('en-US')} km range`;
      r.el.className = `gs-el${l.visible ? ' ok' : ''}`;

      const n2 = l.next_pass;
      r.row.title = `${l.name} · ${l.band}-band, up to ${l.max_rate_mbps} Mbps\n`
        + `${l.role}\n`
        + (l.visible && l.pass
          ? `In contact: ${clock(l.pass.elapsed_s)} elapsed, `
            + `${clock(l.pass.remaining_s)} remaining of a `
            + `${clock(l.pass.duration_s)} pass peaking at `
            + `${l.pass.peak_elevation_deg}° elevation.`
          : (n2 ? `Next pass in ${clock(n2.in_s)}: ${clock(n2.duration_s)} long, `
              + `peaking at ${n2.peak_elevation_deg}° elevation.`
            : 'No contact with this station in the current orbit.'))
        + `\nElevation mask 10°; countdowns are real mission time.`;
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
