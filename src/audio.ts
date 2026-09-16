// Procedural ambience with Web Audio: filtered-noise wind and rain, detuned drones,
// and synthesized footsteps. Must be started from a user gesture.

interface Params {
  wind: number;
  gloom: number;
  rain: number;
}

function noiseBuffer(ctx: AudioContext, seconds: number, brown = false): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (brown) {
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      } else d[i] = w;
    }
    // crossfade the loop seam
    const fade = Math.floor(ctx.sampleRate * 0.25);
    for (let i = 0; i < fade; i++) {
      const t = i / fade;
      d[i] = d[i] * t + d[len - fade + i] * (1 - t);
    }
  }
  return buf;
}

function loopSource(ctx: AudioContext, buf: AudioBuffer): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const fade = 0.25;
  src.loopStart = 0;
  src.loopEnd = buf.duration - fade;
  src.start(0, Math.random() * (buf.duration - 1));
  return src;
}

export class Audio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private windGain!: GainNode;
  private windFilter!: BiquadFilterNode;
  private droneBright!: GainNode;
  private droneDark!: GainNode;
  private rainGain!: GainNode;
  private stepNoise!: AudioBuffer;
  private engineGain!: GainNode;
  private engineFilter!: BiquadFilterNode;
  private engineOsc: OscillatorNode[] = [];
  private washFilter!: BiquadFilterNode;
  private trafficGain!: GainNode;
  private dropTimer = 0;
  private time = 0;

  start(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.gain.linearRampToValueAtTime(0.9, ctx.currentTime + 3);
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(ctx.destination);

    // wind: brown noise through a wandering band-pass
    const windSrc = loopSource(ctx, noiseBuffer(ctx, 12, true));
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = "bandpass";
    this.windFilter.frequency.value = 400;
    this.windFilter.Q.value = 0.7;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    windSrc.connect(this.windFilter).connect(this.windGain).connect(this.master);
    const whistle = loopSource(ctx, noiseBuffer(ctx, 9));
    const wf = ctx.createBiquadFilter();
    wf.type = "bandpass";
    wf.frequency.value = 1100;
    wf.Q.value = 12;
    const wg = ctx.createGain();
    wg.gain.value = 0.05;
    whistle.connect(wf).connect(wg).connect(this.windGain);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 300;
    lfo.connect(lfoGain).connect(wf.frequency);
    lfo.start();

    // drones: slowly beating stacks of sines
    const drone = (ratios: number[]) => {
      const g = ctx.createGain();
      g.gain.value = 0;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 900;
      g.connect(lp).connect(this.master);
      ratios.forEach((r, i) => {
        for (const detune of [-0.2 - 0.1 * i, 0.2 + 0.1 * i]) {
          const o = ctx.createOscillator();
          o.type = i === 0 ? "sine" : "triangle";
          o.frequency.value = 55 * r + detune;
          const og = ctx.createGain();
          og.gain.value = 0.16 / (1 + i);
          const trem = ctx.createOscillator();
          trem.frequency.value = 0.03 + 0.02 * i + Math.random() * 0.02;
          const tg = ctx.createGain();
          tg.gain.value = 0.06 / (1 + i);
          trem.connect(tg).connect(og.gain);
          const pan = ctx.createStereoPanner();
          pan.pan.value = detune < 0 ? -0.4 : 0.4;
          o.connect(og).connect(pan).connect(g);
          o.start();
          trem.start();
        }
      });
      return g;
    };
    this.droneBright = drone([1, 1.5, 2, 3, 4.5]);
    this.droneDark = drone([1, 1.189, 1.414, 2, 2.828]);

    // rain: high hiss + body
    const rainSrc = loopSource(ctx, noiseBuffer(ctx, 7));
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 1400;
    const body = loopSource(ctx, noiseBuffer(ctx, 8, true));
    const bodyF = ctx.createBiquadFilter();
    bodyF.type = "lowpass";
    bodyF.frequency.value = 900;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    rainSrc.connect(hp).connect(this.rainGain);
    body.connect(bodyF).connect(this.rainGain);
    this.rainGain.connect(this.master);

    this.stepNoise = noiseBuffer(ctx, 0.3);

    // flyer engine: detuned saws plus rotor wash
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = "lowpass";
    this.engineFilter.frequency.value = 600;
    this.engineFilter.connect(this.engineGain).connect(this.master);
    for (const [f, type] of [[74, "sawtooth"], [74.9, "sawtooth"], [148, "triangle"]] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = type === "triangle" ? 0.12 : 0.08;
      o.connect(g).connect(this.engineFilter);
      o.start();
      this.engineOsc.push(o);
    }
    const wash = loopSource(ctx, noiseBuffer(ctx, 5));
    this.washFilter = ctx.createBiquadFilter();
    this.washFilter.type = "bandpass";
    this.washFilter.frequency.value = 500;
    this.washFilter.Q.value = 0.8;
    const washGain = ctx.createGain();
    washGain.gain.value = 0.5;
    wash.connect(this.washFilter).connect(washGain).connect(this.engineGain);

    // distant traffic rumble from the street canyons
    const rumble = loopSource(ctx, noiseBuffer(ctx, 9, true));
    const rf = ctx.createBiquadFilter();
    rf.type = "lowpass";
    rf.frequency.value = 220;
    this.trafficGain = ctx.createGain();
    this.trafficGain.gain.value = 0;
    rumble.connect(rf).connect(this.trafficGain).connect(this.master);
  }

  /**
   * Engine sound while in a vehicle. level 0 silences it; base is the idle pitch
   * (74 Hz for a flyer, lower for a car); load raises the pitch a little.
   */
  engine(level: number, base: number, speedNorm: number, load: number): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    const t = ctx.currentTime;
    this.engineGain.gain.setTargetAtTime(level * (0.22 + 0.2 * speedNorm), t, 0.4);
    const pitch = 1 + speedNorm * (base < 60 ? 2.2 : 0.6) + Math.max(-0.15, Math.min(0.25, load));
    [base, base * 1.012, base * 2].forEach((f, i) => this.engineOsc[i].frequency.setTargetAtTime(f * pitch, t, 0.3));
    this.engineFilter.frequency.setTargetAtTime((base < 60 ? 300 : 500) + 900 * speedNorm, t, 0.3);
    this.washFilter.frequency.setTargetAtTime(400 + 700 * speedNorm, t, 0.3);
  }

  /** A bolt leaving the gun. */
  zap(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = "sawtooth";
    o.frequency.setValueAtTime(1800 + Math.random() * 300, t);
    o.frequency.exponentialRampToValueAtTime(180, t + 0.14);
    const f = ctx.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.value = 1200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.12, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    o.connect(f).connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.16);
  }

  /** An explosion at a distance (metres); size scales the blast. */
  boom(distance: number, size = 1): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    const t = ctx.currentTime + Math.min(distance / 343, 1.5); // sound travels
    const vol = Math.min(1, 40 / (distance + 20)) * size;
    if (vol < 0.02) return;
    const src = ctx.createBufferSource();
    src.buffer = this.stepNoise;
    src.playbackRate.value = 0.35;
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.setValueAtTime(2500, t);
    f.frequency.exponentialRampToValueAtTime(120, t + 0.8);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + 0.9);
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(70, t);
    o.frequency.exponentialRampToValueAtTime(28, t + 0.7);
    const og = ctx.createGain();
    og.gain.setValueAtTime(vol * 0.9, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.8);
    o.connect(og).connect(this.master);
    o.start(t);
    o.stop(t + 0.8);
  }

  stop(): void {
    void this.ctx?.suspend();
  }

  update(dt: number, p: Params, speedNorm: number, altitude: number): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    this.time += dt;
    const t = ctx.currentTime;
    const wind = 0.08 + 0.3 * p.wind + 0.25 * speedNorm + Math.min(altitude / 150, 0.3);
    const gust = 0.6 + 0.4 * Math.sin(this.time * 0.23) * Math.sin(this.time * 0.071 + 1);
    this.windGain.gain.setTargetAtTime(wind * gust, t, 0.5);
    this.windFilter.frequency.setTargetAtTime(250 + 500 * gust + 300 * speedNorm, t, 0.8);
    this.droneBright.gain.setTargetAtTime(0.5 * (1 - p.gloom), t, 2);
    this.droneDark.gain.setTargetAtTime(0.55 * p.gloom, t, 2);
    this.rainGain.gain.setTargetAtTime(0.35 * p.rain, t, 1);
    this.trafficGain.gain.setTargetAtTime(0.35 * Math.max(0, 1 - altitude / 60), t, 1);

    if (p.rain > 0.2) {
      this.dropTimer -= dt;
      if (this.dropTimer < 0) {
        this.dropTimer = Math.random() * 0.15 / p.rain;
        this.drop(0.05 * p.rain);
      }
    }
  }

  private drop(vol: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.frequency.value = 1500 + Math.random() * 3000;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 2 - 1;
    o.connect(g).connect(pan).connect(this.master);
    o.start(t);
    o.stop(t + 0.04);
  }

  step(speedNorm: number, wet: number, onMetal = false): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.stepNoise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.value = (onMetal ? 2400 : 900) + Math.random() * 400 + wet * 1500;
    f.Q.value = 0.9;
    const g = ctx.createGain();
    const vol = 0.25 + 0.45 * speedNorm;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.09 + wet * 0.05);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + 0.2);

    const thump = ctx.createOscillator();
    thump.frequency.setValueAtTime(90, t);
    thump.frequency.exponentialRampToValueAtTime(45, t + 0.08);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.35 * vol, t);
    tg.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    thump.connect(tg).connect(this.master);
    thump.start(t);
    thump.stop(t + 0.12);
  }

  landing(strength: number): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(70, t);
    o.frequency.exponentialRampToValueAtTime(35, t + 0.3);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5 + 0.5 * strength, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.4);
    this.step(1, 0);
  }
}
