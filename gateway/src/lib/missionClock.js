import { EventEmitter } from 'node:events';
import config from '../config.js';

/**
 * The mission clock.
 *
 * Owns exactly one number — the timeline slider position in [0, 1] — plus
 * whether it is advancing. Everything else in the system is derived from it,
 * which is why the slider can be scrubbed, snapped to a mode, paused and
 * resumed without any state ever going out of sync.
 *
 * Emits: 'tick' ({ slider, frame }), 'slider' (on any jump), 'transport'.
 */
export class MissionClock extends EventEmitter {
  constructor({
    loopDurationS = config.clock.loopDurationS,
    tickHz = config.clock.tickHz,
    rate = config.clock.defaultRate,
    playing = config.clock.autoplay,
  } = {}) {
    super();
    this.loopDurationS = loopDurationS;
    this.tickHz = tickHz;
    this.rate = rate;
    this.playing = playing;
    this.loopT = 0;
    this.frame = 0;
    this._timer = null;
    // A UI dragging the slider takes control; playback resumes on release.
    this._scrubbing = false;
  }

  get slider() {
    return Number((this.loopT / this.loopDurationS).toFixed(6));
  }

  start() {
    if (this._timer) return this;
    const intervalMs = 1000 / this.tickHz;
    this._timer = setInterval(() => this._tick(intervalMs / 1000), intervalMs);
    this._timer.unref?.();
    return this;
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    return this;
  }

  _tick(dtSeconds) {
    if (this.playing && !this._scrubbing) {
      this.loopT = (this.loopT + dtSeconds * this.rate) % this.loopDurationS;
    }
    this.frame += 1;
    this.emit('tick', { slider: this.slider, loopT: this.loopT, frame: this.frame });
  }

  /** Jump to an absolute slider position. */
  seek(slider) {
    const s = Math.max(0, Math.min(1, Number(slider)));
    this.loopT = s * this.loopDurationS;
    this.emit('slider', { slider: this.slider, source: 'seek' });
    return this.slider;
  }

  /** Begin/end an interactive drag: playback holds while the user scrubs. */
  scrub(active) {
    this._scrubbing = Boolean(active);
    this.emit('transport', this.transport());
    return this._scrubbing;
  }

  setPlaying(playing) {
    this.playing = Boolean(playing);
    this.emit('transport', this.transport());
    return this.playing;
  }

  setRate(rate) {
    this.rate = Math.max(0, Math.min(20, Number(rate) || 0));
    this.emit('transport', this.transport());
    return this.rate;
  }

  transport() {
    return {
      playing: this.playing,
      scrubbing: this._scrubbing,
      rate: this.rate,
      tickHz: this.tickHz,
      slider: this.slider,
      loopT: Number(this.loopT.toFixed(3)),
      loopDurationS: this.loopDurationS,
      frame: this.frame,
    };
  }
}

export default MissionClock;
