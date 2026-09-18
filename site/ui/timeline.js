/**
 * The operational timeline.
 *
 * The slider is the only control in the console, so its track is drawn over
 * the mission's real data — mode bands, the battery curve, and the generation
 * profile. An empty grey bar would waste the most important control on the
 * screen; this one shows you where the battery dips before you drag to it.
 */
const MODE_COLOR = {
  ECLIPSE: ['#04212a', '#0a7c88'],
  SUN_FACING: ['#0c2a12', '#7ce86b'],
  ACTIVE: ['#2a1c02', '#ffaa00'],
};

const STATION_COLOR = {
  DXB_GS: '#00f3ff',
  INU_GS: '#7ce86b',
  TRL_GS: '#ffaa00',
};

export class Timeline {
  constructor(link, { onSeek } = {}) {
    this.link = link;
    this.onSeek = onSeek;
    this.canvas = document.getElementById('tl-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.slider = document.getElementById('tl-slider');
    this.profile = null;

    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(this.canvas);

    // Dragging holds playback; releasing resumes it. Without this the
    // autoplay fights the thumb and it stutters under the finger.
    const start = () => { this._dragging = true; link.scrub(true); };
    const end = () => {
      if (!this._dragging) return;
      this._dragging = false;
      link.scrub(false);
    };
    this.slider.addEventListener('pointerdown', start);
    this.slider.addEventListener('keydown', () => { this._keying = true; });
    window.addEventListener('pointerup', end);
    this.slider.addEventListener('input', () => {
      const v = Number(this.slider.value);
      link.seek(v);
      this.onSeek?.(v);
    });

    for (const btn of document.querySelectorAll('.mode-btn[data-mode]')) {
      btn.addEventListener('click', () => {
        link.setMode(btn.dataset.mode);
        this.onSeek?.(link.slider);
      });
    }

    this.playBtn = document.getElementById('btn-play');
    this.playBtn.addEventListener('click', () => {
      const t = link.setTransport({ playing: !link.playing });
      this._renderPlay(t.playing);
    });
    this._renderPlay(link.playing);
  }

  _renderPlay(playing) {
    this.playBtn.textContent = playing ? '❚❚ PAUSE' : '▶ PLAY';
    this.playBtn.setAttribute('aria-pressed', String(!playing));
  }

  setProfile(profile) {
    this.profile = profile;
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth || 600;
    const h = this.canvas.clientHeight || 46;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w;
    this.h = h;
    this.draw();
  }

  draw() {
    const { ctx, w, h } = this;
    if (!w || !h || !this.profile) return;
    ctx.clearRect(0, 0, w, h);

    const {
      segments, samples, soc_envelope: env, compression_bounds: cb, contacts,
    } = this.profile;
    const loop = segments[segments.length - 1].end_s;
    const TOP = 5;                      // reserved strip for contact windows

    ctx.font = '8px ui-monospace, monospace';

    // --- mode bands --------------------------------------------------------
    for (const seg of segments) {
      const x0 = (seg.start_s / loop) * w;
      const x1 = (seg.end_s / loop) * w;
      const [fill, stroke] = MODE_COLOR[seg.mode] ?? ['#04212a', '#0a7c88'];
      ctx.fillStyle = fill;
      ctx.fillRect(x0, TOP, x1 - x0, h - TOP);
      ctx.strokeStyle = '#072731';
      ctx.beginPath();
      ctx.moveTo(x1, TOP);
      ctx.lineTo(x1, h);
      ctx.stroke();
      // The second SUN_FACING interval is the post-pass egress; labelling both
      // the same way would read as a rendering mistake.
      const label = seg.egress ? 'EGRESS' : seg.mode.replace('_', ' ');
      if (x1 - x0 > 34) {
        ctx.fillStyle = stroke;
        ctx.globalAlpha = 0.85;
        ctx.fillText(label, x0 + 5, TOP + 10);
        ctx.globalAlpha = 1;
      }
    }

    // --- clock rate --------------------------------------------------------
    // The headline behaviour of this timeline is that it slows down, so the
    // track shows it: an amber band whose height is the log of the clock rate.
    // The dip over the UAE pass is the shape of the whole redesign.
    if (cb && cb.max > cb.min) {
      const lnLo = Math.log(cb.min);
      const lnSpan = Math.log(cb.max) - lnLo;
      const ry = (c) => h - ((Math.log(c) - lnLo) / lnSpan) * (h - TOP - 4);
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (const s2 of samples) ctx.lineTo(s2.slider * w, ry(s2.compression));
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fillStyle = 'rgba(255,170,0,0.10)';
      ctx.fill();

      ctx.beginPath();
      samples.forEach((s2, i) => {
        const x = s2.slider * w;
        if (i === 0) ctx.moveTo(x, ry(s2.compression));
        else ctx.lineTo(x, ry(s2.compression));
      });
      ctx.strokeStyle = 'rgba(255,170,0,0.5)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // --- battery ----------------------------------------------------------
    const pad = 15;
    const lo = env.min - 0.6;
    const hi = env.max + 0.6;
    const y = (soc) => h - pad * 0.4 - ((soc - lo) / (hi - lo)) * (h - pad - TOP);

    ctx.beginPath();
    samples.forEach((s2, i) => {
      const x = s2.slider * w;
      if (i === 0) ctx.moveTo(x, y(s2.soc_pct));
      else ctx.lineTo(x, y(s2.soc_pct));
    });
    ctx.strokeStyle = '#00f3ff';
    ctx.lineWidth = 1.4;
    ctx.stroke();

    // --- ground-station contact windows -----------------------------------
    // Drawn last and at the very top so they read as an overlay on the
    // timeline rather than as part of the power plot.
    ctx.fillStyle = '#03121a';
    ctx.fillRect(0, 0, w, TOP);
    for (const c of contacts ?? []) {
      ctx.fillStyle = STATION_COLOR[c.station_id] ?? '#0a7c88';
      for (const win of c.windows) {
        const x0 = (win.loop_start_s / loop) * w;
        const x1 = (win.loop_end_s / loop) * w;
        ctx.fillRect(x0, 1, Math.max(1.5, x1 - x0), TOP - 2);
      }
    }

    // --- axis labels, so the zoomed scales are stated rather than implied --
    ctx.fillStyle = '#4d8d99';
    ctx.textAlign = 'right';
    ctx.fillText(`${env.max.toFixed(1)}%`, w - 3, y(env.max) - 2);
    ctx.fillText(`${env.min.toFixed(1)}%`, w - 3, y(env.min) + 8);
    ctx.textAlign = 'left';
    ctx.fillText('BATTERY SOC', 4, h - 3);
    if (cb) {
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,170,0,0.75)';
      ctx.fillText(`CLOCK ${cb.max.toFixed(0)}x → ${cb.min.toFixed(1)}x`, w / 2, h - 3);
      ctx.textAlign = 'left';
    }
  }

  /** Called every tick with the current state. */
  update(state) {
    const s = state.clock.slider;
    if (!this._dragging && document.activeElement !== this.slider) {
      this.slider.value = String(s);
    }
    this.slider.setAttribute('aria-valuetext',
      `${state.mode.label}, ${(state.mode.progress * 100).toFixed(0)} % through segment`);

    document.getElementById('tl-pos').textContent = s.toFixed(3);
    document.getElementById('tl-seg').textContent =
      `${state.mode.id} ${(state.mode.progress * 100).toFixed(0)} %`;
    const mins = Math.floor(state.clock.orbit_elapsed_s / 60);
    const secs = Math.round(state.clock.orbit_elapsed_s % 60);
    document.getElementById('tl-orbit').textContent = `${mins}m ${String(secs).padStart(2, '0')}s`;
    const rate = document.getElementById('tl-rate');
    rate.textContent = `${state.clock.time_compression.toFixed(1)}× real time`;
    const cb = state.clock.compression_bounds;
    rate.classList.toggle('slow', Boolean(cb) && state.clock.time_compression < cb.min * 3);

    for (const btn of document.querySelectorAll('.mode-btn[data-mode]')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.mode === state.mode.id));
    }
  }
}

export default Timeline;
