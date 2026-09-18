/**
 * Guided tour.
 *
 * An investor console that needs a person standing next to it to be
 * understood is only half a console. The tour drives the timeline itself, so
 * each step shows the thing it is describing actually happening — it is a
 * demo script the page can run on its own.
 */
const STEPS = [
  {
    target: '#timeline',
    title: 'One control',
    body: 'Everything on AL-FALAJ SAT-1\'s console is a function of this slider. It '
      + 'scrubs one complete 94.9-minute orbit in 90 seconds — and because the loop is '
      + 'exactly one orbit, it ends where it began. The cyan curve behind it is the '
      + 'real battery state of charge, the amber curve is the clock rate, and the '
      + 'shaded bands are the operating modes.',
    slider: 0.08,
  },
  {
    target: '#power-panel',
    title: 'Eclipse — power saving',
    body: 'In Earth\'s shadow the arrays make nothing, the imager is switched off at '
      + 'the rail, and the battery carries the load alone. The gauge is zoomed: a real '
      + 'orbit only moves the battery a few percent, so the display shows the mission\'s '
      + 'actual range rather than faking a bigger swing. The true figure is printed '
      + 'beside it.',
    slider: 0.06,
  },
  {
    target: '#gs-panel',
    title: 'A contact in the dark',
    body: 'Troll station, Antarctica, comes over the horizon while the spacecraft is '
      + 'still in eclipse, and the recorder dumps. Watch the power panel as it does: '
      + 'the transmitter draws 9 W at the single deepest point of the orbit. None of '
      + 'these timings are scripted — the propagator is swept against each station\'s '
      + '10° horizon mask to find them.',
    slider: 0.1,
  },
  {
    target: '#power-panel',
    title: 'Sunlight — recharge',
    body: 'Arrays sun-pointed, ~39 W in, and the charge curve tapers as the battery '
      + 'fills — constant-current to 88 %, then constant-voltage, as a real lithium '
      + 'cell behaves. The payload sits in standby, cooling its detector to −40 °C in '
      + 'preparation.',
    slider: 0.32,
  },
  {
    target: '#v-orbit',
    title: 'The clock slows down — listen for it',
    body: 'Watch this number. Coasting, the console runs at about 124× real time. As '
      + 'the spacecraft closes on the UAE it ramps smoothly down to roughly 4.8× — '
      + 'near real time for the part that matters. The rate is continuous, not stepped, '
      + 'and reported in every telemetry frame rather than hidden. The ticking pulse in '
      + 'the score is driven by this same number, so you can hear the clock dilate '
      + 'without looking at it.',
    slider: 0.50,
  },
  {
    target: '#globe-panel',
    title: 'The pass',
    body: 'The spacecraft crosses UAE coastal waters, and the ground station in Dubai '
      + 'has already acquired it. Drag the globe, or click any point on it to sample '
      + 'that spot\'s spectrum. The orbit track is a closed ring because the loop is '
      + 'exactly one revolution.',
    slider: 0.63,
  },
  {
    target: '#spectro-panel',
    title: 'What the instrument sees',
    body: 'Reflected light split into 96 bands. Algae absorb blue and red, reflect '
      + 'green, and — decisively — re-emit light at 681 nm. That fluorescence peak only '
      + 'appears over living algae, which is why it cannot be faked by sediment or '
      + 'glare. Hover the graph to read any band.',
    slider: 0.70,
  },
  {
    target: '#uae-panel',
    title: 'Where it looked',
    body: 'The bright line is the instantaneous scan line; the shaded band is '
      + 'everything captured so far this pass. One crossing covers a 180 km swath at '
      + '30 m resolution — the entire UAE coast in a single strip, once a day.',
    slider: 0.78,
  },
  {
    target: '#desal-panel',
    title: 'The product',
    body: 'Algal blooms clog reverse-osmosis intakes; the 2008–09 bloom repeatedly shut '
      + 'Fujairah down. Each plant gets a draw/throttle/hold verdict and a best window. '
      + 'Hover the 24-hour strip to see every term behind a score — bloom load, '
      + 'stratification, tide, turbidity, and a margin for how old the observation is.',
    slider: 0.80,
  },
  {
    target: '#impact-panel',
    title: 'Why any of this matters',
    body: 'The same scheduler output, in the unit a water authority decides in: cubic '
      + 'metres per day of intake capacity the scheduler will not clear, and how long '
      + 'until it has to be acted on. Note that the two plants disagree: Jebel Ali sits '
      + 'in the shallow, poorly flushed Gulf and swings in and out of a throttle '
      + 'recommendation, while Fujairah\'s deeper Gulf of Oman intake stays clear. '
      + 'Without an ocean-colour pass an operator has no such number at all — they '
      + 'learn about a bloom when pressure across the intake screens rises.',
    slider: 0.80,
  },
  {
    target: '#downlink-panel',
    title: 'Nothing is decoration',
    body: 'Every line in this log is a value shown elsewhere on the console, tagged '
      + 'with its CCSDS application ID — nothing here is filler. Each panel also '
      + 'carries a SOURCE line naming the model behind its numbers, and a ? that '
      + 'explains what you are looking at. A falaj carries water to where it is '
      + 'needed; this one watches the sea that feeds it. Tour complete — the slider '
      + 'is yours.',
    slider: 0.84,
  },
];

export class Tour {
  constructor(link) {
    this.link = link;
    this.mask = document.getElementById('tour-mask');
    this.ring = document.getElementById('tour-ring');
    this.card = document.getElementById('tour-card');
    this.i = 0;
    this._wasPlaying = true;

    document.getElementById('tour-next').addEventListener('click', () => this.go(this.i + 1));
    document.getElementById('tour-prev').addEventListener('click', () => this.go(this.i - 1));
    document.getElementById('tour-skip').addEventListener('click', () => this.stop());
    document.getElementById('btn-tour').addEventListener('click', () => this.start());
    this.mask.addEventListener('click', (e) => { if (e.target === this.mask) this.stop(); });

    this._onKey = (e) => {
      if (!this.active) return;
      if (e.key === 'Escape') this.stop();
      if (e.key === 'ArrowRight' || e.key === 'Enter') this.go(this.i + 1);
      if (e.key === 'ArrowLeft') this.go(this.i - 1);
    };
    window.addEventListener('keydown', this._onKey);
    window.addEventListener('resize', () => { if (this.active) this._place(); });
  }

  start() {
    this.active = true;
    this._wasPlaying = this.link.playing;
    this.link.setTransport({ playing: false });
    this.mask.classList.add('on');
    this.go(0);
  }

  stop() {
    this.active = false;
    this.mask.classList.remove('on');
    this.link.setTransport({ playing: this._wasPlaying });
  }

  go(i) {
    if (i < 0) return;
    if (i >= STEPS.length) { this.stop(); return; }
    this.i = i;
    const step = STEPS[i];

    if (step.slider != null) this.link.seek(step.slider);

    document.getElementById('tour-title').textContent = step.title;
    document.getElementById('tour-body').textContent = step.body;
    document.getElementById('tour-step').textContent = `${i + 1} / ${STEPS.length}`;
    document.getElementById('tour-next').textContent =
      i === STEPS.length - 1 ? 'FINISH' : 'NEXT';
    document.getElementById('tour-prev').style.visibility = i === 0 ? 'hidden' : 'visible';

    // The panel may have just become visible (ACTIVE-only panels), so place
    // after the layout transition has had a frame to run.
    this._place();
    setTimeout(() => this._place(), 420);
  }

  _place() {
    const step = STEPS[this.i];
    const el = document.querySelector(step.target);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 4;

    this.ring.style.left = `${r.left - pad}px`;
    this.ring.style.top = `${r.top - pad}px`;
    this.ring.style.width = `${r.width + pad * 2}px`;
    this.ring.style.height = `${r.height + pad * 2}px`;

    const cw = Math.min(370, window.innerWidth - 24);
    this.card.style.width = `${cw}px`;
    const ch = this.card.offsetHeight || 190;

    // Prefer the side with room; fall back to above/below on narrow screens.
    let left = r.right + 16;
    if (left + cw > window.innerWidth - 12) left = r.left - cw - 16;
    if (left < 12) left = Math.max(12, (window.innerWidth - cw) / 2);

    let top = r.top + r.height / 2 - ch / 2;
    if (top + ch > window.innerHeight - 12) top = window.innerHeight - ch - 12;
    if (top < 12) top = 12;

    this.card.style.left = `${left}px`;
    this.card.style.top = `${top}px`;
  }

  /**
   * Open the tour a few seconds after the console appears.
   *
   * The delay is the point. Opening a modal the instant the page paints means
   * the first thing a viewer sees is a box of text over a console they have
   * not looked at yet; three seconds of live telemetry first gives them
   * something the tour can then explain. `skipAuto` exists so the headless
   * checks can drive the tour deliberately instead of racing it.
   */
  maybeAutoStart({ delayMs = 3000 } = {}) {
    if (new URLSearchParams(location.search).has('notour')) return;
    const btn = document.getElementById('btn-tour');
    btn.classList.add('invite');

    this._autoTimer = setTimeout(() => {
      btn.classList.remove('invite');
      // Do not hijack someone who is already using the console.
      if (this.active || this._userEngaged) return;
      this.start();
    }, delayMs);

    // Any real interaction cancels the auto-open — if they are already
    // driving, they do not need the tour opened on top of them.
    const cancel = () => {
      this._userEngaged = true;
      clearTimeout(this._autoTimer);
      btn.classList.remove('invite');
    };
    for (const ev of ['pointerdown', 'keydown', 'wheel']) {
      window.addEventListener(ev, cancel, { once: true, passive: true });
    }
  }
}

export default Tour;
