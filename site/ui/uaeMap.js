/**
 * 2D UAE swath map.
 *
 * The 3D globe answers "where is the spacecraft"; this answers "what is it
 * looking at, and what has it already covered". A flat, fixed-frame map is
 * better at the second question because nothing moves except the data.
 *
 * Geometry comes from the same Natural Earth vectors the globe uses, and the
 * scan line, swath band and ground track come from the same mission snapshot,
 * so the two views cannot disagree.
 */
import { AOI } from '../engine/config.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const VB = { w: 200, h: 150, pad: 4 };

export class UAEMap {
  constructor(root = document) {
    this.svg = root.getElementById('uae-svg');
    this.elGrid = root.getElementById('uae-grid');
    this.elLand = root.getElementById('uae-land');
    this.elUAE = root.getElementById('uae-shape');
    this.elBloom = root.getElementById('uae-bloom');
    this.elTrack = root.getElementById('uae-track');
    this.elSwath = root.getElementById('uae-swath');
    this.elScan = root.getElementById('uae-scanline');
    this.elPlants = root.getElementById('uae-plants');
    this.elSat = root.getElementById('uae-sat');
    this.elLabels = root.getElementById('uae-labels');
    this.tag = root.getElementById('uae-tag');

    // Equirectangular fit of the AOI box, aspect preserved so the coastline
    // is not stretched — a squashed Gulf reads as a mistake.
    const [w, s, e, n] = AOI.bbox;
    const kx = Math.cos((((s + n) / 2) * Math.PI) / 180);
    const spanX = (e - w) * kx;
    const spanY = n - s;
    const scale = Math.min((VB.w - 2 * VB.pad) / spanX, (VB.h - 2 * VB.pad) / spanY);
    this.proj = (lat, lon) => [
      VB.w / 2 + (lon - (w + e) / 2) * kx * scale,
      VB.h / 2 - (lat - (s + n) / 2) * scale,
    ];
    this.bbox = AOI.bbox;
  }

  async build() {
    this._graticule();
    await this._coastlines();
    this._plants();
    return this;
  }

  _graticule() {
    const [w, s, e, n] = this.bbox;
    const frag = document.createDocumentFragment();
    for (let lat = Math.ceil(s); lat <= n; lat += 1) {
      const [x1, y1] = this.proj(lat, w);
      const [x2, y2] = this.proj(lat, e);
      frag.appendChild(this._line(x1, y1, x2, y2, 'grid'));
      if (lat % 2 === 0) frag.appendChild(this._text(x1 + 1.5, y1 - 1, `${lat}°N`));
    }
    for (let lon = Math.ceil(w); lon <= e; lon += 1) {
      const [x1, y1] = this.proj(s, lon);
      const [x2, y2] = this.proj(n, lon);
      frag.appendChild(this._line(x1, y1, x2, y2, 'grid'));
      if (lon % 2 === 0) frag.appendChild(this._text(x1 + 1, VB.h - 2, `${lon}°E`));
    }
    this.elGrid.appendChild(frag);
  }

  async _coastlines() {
    const url = new URL('../map3d/data/gulf-countries.json', import.meta.url);
    const data = await fetch(url).then((r) => r.json());
    const frag = document.createDocumentFragment();
    let uaePath = '';

    for (const [code, entry] of Object.entries(data.countries ?? {})) {
      const d = entry.rings.map((ring) => this._ringPath(ring)).join(' ');
      if (!d.trim()) continue;
      if (code === 'ARE') { uaePath = d; continue; }
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('class', 'land');
      p.setAttribute('d', d);
      frag.appendChild(p);
    }
    this.elLand.appendChild(frag);
    if (uaePath) this.elUAE.setAttribute('d', uaePath);
  }

  _ringPath(ring) {
    let d = '';
    let started = false;
    for (const [lon, lat] of ring) {
      // Clip a few degrees past the frame rather than at it: the neighbouring
      // states need enough of their outline to close into a filled shape, or
      // land ends up transparent and the chlorophyll layer beneath shows
      // through ground it could never have been measured on.
      const M = 4;
      if (lon < this.bbox[0] - M || lon > this.bbox[2] + M
        || lat < this.bbox[1] - M || lat > this.bbox[3] + M) { started = false; continue; }
      const [x, y] = this.proj(lat, lon);
      d += `${started ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)} `;
      started = true;
    }
    return d ? `${d}Z` : '';
  }

  _plants() {
    const frag = document.createDocumentFragment();
    const labels = document.createDocumentFragment();
    this.plantNodes = new Map();
    for (const p of [
      { id: 'JEBEL_ALI', short: 'JEBEL ALI', lat: 25.0, lon: 55.06 },
      { id: 'FUJAIRAH', short: 'FUJAIRAH', lat: 25.11, lon: 56.35 },
    ]) {
      const [x, y] = this.proj(p.lat, p.lon);
      const c = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('class', 'plant');
      c.setAttribute('cx', x.toFixed(2));
      c.setAttribute('cy', y.toFixed(2));
      c.setAttribute('r', '1.6');
      frag.appendChild(c);
      labels.appendChild(this._text(x + 2.4, y + 1.6, p.short, 'plant-label'));
      this.plantNodes.set(p.id, c);
    }
    this.elPlants.appendChild(frag);
    this.elLabels.appendChild(labels);
  }

  // -- live updates ---------------------------------------------------------
  update(state) {
    if (!state?.map) return;
    const m = state.map;
    const [sx, sy] = this.proj(m.subsatellite.lat, m.subsatellite.lon);
    this.elSat.setAttribute('cx', sx.toFixed(2));
    this.elSat.setAttribute('cy', sy.toFixed(2));

    const [lx, ly] = this.proj(m.scan_line.left.lat, m.scan_line.left.lon);
    const [rx, ry] = this.proj(m.scan_line.right.lat, m.scan_line.right.lon);
    this.elScan.setAttribute('x1', lx.toFixed(2));
    this.elScan.setAttribute('y1', ly.toFixed(2));
    this.elScan.setAttribute('x2', rx.toFixed(2));
    this.elScan.setAttribute('y2', ry.toFixed(2));

    // Covered swath: the same GeoJSON ring the science was computed over.
    const ring = m.swath_covered?.geometry?.coordinates?.[0];
    this.elSwath.setAttribute('points', ring
      ? ring.map(([lon, lat]) => this.proj(lat, lon).map((v) => v.toFixed(1)).join(',')).join(' ')
      : '');

    const track = m.ground_track
      .filter((p) => p.lat > this.bbox[1] - 3 && p.lat < this.bbox[3] + 3
        && p.lon > this.bbox[0] - 3 && p.lon < this.bbox[2] + 3);
    this.elTrack.setAttribute('d', track.length > 1
      ? track.map((p, i) => {
        const [x, y] = this.proj(p.lat, p.lon);
        return `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
      }).join(' ')
      : '');

    for (const wq of state.science?.water_quality ?? []) {
      const node = this.plantNodes.get(wq.plant_id);
      if (node) node.classList.toggle('hot', wq.risk >= 0.5);
    }

    if (this.tag) {
      this.tag.textContent = m.aoi.over_aoi
        ? `OVER AOI · SWATH ${m.swath_half_width_km * 2} KM`
        : `${Math.round(m.aoi.range_to_center_km)} KM TO AOI`;
    }
  }

  /** Paint the Chl-a field as a coarse cell grid behind the coastline. */
  setField(field, rampFn) {
    if (!field?.values?.length) return;
    const { nx, ny, values, max } = field;
    const [w, s, e, n] = field.bbox;
    const cw = (e - w) / (nx - 1);
    const ch = (n - s) / (ny - 1);
    const frag = document.createDocumentFragment();

    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        const t = values[j * nx + i] / (max || 1);
        if (t < 0.12) continue;                 // clear water stays clear
        const [x0, y0] = this.proj(s + (j + 0.5) * ch, w + (i - 0.5) * cw);
        const [x1, y1] = this.proj(s + (j - 0.5) * ch, w + (i + 0.5) * cw);
        const r = document.createElementNS(SVG_NS, 'rect');
        r.setAttribute('x', Math.min(x0, x1).toFixed(2));
        r.setAttribute('y', Math.min(y0, y1).toFixed(2));
        r.setAttribute('width', Math.abs(x1 - x0).toFixed(2));
        r.setAttribute('height', Math.abs(y1 - y0).toFixed(2));
        r.setAttribute('fill', `#${rampFn(t).toString(16).padStart(6, '0')}`);
        r.setAttribute('opacity', (0.14 + 0.5 * t).toFixed(3));
        frag.appendChild(r);
      }
    }
    this.elBloom.replaceChildren(frag);
  }

  clearField() { this.elBloom.replaceChildren(); }

  // -- helpers --------------------------------------------------------------
  _line(x1, y1, x2, y2, cls) {
    const l = document.createElementNS(SVG_NS, 'line');
    l.setAttribute('class', cls);
    l.setAttribute('x1', x1.toFixed(2));
    l.setAttribute('y1', y1.toFixed(2));
    l.setAttribute('x2', x2.toFixed(2));
    l.setAttribute('y2', y2.toFixed(2));
    return l;
  }

  _text(x, y, s, cls) {
    const t = document.createElementNS(SVG_NS, 'text');
    if (cls) t.setAttribute('class', cls);
    t.setAttribute('x', x.toFixed(2));
    t.setAttribute('y', y.toFixed(2));
    t.textContent = s;
    return t;
  }
}

export default UAEMap;
