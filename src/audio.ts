// Procedural ambience with Web Audio: filtered-noise wind and rain, detuned drones,
// and synthesized footsteps, with the generative score from music.ts on top. Must be
// started from a user gesture.

import { Music } from "./music";

/** A sound out in the city: where it is coming from, and how loud it is here, 0..1. */
export interface Source {
  pos: [number, number, number];
  level: number;
}

/**
 * What the city sounds like from where the listener is: the nearest train (and whether there
 * is ground between it and them), the traffic close by (and whether the road is wet), and the
 * nearest market playing.
 */
export interface CitySound {
  train: Source & { muffled: boolean };
  road: Source & { wet: number };
  market: Source;
}

interface Params {
  wind: number;
  gloom: number;
  rain: number;
  night: number;
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
  /** Brown noise, long enough for one roll of thunder. */
  private thunderNoise!: AudioBuffer;
  private engineGain!: GainNode;
  private engineFilter!: BiquadFilterNode;
  private engineOsc: OscillatorNode[] = [];
  private washFilter!: BiquadFilterNode;
  private trafficGain!: GainNode;
  /** The positioned sources: see `city`. */
  private trainBus!: { gain: GainNode; filter: BiquadFilterNode; pan: PannerNode; clack: GainNode };
  private roadBus!: { gain: GainNode; hiss: GainNode; pan: PannerNode };
  private marketBus!: { gain: GainNode; pan: PannerNode };
  private marketNext = 0;
  private marketStep = 0;
  private marketNote = 0;
  private dropTimer = 0;
  private time = 0;
  private music: Music | null = null;
  /** The score has a fader of its own, beside `master`, which carries everything else. */
  private musicBus!: GainNode;
  /** Boosting in a vehicle, 0..1; the score drives harder while it is. */
  boost = 0;
  private sfxVolume = 1;
  private musicVolume = 1;

  /** `musicOn` false starts with the score off; it can still be switched on later. */
  constructor(private musicOn = true) {}

  /** Whether sound is coming out; null before `start` has been called at all. */
  get running(): boolean | null {
    return this.ctx ? this.ctx.state === "running" : null;
  }

  /** Switch the score on or off. */
  setMusic(on: boolean): void {
    this.musicOn = on;
    if (this.ctx && this.musicOn && !this.music) this.music = new Music(this.ctx, this.musicBus);
    this.music?.setOn(this.musicOn);
  }

  /** Effects and score levels, 0..1 each. */
  setVolumes(sfx: number, music: number): void {
    this.sfxVolume = sfx;
    this.musicVolume = music;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(sfx, t, 0.05);
    this.musicBus.gain.setTargetAtTime(music, t, 0.05);
  }

  start(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    // everything fades up together from silence
    const fadeIn = ctx.createGain();
    fadeIn.gain.value = 0;
    fadeIn.gain.linearRampToValueAtTime(0.9, ctx.currentTime + 3);
    const comp = ctx.createDynamicsCompressor();
    fadeIn.connect(comp).connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.gain.value = this.sfxVolume;
    this.master.connect(fadeIn);
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = this.musicVolume;
    this.musicBus.connect(fadeIn);

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
    this.thunderNoise = noiseBuffer(ctx, 8, true);

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

    // Sources out in the city, each through a panner that only says which way it is: how loud
    // it is is worked out from the city itself (see `city`), not from the panner's own rolloff.
    const panner = () => {
      const pn = ctx.createPanner();
      pn.panningModel = "equalpower";
      pn.distanceModel = "linear";
      pn.rolloffFactor = 0;
      pn.connect(this.master);
      return pn;
    };
    {
      // a train: a low roar with the beat of the rail joints in it
      const src = loopSource(ctx, noiseBuffer(ctx, 6, true));
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 300;
      const clack = ctx.createGain();
      clack.gain.value = 0.7;
      const beat = ctx.createOscillator();
      beat.type = "square";
      beat.frequency.value = 2.6;
      const depth = ctx.createGain();
      depth.gain.value = 0.3;
      beat.connect(depth).connect(clack.gain);
      beat.start();
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const pan = panner();
      src.connect(filter).connect(clack).connect(gain).connect(pan);
      this.trainBus = { gain, filter, pan, clack };
    }
    {
      // the road: the rumble of engines and the hiss of tyres, which the wet makes louder
      const low = loopSource(ctx, noiseBuffer(ctx, 7, true));
      const lf = ctx.createBiquadFilter();
      lf.type = "lowpass";
      lf.frequency.value = 260;
      const hissSrc = loopSource(ctx, noiseBuffer(ctx, 5));
      const hf = ctx.createBiquadFilter();
      hf.type = "bandpass";
      hf.frequency.value = 2600;
      hf.Q.value = 0.6;
      const hiss = ctx.createGain();
      hiss.gain.value = 0.15;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const pan = panner();
      low.connect(lf).connect(gain);
      hissSrc.connect(hf).connect(hiss).connect(gain);
      gain.connect(pan);
      this.roadBus = { gain, hiss, pan };
    }
    {
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 2400;
      const pan = panner();
      gain.connect(lp).connect(pan);
      this.marketBus = { gain, pan };
    }

    if (this.musicOn) this.music = new Music(ctx, this.musicBus);
  }

  /**
   * The city around the listener, standing at `eye` and looking along `fwd`: each source is
   * turned to come from where it is, and brought up or down to how loud it is from here.
   */
  city(c: CitySound, eye: [number, number, number], fwd: [number, number, number]): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    const t = ctx.currentTime;
    const L = ctx.listener;
    if (L.positionX) {
      L.positionX.setValueAtTime(eye[0], t);
      L.positionY.setValueAtTime(eye[1], t);
      L.positionZ.setValueAtTime(eye[2], t);
      L.forwardX.setValueAtTime(fwd[0], t);
      L.forwardY.setValueAtTime(fwd[1], t);
      L.forwardZ.setValueAtTime(fwd[2], t);
      L.upX.setValueAtTime(0, t);
      L.upY.setValueAtTime(1, t);
      L.upZ.setValueAtTime(0, t);
    } else {
      L.setPosition(eye[0], eye[1], eye[2]);
      L.setOrientation(fwd[0], fwd[1], fwd[2], 0, 1, 0);
    }
    const place = (pn: PannerNode, at: [number, number, number]) => {
      if (pn.positionX) {
        pn.positionX.setTargetAtTime(at[0], t, 0.1);
        pn.positionY.setTargetAtTime(at[1], t, 0.1);
        pn.positionZ.setTargetAtTime(at[2], t, 0.1);
      } else pn.setPosition(at[0], at[1], at[2]);
    };
    const { train, road, market } = c;
    place(this.trainBus.pan, train.pos);
    // through the ground it is all roar and no rattle
    this.trainBus.gain.gain.setTargetAtTime(0.75 * train.level, t, 0.3);
    this.trainBus.filter.frequency.setTargetAtTime(train.muffled ? 110 : 420, t, 0.5);
    place(this.roadBus.pan, road.pos);
    this.roadBus.gain.gain.setTargetAtTime(0.55 * road.level, t, 0.4);
    this.roadBus.hiss.gain.setTargetAtTime(0.12 + 0.55 * road.wet, t, 1);
    place(this.marketBus.pan, market.pos);
    this.marketBus.gain.gain.setTargetAtTime(0.5 * market.level, t, 0.6);
    if (market.level > 0.01) this.busk(t);
    else this.marketNext = 0;
  }

  /**
   * Someone playing in a market: a squeezebox tune wandering up and down A minor pentatonic over
   * a bass on the beat, scheduled a little ahead like the score is.
   */
  private busk(t: number): void {
    const ctx = this.ctx!;
    const STEP = 0.22;
    if (this.marketNext < t) this.marketNext = t + 0.05;
    const scale = [57, 60, 62, 64, 67, 69, 72, 74, 76];
    while (this.marketNext < t + 0.4) {
      const at = this.marketNext, step = this.marketStep++;
      const voice = (midi: number, len: number, vol: number, kind: OscillatorType) => {
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, at);
        g.gain.exponentialRampToValueAtTime(vol, at + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, at + len);
        g.connect(this.marketBus.gain);
        for (const d of [-4, 4]) {
          const o = ctx.createOscillator();
          o.type = kind;
          o.frequency.value = 440 * Math.pow(2, (midi - 69) / 12);
          o.detune.value = d;
          o.connect(g);
          o.start(at);
          o.stop(at + len + 0.05);
        }
      };
      // the tune: a step or two at a time, now and then a rest or a leap
      if (Math.random() > 0.18) {
        this.marketNote = Math.max(0, Math.min(scale.length - 1, this.marketNote + Math.round((Math.random() - 0.5) * 3.2)));
        voice(scale[this.marketNote], STEP * (Math.random() < 0.25 ? 2 : 1.1), 0.09, "sawtooth");
      }
      if (step % 4 === 0) voice(step % 16 < 8 ? 45 : 43, STEP * 2.2, 0.12, "triangle");
      this.marketNext += STEP;
    }
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

  /** A bolt leaving a gun; hunters' guns are pitched lower and fade with distance. */
  zap(volume = 1, pitch = 1): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = "sawtooth";
    o.frequency.setValueAtTime((1800 + Math.random() * 300) * pitch, t);
    o.frequency.exponentialRampToValueAtTime(180 * pitch, t + 0.14);
    const f = ctx.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.value = 1200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.12 * volume, t);
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

  /**
   * Thunder from a strike `distance` metres off, arriving as late as sound that far away
   * would. Close, it opens with a crack and a slam; far off it is only the roll — lower,
   * softer and longer, the high end taken out by the miles of air it came through.
   */
  thunder(distance: number): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    const t = ctx.currentTime + Math.min(distance / 343, 9);
    const near = Math.max(0, 1 - distance / 1400);
    // Loud: it has to come through the rain, which is a wall of hiss at the same time. Most of
    // its weight is down where the rain has none, and the compressor on the way out pulls the
    // rest of the mix down under it, the way a clap overhead drowns everything else.
    const vol = Math.min(2.6, 2200 / (distance + 350));
    const len = 3.5 + (distance / 3500) * 4 + Math.random() * 1.5;
    if (near > 0.05) {
      // the crack: a burst of bright noise, gone in a fraction of a second
      const crack = ctx.createBufferSource();
      crack.buffer = this.stepNoise;
      crack.playbackRate.value = 0.7;
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 900;
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(0.0001, t);
      cg.gain.exponentialRampToValueAtTime(0.5 * near * vol, t + 0.01);
      cg.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
      crack.connect(hp).connect(cg).connect(this.master);
      crack.start(t);
      crack.stop(t + 0.32);
    }
    // the roll: low noise swelling in and dying away in a few uneven surges
    const src = ctx.createBufferSource();
    src.buffer = this.thunderNoise;
    src.playbackRate.value = 0.55 + Math.random() * 0.25;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(600 + 1400 * near, t);
    lp.frequency.exponentialRampToValueAtTime(90, t + len);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol * (0.6 + 0.4 * near), t + 0.08 + 0.5 * (1 - near));
    let at = t + 0.4 + 0.5 * (1 - near);
    for (let k = 0; k < 3 && at < t + len - 1; k++) {
      // a surge, and a sag after it
      g.gain.exponentialRampToValueAtTime(vol * (0.35 + Math.random() * 0.5), at);
      at += 0.5 + Math.random() * 0.9;
    }
    g.gain.exponentialRampToValueAtTime(0.001, t + len);
    src.connect(lp).connect(g).connect(this.master);
    src.start(t, Math.random() * 2);
    src.stop(t + len + 0.1);
    // and under all of it a sub-bass shudder, felt as much as heard
    const sub = ctx.createOscillator();
    sub.frequency.setValueAtTime(48 + 20 * near, t);
    sub.frequency.exponentialRampToValueAtTime(30, t + len * 0.7);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.0001, t);
    sg.gain.exponentialRampToValueAtTime(vol * 0.5, t + 0.15 + 0.4 * (1 - near));
    sg.gain.exponentialRampToValueAtTime(0.001, t + len * 0.8);
    sub.connect(sg).connect(this.master);
    sub.start(t);
    sub.stop(t + len);
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
    // the drones step back under the score, which carries the harmony
    const drones = this.musicOn ? 0.35 : 1;
    this.droneBright.gain.setTargetAtTime(0.5 * (1 - p.gloom) * drones, t, 2);
    this.droneDark.gain.setTargetAtTime(0.55 * p.gloom * drones, t, 2);
    if (this.musicOn) this.music?.update({ ...p, boost: this.boost });
    this.rainGain.gain.setTargetAtTime(0.35 * p.rain, t, 1);
    // the city's far-off murmur under the traffic close by, which comes from where it is (see `city`)
    this.trafficGain.gain.setTargetAtTime(0.18 * Math.max(0, 1 - altitude / 60), t, 1);

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

  /** Taking a hit. */
  hurt(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.stepNoise;
    src.playbackRate.value = 0.8;
    const f = ctx.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.value = 900;
    f.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + 0.2);
    const o = ctx.createOscillator();
    o.type = "triangle";
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(50, t + 0.2);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.4, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    o.connect(og).connect(this.master);
    o.start(t);
    o.stop(t + 0.24);
  }

  /** A health kit taken: two soft rising notes. */
  heal(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    const t = ctx.currentTime;
    for (const [at, freq] of [[0, 520], [0.09, 780]]) {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.setValueAtTime(freq, t + at);
      o.frequency.exponentialRampToValueAtTime(freq * 1.06, t + at + 0.25);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + at);
      g.gain.exponentialRampToValueAtTime(0.22, t + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + at + 0.35);
      o.connect(g).connect(this.master);
      o.start(t + at);
      o.stop(t + at + 0.4);
    }
  }

  /**
   * A job's moments, as a few soft bell notes: something taken, handed over, a lamp lit, the
   * job done (rising), or lost (falling).
   */
  chime(kind: "take" | "give" | "done" | "fail" | "lamp"): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    const t = ctx.currentTime;
    const notes: Record<typeof kind, number[]> = {
      take: [440, 660], give: [660, 440], lamp: [880], done: [523, 659, 784, 1047], fail: [392, 330, 262],
    };
    notes[kind].forEach((freq, i) => {
      const at = t + i * 0.11;
      const o = ctx.createOscillator();
      o.type = "triangle";
      o.frequency.setValueAtTime(freq, at);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.16, at + 0.015);
      g.gain.exponentialRampToValueAtTime(0.001, at + (kind === "done" ? 0.9 : 0.5));
      o.connect(g).connect(this.master);
      o.start(at);
      o.stop(at + 1);
    });
  }

  /** Water: going into it (`strength` towards 1), or a stroke through it (a tenth or so). */
  splash(strength: number): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    const t = ctx.currentTime;
    const len = 0.15 + 0.6 * strength;
    const src = ctx.createBufferSource();
    src.buffer = this.stepNoise;
    src.loop = true;
    src.playbackRate.value = 0.5 + Math.random() * 0.3;
    const f = ctx.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.setValueAtTime(700 + 900 * strength, t);
    f.frequency.exponentialRampToValueAtTime(300, t + len);
    f.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25 + 0.9 * strength, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + len);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + len + 0.05);
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
