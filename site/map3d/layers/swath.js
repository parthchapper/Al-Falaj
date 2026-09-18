import * as THREE from 'three';
import { PALETTE } from '../palette.js';
import { km, llaToVec3 } from '../coords.js';

/**
 * The scanning swath.
 *
 * Three parts, because three different things are true at once:
 *   - the *scan line*: where the pushbroom is looking right this instant,
 *   - the *sensor cone*: the volume between the spacecraft and that line,
 *   - the *covered area*: everything imaged so far this pass, as a filled
 *     ribbon on the surface.
 *
 * The covered ribbon is rebuilt from the GeoJSON ring the backend sends, so
 * the picture on the globe is the same polygon the science products were
 * computed over — not a decorative approximation of it.
 */
export class SwathLayer {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'swath-layer';
    this.group.visible = false;
    this._build();
  }

  _build() {
    this.scanLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineBasicMaterial({ color: PALETTE.amber, linewidth: 2 }),
    );
    this.scanLine.name = 'scan-line';
    this.group.add(this.scanLine);

    this.coneMaterial = new THREE.MeshBasicMaterial({
      color: PALETTE.cyan, transparent: true, opacity: 0.18,
      side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.cone = new THREE.Mesh(new THREE.BufferGeometry(), this.coneMaterial);
    this.cone.name = 'sensor-cone';
    this.cone.frustumCulled = false;
    this.group.add(this.cone);

    this.ribbonMaterial = new THREE.MeshBasicMaterial({
      color: PALETTE.cyan, transparent: true, opacity: 0.26,
      side: THREE.DoubleSide, depthWrite: false,
    });
    this.ribbon = new THREE.Mesh(new THREE.BufferGeometry(), this.ribbonMaterial);
    this.ribbon.name = 'covered-swath';
    this.ribbon.frustumCulled = false;
    this.group.add(this.ribbon);

    this.edgeMaterial = new THREE.LineBasicMaterial({
      color: PALETTE.cyan, transparent: true, opacity: 0.55,
    });
    this.edges = new THREE.LineSegments(new THREE.BufferGeometry(), this.edgeMaterial);
    this.edges.name = 'swath-edges';
    this.group.add(this.edges);
  }

  /** Instantaneous scan line + the cone back to the spacecraft. */
  updateScan(scanLine, satPosition) {
    if (!scanLine) return;
    const l = llaToVec3(scanLine.left.lat, scanLine.left.lon, 4);
    const r = llaToVec3(scanLine.right.lat, scanLine.right.lon, 4);

    this.scanLine.geometry.setFromPoints([l, r]);
    this.scanLine.geometry.attributes.position.needsUpdate = true;

    if (satPosition) {
      const verts = new Float32Array([
        satPosition.x, satPosition.y, satPosition.z,
        l.x, l.y, l.z,
        r.x, r.y, r.z,
      ]);
      this.cone.geometry.dispose();
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(verts, 3));
      g.computeVertexNormals();
      this.cone.geometry = g;
    }
  }

  /**
   * Rebuild the covered-area ribbon from a GeoJSON Polygon feature.
   *
   * The ring arrives as [left edge forward..., right edge backward...], so
   * pairing index i with index (n-1-i) recovers the across-track rungs and
   * lets the ribbon be triangulated as a strip — no earcut needed, and it
   * follows the curvature of the globe correctly.
   */
  updateCovered(feature) {
    if (!feature?.geometry?.coordinates?.[0]) {
      this.ribbon.visible = false;
      this.edges.visible = false;
      return;
    }
    this.ribbon.visible = true;
    this.edges.visible = true;

    const ring = feature.geometry.coordinates[0];
    const closed = ring.length > 1 &&
      ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
    const pts = closed ? ring.slice(0, -1) : ring;
    const n = Math.floor(pts.length / 2);
    if (n < 2) { this.ribbon.visible = false; return; }

    const positions = [];
    const edgeSegs = [];
    let prevL = null;
    let prevR = null;

    for (let i = 0; i < n; i += 1) {
      const [lonL, latL] = pts[i];
      const [lonR, latR] = pts[pts.length - 1 - i];
      const L = llaToVec3(latL, lonL, 3);
      const R = llaToVec3(latR, lonR, 3);

      if (prevL && prevR) {
        positions.push(
          prevL.x, prevL.y, prevL.z, prevR.x, prevR.y, prevR.z, L.x, L.y, L.z,
          L.x, L.y, L.z, prevR.x, prevR.y, prevR.z, R.x, R.y, R.z,
        );
        edgeSegs.push(prevL.x, prevL.y, prevL.z, L.x, L.y, L.z);
        edgeSegs.push(prevR.x, prevR.y, prevR.z, R.x, R.y, R.z);
      }
      prevL = L;
      prevR = R;
    }

    this.ribbon.geometry.dispose();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.computeVertexNormals();
    this.ribbon.geometry = g;

    this.edges.geometry.dispose();
    const eg = new THREE.BufferGeometry();
    eg.setAttribute('position', new THREE.Float32BufferAttribute(edgeSegs, 3));
    this.edges.geometry = eg;
  }

  setTheme(theme, tSeconds = 0) {
    const on = theme.swathOpacity > 0;
    this.group.visible = on;
    if (!on) return;
    const sweep = 0.6 + 0.4 * Math.sin(tSeconds * Math.PI * 2 * theme.pulseHz);
    this.coneMaterial.opacity = theme.swathOpacity * 0.55 * sweep;
    this.ribbonMaterial.opacity = theme.swathOpacity * 0.8;
    this.edgeMaterial.opacity = theme.swathOpacity * 1.6 * sweep;
    this.scanLine.material.opacity = 0.5 + 0.5 * sweep;
    this.scanLine.material.transparent = true;
  }

  setWidthKm(widthKm) { this.halfWidth = km(widthKm / 2); }

  dispose() {
    this.group.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
  }
}

export default SwathLayer;
