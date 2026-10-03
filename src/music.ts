// A generative ambient score in the spirit of early-90s London ambient techno: slow
// extended minor chords on filtered pads, FM bells thrown into a ping-pong echo, a sub
// that breathes with the chords, a resonant "air" texture and a soft broken beat that
// drifts in and out over minutes. Everything is synthesized and scheduled a little ahead
// of the audio clock, so nothing repeats exactly. The key is A, to sit on the ambience's
// 55 Hz drones.

interface Mood {
  gloom: number;
  night: number;
  rain: number;
}

interface Chord {
  root: number; // MIDI note of the bass
  notes: number[]; // MIDI notes of the pad voicing
}

// Day: A aeolian / dorian colours — open ninths and elevenths.
const LIGHT: Chord[] = [
  { root: 45, notes: [57, 60, 64, 67, 74] }, // Am11
  { root: 41, notes: [53, 57, 60, 64, 67] }, // Fmaj9
  { root: 38, notes: [53, 57, 60, 62, 64] }, // Dm9
  { root: 43, notes: [55, 59, 62, 64, 69] }, // G6/9
  { root: 36, notes: [55, 59, 60, 64, 67] }, // Cmaj7
  { root: 40, notes: [55, 59, 62, 64, 67] }, // Em7(add11)
];
// Night and murk: phrygian flats and suspended things that never quite resolve.
const DARK: Chord[] = [
  { root: 45, notes: [57, 60, 64, 71] }, // Am(add9)
  { root: 46, notes: [58, 62, 64, 65, 69] }, // Bbmaj7#11
  { root: 43, notes: [55, 58, 62, 65, 69] }, // Gm9
  { root: 41, notes: [53, 57, 60, 64] }, // Fmaj7
  { root: 38, notes: [53, 57, 60, 62, 65] }, // Dm(add9)
];

const BPM = 86;
const STEP = 60 / BPM / 4; // a sixteenth
const BAR = 16;
const CHORD_BARS = 4;

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];

/** A long dark hall: stereo noise with an exponential tail, softened as it decays. */
function impulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const k = 0.9 - 0.85 * t; // the tail loses its top end
      lp += k * ((Math.random() * 2 - 1) - lp);
      d[i] = lp * (1 - t) ** 3;
    }
  }
  return buf;
}

function noise(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

export class Music {
  private out: GainNode;
  private verb: GainNode; // send into the reverb
  private echo: GainNode; // send into the ping-pong delay
  private padFilter: BiquadFilterNode;
  private padBus: GainNode;
  private beatBus: GainNode;
  private beatFilter: BiquadFilterNode;
  private airFilter: BiquadFilterNode;
  private airGain: GainNode;
  private noise: AudioBuffer;
  private next = 0; // audio time of the next sixteenth
  private step = 0;
  private chord: Chord = LIGHT[0];
  private voices: { osc: OscillatorNode[]; gain: GainNode }[] = [];
  private bass: AudioParam | null = null;
  private groove = 0; // where the beat is heading, 0 or 1
  private grooveBars = 8;
  private arp: number[] = [];
  private mood: Mood = { gloom: 0, night: 0, rain: 0 };
  private on = true;

  constructor(private ctx: BaseAudioContext, dest: AudioNode) {
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(dest);

    const conv = ctx.createConvolver();
    conv.buffer = impulse(ctx, 7);
    this.verb = ctx.createGain();
    const wet = ctx.createGain();
    wet.gain.value = 0.9;
    this.verb.connect(conv).connect(wet).connect(this.out);

    // ping-pong echo on a dotted eighth, darkening on each repeat
    this.echo = ctx.createGain();
    const dl = ctx.createDelay(2), dr = ctx.createDelay(2);
    dl.delayTime.value = dr.delayTime.value = STEP * 3;
    const fl = ctx.createGain(), fr = ctx.createGain();
    fl.gain.value = fr.gain.value = 0.55;
    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = 2600;
    const pl = ctx.createStereoPanner(), pr = ctx.createStereoPanner();
    pl.pan.value = -0.8;
    pr.pan.value = 0.8;
    this.echo.connect(tone).connect(dl);
    dl.connect(fl).connect(dr);
    dr.connect(fr).connect(tone);
    dl.connect(pl).connect(this.out);
    dr.connect(pr).connect(this.out);
    pl.connect(this.verb);
    pr.connect(this.verb);

    // pads share one resonant filter that a slow LFO sweeps
    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = "lowpass";
    this.padFilter.frequency.value = 700;
    this.padFilter.Q.value = 3;
    const sweep = ctx.createOscillator();
    sweep.frequency.value = 0.021;
    const sweepDepth = ctx.createGain();
    sweepDepth.gain.value = 450;
    sweep.connect(sweepDepth).connect(this.padFilter.frequency);
    sweep.start();
    this.padBus = ctx.createGain();
    this.padBus.gain.value = 0.5;
    this.padFilter.connect(this.padBus);
    this.padBus.connect(this.out);
    this.padBus.connect(this.verb);

    this.beatFilter = ctx.createBiquadFilter();
    this.beatFilter.type = "lowpass";
    this.beatFilter.frequency.value = 300;
    this.beatBus = ctx.createGain();
    this.beatBus.gain.value = 0;
    this.beatFilter.connect(this.beatBus).connect(this.out);

    this.noise = noise(ctx, 2);

    // air: noise through a narrow band that wanders and pans, like a far-off transmission
    const air = ctx.createBufferSource();
    air.buffer = noise(ctx, 6);
    air.loop = true;
    this.airFilter = ctx.createBiquadFilter();
    this.airFilter.type = "bandpass";
    this.airFilter.frequency.value = 1200;
    this.airFilter.Q.value = 14;
    const airLfo = ctx.createOscillator();
    airLfo.frequency.value = 0.013;
    const airDepth = ctx.createGain();
    airDepth.gain.value = 800;
    airLfo.connect(airDepth).connect(this.airFilter.frequency);
    const airPan = ctx.createStereoPanner();
    const panLfo = ctx.createOscillator();
    panLfo.frequency.value = 0.037;
    const panDepth = ctx.createGain();
    panDepth.gain.value = 0.7;
    panLfo.connect(panDepth).connect(airPan.pan);
    this.airGain = ctx.createGain();
    this.airGain.gain.value = 0.12;
    air.connect(this.airFilter).connect(this.airGain).connect(airPan);
    airPan.connect(this.out);
    airPan.connect(this.verb);
    air.start();
    airLfo.start();
    panLfo.start();

    this.next = ctx.currentTime + 0.1;
    this.setOn(true);
  }

  get playing(): boolean {
    return this.on;
  }

  setOn(on: boolean): void {
    this.on = on;
    const t = this.ctx.currentTime;
    this.out.gain.setTargetAtTime(on ? 0.5 : 0, t, on ? 2.5 : 0.8);
    if (on) {
      // come back in on a fresh chord rather than a bar of nothing
      const phrase = BAR * CHORD_BARS;
      this.step = Math.ceil(this.step / phrase) * phrase;
    } else {
      // the pads would otherwise drone on unheard until the next chord that never comes
      for (const v of this.voices) for (const o of v.osc) o.stop(t + 4);
      this.voices = [];
    }
  }

  /** Schedule whatever falls within the next moment; call every frame. */
  update(mood: Mood): void {
    const ctx = this.ctx;
    this.mood = mood;
    const t = ctx.currentTime;
    // after a stall or a pause, pick up from now rather than firing a backlog
    if (this.next < t - 0.1) this.next = t + 0.05;
    const dark = Math.max(mood.gloom, mood.night);
    this.airGain.gain.setTargetAtTime(0.08 + 0.12 * dark + 0.1 * mood.rain, t, 3);
    while (this.next < t + 0.3) {
      this.tick(this.step, this.next);
      this.step++;
      this.next += STEP;
    }
  }

  private tick(step: number, t: number): void {
    const s = step % BAR;
    const bar = Math.floor(step / BAR);
    const dark = Math.max(this.mood.gloom, this.mood.night);
    if (s === 0) {
      if (bar % CHORD_BARS === 0) this.changeChord(t, dark);
      if (--this.grooveBars <= 0) {
        // the beat comes in for a stretch and goes away again; murk keeps it away longer
        this.groove = this.groove ? 0 : Math.random() < 0.75 - 0.35 * this.mood.gloom ? 1 : 0;
        this.grooveBars = (this.groove ? 16 : 12) + 4 * Math.floor(Math.random() * 4);
      }
      this.beatBus.gain.setTargetAtTime(this.groove * 0.55, t, 6);
      this.beatFilter.frequency.setTargetAtTime(this.groove ? 5000 - 2500 * dark : 250, t, 8);
      if (this.arp.length === 0 && Math.random() < 0.3) this.makeArp();
    }
    // a little swing on the off sixteenths
    const at = t + (s % 2 ? STEP * 0.16 : 0);

    // broken beat, while it is in or still fading
    if (this.groove || this.beatBus.gain.value > 0.01) this.beat(s, at);

    // the sub follows the bar: one long note, or with the beat a shorter one and a push on the "and" of three
    if (s === 0) this.bassNote(this.chord.root - 12, at, STEP * (this.groove ? 9 : 15));
    if (s === 11 && this.groove && Math.random() < 0.6) this.bassNote(this.chord.root - 12 + pick([0, 7, 12]), at, STEP * 4);

    // arpeggio on the eighths, then silence
    if (s % 2 === 0 && this.arp.length) {
      const n = this.arp.shift()!;
      if (n > 0) this.bell(n, at, 0.11, 1);
    }
    // stray bells, more of them in clear daylight
    if (Math.random() < 0.025 + 0.02 * (1 - dark)) {
      const n = pick(this.chord.notes) + pick([12, 24, 24]);
      this.bell(n, at, 0.06 + Math.random() * 0.06, pick([1, 1, 3.5]));
    }
    // a rising swell into the next chord
    if (bar % CHORD_BARS === CHORD_BARS - 1 && s === 0 && Math.random() < 0.45) this.swell(t, STEP * BAR);
  }

  private beat(s: number, at: number): void {
    if (s === 0 || s === 10 || (s === 6 && Math.random() < 0.4) || (s === 3 && Math.random() < 0.15)) this.kick(at);
    if (s === 4 || s === 12) this.snare(at, 1);
    else if ((s === 7 || s === 15) && Math.random() < 0.25) this.snare(at, 0.3);
    if (s % 2 === 0 || Math.random() < 0.3) this.hat(at, s === 14 && Math.random() < 0.5, s % 4 === 2 ? 1 : 0.5);
  }

  private changeChord(t: number, dark: number): void {
    const set = Math.random() < dark ? DARK : LIGHT;
    let c = pick(set);
    for (let i = 0; i < 4 && c === this.chord; i++) c = pick(set);
    this.chord = c;
    // release what is sounding and fade the new chord in under it
    for (const v of this.voices) {
      v.gain.gain.setTargetAtTime(0, t, 2.2);
      for (const o of v.osc) o.stop(t + 14);
    }
    this.voices = [];
    const ctx = this.ctx;
    this.padFilter.Q.setTargetAtTime(2 + 4 * this.mood.rain, t, 4);
    this.padFilter.frequency.setTargetAtTime(500 + 900 * (1 - dark), t, 6);
    c.notes.forEach((n, i) => {
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.07, t + 3 + Math.random() * 2);
      const pan = ctx.createStereoPanner();
      pan.pan.value = (i / (c.notes.length - 1)) * 1.2 - 0.6;
      gain.connect(pan).connect(this.padFilter);
      const osc: OscillatorNode[] = [];
      for (const cents of [-9, 7]) {
        const o = ctx.createOscillator();
        o.type = "sawtooth";
        o.frequency.value = hz(n);
        o.detune.value = cents + Math.random() * 4;
        o.connect(gain);
        o.start(t);
        osc.push(o);
      }
      // a soft sine an octave down gives the pad its body
      const sub = ctx.createOscillator();
      sub.frequency.value = hz(n - 12);
      const sg = ctx.createGain();
      sg.gain.value = 0.6;
      sub.connect(sg).connect(gain);
      sub.start(t);
      osc.push(sub);
      this.voices.push({ osc, gain });
    });
  }

  private makeArp(): void {
    const notes = [...this.chord.notes].sort((a, b) => a - b).map((n) => n + 12);
    const shape = pick(["up", "down", "skip"]);
    const seq = shape === "down" ? notes.reverse() : shape === "skip" ? [notes[0], notes[2], notes[1], notes[3] ?? notes[0] + 12] : notes;
    this.arp = [...seq, 0, ...seq.slice(1).map((n) => n + (Math.random() < 0.5 ? 12 : 0)), 0, 0, 0];
  }

  private bassNote(midi: number, t: number, len: number): void {
    const ctx = this.ctx;
    // choke the last note; its own stop is already scheduled
    this.bass?.setTargetAtTime(0, t, 0.05);
    const osc = ctx.createOscillator();
    osc.frequency.value = hz(midi);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.32, t + 0.04);
    gain.gain.setTargetAtTime(0.18, t + 0.05, 0.4);
    gain.gain.setTargetAtTime(0, t + len, 0.3);
    osc.connect(gain).connect(this.out);
    osc.start(t);
    osc.stop(t + len + 2);
    this.bass = gain.gain;
  }

  /** Two-operator FM: a sine bent by another sine whose depth dies away. */
  private bell(midi: number, t: number, vol: number, ratio: number): void {
    const ctx = this.ctx;
    const f = hz(midi);
    const car = ctx.createOscillator();
    car.frequency.value = f;
    const mod = ctx.createOscillator();
    mod.frequency.value = f * ratio;
    const depth = ctx.createGain();
    depth.gain.setValueAtTime(f * (ratio === 1 ? 2 : 1.2), t);
    depth.gain.exponentialRampToValueAtTime(f * 0.05, t + 1.2);
    mod.connect(depth).connect(car.frequency);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(vol, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0005, t + 2.5);
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 1.4 - 0.7;
    car.connect(gain).connect(pan);
    pan.connect(this.out);
    pan.connect(this.echo);
    pan.connect(this.verb);
    car.start(t);
    mod.start(t);
    car.stop(t + 2.6);
    mod.stop(t + 2.6);
  }

  private kick(t: number): void {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(115, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.14);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.8, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    o.connect(g).connect(this.beatFilter);
    o.start(t);
    o.stop(t + 0.5);
  }

  private snare(t: number, vol: number): void {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.value = 1700;
    f.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.35 * vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    src.connect(f).connect(g).connect(this.beatFilter);
    const send = ctx.createGain();
    send.gain.value = 0.5 * this.beatBus.gain.value;
    g.connect(send).connect(this.verb);
    src.start(t, Math.random());
    src.stop(t + 0.25);
    const body = ctx.createOscillator();
    body.type = "triangle";
    body.frequency.setValueAtTime(190, t);
    body.frequency.exponentialRampToValueAtTime(140, t + 0.08);
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0.2 * vol, t);
    bg.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    body.connect(bg).connect(this.beatFilter);
    body.start(t);
    body.stop(t + 0.12);
  }

  private hat(t: number, open: boolean, vol: number): void {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = "highpass";
    f.frequency.value = 7000;
    const g = ctx.createGain();
    const len = open ? 0.25 : 0.035;
    g.gain.setValueAtTime(0.09 * vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + len);
    const pan = ctx.createStereoPanner();
    pan.pan.value = 0.3;
    src.connect(f).connect(g).connect(pan).connect(this.beatFilter);
    src.start(t, Math.random());
    src.stop(t + len + 0.02);
  }

  /** Noise opening up over a bar, cut dead on the downbeat — a reversed cymbal. */
  private swell(t: number, len: number): void {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = "bandpass";
    f.Q.value = 2;
    f.frequency.setValueAtTime(400, t);
    f.frequency.exponentialRampToValueAtTime(6000, t + len);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.09, t + len);
    g.gain.linearRampToValueAtTime(0, t + len + 0.03);
    src.connect(f).connect(g);
    g.connect(this.out);
    g.connect(this.verb);
    src.start(t);
    src.stop(t + len + 0.05);
  }
}
