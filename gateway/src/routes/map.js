import { Router } from 'express';
import worker from '../lib/workerClient.js';
import { getMapGeometry, getState } from '../lib/stateCache.js';

/**
 * Geometry feed for the 3D globe.
 *
 * Everything here is renderer-agnostic: lat/lon, GeoJSON rings and
 * ECEF-ready polylines. The three.js module in /map3d consumes it, but so
 * could Cesium, Mapbox, deck.gl or a flat SVG.
 */
export function mapRoutes(clock) {
  const r = Router();
  const slider = (req) =>
    req.query.slider != null ? Math.max(0, Math.min(1, Number(req.query.slider))) : clock.slider;

  r.get('/geometry', async (req, res, next) => {
    try { res.json(await getMapGeometry(slider(req))); } catch (e) { next(e); }
  });

  r.get('/groundtrack', async (req, res, next) => {
    try { res.json(await worker.groundTrack(Number(req.query.samples) || 240)); } catch (e) { next(e); }
  });

  /** Everything the globe needs at boot, in one round trip. */
  r.get('/bootstrap', async (req, res, next) => {
    try {
      const s = slider(req);
      const [cfg, track, state] = await Promise.all([
        worker.config(),
        worker.groundTrack(360),
        getState(s, { schedule: false, track: true }),
      ]);
      res.json({
        aoi: cfg.aoi,
        markers: state.map.markers,
        ground_track: track.track,
        orbit: cfg.spacecraft.orbit,
        payload: cfg.spacecraft.payload,
        modes: cfg.timeline,
        initial: {
          slider: s,
          mode: state.mode.id,
          subsatellite: state.map.subsatellite,
          scan_line: state.map.scan_line,
        },
      });
    } catch (e) { next(e); }
  });

  /** GeoJSON FeatureCollection — drop straight into any mapping library. */
  r.get('/geojson', async (req, res, next) => {
    try {
      const s = slider(req);
      const g = await getMapGeometry(s);
      const features = [
        {
          type: 'Feature',
          properties: { id: 'GROUND_TRACK', kind: 'track' },
          geometry: { type: 'LineString', coordinates: g.ground_track.map((p) => [p.lon, p.lat]) },
        },
        {
          type: 'Feature',
          properties: { id: 'SCAN_LINE', kind: 'scan' },
          geometry: {
            type: 'LineString',
            coordinates: [
              [g.scan_line.left.lon, g.scan_line.left.lat],
              [g.scan_line.right.lon, g.scan_line.right.lat],
            ],
          },
        },
        {
          type: 'Feature',
          properties: { id: 'SUBSATELLITE', kind: 'satellite', alt_km: g.subsatellite.alt_km },
          geometry: { type: 'Point', coordinates: [g.subsatellite.lon, g.subsatellite.lat] },
        },
        ...g.markers.map((m) => ({
          type: 'Feature',
          properties: { id: m.id, name: m.name, kind: m.kind },
          geometry: { type: 'Point', coordinates: [m.lon, m.lat] },
        })),
      ];
      if (g.swath_covered) features.push(g.swath_covered);
      res.json({ type: 'FeatureCollection', features });
    } catch (e) { next(e); }
  });

  return r;
}

export default mapRoutes;
