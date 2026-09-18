import { Router } from 'express';
import worker from '../lib/workerClient.js';
import { getDesalination, getField, getSpectrum } from '../lib/stateCache.js';

/** Science products: spectroscopy, algae field, desalination scheduling. */
export function scienceRoutes(clock) {
  const r = Router();
  const slider = (req) =>
    req.query.slider != null ? Math.max(0, Math.min(1, Number(req.query.slider))) : clock.slider;

  r.get('/spectrum', async (req, res, next) => {
    try {
      res.json(await getSpectrum(slider(req), {
        lat: req.query.lat != null ? Number(req.query.lat) : undefined,
        lon: req.query.lon != null ? Number(req.query.lon) : undefined,
        bands: req.query.bands != null ? Number(req.query.bands) : 96,
      }));
    } catch (e) { next(e); }
  });

  r.get('/field', async (req, res, next) => {
    try {
      res.json(await getField(slider(req), Number(req.query.nx) || 48, Number(req.query.ny) || 24));
    } catch (e) { next(e); }
  });

  r.get('/water-quality', async (req, res, next) => {
    try { res.json(await worker.waterQuality(slider(req))); } catch (e) { next(e); }
  });

  r.get('/desalination', async (req, res, next) => {
    try { res.json(await getDesalination(slider(req))); } catch (e) { next(e); }
  });

  return r;
}

export default scienceRoutes;
