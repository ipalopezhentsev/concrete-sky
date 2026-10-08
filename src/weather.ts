// Weather and mood: named states that blend smoothly into each other.
//
// A state no longer says where the sun is or what colour the sky is — the clock does that
// (src/daylight.ts). A state says what the air between you and the sky is doing: how much
// cloud, how far it flattens and greys what is behind it, how much of the sun gets
// through, how thick the haze is. So the same overcast is a white glare at noon, a dull
// brown smear at sunset and a lid over a dark city at two in the morning, from one entry.

import { clamp, lerp, lerp3, smooth, type Vec3 } from "./math";
import { clockText, daylight, DAY_SECONDS, type Daylight, wrapHour, hourAtElevation } from "./daylight";

interface State {
  cloudCover: number;
  cloudDark: number;
  cloudSpeed: number;
  /**
   * How far the deck flattens the sky towards one shade: 0 leaves the clock's own gradient
   * alone. The shade is the sky's own brightness times the tints below, so it tracks the
   * hour by itself — an overcast midnight comes out of the same three numbers as an
   * overcast noon.
   */
  flatten: number;
  zenithTint: Vec3;
  horizonTint: Vec3;
  groundTint: Vec3;
  /** Multipliers on the daylight: the direct sun (or moon), its glow, the sky fill. */
  sun: number;
  glow: number;
  ambient: number;
  /** Gloom dark enough to bring the lamps on before dusk. */
  lamps: number;
  fogDensity: number;
  fogTint: number;
  mist: number;
  rain: number;
  /** How often lightning strikes: 1 is a thunderstorm, a strike every ten seconds or so. */
  thunder: number;
  wind: number;
  gloom: number;
  exposure: number;
  saturation: number;
  contrast: number;
  grade: Vec3;
  weight: number;
}

export const STATES: Record<string, State> = {
  "clear sky": {
    cloudCover: 0.42, cloudDark: 0.1, cloudSpeed: 1.0,
    flatten: 0, zenithTint: [1, 1, 1], horizonTint: [1, 1, 1], groundTint: [1, 1, 1],
    sun: 1.0, glow: 1.0, ambient: 1.0, lamps: 0,
    fogDensity: 0.0012, fogTint: 0.1, mist: 0.004, rain: 0, thunder: 0, wind: 0.35, gloom: 0,
    exposure: 1.0, saturation: 1.1, contrast: 1.1, grade: [1, 1, 1], weight: 5,
  },
  "drifting cumulus": {
    cloudCover: 0.6, cloudDark: 0.35, cloudSpeed: 1.6,
    flatten: 0.08, zenithTint: [1, 1, 1.05], horizonTint: [1, 1, 1.02], groundTint: [0.95, 0.95, 0.96],
    sun: 1.03, glow: 1.0, ambient: 1.0, lamps: 0,
    fogDensity: 0.0015, fogTint: 0.15, mist: 0.005, rain: 0, thunder: 0, wind: 0.5, gloom: 0.15,
    exposure: 1.05, saturation: 1.05, contrast: 1.08, grade: [1, 1, 1.02], weight: 4,
  },
  "hard light": {
    // Scoured air: barely a cloud, next to no haze, and shadows with a hard edge.
    cloudCover: 0.12, cloudDark: 0.15, cloudSpeed: 0.7,
    flatten: 0, zenithTint: [1, 1, 1], horizonTint: [1, 1, 1], groundTint: [1, 1, 1],
    sun: 1.12, glow: 0.85, ambient: 0.85, lamps: 0,
    fogDensity: 0.0006, fogTint: 0.05, mist: 0.002, rain: 0, thunder: 0, wind: 0.2, gloom: 0,
    exposure: 0.95, saturation: 1.15, contrast: 1.16, grade: [1.01, 1, 0.99], weight: 3,
  },
  "high haze": {
    // A thin veil drawn over the whole sky: it pales out without darkening anything.
    cloudCover: 0.25, cloudDark: 0.05, cloudSpeed: 0.6,
    flatten: 0.55, zenithTint: [1.1, 1.15, 1.3], horizonTint: [1.06, 1.08, 1.12], groundTint: [1.06, 1.04, 1.0],
    sun: 1.0, glow: 1.25, ambient: 1.15, lamps: 0,
    fogDensity: 0.0022, fogTint: 0.3, mist: 0.004, rain: 0, thunder: 0, wind: 0.25, gloom: 0,
    exposure: 0.92, saturation: 0.9, contrast: 1.1, grade: [1.02, 1.01, 0.98], weight: 3,
  },
  overcast: {
    cloudCover: 0.96, cloudDark: 0.45, cloudSpeed: 1.2,
    flatten: 1, zenithTint: [1.63, 1.85, 2.17], horizonTint: [0.96, 1.02, 1.08], groundTint: [0.73, 0.73, 0.77],
    sun: 0.15, glow: 0.3, ambient: 2.45, lamps: 0.05,
    fogDensity: 0.0035, fogTint: 0.6, mist: 0.012, rain: 0, thunder: 0, wind: 0.55, gloom: 0.6,
    exposure: 1.22, saturation: 0.72, contrast: 1.02, grade: [0.98, 1, 1.03], weight: 3,
  },
  rain: {
    cloudCover: 1.0, cloudDark: 0.85, cloudSpeed: 2.4,
    flatten: 1, zenithTint: [0.76, 0.87, 1.09], horizonTint: [0.52, 0.57, 0.64], groundTint: [0.4, 0.4, 0.43],
    sun: 0.08, glow: 0.1, ambient: 2.2, lamps: 0.25,
    fogDensity: 0.005, fogTint: 0.8, mist: 0.016, rain: 1, thunder: 0.2, wind: 0.9, gloom: 1,
    exposure: 1.4, saturation: 0.65, contrast: 1.08, grade: [0.94, 0.99, 1.06], weight: 2,
  },
  thunderstorm: {
    // The rain, under a lower and blacker deck, with the lightning in it.
    cloudCover: 1.0, cloudDark: 0.97, cloudSpeed: 3.2,
    flatten: 1, zenithTint: [0.62, 0.72, 0.95], horizonTint: [0.44, 0.48, 0.56], groundTint: [0.34, 0.34, 0.38],
    sun: 0.05, glow: 0.06, ambient: 1.9, lamps: 0.4,
    fogDensity: 0.0055, fogTint: 0.85, mist: 0.018, rain: 1, thunder: 1, wind: 1, gloom: 1,
    exposure: 1.38, saturation: 0.6, contrast: 1.12, grade: [0.93, 0.98, 1.07], weight: 1.5,
  },
  fog: {
    cloudCover: 0.75, cloudDark: 0.2, cloudSpeed: 0.3,
    flatten: 1, zenithTint: [2.83, 3.1, 3.48], horizonTint: [1.2, 1.26, 1.31], groundTint: [1.33, 1.37, 1.4],
    sun: 0.27, glow: 0.8, ambient: 1.8, lamps: 0.1,
    fogDensity: 0.011, fogTint: 1.0, mist: 0.022, rain: 0, thunder: 0, wind: 0.15, gloom: 0.7,
    exposure: 1.05, saturation: 0.6, contrast: 0.95, grade: [0.98, 1, 1.02], weight: 2,
  },
  "storm light": {
    // Black cloud overhead with the sun still under its edge: the whole point is contrast.
    cloudCover: 0.72, cloudDark: 0.95, cloudSpeed: 3.0,
    flatten: 0.85, zenithTint: [0.82, 0.92, 1.25], horizonTint: [0.77, 0.72, 0.69], groundTint: [0.6, 0.57, 0.57],
    sun: 1.25, glow: 1.2, ambient: 2.35, lamps: 0.1,
    fogDensity: 0.003, fogTint: 0.4, mist: 0.012, rain: 0.15, thunder: 0, wind: 1, gloom: 0.9,
    exposure: 1.12, saturation: 0.9, contrast: 1.12, grade: [1.02, 1, 0.98], weight: 2,
  },
};

export const ORDER = Object.keys(STATES);

/**
 * Names that were weather states before the city had a clock, and are really times of day.
 * They still work — as a state plus an hour — so older links and screenshot runs land on
 * the picture they asked for.
 */
export const MOMENTS: Record<string, { weather: string; hour: number }> = {
  dawn: { weather: "clear sky", hour: hourAtElevation(-4.5, false) },
  sunrise: { weather: "clear sky", hour: hourAtElevation(1, false) },
  "white noon": { weather: "high haze", hour: 12 },
  "golden hour": { weather: "clear sky", hour: hourAtElevation(7, true) },
  sunset: { weather: "clear sky", hour: hourAtElevation(1, true) },
  "blue hour": { weather: "clear sky", hour: hourAtElevation(-4.5, true) },
  midnight: { weather: "clear sky", hour: 0 },
};

/**
 * Where the clock starts: mid-afternoon, so a session of any length runs down through the
 * long light, the golden hour and dusk before the city goes dark. `?time=` overrides it.
 */
export const START_HOUR = 15.5;

/** A resolved sky: the clock and the weather, together, as everything downstream reads it. */
export interface Look {
  sunColor: Vec3;
  sunInt: number;
  sunGlow: number;
  zenith: Vec3;
  horizon: Vec3;
  ground: Vec3;
  ambient: number;
  night: number;
  cloudCover: number;
  cloudDark: number;
  cloudSpeed: number;
  fogColor: Vec3;
  fogDensity: number;
  fogTint: number;
  mist: number;
  rain: number;
  thunder: number;
  wind: number;
  gloom: number;
  exposure: number;
  saturation: number;
  contrast: number;
  grade: Vec3;
}

function blend(a: State, b: State, t: number): State {
  const out = { ...a };
  for (const k of Object.keys(a) as (keyof State)[]) {
    const va = a[k], vb = b[k];
    (out as Record<string, unknown>)[k] = Array.isArray(va)
      ? lerp3(va as Vec3, vb as Vec3, t)
      : lerp(va as number, vb as number, t);
  }
  return out;
}

const LUMA: Vec3 = [0.2126, 0.7152, 0.0722];

/** Flatten a sky colour towards its own brightness times a tint — see `State.flatten`. */
function flatten(c: Vec3, tint: Vec3, amount: number): Vec3 {
  const lum = c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2];
  return lerp3(c, [lum * tint[0], lum * tint[1], lum * tint[2]], amount);
}

/**
 * A weather's lift on the ambient and on the exposure is compensation for daylight the
 * cloud has taken away — at night there is none left to take, and the two lifts stacked on
 * the ones the dark hours already carry would wash the lamps out. So both fade as the night
 * comes in: the exposure almost entirely, the ambient only most of the way, because a lid
 * of cloud over a lit city really does hold some glow down in the streets.
 */
function resolve(d: Daylight, w: State): Look {
  const ambient = lerp(w.ambient, 1, 0.7 * d.night);
  const exposure = lerp(w.exposure, 1, 0.85 * d.night);
  return {
    sunColor: d.sunColor,
    sunInt: d.sunInt * w.sun,
    sunGlow: d.sunGlow * w.glow,
    zenith: flatten(d.zenith, w.zenithTint, w.flatten),
    horizon: flatten(d.horizon, w.horizonTint, w.flatten),
    ground: flatten(d.ground, w.groundTint, w.flatten),
    ambient: d.ambient * ambient,
    night: clamp(d.night + w.lamps, 0, 1),
    cloudCover: w.cloudCover,
    cloudDark: w.cloudDark,
    cloudSpeed: w.cloudSpeed,
    fogColor: flatten(d.fog, w.horizonTint, w.flatten),
    fogDensity: w.fogDensity,
    fogTint: w.fogTint,
    mist: w.mist,
    rain: w.rain,
    thunder: w.thunder * clamp((w.rain - 0.5) * 2, 0, 1),
    wind: w.wind,
    gloom: w.gloom,
    exposure: d.exposure * exposure,
    saturation: w.saturation,
    contrast: w.contrast,
    grade: w.grade,
  };
}

export class Weather {
  private src: State;
  private dst: State;
  private state: State;
  private blendT = 1;
  private blendTime = 20;
  private hold = 50 + Math.random() * 30;
  /** Local solar time, in hours; noon is the sun at its highest. */
  hour: number;
  /** Real seconds in a full day. 0 stops the clock where it stands. */
  dayLength = DAY_SECONDS;
  /** The clock runs (L holds the weather, K holds the clock). */
  running = true;
  sky: Daylight;
  params: Look;
  wet: number;
  cycle = true;
  name: string;
  changed: string | null;
  private cloudOffset: [number, number] = [Math.random() * 10, Math.random() * 10];
  /**
   * Lightning: how bright the flash is right now (0 none, about 1 a near strike), and the bolt
   * that made it, if it came down where it can be seen — which way, how high it reaches into
   * the sky, how bright, and which of all the jagged shapes it is.
   */
  flash = 0;
  bolt: [number, number, number, number] = [0, 0, 0, 0];
  /** How far off each strike since the last frame was, in metres, for the thunder to follow. */
  readonly strikes: number[] = [];
  /** Where lightning came down on a mast since the last frame, for the sparks. */
  readonly hits: Vec3[] = [];
  /** How low the bolt comes down the sky: the horizon, or the top of the mast it struck. */
  boltLow = 0;
  /**
   * The windows round a struck mast going dark: where (x, z), how far out, and how far out
   * they are right now, 0..1 — off for a few seconds, then flickering back on.
   */
  outage: [number, number, number, number] = [0, 0, 0, 0];
  private outageAge = Infinity;
  private outageFor = 0;
  /** Where the eye is, and the masts near it that lightning can find; set from outside. */
  eye: Vec3 = [0, 0, 0];
  masts: Vec3[] = [];
  private strikeIn = 4 + Math.random() * 8;
  private strike: { age: number; pulses: number[]; strength: number; seen: boolean } | null = null;

  constructor(start = "clear sky", hour = START_HOUR) {
    this.name = start;
    this.src = this.dst = this.state = STATES[start];
    this.hour = wrapHour(hour);
    this.sky = daylight(this.hour);
    this.params = resolve(this.sky, this.state);
    this.wet = this.params.rain;
    this.changed = start;
  }

  goTo(name: string, duration: number): void {
    this.src = this.state;
    this.dst = STATES[name];
    this.name = name;
    this.blendT = 0;
    this.blendTime = duration;
    this.hold = 45 + Math.random() * 45;
    this.changed = name;
  }

  next(duration = 6): void {
    this.goTo(ORDER[(ORDER.indexOf(this.name) + 1) % ORDER.length], duration);
  }

  /** Wind the clock on (or back) by hours, without touching the weather. */
  skip(hours: number): void {
    this.hour = wrapHour(this.hour + hours);
  }

  /** "14:35". */
  get clock(): string {
    return clockText(this.hour);
  }

  private pickNext(): string {
    const names = ORDER.filter((n) => n !== this.name);
    const total = names.reduce((s, n) => s + STATES[n].weight, 0);
    let x = Math.random() * total;
    for (const n of names) {
      x -= STATES[n].weight;
      if (x <= 0) return n;
    }
    return names[0];
  }

  update(dt: number): void {
    if (this.running && this.dayLength > 0) this.hour = wrapHour(this.hour + (dt / this.dayLength) * 24);
    if (this.blendT < 1) this.blendT = Math.min(1, this.blendT + dt / this.blendTime);
    else if (this.cycle) {
      this.hold -= dt;
      if (this.hold <= 0) this.goTo(this.pickNext(), 15 + Math.random() * 15);
    }
    this.state = blend(this.src, this.dst, smooth(this.blendT));
    this.sky = daylight(this.hour);
    this.params = resolve(this.sky, this.state);
    const p = this.params;
    const rate = p.rain > this.wet ? 0.36 : 0.075;
    this.wet += (p.rain - this.wet) * Math.min(1, dt * rate);
    this.lightning(dt);
    this.cloudOffset[0] = (this.cloudOffset[0] + dt * 0.0022 * p.cloudSpeed * 0.8) % 64;
    this.cloudOffset[1] = (this.cloudOffset[1] + dt * 0.0022 * p.cloudSpeed * 0.6) % 64;
  }

  /**
   * Strikes now and then while there is thunder about, a few seconds to half a minute apart,
   * each one a flash of two or three flickers. Most come down somewhere it can be seen; the
   * rest are in the cloud and only light it up.
   */
  /**
   * A strike `distance` metres off, in the direction `az` (radians, as `atan2(x, z)`): the
   * flash now, the thunder once the sound gets here. `seen` false is lightning in the cloud,
   * which lights everything up and shows no bolt. `pulses` is how many times it flickers.
   */
  strikeNow(distance: number, az: number, seen = true, pulses = 1 + Math.floor(Math.random() * 2.5)): void {
    const at = [0];
    for (let k = pulses; k > 0; k--) at.push(at[at.length - 1] + 0.05 + Math.random() * 0.18);
    this.strike = { age: 0, pulses: at, strength: clamp(1.25 - distance / 3200, 0.25, 1), seen };
    // high in the sky when it is close, a thread on the horizon when it is far
    this.bolt = [az, clamp(Math.atan(1100 / distance), 0.14, 0.75), 0, Math.random()];
    this.boltLow = 0;
    this.strikes.push(distance);
  }

  /** A mast in view to strike, between a few hundred metres and a couple of kilometres off. */
  private pickMast(): Vec3 | null {
    const e = this.eye;
    const fit = this.masts.filter((m) => {
      const d = Math.hypot(m[0] - e[0], m[2] - e[2]);
      return d > 250 && d < 2200;
    });
    return fit.length ? fit[Math.floor(Math.random() * fit.length)] : null;
  }

  /**
   * Lightning down onto the tip of a mast: the bolt comes out of the cloud and ends on it, it
   * throws sparks, and the windows round it go dark for a few seconds.
   */
  strikeMast(m: Vec3): void {
    const e = this.eye;
    const dx = m[0] - e[0], dz = m[2] - e[2], flat = Math.hypot(dx, dz);
    this.strikeNow(Math.hypot(flat, m[1] - e[1]), Math.atan2(dx, dz), true, 2 + Math.floor(Math.random() * 2));
    this.boltLow = Math.atan2(m[1] - e[1], flat);
    this.bolt[1] = Math.max(this.bolt[1], this.boltLow + 0.18);
    this.hits.push(m);
    this.outage = [m[0], m[2], 110 + Math.random() * 90, 1];
    this.outageAge = 0;
    this.outageFor = 2.5 + Math.random() * 4;
  }

  private lightning(dt: number): void {
    // the lights coming back after a strike: out, then a stutter, then on
    this.outageAge += dt;
    const back = this.outageAge - this.outageFor;
    this.outage[3] = back < 0 ? 1 : back < 1.2 ? (Math.sin(back * 37) > 0.2 - back ? 1 : 0) * (1 - back / 1.2) : 0;
    const th = this.params.thunder;
    if (th > 0.02) {
      this.strikeIn -= dt * th;
      if (this.strikeIn <= 0) {
        this.strikeIn = 5 + Math.random() * 22;
        // the tallest things about draw some of it down on themselves
        const mast = Math.random() < 0.4 ? this.pickMast() : null;
        if (mast) this.strikeMast(mast);
        else this.strikeNow(350 + Math.pow(Math.random(), 0.7) * 3200, Math.random() * Math.PI * 2, Math.random() < 0.65);
      }
    }
    const st = this.strike;
    if (!st) {
      this.flash = 0;
      this.bolt[2] = 0;
      return;
    }
    st.age += dt;
    let f = 0;
    for (const p of st.pulses) if (st.age >= p) f = Math.max(f, Math.exp(-(st.age - p) / 0.07));
    this.flash = f * st.strength;
    this.bolt[2] = st.seen ? this.flash : 0;
    if (st.age > st.pulses[st.pulses.length - 1] + 0.6) this.strike = null;
  }

  uniforms(): Record<string, number | number[]> {
    const p = this.params;
    // The flash is added light rather than a multiple of what is there: by day it is a blink
    // in a grey sky, at night it turns the whole city blue-white for an instant.
    const f = this.flash;
    const lit = (c: Vec3, k: number): Vec3 => [c[0] + 0.75 * k * f, c[1] + 0.8 * k * f, c[2] + 1.0 * k * f];
    return {
      uSunDir: this.sky.sunDir,
      uLightDir: this.sky.lightDir,
      uSunColor: p.sunColor.map((c) => c * p.sunInt),
      uZenith: lit(p.zenith, 1.6),
      uHorizon: lit(p.horizon, 1.2),
      uGroundCol: lit(p.ground, 0.5),
      uSunGlow: p.sunGlow,
      uAmbient: p.ambient + 0.9 * f,
      uBolt: this.bolt,
      uBoltLow: this.boltLow,
      uOutage: this.outage,
      uCloudCover: p.cloudCover,
      uCloudDark: p.cloudDark,
      uCloudOffset: this.cloudOffset,
      uFogColor: lit(p.fogColor, 0.8),
      uFogDensity: p.fogDensity,
      uFogTint: p.fogTint,
      uMist: p.mist,
      uNight: p.night,
      uMoon: this.sky.moon,
      uWet: Math.min(this.wet * 1.2, 1),
    };
  }

  postUniforms(): Record<string, number | number[]> {
    const p = this.params;
    return {
      uExposure: p.exposure,
      uSaturation: p.saturation,
      uContrast: p.contrast,
      uGrade: p.grade,
      uBloom: 0.6 + 0.8 * p.night,
    };
  }
}
