/**
 * Mission score.
 *
 * Every sound is synthesised at runtime with the Web Audio API — additive
 * organ voices, filtered noise, and a convolution reverb whose impulse
 * response is generated in a loop rather than loaded. **Nothing ships as an
 * audio file**, which is what keeps the console a genuinely self-contained
 * static site: no assets to bundle, no CDN, nothing to 404 on a Pages
 * subpath. The headless check asserts the page requests no media at all.
 *
 * The palette is deliberately Zimmer-ish, because that language happens to
 * fit a spacecraft: a church organ (additive partials, not a sawtooth), a
 * minimalist arpeggio ostinato, enormous reverb, and a slow ticking pulse.
 *
 * The ticking is the part that earns its place. In *Interstellar* the tick is
 * time dilation made audible. This console already has a clock that dilates —
 * `clock.time_compression` runs at ~124x while the spacecraft coasts and
 * ~4.8x through the UAE overpass — so the tick is driven by exactly that
 * number. It is one tick per 60 seconds of *orbit* time, which means the
 * pulse audibly decelerates as the console slows into the pass. The score is
 * reading the same state vector as the gauges, not running on a timer of its
 * own, and the deceleration is the mission rather than an effect.
 */

// A minor, which is where the harmony sits. Frequencies in Hz.
const N = {
  A1: 55.00, C2: 65.41, D2: 73.42, E2: 82.41, G2: 98.00,
  A2: 110.00, C3: 130.81, D3: 146.83, E3: 164.81, G3: 196.00,
  A3: 220.00, B3: 246.94, C4: 261.63, D4: 293.66, E4: 329.63, G4: 392.00,
  A4: 440.00, C5: 523.25, E5: 659.26,
};

/**
 * One voicing per operating mode.
 *
 * `pad` is the sustained organ chord, `arp` the ostinato cell, `step` its
 * note length in seconds, `bright` the pad's filter cutoff. The progression
 * is deliberately simple and diatonic — it has to survive being looped for
 * an hour behind someone talking over it.
 */
const VOICING = {
  ECLIPSE: {
    pad: [N.A1, N.E2, N.C3],
    arp: [N.A2, N.E3, N.C3, N.E3],
    step: 0.62,
    bright: 520,
    padGain: 0.30,
    arpGain: 0.11,
    label: 'A minor · low, sparse',
  },
  SUN_FACING: {
    pad: [N.A1, N.E2, N.C3, N.G3],
    arp: [N.A2, N.C3, N.E3, N.G3, N.E3, N.C3],
    step: 0.42,
    bright: 1150,
    padGain: 0.27,
    arpGain: 0.15,
    label: 'A minor 7 · rising',
  },
  ACTIVE: {
    pad: [N.A2, N.E3, N.A3, N.C4, N.E4],
    arp: [N.A3, N.C4, N.E4, N.A4, N.E4, N.C4, N.E4, N.A4],
    step: 0.25,
    bright: 2600,
    padGain: 0.32,
    arpGain: 0.19,
    label: 'A minor add9 · driving',
  },
};

// Pipe-organ principal stop: fundamental plus octave, twelfth, fifteenth and
// two faint upper partials. This is what makes it read as an organ rather
// than as a synth pad — a sawtooth has every harmonic, an organ has these.
const PARTIALS = [
  { mul: 1, gain: 1.00 },
  { mul: 2, gain: 0.46 },
  { mul: 3, gain: 0.26 },
  { mul: 4, gain: 0.18 },
  { mul: 6, gain: 0.08 },
  { mul: 8, gain: 0.05 },
];

const SCHED_AHEAD = 0.18;   // seconds of notes queued in advance
const SCHED_TICK = 30;      // ms between scheduler wake-ups

export class MissionAudio {
  constructor({ button, enabled = true } = {}) {
    this.button = button ?? null;
    this.ctx = null;
    this.ready = false;
    this.unlocked = false;
    this.enabled = enabled;
    this.mode = null;
    this.slow = 0;
    this.compression = 60;
    this.lastAlertAt = 0;
    this.lastBlipAt = 0;
    this.arpStep = 0;
    this.nextNoteAt = 0;
    this.nextTickAt = 0;
    this.padVoices = [];

    // Respect the accessibility signal. Someone who has asked their OS for
    // less motion has usually asked for less of everything.
    this.reduced = typeof matchMedia === 'function'
      && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (this.reduced) this.enabled = false;

    this._paint();
  }

  // -------------------------------------------------------------------------
  // Graph
  // -------------------------------------------------------------------------
  init() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext ?? window.webkitAudioContext;
    if (!AC) return null;
    const ctx = new AC();
    this.ctx = ctx;

    // --- master ------------------------------------------------------------
    const master = ctx.createGain();
    master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 26;
    comp.ratio.value = 10;
    comp.attack.value = 0.004;
    comp.release.value = 0.3;
    master.connect(comp).connect(ctx.destination);
    this.master = master;

    // --- cathedral -----------------------------------------------------------
    // A convolver with a procedurally generated impulse response. This single
    // node is most of what separates "synth pad" from "organ in a large stone
    // room" — the tail is 4.2 s, which is roughly a real cathedral.
    const conv = ctx.createConvolver();
    conv.buffer = this._impulse(4.2, 2.6);
    const wet = ctx.createGain();
    wet.gain.value = 0.9;
    // Roll the top off the tail so the reverb sits behind the dry signal
    // instead of hissing over it.
    const wetLP = ctx.createBiquadFilter();
    wetLP.type = 'lowpass';
    wetLP.frequency.value = 3400;
    conv.connect(wetLP).connect(wet).connect(master);
    this.reverbIn = conv;

    const dry = ctx.createGain();
    dry.gain.value = 1;
    dry.connect(master);
    this.dry = dry;

    // Two sends, so a tick can be dry and a pad can be drenched.
    this.sendFar = ctx.createGain();   // heavy reverb
    this.sendFar.gain.value = 0.85;
    this.sendFar.connect(conv);
    this.sendNear = ctx.createGain();  // a touch of space
    this.sendNear.gain.value = 0.22;
    this.sendNear.connect(conv);

    // --- sustained organ pad -------------------------------------------------
    const padBus = ctx.createGain();
    padBus.gain.value = 0;
    const padLP = ctx.createBiquadFilter();
    padLP.type = 'lowpass';
    padLP.frequency.value = 600;
    padLP.Q.value = 0.7;
    padBus.connect(padLP);
    padLP.connect(dry);
    padLP.connect(this.sendFar);
    this.padBus = padBus;
    this.padLP = padLP;

    // Slow tremulant — the organ stop that makes a held chord breathe.
    const trem = ctx.createOscillator();
    const tremDepth = ctx.createGain();
    trem.frequency.value = 0.19;
    tremDepth.gain.value = 0.055;
    trem.connect(tremDepth).connect(padBus.gain);
    trem.start();
    this.trem = trem;

    // --- arpeggio + percussion buses ----------------------------------------
    this.arpBus = ctx.createGain();
    this.arpBus.gain.value = 0.0;
    this.arpBus.connect(dry);
    this.arpBus.connect(this.sendFar);

    this.tickBus = ctx.createGain();
    this.tickBus.gain.value = 0.9;
    this.tickBus.connect(dry);
    this.tickBus.connect(this.sendNear);

    this.fxBus = ctx.createGain();
    this.fxBus.gain.value = 1;
    this.fxBus.connect(dry);
    this.fxBus.connect(this.sendNear);

    // --- sub: the floor under everything ------------------------------------
    const sub = ctx.createOscillator();
    const subGain = ctx.createGain();
    sub.type = 'sine';
    sub.frequency.value = N.A1;
    subGain.gain.value = 0;
    sub.connect(subGain).connect(dry);
    sub.start();
    this.sub = sub;
    this.subGain = subGain;

    this.ready = true;
    this._paint();
    return ctx;
  }

  /**
   * Generated impulse response: exponentially decaying noise, decorrelated
   * between channels so the tail is wide rather than centred.
   */
  _impulse(seconds, decay) {
    const rate = this.ctx.sampleRate;
    const n = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, n, rate);
    let x = 0x9e3779b9;
    const rnd = () => {
      x ^= x << 13; x >>>= 0;
      x ^= x >> 17;
      x ^= x << 5; x >>>= 0;
      return x / 0xffffffff;
    };
    for (let ch = 0; ch < 2; ch += 1) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < n; i += 1) {
        // A short build before the decay reads as a room rather than a gate.
        const early = Math.min(1, i / (rate * 0.012));
        d[i] = (rnd() * 2 - 1) * early * (1 - i / n) ** decay;
      }
    }
    return buf;
  }

  _noiseBuffer(seconds) {
    const n = Math.max(64, Math.floor(this.ctx.sampleRate * seconds));
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
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
  // Lifecycle
  // -------------------------------------------------------------------------
  /** Call from a real user gesture. Returns true once audio is running. */
  async unlock() {
    if (this.reduced) return false;
    this.init();
    if (!this.ctx) return false;
    if (this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch { return false; }
    }
    this.unlocked = true;
    this._applyMaster();
    this._startScheduler();
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
    const target = this.enabled && this.unlocked ? 0.9 : 0;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(target, t, 0.6);
  }

  _paint() {
    if (!this.button) return;
    const on = this.enabled && this.unlocked;
    const armed = this.enabled && !this.unlocked;
    this.button.classList.toggle('on', on);
    this.button.classList.toggle('armed', armed);
    this.button.textContent = this.reduced ? 'SCORE OFF'
      : (on ? 'SCORE ON' : (armed ? 'SCORE ARMED' : 'SCORE OFF'));
    this.button.setAttribute('aria-pressed', String(on));
    this.button.title = this.reduced
      ? 'Muted: your system is set to reduced motion.'
      : (armed ? 'The score is armed — click anywhere to start it.'
        : (on ? 'Mute the mission score' : 'Unmute the mission score'));
  }

  // -------------------------------------------------------------------------
  // Voices
  // -------------------------------------------------------------------------
  /** One additive organ note. Returns its oscillators so a pad can hold them. */
  _organ(freq, { at, dur, gain, dest, detune = 5, partials = PARTIALS }) {
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(dest);

    const oscs = [];
    for (const p of partials) {
      for (const d of [-detune, detune]) {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = freq * p.mul;
        o.detune.value = d;
        const g = ctx.createGain();
        g.gain.value = (p.gain * gain) / 2;
        o.connect(g).connect(out);
        o.start(at);
        if (dur != null) o.stop(at + dur + 0.6);
        oscs.push(o);
      }
    }

    if (dur == null) {
      // Sustained: the caller controls the envelope.
      out.gain.setValueAtTime(0.0001, at);
      out.gain.exponentialRampToValueAtTime(1, at + 1.6);
    } else {
      // Plucked organ: fast attack, long-ish release into the reverb.
      out.gain.setValueAtTime(0.0001, at);
      out.gain.exponentialRampToValueAtTime(1, at + 0.028);
      out.gain.exponentialRampToValueAtTime(0.28, at + dur * 0.55);
      out.gain.exponentialRampToValueAtTime(0.0001, at + dur + 0.5);
    }
    return { out, oscs };
  }

  /** Rebuild the sustained chord for a mode, crossfading from the old one. */
  _setChord(v, when) {
    const ctx = this.ctx;
    // Release whatever is currently held.
    for (const voice of this.padVoices) {
      voice.out.gain.cancelScheduledValues(when);
      voice.out.gain.setValueAtTime(Math.max(0.0001, voice.out.gain.value), when);
      voice.out.gain.exponentialRampToValueAtTime(0.0001, when + 2.2);
      for (const o of voice.oscs) o.stop(when + 2.6);
    }
    this.padVoices = v.pad.map((f) => this._organ(f, {
      at: when, dur: null, gain: 0.8 / v.pad.length, dest: this.padBus, detune: 6,
    }));
    this.padBus.gain.setTargetAtTime(v.padGain, when, 1.4);
    this.padLP.frequency.setTargetAtTime(v.bright, when, 1.6);
    this.subGain.gain.setTargetAtTime(0.16, when, 1.8);
  }

  // -------------------------------------------------------------------------
  // Scheduler
  // -------------------------------------------------------------------------
  /**
   * Lookahead scheduler.
   *
   * Notes are queued against `ctx.currentTime` a fraction of a second ahead
   * rather than fired from a timer, because `setInterval` drifts and a
   * drifting ostinato is immediately audible. The timer only decides *what*
   * to queue; the audio clock decides when it sounds.
   */
  _startScheduler() {
    if (this._timer) return;
    this.nextNoteAt = this.ctx.currentTime + 0.1;
    this.nextTickAt = this.ctx.currentTime + 0.1;
    this._timer = setInterval(() => this._schedule(), SCHED_TICK);
  }

  _schedule() {
    if (!this.audible) return;
    const ctx = this.ctx;
    const horizon = ctx.currentTime + SCHED_AHEAD;
    const v = VOICING[this.mode] ?? VOICING.SUN_FACING;

    // --- ostinato ----------------------------------------------------------
    while (this.nextNoteAt < horizon) {
      const at = Math.max(this.nextNoteAt, ctx.currentTime + 0.01);
      const note = v.arp[this.arpStep % v.arp.length];
      // Lift the accent on the first note of each cell so the cell has shape.
      const accent = (this.arpStep % v.arp.length) === 0 ? 1.5 : 1;
      this._organ(note, {
        at,
        dur: v.step * 1.9,
        gain: v.arpGain * accent,
        dest: this.arpBus,
        detune: 3,
        partials: PARTIALS.slice(0, 4),
      });
      this.arpStep += 1;
      this.nextNoteAt += v.step;
    }
    this.arpBus.gain.setTargetAtTime(1, ctx.currentTime, 0.4);

    // --- the tick ----------------------------------------------------------
    // One tick per 60 seconds of orbit time. The clock runs at ~124x while
    // coasting and ~4.8x over the UAE, so the pulse decelerates into the
    // pass — the console's own time dilation, made audible.
    const interval = Math.min(2.6, Math.max(0.4, 60 / Math.max(1, this.compression)));
    while (this.nextTickAt < horizon) {
      this._tick(Math.max(this.nextTickAt, ctx.currentTime + 0.01));
      this.nextTickAt += interval;
    }
  }

  _tick(at) {
    const ctx = this.ctx;
    // Low body.
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(96, at);
    o.frequency.exponentialRampToValueAtTime(46, at + 0.13);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.34 + 0.24 * this.slow, at + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.3);
    o.connect(g).connect(this.tickBus);
    o.start(at);
    o.stop(at + 0.36);

    // Wooden click on top so it reads as a mechanism, not a kick drum.
    const s = ctx.createBufferSource();
    s.buffer = this._noiseBuffer(0.06);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1900;
    f.Q.value = 2.4;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.0001, at);
    cg.gain.exponentialRampToValueAtTime(0.10, at + 0.003);
    cg.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
    s.connect(f).connect(cg).connect(this.tickBus);
    s.start(at);
    s.stop(at + 0.07);
  }

  // -------------------------------------------------------------------------
  // Following the mission
  // -------------------------------------------------------------------------
  follow(state) {
    if (!this.audible) return;
    const t = this.ctx.currentTime;
    const mode = state.mode.id;

    if (mode !== this.mode) {
      this.mode = mode;
      this._setChord(VOICING[mode] ?? VOICING.SUN_FACING, t);
      // Re-align the ostinato so a mode change lands on beat one of the cell.
      this.arpStep = 0;
      this.nextNoteAt = Math.max(this.nextNoteAt, t + 0.05);
    }

    this.compression = state.clock.time_compression;

    // 0 while coasting, 1 at the heart of the pass — the console's own number,
    // log-scaled because the clock rate is.
    const b = state.clock.compression_bounds;
    this.slow = b && b.max > b.min
      ? Math.max(0, Math.min(1,
        1 - Math.log(this.compression / b.min) / Math.log(b.max / b.min)))
      : 0;

    // The room opens up as the spacecraft closes on the target.
    this.padLP.frequency.setTargetAtTime(
      (VOICING[mode] ?? VOICING.SUN_FACING).bright * (1 + 1.1 * this.slow), t, 0.9,
    );
    this.subGain.gain.setTargetAtTime(0.14 + 0.12 * this.slow, t, 1.2);
  }

  // -------------------------------------------------------------------------
  // One-shots
  // -------------------------------------------------------------------------
  _tone({ freq, to, type = 'sine', peak = 0.25, attack = 0.005, decay = 0.25,
    delay = 0, dest = null }) {
    if (!this.audible) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + attack + decay);
    o.connect(g).connect(dest ?? this.fxBus);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    o.start(t);
    o.stop(t + attack + decay + 0.08);
  }

  _burst({ centre = 900, q = 1, peak = 0.3, attack = 0.004, decay = 0.3,
    delay = 0, dest = null }) {
    if (!this.audible) return;
    const t = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer(Math.max(0.35, attack + decay + 0.1));
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(centre, t);
    f.Q.value = q;
    const g = this.ctx.createGain();
    src.connect(f).connect(g).connect(dest ?? this.fxBus);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    src.start(t);
    src.stop(t + attack + decay + 0.1);
  }

  /**
   * Shutter open — the loudest moment in the loop, once per orbit.
   * A full organ chord swelling over a sub drop, straight into the cathedral.
   */
  shutter() {
    if (!this.audible) return;
    const t = this.ctx.currentTime;
    for (const [i, f] of [N.A2, N.E3, N.A3, N.C4, N.E4].entries()) {
      this._organ(f, {
        at: t + i * 0.035, dur: 2.6, gain: 0.16,
        dest: this.arpBus, detune: 7,
      });
    }
    this._tone({ freq: 150, to: 38, peak: 0.6, attack: 0.008, decay: 1.1 });
    this._burst({ centre: 2400, q: 0.6, peak: 0.2, attack: 0.003, decay: 0.55 });
  }

  /** Mode change other than the pass — a short confirming cadence. */
  modeChange(to) {
    if (!this.audible) return;
    if (to === 'ACTIVE') { this.shutter(); return; }
    const t = this.ctx.currentTime;
    const chord = to === 'SUN_FACING' ? [N.A2, N.E3, N.G3] : [N.A1, N.E2, N.C3];
    for (const [i, f] of chord.entries()) {
      this._organ(f, {
        at: t + i * 0.05, dur: 1.5, gain: 0.13, dest: this.arpBus, detune: 6,
      });
    }
  }

  /** Acquisition of signal — a rising fifth, in key. */
  aos() {
    this._tone({ freq: N.E4, peak: 0.1, attack: 0.006, decay: 0.2, type: 'triangle' });
    this._tone({ freq: N.A4, peak: 0.1, attack: 0.006, decay: 0.34, type: 'triangle', delay: 0.11 });
  }

  /** Loss of signal — the same figure, inverted. */
  los() {
    this._tone({ freq: N.A4, peak: 0.085, attack: 0.006, decay: 0.2, type: 'triangle' });
    this._tone({ freq: N.E4, peak: 0.085, attack: 0.006, decay: 0.4, type: 'triangle', delay: 0.11 });
  }

  /**
   * Telemetry tick. Pitched to notes of the chord rather than to an arbitrary
   * frequency, so a burst of downlink lines reads as part of the texture
   * instead of bleeping over it.
   */
  blip() {
    const now = performance.now();
    if (now - this.lastBlipAt < 140) return;
    this.lastBlipAt = now;
    const scale = [N.A4, N.C5, N.E5];
    const f = scale[Math.floor(now / 140) % scale.length];
    this._tone({ freq: f, type: 'sine', peak: 0.022, attack: 0.002, decay: 0.16 });
  }

  /** Alert tone, pitched by severity. Rate-limited to one per 3 s. */
  alert(level) {
    const now = performance.now();
    if (now - this.lastAlertAt < 3000) return;
    this.lastAlertAt = now;
    if (level === 'CRITICAL') {
      this._tone({ freq: N.D4, type: 'triangle', peak: 0.17, attack: 0.008, decay: 0.4 });
      this._tone({ freq: N.B3, type: 'triangle', peak: 0.17, attack: 0.008, decay: 0.6, delay: 0.26 });
    } else {
      this._tone({ freq: N.C4, type: 'triangle', peak: 0.11, attack: 0.008, decay: 0.45 });
    }
  }

  /** UI feedback: a dry tick, deliberately unmusical and very short. */
  click() {
    this._burst({ centre: 2600, q: 5, peak: 0.07, attack: 0.001, decay: 0.03,
      dest: this.dry });
  }

  /** Scrubbing the timeline — quieter still, heavily rate-limited. */
  scrub() {
    const now = performance.now();
    if (now - this.lastBlipAt < 60) return;
    this.lastBlipAt = now;
    this._burst({ centre: 1700, q: 6, peak: 0.03, attack: 0.001, decay: 0.02,
      dest: this.dry });
  }

  /** The opening hit, played when the viewer starts the mission. */
  launch() {
    if (!this.audible) return;
    const t = this.ctx.currentTime;
    for (const [i, f] of [N.A1, N.A2, N.E3, N.A3].entries()) {
      this._organ(f, {
        at: t + i * 0.09, dur: 3.4, gain: 0.2, dest: this.arpBus, detune: 8,
      });
    }
    this._tone({ freq: 120, to: 34, peak: 0.55, attack: 0.02, decay: 2.0 });
  }
}
