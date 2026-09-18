import * as THREE from 'three';
import { PALETTE } from '../palette.js';
import { EARTH_RADIUS, km, llaToVec3, polylineToSegments } from '../coords.js';

/**
 * The spacecraft, its orbit path, and the nadir line that ties it to the
 * point it is looking at. Deliberately schematic: a recognisable 6U body
 * with two wings reads better at globe scale than an accurate model.
 */
export class SatelliteLayer {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'satellite-layer';
    this._pos = new THREE.Vector3();
    this._pulseScale = 1;
    this._up = new THREE.Vector3();
    this.build();
  }

  build() {
    this.craft = new THREE.Group();
    this.craft.name = 'spacecraft';

    const bodyMat = new THREE.MeshBasicMaterial({ color: PALETTE.white });
    const body = new THREE.Mesh(new THREE.BoxGeometry(km(170), km(110), km(110)), bodyMat);
    this.craft.add(body);

    const wingMat = new THREE.MeshBasicMaterial({
      color: PALETTE.amber, transparent: true, opacity: 0.85, side: THREE.DoubleSide,
    });
    for (const sign of [-1, 1]) {
      const wing = new THREE.Mesh(new THREE.PlaneGeometry(km(340), km(140)), wingMat);
      wing.position.x = sign * km(260);
      this.craft.add(wing);
    }

    // Halo so the craft stays visible against the limb at any zoom.
    this.halo = new THREE.Mesh(
      new THREE.SphereGeometry(km(190), 16, 12),
      new THREE.MeshBasicMaterial({
        color: PALETTE.cyan, transparent: true, opacity: 0.16,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    this.craft.add(this.halo);
    this.group.add(this.craft);

    // Nadir / boresight line from spacecraft to the surface.
    this.boresight = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineBasicMaterial({ color: PALETTE.amber, transparent: true, opacity: 0.7 }),
    );
    this.boresight.name = 'boresight';
    this.group.add(this.boresight);

    // Sub-satellite marker on the surface.
    this.nadirMarker = new THREE.Mesh(
      new THREE.RingGeometry(km(70), km(120), 32),
      new THREE.MeshBasicMaterial({
        color: PALETTE.amber, transparent: true, opacity: 0.9,
        side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    this.nadirMarker.name = 'nadir-marker';
    this.group.add(this.nadirMarker);

    this.trackGroup = new THREE.Group();
    this.trackGroup.name = 'ground-track';
    this.group.add(this.trackGroup);

    this.aheadGroup = new THREE.Group();
    this.aheadGroup.name = 'track-ahead';
    this.group.add(this.aheadGroup);
  }

  /** Full-orbit ground track. Set once at bootstrap. */
  setGroundTrack(points) {
    this.trackGroup.clear();
    const mat = new THREE.LineBasicMaterial({
      color: PALETTE.cyan, transparent: true, opacity: 0.45,
    });
    for (const seg of polylineToSegments(points, 10)) {
      this.trackGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(seg), mat));
    }
    this.trackMaterial = mat;
  }

  /** The next ~45 s of track, drawn brighter as a lead indicator. */
  setTrackAhead(points) {
    this.aheadGroup.clear();
    const mat = new THREE.LineBasicMaterial({
      color: PALETTE.amber, transparent: true, opacity: 0.9,
    });
    for (const seg of polylineToSegments(points, 16)) {
      this.aheadGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(seg), mat));
    }
  }

  /** Move the craft. `lerp` < 1 smooths between telemetry frames. */
  update({ lat, lon, alt_km: altKm }, lerp = 1) {
    llaToVec3(lat, lon, altKm, this._pos);
    if (lerp >= 1 || this.craft.position.lengthSq() === 0) {
      this.craft.position.copy(this._pos);
    } else {
      this.craft.position.lerp(this._pos, lerp);
    }

    // Keep the body nadir-pointing: +Y of the mesh away from Earth centre.
    this._up.copy(this.craft.position).normalize();
    this.craft.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), this._up);

    const surface = llaToVec3(lat, lon, 2);
    this.boresight.geometry.setFromPoints([this.craft.position.clone(), surface]);
    this.boresight.geometry.attributes.position.needsUpdate = true;

    this.nadirMarker.position.copy(llaToVec3(lat, lon, 8));
    this.nadirMarker.lookAt(0, 0, 0);
  }

  setTheme(theme, tSeconds = 0) {
    const c = new THREE.Color(theme.satelliteColor);
    this.craft.children[0].material.color.copy(c);
    this.halo.material.opacity = 0.08 + 0.18 * theme.exposure;
    if (this.trackMaterial) this.trackMaterial.opacity = 0.18 + 0.5 * theme.trackOpacity;
    this.boresight.material.opacity = 0.2 + 0.6 * theme.exposure;

    // Nadir marker pulses at the mode's rate — the tactile "it's alive" cue.
    const pulse = 0.55 + 0.45 * Math.sin(tSeconds * Math.PI * 2 * theme.pulseHz);
    this.nadirMarker.material.opacity = 0.25 + 0.7 * pulse * theme.exposure;
    this._pulseScale = 1 + 0.35 * pulse;
  }

  /**
   * Keep the spacecraft a constant size on screen.
   *
   * A real 6U CubeSat is 30 cm across — at globe scale it is smaller than a
   * pixel, so the mesh is a symbol, not a model. Scaling it with camera
   * distance keeps it readable when zoomed out and stops it swallowing the
   * UAE when zoomed in.
   */
  setScreenScale(cameraDistance) {
    const s = Math.max(0.28, Math.min(1.8, cameraDistance / 3.1));
    this.craft.scale.setScalar(s);
    this.nadirMarker.scale.setScalar(this._pulseScale * s);
  }

  setVisible(v) { this.group.visible = v; }

  get position() { return this.craft.position; }

  dispose() {
    this.group.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
  }
}

export const EARTH_R = EARTH_RADIUS;
export default SatelliteLayer;
