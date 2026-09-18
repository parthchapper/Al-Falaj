/**
 * AL-FALAJ SAT-1 — mission score.
 *
 * Drop-in replacement for site/ui/audio.js. Same class, same method names, so
 * nothing else in the console changes.
 *
 * Synthesised entirely at runtime with the Web Audio API — no audio files, no
 * CDN, nothing to 404 on a GitHub Pages subpath.
 *
 *
 * DESIGN BRIEF: cinematic, not anxious.
 * ------------------------------------
 * The obvious way to score a spacecraft is tension — fast ticking, rising
 * arpeggios, alarms. That reads as *panic*, and a console is something people
 * stand in front of for ten minutes, so it has to be livable. Everything here
 * is chosen against that:
 *
 *   - **Harmony moves slowly and never jumps.** One four-chord cycle, Am - F -
 *     C - G, ~15 seconds a chord, with real voice leading: each of the four
 *     pad voices moves by a tone or two, or holds. Chord changes crossfade
 *     over three seconds under a four-second reverb tail, so there is no
 *     attack transient to notice.
 *
 *   - **Operating mode changes timbre, not key.** ECLIPSE and ACTIVE are the
 *     same piece with the filter opened and the ostinato thinned or thickened.
 *     Re-pitching the whole bed on every mode change is what makes a score
 *     feel like a jump cut.
 *
 *   - **The pulse is a heartbeat, not a clock.** It still follows
 *     `clock.time_compression` — that link is the good idea, and it is the
 *     console's own number — but mapped onto a calm 1.15-3.8 s. Measured
 *     across the orbit it runs 1.15 s while coasting (~52 bpm, slower than a
 *     resting pulse), 2.97 s on the sunlit arc and 3.67 s through the
 *     overpass. You hear the clock dilate as things getting *slower*, which is
 *     the opposite of an alarm and truer to the source.
 *
 *   - **No noise bursts, no square waves, no slams.** Every voice is summed
 *     sine partials with a soft attack. Nothing in the score has a transient
 *     sharp enough to startle.
 *
 *   - **Level is capped and steady.** Pad gain is near-constant across modes,
 *     so nothing lurches; a gentle limiter sits on the master purely as a
 *     safety net rather than as a pumping effect.
 */

// ---------------------------------------------------------------------------
// Pitch
// ---------------------------------------------------------------------------
const F1 = 43.65, G1 = 49.00, A1 = 55.00, C2 = 65.41, F2 = 87.31;
const A2 = 110.00, B2 = 123.47, C3 = 130.81, D3 = 146.83, E3 = 164.81;
const G3 = 196.00, A3 = 220.00, B3 = 246.94;
const C4 = 261.63, D4 = 293.66, E4 = 329.63, F4 = 349.23, G4 = 392.00;
const A4 = 440.00, C5 = 523.25, E5 = 659.26;

/**
 * The cycle: i - VI - III - VII in A minor. Warm and open rather than dark,
 * and the standard harmonic shape of this kind of score.
 *
 * `pad` is four voices in fixed slots, voice-led so consecutive chords share
 * notes or move by a step:
 *
 *      slot      1     2     3     4
 *      Am       A2    E3    A3    C4
 *      F        F2    C3    A3    C4     <- two common tones
 *      C        C3    E3    G3    C4     <- one common tone
 *      G        B2    D3    G3    B3     <- one common tone
 *
 * `arp` stays inside the chord, so the ostinato can never land on a clash.
 */
const PROGRESSION = [
  { name: 'Am', bass: A1, pad: [A2, E3, A3, C4], arp: [A3, C4, E4, C4] },
  { name: 'F',  bass: F1, pad: [F2, C3, A3, C4], arp: [A3, C4, F4, C4] },
  { name: 'C',  bass: C2, pad: [C3, E3, G3, C4], arp: [G3, C4, E4, C4] },
  { name: 'G',  bass: G1, pad: [B2, D3, G3, B3], arp: [G3, B3, D4, B3] },
];

const CHORD_S = 15.0;     // how long each chord is held
const CROSSFADE_S = 3.0;  // how long the change takes

/**
 * Per-mode character. Note that `padGain` barely moves — a mode change should
 * open the room, not turn the volume up.
 */
const MODE = {
  ECLIPSE:    { cutoff: 380,  padGain: 0.26, arpGain: 0.000, arpStep: 1.50, air: 0.010 },
  SUN_FACING: { cutoff: 950,  padGain: 0.25, arpGain: 0.055, arpStep: 1.10, air: 0.016 },
  ACTIVE:     { cutoff: 1900, padGain: 0.26, arpGain: 0.075, arpStep: 0.55, air: 0.024 },
};

/**
 * Flute-ish organ partials: fundamental, octave, twelfth, fifteenth, rolling
 * off fast. A principal stop with all its upper work is bright and edgy; this
 * is the softer register, which is what makes it sit under a voice instead of
 * over it.
 */
const PARTIALS = [
  { mul: 1, gain: 1.00 },
  { mul: 2, gain: 0.34 },
  { mul: 3, gain: 0.13 },
  { mul: 4, gain: 0.07 },
];

const SCHED_AHEAD = 0.25;   // seconds of music queued in advance
const SCHED_TICK = 40;      // ms between scheduler wake-ups

export class MissionAudio {
  constructor({ button, enabled = true } = {}) {
    this.button = button ?? null;
    this.ctx = null;
    this.ready = false;
    this.unlocked = false;
    this.enabled = enabled;

    this.mode = null;
    this.compression = 60;     // read by the console's own checks
    this.slow = 0;             // 0 coasting, 1 at the heart of the pass
    this.chordIndex = 0;
    this.arpStep = 0;          // read by the console's own checks
    this.padVoices = [];       // read by the console's own checks

    this.nextChordAt = 0;
    this.nextNoteAt = 0;
    this.nextPulseAt = 0;
    this.lastAlertAt = 0;
    this.lastBlipAt = 0;

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

    // Master: a gentle limiter as a safety net. Soft knee, modest ratio and a
    // slow release, so it catches a stacked moment without audibly pumping.
    const master = ctx.createGain();
    master.gain.value = 0;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 30;
    limiter.ratio.value = 4;
    limiter.attack.value = 0.02;
    limiter.release.value = 0.5;
    master.connect(limiter).connect(ctx.destination);
    this.master = master;

    // Cathedral. The impulse response is generated in a loop, which is what
    // lets a "real room" ship without a single asset.
    const conv = ctx.createConvolver();
    conv.buffer = this._impulse(4.6, 2.4);
    const wetLP = ctx.createBiquadFilter();   // keep the tail dark, not hissy
    wetLP.type = 'lowpass';
    wetLP.frequency.value = 2600;
    const wet = ctx.createGain();
    wet.gain.value = 1.0;
    conv.connect(wetLP).connect(wet).connect(master);
    this.reverbIn = conv;                      // read by the console's checks

    const dry = ctx.createGain();
    dry.gain.value = 0.85;
    dry.connect(master);
    this.dry = dry;

    this.sendFar = ctx.createGain();    // drenched — pad, ostinato
    this.sendFar.gain.value = 0.9;
    this.sendFar.connect(conv);
    this.sendNear = ctx.createGain();   // a suggestion of space — pulse, UI
    this.sendNear.gain.value = 0.3;
    this.sendNear.connect(conv);

    // --- pad ---------------------------------------------------------------
    const padBus = ctx.createGain();
    padBus.gain.value = 0;
    const padLP = ctx.createBiquadFilter();
    padLP.type = 'lowpass';
    padLP.frequency.value = 380;
    padLP.Q.value = 0.5;                 // no resonance: a peak here whistles
    padBus.connect(padLP);
    padLP.connect(dry);
    padLP.connect(this.sendFar);
    this.padBus = padBus;
    this.padLP = padLP;

    // Tremulant, deliberately slow and shallow — it should be felt, not heard.
    const trem = ctx.createOscillator();
    const tremDepth = ctx.createGain();
    trem.frequency.value = 0.13;
    tremDepth.gain.value = 0.02;
    trem.connect(tremDepth).connect(padBus.gain);
    trem.start();

    // --- ostinato ----------------------------------------------------------
    this.arpBus = ctx.createGain();
    this.arpBus.gain.value = 1;
    this.arpBus.connect(dry);
    this.arpBus.connect(this.sendFar);

    // --- heartbeat ---------------------------------------------------------
    this.pulseBus = ctx.createGain();
    this.pulseBus.gain.value = 1;
    const pulseLP = ctx.createBiquadFilter();
    pulseLP.type = 'lowpass';
    pulseLP.frequency.value = 180;      // no click, just weight
    this.pulseBus.connect(pulseLP);
    pulseLP.connect(dry);
    pulseLP.connect(this.sendNear);

    // --- one-shots ---------------------------------------------------------
    this.fxBus = ctx.createGain();
    this.fxBus.gain.value = 1;
    this.fxBus.connect(dry);
    this.fxBus.connect(this.sendNear);

    // --- sub ---------------------------------------------------------------
    const sub = ctx.createOscillator();
    const subGain = ctx.createGain();
    sub.type = 'sine';
    sub.frequency.value = A1;
    subGain.gain.value = 0;
    sub.connect(subGain).connect(dry);
    sub.start();
    this.sub = sub;
    this.subGain = subGain;

    // --- air ---------------------------------------------------------------
    // Very quiet filtered noise. Below the level anyone notices, but it fills
    // the gap between the pad's partials so the bed sounds like a space rather
    // than like four sine waves.
    const air = ctx.createBufferSource();
    air.buffer = this._noise(6);
    air.loop = true;
    const airLP = ctx.createBiquadFilter();
    airLP.type = 'lowpass';
    airLP.frequency.value = 700;
    const airGain = ctx.createGain();
    airGain.gain.value = 0;
    air.connect(airLP).connect(airGain);
    airGain.connect(dry);
    airGain.connect(this.sendFar);
    air.start();
    this.airGain = airGain;
    this.airLP = airLP;

    this.ready = true;
    this._paint();
    return ctx;
  }

  /** Exponentially decaying noise, decorrelated per channel for a wide tail. */
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
        const build = Math.min(1, i / (rate * 0.02));   // reads as a room
        d[i] = (rnd() * 2 - 1) * build * (1 - i / n) ** decay;
      }
    }
    return buf;
  }

  _noise(seconds) {
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
  async unlock() {
    if (this.reduced) return false;
    this.init();
    if (!this.ctx) return false;
    if (this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch { return false; }
    }
    this.unlocked = true;
    if (!this.padVoices.length) {
      this._setChord(0, this.ctx.currentTime + 0.05, 4.5);   // slow fade-in
      this.nextChordAt = this.ctx.currentTime + CHORD_S;
    }
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
    const target = this.enabled && this.unlocked ? 0.75 : 0;
    this.master.gain.cancelScheduledValues(t);
    // A long time constant both ways: the score should arrive and leave the
    // way weather does, never as a switch.
    this.master.gain.setTargetAtTime(target, t, 1.1);
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
  /**
   * One additive note.
   *
   * `dur: null` sustains until released. Attacks are never shorter than 25 ms
   * — that is the threshold below which a note reads as a click, and a click
   * is the thing that makes a score feel like an alarm.
   */
  _voice(freq, { at, dur, gain, dest, detune = 4, attack = 0.9,
    partials = PARTIALS }) {
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = 0.0001;
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
        if (dur != null) o.stop(at + dur + 1.2);
        oscs.push(o);
      }
    }

    out.gain.setValueAtTime(0.0001, at);
    out.gain.exponentialRampToValueAtTime(1, at + attack);
    if (dur != null) {
      out.gain.setValueAtTime(1, at + Math.min(attack, dur * 0.4));
      out.gain.exponentialRampToValueAtTime(0.0001, at + dur + 1.0);
    }
    return { out, oscs };
  }

  /** Move to a chord, crossfading under the reverb tail. */
  _setChord(index, when, fade = CROSSFADE_S) {
    const ch = PROGRESSION[index % PROGRESSION.length];
    this.chordIndex = index % PROGRESSION.length;

    for (const v of this.padVoices) {
      v.out.gain.cancelScheduledValues(when);
      v.out.gain.setValueAtTime(Math.max(0.0001, v.out.gain.value), when);
      v.out.gain.exponentialRampToValueAtTime(0.0001, when + fade);
      for (const o of v.oscs) o.stop(when + fade + 0.4);
    }

    this.padVoices = ch.pad.map((f) => this._voice(f, {
      at: when, dur: null, gain: 0.85 / ch.pad.length,
      dest: this.padBus, detune: 5, attack: fade,
    }));

    this.sub.frequency.setTargetAtTime(ch.bass, when, fade * 0.5);
  }

  // -------------------------------------------------------------------------
  // Scheduler
  // -------------------------------------------------------------------------
  /**
   * Notes are queued against `ctx.currentTime` a quarter-second ahead rather
   * than fired from the timer. `setInterval` drifts, and a drifting ostinato
   * is immediately audible; the timer decides only *what* to queue.
   */
  _startScheduler() {
    if (this._timer) return;
    const t = this.ctx.currentTime;
    this.nextNoteAt = t + 0.3;
    this.nextPulseAt = t + 1.0;
    if (!this.nextChordAt) this.nextChordAt = t + CHORD_S;
    this._timer = setInterval(() => this._schedule(), SCHED_TICK);
  }

  _schedule() {
    if (!this.audible) return;
    const ctx = this.ctx;
    const horizon = ctx.currentTime + SCHED_AHEAD;
    const m = MODE[this.mode] ?? MODE.SUN_FACING;
    const chord = PROGRESSION[this.chordIndex];

    // --- harmony -----------------------------------------------------------
    while (this.nextChordAt < horizon) {
      this._setChord(this.chordIndex + 1,
        Math.max(this.nextChordAt, ctx.currentTime + 0.02));
      this.nextChordAt += CHORD_S;
    }

    // --- ostinato ----------------------------------------------------------
    while (this.nextNoteAt < horizon) {
      const at = Math.max(this.nextNoteAt, ctx.currentTime + 0.02);
      if (m.arpGain > 0) {
        const note = chord.arp[this.arpStep % chord.arp.length];
        // Breathe: the first note of each cell a little louder, the rest
        // softer, so the figure has shape without anything being struck hard.
        const accent = (this.arpStep % chord.arp.length) === 0 ? 1.35 : 0.85;
        this._voice(note, {
          at,
          dur: m.arpStep * 2.6,
          gain: m.arpGain * accent,
          dest: this.arpBus,
          detune: 3,
          attack: 0.055,
          partials: PARTIALS.slice(0, 3),
        });
      }
      this.arpStep += 1;
      this.nextNoteAt += m.arpStep;
    }

    // --- heartbeat ---------------------------------------------------------
    // Still driven by the mission clock, but clamped into a calm range: ~52 bpm
    // while coasting, stretching towards one beat every four seconds through
    // the overpass. The dilation is audible as things getting *slower*, which
    // is the opposite of an alarm.
    const interval = this.pulseInterval();
    while (this.nextPulseAt < horizon) {
      this._pulse(Math.max(this.nextPulseAt, ctx.currentTime + 0.02));
      this.nextPulseAt += interval;
    }
  }

  /**
   * Seconds between heartbeats.
   *
   * Interpolated on `slow` — the log-scaled 0..1 position between the clock's
   * fastest and slowest rates — rather than straight off the raw compression.
   * A raw `k / compression` with clamps at both ends spends most of the orbit
   * pinned against one clamp or the other: measured at slider 0.35 it was
   * already at maximum slowness, so the deceleration was over before the
   * approach began. This decelerates continuously the whole way in, which is
   * the entire point of tying it to the clock.
   */
  pulseInterval() {
    const t = Math.max(0, Math.min(1, this.slow)) ** 0.8;
    return 1.15 + (3.8 - 1.15) * t;
  }

  _pulse(at) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(62, at);
    o.frequency.exponentialRampToValueAtTime(44, at + 0.35);
    // 30 ms attack: felt in the chest, never heard as a click.
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.16 + 0.06 * this.slow, at + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.75);
    o.connect(g).connect(this.pulseBus);
    o.start(at);
    o.stop(at + 0.85);
  }

  // -------------------------------------------------------------------------
  // Following the mission
  // -------------------------------------------------------------------------
  follow(state) {
    if (!this.audible) return;
    const t = this.ctx.currentTime;
    const mode = state.mode.id;
    const m = MODE[mode] ?? MODE.SUN_FACING;

    if (mode !== this.mode) {
      this.mode = mode;
      // Deliberately no chord change and no re-trigger: a mode change opens
      // the room, it does not restart the music.
      this.padBus.gain.setTargetAtTime(m.padGain, t, 2.2);
      this.airGain.gain.setTargetAtTime(m.air, t, 3.0);
      this.nextNoteAt = Math.max(this.nextNoteAt, t + 0.1);
    }

    this.compression = state.clock.time_compression;

    const b = state.clock.compression_bounds;
    this.slow = b && b.max > b.min
      ? Math.max(0, Math.min(1,
        1 - Math.log(this.compression / b.min) / Math.log(b.max / b.min)))
      : 0;

    // The only continuous gesture in the piece: the room opens as the
    // spacecraft closes on the target, and closes again as it leaves.
    this.padLP.frequency.setTargetAtTime(m.cutoff * (1 + 0.8 * this.slow), t, 2.0);
    this.airLP.frequency.setTargetAtTime(700 + 900 * this.slow, t, 2.5);
    this.subGain.gain.setTargetAtTime(0.10 + 0.06 * this.slow, t, 2.0);
  }

  // -------------------------------------------------------------------------
  // One-shots — all soft-attack sines, nothing percussive
  // -------------------------------------------------------------------------
  _bell(freq, { peak = 0.09, attack = 0.04, decay = 1.2, delay = 0, dest = null } = {}) {
    if (!this.audible) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq, t);
    o.connect(g).connect(dest ?? this.fxBus);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    o.start(t);
    o.stop(t + attack + decay + 0.1);
  }

  /**
   * Shutter open. A *swell*, not a hit — the chord blooms an octave up over
   * two seconds. The most important moment in the loop should feel like
   * arriving somewhere, not like something going wrong.
   */
  shutter() {
    if (!this.audible) return;
    const t = this.ctx.currentTime;
    const ch = PROGRESSION[this.chordIndex];
    for (const [i, f] of ch.pad.entries()) {
      this._voice(f * 2, {
        at: t + i * 0.18, dur: 3.2, gain: 0.05,
        dest: this.arpBus, detune: 6, attack: 1.1,
      });
    }
    this._bell(ch.bass * 2, { peak: 0.14, attack: 0.5, decay: 3.0 });
  }

  modeChange(to) {
    if (!this.audible) return;
    if (to === 'ACTIVE') { this.shutter(); return; }
    // Elsewhere: a single soft chord tone, an acknowledgement rather than a
    // fanfare. Mode changes happen four times a loop; they cannot be events.
    const ch = PROGRESSION[this.chordIndex];
    this._bell(ch.arp[0], { peak: 0.06, attack: 0.25, decay: 2.0 });
  }

  /** Acquisition of signal — a gentle rising third, inside the chord. */
  aos() {
    const ch = PROGRESSION[this.chordIndex];
    this._bell(ch.arp[0], { peak: 0.055, attack: 0.05, decay: 0.9 });
    this._bell(ch.arp[2], { peak: 0.055, attack: 0.05, decay: 1.2, delay: 0.16 });
  }

  /** Loss of signal — the same figure, falling. */
  los() {
    const ch = PROGRESSION[this.chordIndex];
    this._bell(ch.arp[2], { peak: 0.05, attack: 0.05, decay: 0.9 });
    this._bell(ch.arp[0], { peak: 0.05, attack: 0.05, decay: 1.3, delay: 0.16 });
  }

  /**
   * Telemetry tick. Pitched high inside the chord and very quiet, so a burst
   * of downlink lines shimmers rather than bleeps. Rate-limited hard — the log
   * can produce four lines a tick and the ear cannot take four events a tick.
   */
  blip() {
    const now = performance.now();
    if (now - this.lastBlipAt < 260) return;
    this.lastBlipAt = now;
    const up = [C5, E5, A4];
    this._bell(up[Math.floor(now / 260) % up.length],
      { peak: 0.016, attack: 0.03, decay: 0.7 });
  }

  /**
   * Alert. A falling minor third — the shape of a sigh, not a siren. Rate
   * limited to one every eight seconds, because a standing warning that
   * repeats is the single most stressful thing a console can do.
   */
  alert(level) {
    const now = performance.now();
    if (now - this.lastAlertAt < 8000) return;
    this.lastAlertAt = now;
    if (level === 'CRITICAL') {
      this._bell(D4, { peak: 0.085, attack: 0.06, decay: 1.1 });
      this._bell(B3, { peak: 0.085, attack: 0.06, decay: 1.8, delay: 0.3 });
    } else {
      this._bell(C4, { peak: 0.055, attack: 0.08, decay: 1.4 });
    }
  }

  /** UI feedback: one very short, very quiet sine. No noise burst. */
  click() {
    this._bell(G4, { peak: 0.03, attack: 0.008, decay: 0.12, dest: this.dry });
  }

  /** Scrubbing — quieter still, and heavily rate-limited. */
  scrub() {
    const now = performance.now();
    if (now - this.lastBlipAt < 90) return;
    this.lastBlipAt = now;
    this._bell(A4, { peak: 0.012, attack: 0.006, decay: 0.08, dest: this.dry });
  }

  /** Played once when the viewer starts the mission from the volume gate. */
  launch() {
    if (!this.audible) return;
    const t = this.ctx.currentTime;
    const ch = PROGRESSION[0];
    for (const [i, f] of ch.pad.entries()) {
      this._voice(f, {
        at: t + i * 0.25, dur: 5.0, gain: 0.07,
        dest: this.arpBus, detune: 7, attack: 1.6,
      });
    }
    this._bell(A1, { peak: 0.18, attack: 0.9, decay: 4.5 });
  }
}

export default MissionAudio;
