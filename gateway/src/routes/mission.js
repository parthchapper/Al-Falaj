import { Router } from 'express';
import worker from '../lib/workerClient.js';
import { getState } from '../lib/stateCache.js';

/**
 * Mission control surface.
 *
 * The slider is the only control input in the whole system: every mode
 * change, every gauge, every map update is a consequence of moving it.
 */
export function missionRoutes(clock) {
  const r = Router();

  const resolveSlider = (req) =>
    req.query.slider != null ? Math.max(0, Math.min(1, Number(req.query.slider))) : clock.slider;

  r.get('/config', async (_req, res, next) => {
    try { res.json(await worker.config()); } catch (e) { next(e); }
  });

  r.get('/state', async (req, res, next) => {
    try {
      const slider = resolveSlider(req);
      const state = await getState(slider, {
        schedule: req.query.schedule !== 'false',
        track: req.query.track !== 'false',
      });
      res.json({ ...state, transport: clock.transport() });
    } catch (e) { next(e); }
  });

  r.get('/timeline', async (req, res, next) => {
    try { res.json(await worker.timeline(Number(req.query.samples) || 60)); } catch (e) { next(e); }
  });

  // --- control -------------------------------------------------------------
  r.post('/slider', async (req, res, next) => {
    try {
      const { slider } = req.body ?? {};
      if (typeof slider !== 'number' || Number.isNaN(slider)) {
        return res.status(400).json({ error: 'body must be { slider: number in [0,1] }' });
      }
      const s = clock.seek(slider);
      const state = await getState(s);
      res.json({ slider: s, mode: state.mode, transport: clock.transport() });
    } catch (e) { next(e); }
  });

  r.post('/mode', async (req, res, next) => {
    try {
      const mode = String(req.body?.mode ?? '').toUpperCase();
      const { slider } = await worker.mode(mode);
      clock.seek(slider);
      const state = await getState(slider);
      res.json({ mode: state.mode, slider, transport: clock.transport() });
    } catch (e) { next(e); }
  });

  r.post('/transport', (req, res) => {
    const { playing, rate, scrubbing } = req.body ?? {};
    if (playing !== undefined) clock.setPlaying(playing);
    if (rate !== undefined) clock.setRate(rate);
    if (scrubbing !== undefined) clock.scrub(scrubbing);
    res.json(clock.transport());
  });

  r.get('/transport', (_req, res) => res.json(clock.transport()));

  return r;
}

export default missionRoutes;
