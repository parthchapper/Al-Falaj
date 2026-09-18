import * as THREE from 'three';
import { PALETTE, sampleRamp } from '../palette.js';
import { km, llaToVec3 } from '../coords.js';

const KIND_STYLE = {
  DESALINATION: { color: PALETTE.amber, radius: km(110) },
  GROUND_STATION: { color: PALETTE.cyan, radius: km(90) },
  AOI: { color: PALETTE.amber, radius: km(140) },
};

/**
 * Surface markers: desalination plants, ground stations, and the AOI box.
 *
 * Plant markers are data-bound — their colour tracks the bloom risk the
 * scheduler computed, so the globe and the prediction panel can never tell
 * the investor two different stories.
 */
export class MarkerLayer {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'markers';
    this.byId = new Map();
    this.aoiGroup = new THREE.Group();
    this.group.add(this.aoiGroup);
  }

  setMarkers(markers = []) {
    for (const [, m] of this.byId) this.group.remove(m.node);
    this.byId.clear();

    for (const m of markers) {
      const style = KIND_STYLE[m.kind] ?? KIND_STYLE.GROUND_STATION;
      const node = new THREE.Group();
      node.name = `marker-${m.id}`;

      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(style.radius * 0.45, 12, 10),
        new THREE.MeshBasicMaterial({ color: style.color }),
      );
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(style.radius, style.radius * 1.45, 28),
        new THREE.MeshBasicMaterial({
          color: style.color, transparent: true, opacity: 0.7,
          side: THREE.DoubleSide, depthWrite: false,
        }),
      );
      ring.lookAt(llaToVec3(m.lat, m.lon, 0).multiplyScalar(2));

      // Vertical stalk so a plant reads at a glance from an oblique camera.
      const stalk = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          llaToVec3(m.lat, m.lon, 4), llaToVec3(m.lat, m.lon, 320),
        ]),
        new THREE.LineBasicMaterial({ color: style.color, transparent: true, opacity: 0.55 }),
      );

      const p = llaToVec3(m.lat, m.lon, 10);
      dot.position.copy(p);
      ring.position.copy(p);
      node.add(dot, ring, stalk);

      this.group.add(node);
      this.byId.set(m.id, { node, dot, ring, stalk, meta: m });
    }
    return this;
  }

  /** Recolour plant markers from the scheduler's risk values. */
  applyWaterQuality(plants = []) {
    for (const p of plants) {
      const entry = this.byId.get(p.plant_id);
      if (!entry) continue;
      const c = new THREE.Color(sampleRamp(p.risk ?? p.bloom_index ?? 0));
      entry.dot.material.color.copy(c);
      entry.ring.material.color.copy(c);
      entry.stalk.material.color.copy(c);
      entry.risk = p.risk ?? p.bloom_index ?? 0;
    }
  }

  /** AOI bounding box, drawn as a closed surface-hugging outline. */
  setAOI(bbox) {
    this.aoiGroup.clear();
    if (!bbox) return;
    const [w, s, e, n] = bbox;
    const pts = [];
    const step = 0.5;
    for (let lon = w; lon <= e; lon += step) pts.push([lon, s]);
    for (let lat = s; lat <= n; lat += step) pts.push([e, lat]);
    for (let lon = e; lon >= w; lon -= step) pts.push([lon, n]);
    for (let lat = n; lat >= s; lat -= step) pts.push([w, lat]);
    pts.push([w, s]);

    const geo = new THREE.BufferGeometry().setFromPoints(
      pts.map(([lon, lat]) => llaToVec3(lat, lon, 18)),
    );
    this.aoiOutline = new THREE.Line(
      geo,
      new THREE.LineBasicMaterial({ color: PALETTE.amber, transparent: true, opacity: 0.8 }),
    );
    this.aoiOutline.name = 'aoi-outline';
    this.aoiGroup.add(this.aoiOutline);
  }

  /** Markers keep a constant apparent size as the camera moves. */
  setScreenScale(cameraDistance) {
    const s = Math.max(0.3, Math.min(1.6, cameraDistance / 3.1));
    for (const [, m] of this.byId) {
      m.dot.scale.setScalar(s);
      m.ring.scale.setScalar(s * (m.ringPulse ?? 1));
    }
  }

  setTheme(theme, tSeconds = 0) {
    const pulse = 0.5 + 0.5 * Math.sin(tSeconds * Math.PI * 2 * theme.pulseHz * 0.5);
    for (const [, m] of this.byId) {
      m.ring.material.opacity = (0.25 + 0.5 * pulse) * theme.exposure;
      m.stalk.material.opacity = 0.2 + 0.5 * theme.exposure;
      m.ringPulse = 1 + 0.25 * pulse;
    }
    if (this.aoiOutline) {
      this.aoiOutline.material.opacity = (0.3 + 0.55 * pulse) * theme.exposure;
    }
  }

  dispose() {
    this.group.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
  }
}

export default MarkerLayer;
