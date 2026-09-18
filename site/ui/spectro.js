/**
 * Spectroscopy graph.
 *
 * 96 bars, one per spectral band, coloured by their own wavelength so the
 * plot reads as a spectrum rather than a bar chart. The diagnostic
 * wavelengths are drawn as labelled guides, because an unannotated spike is
 * decoration — the point of the panel is that a viewer can see *why* the
 * instrument concludes there is algae down there.
 */
const FEATURE_COLOR = { absorption: '#ff2d2d', peak: '#ffaa00', reference: '#4d8d99' };

/** Approximate visible-spectrum colour for a wavelength, used for the bars. */
function wavelengthColor(nm) {
  if (nm < 440) return [80, 110, 255];
  if (nm < 490) return [0, 170, 255];
  if (nm < 510) return [0, 243, 255];
  if (nm < 580) return [124, 232, 107];
  if (nm < 645) return [255, 170, 0];
  if (nm < 700) return [255, 70, 60];
  // Beyond visible: fade to a dim infrared red so the NIR bands read as
  // "measured but not seen".
  const f = Math.max(0, 1 - (nm - 700) / 220);
  return [Math.round(150 * f + 45), Math.round(26 * f + 12), Math.round(30 * f + 14)];
}

export class SpectroGraph {
  constructor(canvas, legendEl, indicesEl) {
    this.canvas = canvas;
    this.legend = legendEl;
    this.indices = indicesEl;
    this.ctx = canvas.getContext('2d');
    this.data = null;
    this._legendKey = '';
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(canvas);
    this.resize();
    canvas.addEventListener('mousemove', (e) => this._hover(e));
    canvas.addEventListener('mouseleave', () => { this.hoverNm = null; this.draw(); });
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth || 300;
    const h = this.canvas.clientHeight || 140;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w;
    this.h = h;
    this.draw();
  }

  _hover(e) {
    const r = this.canvas.getBoundingClientRect();
    const f = (e.clientX - r.left) / r.width;
    this.hoverNm = 400 + f * 500;
    this.draw();
  }

  /** `science` is a spectrum payload, or null outside ACTIVE. */
  set(science) {
    this.data = science;
    this.draw();
    this._renderLegend();
    this._renderIndices();
  }

  draw() {
    const { ctx, w, h } = this;
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);

    const padB = 14;
    const plotH = h - padB;

    // Baseline grid at 400/500/…/900 nm.
    ctx.strokeStyle = '#072731';
    ctx.lineWidth = 1;
    ctx.font = '8px ui-monospace, monospace';
    ctx.fillStyle = '#4d8d99';
    ctx.textAlign = 'center';
    for (let nm = 400; nm <= 900; nm += 100) {
      const x = ((nm - 400) / 500) * w;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, plotH);
      ctx.stroke();
      ctx.fillText(`${nm}`, Math.min(w - 10, Math.max(10, x)), h - 4);
    }

    if (!this.data) {
      ctx.fillStyle = '#2b5c66';
      ctx.font = '11px ui-monospace, monospace';
      ctx.fillText('PAYLOAD INACTIVE — NO SPECTRAL DATA', w / 2, plotH / 2);
      return;
    }

    // Bars.
    const bands = this.data.bands;
    const bw = w / bands.length;
    bands.forEach((b, i) => {
      const [r, g, bl] = wavelengthColor(b.nm);
      const barH = Math.max(1, b.norm * (plotH - 4));
      ctx.fillStyle = `rgba(${r},${g},${bl},0.9)`;
      ctx.fillRect(i * bw, plotH - barH, Math.max(1, bw - 0.8), barH);
    });

    // Diagnostic wavelength guides.
    ctx.textAlign = 'left';
    for (const f of this.data.features) {
      const x = ((f.nm - 400) / 500) * w;
      ctx.strokeStyle = FEATURE_COLOR[f.kind] ?? '#4d8d99';
      ctx.globalAlpha = 0.55;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      // Marker dot at the band's own height.
      ctx.fillStyle = FEATURE_COLOR[f.kind] ?? '#4d8d99';
      ctx.beginPath();
      ctx.arc(x, plotH - f.norm * (plotH - 4), 2.2, 0, Math.PI * 2);
      ctx.fill();
    }

    // Hover crosshair with a readout.
    if (this.hoverNm != null) {
      const nm = this.hoverNm;
      const x = ((nm - 400) / 500) * w;
      const band = bands.reduce((a, b) => (Math.abs(b.nm - nm) < Math.abs(a.nm - nm) ? b : a));
      ctx.strokeStyle = '#d8fbff';
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, plotH);
      ctx.stroke();
      ctx.globalAlpha = 1;

      const near = this.data.features.reduce(
        (a, b) => (Math.abs(b.nm - nm) < Math.abs(a.nm - nm) ? b : a));
      const label = Math.abs(near.nm - nm) < 12 ? ` · ${near.name}` : '';
      const txt = `${band.nm.toFixed(0)} nm  Rrs ${band.rrs.toExponential(2)}${label}`;
      ctx.font = '9px ui-monospace, monospace';
      const tw = ctx.measureText(txt).width + 8;
      const tx = Math.min(w - tw - 2, Math.max(2, x + 5));
      ctx.fillStyle = 'rgba(0,16,22,0.92)';
      ctx.fillRect(tx, 2, tw, 13);
      ctx.strokeStyle = '#0d3f49';
      ctx.strokeRect(tx, 2, tw, 13);
      ctx.fillStyle = '#d8fbff';
      ctx.textAlign = 'left';
      ctx.fillText(txt, tx + 4, 11.5);
    }
  }

  _renderLegend() {
    if (!this.data) { this.legend.replaceChildren(); this._legendKey = ''; return; }
    const key = this.data.features.map((f) => f.nm).join(',');
    if (key === this._legendKey) return;      // the feature set never changes
    this._legendKey = key;
    this.legend.replaceChildren(...this.data.features.map((f) => {
      const s = document.createElement('span');
      s.title = `${f.nm} nm — ${f.name} (${f.kind})`;
      s.innerHTML = `<i style="color:${FEATURE_COLOR[f.kind] ?? '#4d8d99'}">${f.nm}</i>${f.name}`;
      return s;
    }));
  }

  _renderIndices() {
    if (!this.data) { this.indices.replaceChildren(); return; }
    const i = this.data.indices;
    const cells = [
      ['CHL-A mg/m³', i.chl_a_mg_m3.toFixed(1), ''],
      ['SEVERITY', i.severity, `sev-${i.severity}`],
      ['BLOOM IDX', i.bloom_index.toFixed(2), ''],
      ['MCI', i.mci.toExponential(1), ''],
      ['NDCI', i.ndci.toFixed(3), ''],
      ['FLH 681nm', i.fluorescence_line_height.toExponential(1), ''],
    ];
    this.indices.replaceChildren(...cells.map(([k, v, cls]) => {
      const d = document.createElement('div');
      d.className = 'idx';
      d.innerHTML = `<div class="k">${k}</div><div class="v ${cls}">${v}</div>`;
      return d;
    }));
    this.indices.title =
      'MCI = maximum chlorophyll index, the operational bloom detector. '
      + 'NDCI = normalised difference chlorophyll index. '
      + 'FLH = fluorescence line height at 681 nm — the live-algae signal.';
  }
}

export default SpectroGraph;
