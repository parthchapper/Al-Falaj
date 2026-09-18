import * as THREE from 'three';

/**
 * Coordinate conversions.
 *
 * Scene units: 1 unit = 1 Earth radius. Keeping the globe unit-radius means
 * altitudes, swath widths and camera distances are all directly comparable
 * without a scale factor floating around the codebase.
 */
export const R_EARTH_KM = 6378.137;
export const EARTH_RADIUS = 1;

const DEG = Math.PI / 180;

/** Geodetic lat/lon (degrees) + altitude (km) -> scene position. */
export function llaToVec3(lat, lon, altKm = 0, target = new THREE.Vector3()) {
  const r = EARTH_RADIUS + altKm / R_EARTH_KM;
  const phi = (90 - lat) * DEG;
  const theta = (lon + 180) * DEG;
  return target.set(
    -r * Math.sin(phi) * Math.cos(theta),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(theta),
  );
}

/** Inverse of llaToVec3, for picking. */
export function vec3ToLatLon(v) {
  const r = v.length() || 1;
  const lat = 90 - Math.acos(v.y / r) / DEG;
  const lon = ((Math.atan2(v.z, -v.x) / DEG) - 180 + 540) % 360 - 180;
  return { lat, lon, alt_km: (r - EARTH_RADIUS) * R_EARTH_KM };
}

/** Kilometres expressed in scene units. */
export const km = (d) => d / R_EARTH_KM;

/**
 * Densify a lat/lon polyline and lift it slightly off the surface so it does
 * not z-fight with the globe. Splits the line where it crosses the
 * antimeridian, which is what stops ground tracks drawing a stripe across
 * the whole planet.
 */
export function polylineToSegments(points, altKm = 12, maxJumpDeg = 170) {
  const segments = [];
  let current = [];
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i];
    if (i > 0 && Math.abs(p.lon - points[i - 1].lon) > maxJumpDeg) {
      if (current.length > 1) segments.push(current);
      current = [];
    }
    current.push(llaToVec3(p.lat, p.lon, altKm));
  }
  if (current.length > 1) segments.push(current);
  return segments;
}

/** Great-circle interpolation between two surface points. */
export function slerpSurface(a, b, t, altKm = 0) {
  const va = llaToVec3(a.lat, a.lon, 0).normalize();
  const vb = llaToVec3(b.lat, b.lon, 0).normalize();
  const out = va.clone().lerp(vb, t).normalize();
  return out.multiplyScalar(EARTH_RADIUS + altKm / R_EARTH_KM);
}

export default { llaToVec3, vec3ToLatLon, km, polylineToSegments, slerpSurface };
