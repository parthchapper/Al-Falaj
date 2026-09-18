/**
 * Mission audio.
 *
 * Every sound here is synthesised at runtime with the Web Audio API —
 * oscillators, filtered noise and envelopes. Nothing is loaded from disk or
 * from a CDN, which is what keeps the console a genuinely self-contained
 * static site: no audio files in the bundle, no network calls, nothing to
 * 404 on a GitHub Pages subpath.
 *
 * The design follows the mission rather than decorating it. The drone is
 * pitched by operating mode, so the room can hear the spacecraft come out of
 * eclipse. The tension sweep is driven by the *time compression* — as the
 * clock slows into the overpass, the sweep rises, which means the audio is
 * reading the same state vector as the gauges rather than running on a timer
 * of its own.
 *
 * Browsers will not start audio without a user gesture, so the context is
 * created lazily and resumed on the first interaction. Until then the button
 * reads ARMED rather than ON — the console does not claim to be making a
 * sound it is not making.
 */

const MODE_VOICE = {
  //            root Hz  filter Hz  drone gain  shimmer
  ECLIPSE: { root: 41.2, cutoff: 190, gain: 0.34, shimmer: 0.0 },
  SUN_FACING: { root: 55.0, cutoff: 460, gain: 0.30, shimmer: 0.05 },
  ACTIVE: { root: 73.4, cutoff: 1050, gain: 0.34, shimmer: 0.14 },
};

export class MissionAudio {
  constructor({ button, enabled = true } = {}) {
    this.button = button ?? null;
    this.ctx = null;
    this.ready = false;
    this.enabled = enabled;
    this.mode = null;
    this.lastAlertAt = 0;
    this.lastBlipAt = 0;
    this.blipPhase = 0;

    // Respect the accessibility signal. Someone who has asked their OS for
    // less motion has usually asked for less of everything.
    this.reduced = typeof matchMedia === 'function'
      && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (this.reduced) this.enabled = false;

    this._paint();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------
  /** Build the graph. Safe to call repeatedly; only the first call does work. */
  init() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext ?? window.webkitAudioContext;
    if (!AC) return null;
    const ctx = new AC();
    this.ctx = ctx;

    // Master chain: everything meets a limiter so a stacked alert plus a
    // shutter hit cannot clip.
    const master = ctx.createGain();
    master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 24;
    comp.ratio.value = 12;
    comp.attack.value = 0.003;
    comp.release.value = 0.22;
    master.connect(comp).connect(ctx.destination);
    this.master = master;

    // --- the drone: two detuned saws and a sub sine through a lowpass ------
    const droneGain = ctx.createGain();
    droneGain.gain.value = 0;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 200;
    lp.Q.value = 6;
    droneGain.connect(lp).connect(master);

    const mkOsc = (type, detune) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = 41.2;
      o.detune.value = detune;
      o.connect(droneGain);
      o.start();
      return o;
    };
    this.droneA = mkOsc('sawtooth', -7);
    this.droneB = mkOsc('sawtooth', 8);
    this.droneSub = mkOsc('sine', 0);
    this.droneGain = droneGain;
    this.droneLP = lp;

    // --- shimmer: a high, quiet band of noise that opens up in ACTIVE ------
    const shimmer = ctx.createGain();
    shimmer.gain.value = 0;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 3200;
    bp.Q.value = 1.4;
    const noise = ctx.createBufferSource();
    noise.buffer = this._noiseBuffer(4);
    noise.loop = true;
    noise.connect(bp).connect(shimmer).connect(master);
    noise.start();
    this.shimmer = shimmer;

    // --- tension sweep: driven by the clock, not by a timer ----------------
    const sweepGain = ctx.createGain();
    sweepGain.gain.value = 0;
    const sweepFilter = ctx.createBiquadFilter();
    sweepFilter.type = 'bandpass';
    sweepFilter.frequency.value = 400;
    sweepFilter.Q.value = 3.5;
    const sweepNoise = ctx.createBufferSource();
    sweepNoise.buffer = this._noiseBuffer(4);
    sweepNoise.loop = true;
    sweepNoise.connect(sweepFilter).connect(sweepGain).connect(master);
    sweepNoise.start();
    this.sweepGain = sweepGain;
    this.sweepFilter = sweepFilter;

    this.ready = true;
    this._paint();
    return ctx;
  }

  /**
   * Call from a real user gesture. Resumes the context and fades in.
   * Returns true once audio is genuinely running.
   */
  async unlock() {
    if (this.reduced) return false;
    this.init();
    if (!this.ctx) return false;
    if (this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch { return false; }
    }
    this.unlocked = true;
    this._applyMaster();
    this._paint();
    return this.ctx.state === 'running';
  }

  toggle() {
    this.enabled = !this.enabled;
    if (this.enabled) this.unlock();
    else this._applyMaster();
    this._paint();
    return this.enabled;
  }

  get audible() {
    return Boolean(this.enabled && this.ready && this.unlocked
      && this.ctx?.state === 'running');
  }

  _applyMaster() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const target = this.enabled && this.unlocked ? 0.85 : 0;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(target, t, 0.25);
  }

  _paint() {
    if (!this.button) return;
    const on = this.enabled && this.unlocked;
    const armed = this.enabled && !this.unlocked;
    this.button.classList.toggle('on', on);
    this.button.classList.toggle('armed', armed);
    this.button.textContent = this.reduced ? 'AUDIO OFF'
      : (on ? 'AUDIO ON' : (armed ? 'AUDIO ARMED' : 'AUDIO OFF'));
    this.button.setAttribute('aria-pressed', String(on));
    this.button.title = this.reduced
      ? 'Muted: your system is set to reduced motion.'
      : (armed ? 'Audio is armed — click anywhere to start it.'
        : (on ? 'Mute mission audio' : 'Unmute mission audio'));
  }

  _noiseBuffer(seconds) {
    const n = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    // Deterministic noise — the console is deterministic everywhere else.
    let x = 0x2f6e2b1;
    for (let i = 0; i < n; i += 1) {
      x ^= x << 13; x >>>= 0;
      x ^= x >> 17;
      x ^= x << 5; x >>>= 0;
      d[i] = (x / 0xffffffff) * 2 - 1;
    }
    return buf;
  }

  // -------------------------------------------------------------------------
  // Continuous state
  // -------------------------------------------------------------------------
  /**
   * Follow the mission state.
   *
   * `compression` is the live clock rate. Mapping the sweep to it means the
   * sound tightens exactly as the timeline slows into the overpass, because
   * both are reading the same number.
   */
  follow(state) {
    if (!this.audible) return;
    const t = this.ctx.currentTime;
    const mode = state.mode.id;
    const v = MODE_VOICE[mode] ?? MODE_VOICE.SUN_FACING;

    if (mode !== this.mode) {
      this.droneA.frequency.setTargetAtTime(v.root, t, 0.7);
      this.droneB.frequency.setTargetAtTime(v.root * 1.5, t, 0.7);
      this.droneSub.frequency.setTargetAtTime(v.root / 2, t, 0.7);
      this.droneLP.frequency.setTargetAtTime(v.cutoff, t, 0.8);
      this.droneGain.gain.setTargetAtTime(v.gain, t, 0.6);
      this.shimmer.gain.setTargetAtTime(v.shimmer, t, 1.1);
      this.mode = mode;
    }

    // Normalised "how slow is the clock running" — 0 while coasting, 1 at the
    // heart of the pass. The console's own number, not a separate animation.
    const b = state.clock.compression_bounds;
    const c = state.clock.time_compression;
    const slow = b && b.max > b.min
      ? Math.max(0, Math.min(1, 1 - (Math.log(c / b.min) / Math.log(b.max / b.min))))
      : 0;

    this.sweepGain.gain.setTargetAtTime(0.16 * slow ** 1.6, t, 0.35);
    this.sweepFilter.frequency.setTargetAtTime(320 + 2600 * slow ** 2, t, 0.4);
  }

  // -------------------------------------------------------------------------
  // One-shots
  // -------------------------------------------------------------------------
  _env(node, peak, attack, decay, when) {
    const g = node.gain;
    g.setValueAtTime(0.0001, when);
    g.exponentialRampToValueAtTime(Math.max(0.0002, peak), when + attack);
    g.exponentialRampToValueAtTime(0.0001, when + attack + decay);
  }

  _tone({ freq, to, type = 'sine', peak = 0.25, attack = 0.005, decay = 0.25, delay = 0 }) {
    if (!this.audible) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + attack + decay);
    o.connect(g).connect(this.master);
    this._env(g, peak, attack, decay, t);
    o.start(t);
    o.stop(t + attack + decay + 0.06);
  }

  _burst({ centre = 900, q = 1, peak = 0.3, attack = 0.004, decay = 0.3, delay = 0 }) {
    if (!this.audible) return;
    const t = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer(Math.max(0.35, attack + decay + 0.1));
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(centre, t);
    f.Q.value = q;
    const g = this.ctx.createGain();
    src.connect(f).connect(g).connect(this.master);
    this._env(g, peak, attack, decay, t);
    src.start(t);
    src.stop(t + attack + decay + 0.08);
  }

  /** Shutter open — the loudest thing the console does, once per orbit. */
  shutter() {
    this._tone({ freq: 160, to: 38, type: 'sine', peak: 0.75, attack: 0.006, decay: 0.85 });
    this._burst({ centre: 2200, q: 0.7, peak: 0.34, attack: 0.002, decay: 0.42 });
    this._tone({ freq: 1760, to: 2640, type: 'triangle', peak: 0.16, attack: 0.004, decay: 0.5, delay: 0.02 });
    this._tone({ freq: 880, to: 1320, type: 'sine', peak: 0.12, attack: 0.01, decay: 0.7, delay: 0.06 });
  }

  /** Mode change other than the pass — a short confirming swell. */
  modeChange(to) {
    if (to === 'ACTIVE') { this.shutter(); return; }
    const up = to === 'SUN_FACING';
    this._tone({
      freq: up ? 220 : 180, to: up ? 330 : 110, type: 'triangle',
      peak: 0.22, attack: 0.02, decay: 0.55,
    });
    this._burst({ centre: up ? 1400 : 600, q: 1.2, peak: 0.12, attack: 0.02, decay: 0.45 });
  }

  /** Acquisition of signal — rising two-note chirp. */
  aos() {
    this._tone({ freq: 660, type: 'square', peak: 0.1, attack: 0.004, decay: 0.09 });
    this._tone({ freq: 990, type: 'square', peak: 0.1, attack: 0.004, decay: 0.13, delay: 0.1 });
  }

  /** Loss of signal — the same figure, inverted. */
  los() {
    this._tone({ freq: 880, type: 'square', peak: 0.09, attack: 0.004, decay: 0.09 });
    this._tone({ freq: 550, type: 'square', peak: 0.09, attack: 0.004, decay: 0.16, delay: 0.1 });
  }

  /** Telemetry tick. Rate-limited — the log can burst faster than the ear. */
  blip(n = 1) {
    const now = performance.now();
    if (now - this.lastBlipAt < 90) return;
    this.lastBlipAt = now;
    this.blipPhase = (this.blipPhase + 1) % 4;
    const base = [2400, 2800, 2200, 3100][this.blipPhase];
    this._tone({
      freq: base, type: 'square',
      peak: 0.028 * Math.min(2, n), attack: 0.001, decay: 0.035,
    });
  }

  /** Alert tone, pitched by severity. Rate-limited to one per 2.5 s. */
  alert(level) {
    const now = performance.now();
    if (now - this.lastAlertAt < 2500) return;
    this.lastAlertAt = now;
    if (level === 'CRITICAL') {
      this._tone({ freq: 740, type: 'square', peak: 0.2, attack: 0.005, decay: 0.16 });
      this._tone({ freq: 560, type: 'square', peak: 0.2, attack: 0.005, decay: 0.22, delay: 0.19 });
    } else {
      this._tone({ freq: 620, type: 'triangle', peak: 0.14, attack: 0.006, decay: 0.24 });
    }
  }

  /** UI feedback: a dry tick, deliberately unmusical. */
  click() { this._burst({ centre: 2600, q: 4, peak: 0.08, attack: 0.001, decay: 0.035 }); }

  /** Scrubbing the timeline — quieter still, and heavily rate-limited. */
  scrub() {
    const now = performance.now();
    if (now - this.lastBlipAt < 55) return;
    this.lastBlipAt = now;
    this._burst({ centre: 1700, q: 6, peak: 0.035, attack: 0.001, decay: 0.022 });
  }
}
