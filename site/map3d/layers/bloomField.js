import * as THREE from 'three';
import { sampleRamp } from '../palette.js';
import { llaToVec3 } from '../coords.js';

/**
 * Chlorophyll-a overlay for the AOI.
 *
 * The backend returns a row-major grid of Chl-a values over the UAE
 * bounding box; this paints it into a canvas through the severity ramp and
 * drapes it on a curved lat/lon patch that follows the globe. It is the
 * layer that makes "algae density" a thing you can see rather than a
 * number you have to trust.
 */
export class BloomFieldLayer {
  constructor({ segments = 64 } = {}) {
    this.segments = segments;
    this.group = new THREE.Group();
    this.group.name = 'bloom-field';
    this.group.visible = false;

    // The presentation canvas is a FIXED size. The grid the backend returns
    // changes resolution between calls, and resizing a canvas that a live
    // WebGL texture is bound to is the kind of thing that works on one
    // driver and silently misaligns on another. Instead the grid is painted
    // into a small scratch canvas and scaled up into this one, which also
    // gives the overlay smooth interpolation for free.
    this.canvas = document.createElement('canvas');
    this.canvas.width = 512;
    this.canvas.height = 256;
    this.ctx = this.canvas.getContext('2d');
    this.ctx.imageSmoothingEnabled = true;

    this.scratch = document.createElement('canvas');
    this.scratchCtx = this.scratch.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;

    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      opacity: 0.0,
      depthWrite: false,
      // Normal blending, not additive: additive over a near-black globe
      // washes the low end out to nothing, and the whole point of the
      // overlay is that moderate Chl-a is still legible.
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
  }

  /** Build the curved patch once the AOI bbox is known. */
  setBBox(bbox, altKm = 22) {
    this.bbox = bbox;
    const [w, s, e, n] = bbox;
    const seg = this.segments;

    const positions = [];
    const uvs = [];
    const indices = [];

    for (let j = 0; j <= seg; j += 1) {
      const fy = j / seg;
      const lat = s + (n - s) * fy;
      for (let i = 0; i <= seg; i += 1) {
        const fx = i / seg;
        const lon = w + (e - w) * fx;
        const v = llaToVec3(lat, lon, altKm);
        positions.push(v.x, v.y, v.z);
        uvs.push(fx, fy);
      }
    }
    for (let j = 0; j < seg; j += 1) {
      for (let i = 0; i < seg; i += 1) {
        const a = j * (seg + 1) + i;
        const b = a + 1;
        const c = a + seg + 1;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(indices);
    g.computeVertexNormals();
    this.mesh.geometry.dispose();
    this.mesh.geometry = g;
    return this;
  }

  /** Paint a field payload from GET /api/science/field. */
  setField(field) {
    if (!field?.values?.length) return;
    const { nx, ny, values } = field;
    const max = Math.max(1e-6, field.max ?? Math.max(...values));

    this.scratch.width = nx;
    this.scratch.height = ny;
    const img = this.scratchCtx.createImageData(nx, ny);

    for (let j = 0; j < ny; j += 1) {
      // Grid is south-to-north; canvas rows run top-down, so flip.
      const src = (ny - 1 - j) * nx;
      for (let i = 0; i < nx; i += 1) {
        const t = values[src + i] / max;
        const rgb = sampleRamp(t);
        const o = (j * nx + i) * 4;
        img.data[o] = (rgb >> 16) & 255;
        img.data[o + 1] = (rgb >> 8) & 255;
        img.data[o + 2] = rgb & 255;
        // Clear water stays nearly transparent, but anything above the
        // background rises quickly so a WATCH-level patch is unmissable.
        img.data[o + 3] = Math.round(235 * Math.min(1, Math.pow(t, 1.15)));
      }
    }
    this.scratchCtx.putImageData(img, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.drawImage(this.scratch, 0, 0, this.canvas.width, this.canvas.height);
    this.texture.needsUpdate = true;
    this.max = max;
    this.grid = [nx, ny];
  }

  setTheme(theme, tSeconds = 0) {
    const on = theme.swathOpacity > 0;
    this.group.visible = on;
    if (!on) return;
    const breathe = 0.86 + 0.14 * Math.sin(tSeconds * Math.PI * 2 * 0.25);
    this.material.opacity = 0.8 * breathe * theme.exposure;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}

export default BloomFieldLayer;
