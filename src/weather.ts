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
    fogDensity: 0.0012, fogTint: 0.1, mist: 0.004, rain: 0, wind: 0.35, gloom: 0,
    exposure: 1.0, saturation: 1.1, contrast: 1.1, grade: [1, 1, 1], weight: 5,
  },
  "drifting cumulus": {
    cloudCover: 0.6, cloudDark: 0.35, cloudSpeed: 1.6,
    flatten: 0.08, zenithTint: [1, 1, 1.05], horizonTint: [1, 1, 1.02], groundTint: [0.95, 0.95, 0.96],
    sun: 1.03, glow: 1.0, ambient: 1.0, lamps: 0,
    fogDensity: 0.0015, fogTint: 0.15, mist: 0.005, rain: 0, wind: 0.5, gloom: 0.15,
    exposure: 1.05, saturation: 1.05, contrast: 1.08, grade: [1, 1, 1.02], weight: 4,
  },
  "hard light": {
    // Scoured air: barely a cloud, next to no haze, and shadows with a hard edge.
    cloudCover: 0.12, cloudDark: 0.15, cloudSpeed: 0.7,
    flatten: 0, zenithTint: [1, 1, 1], horizonTint: [1, 1, 1], groundTint: [1, 1, 1],
    sun: 1.12, glow: 0.85, ambient: 0.85, lamps: 0,
    fogDensity: 0.0006, fogTint: 0.05, mist: 0.002, rain: 0, wind: 0.2, gloom: 0,
    exposure: 0.95, saturation: 1.15, contrast: 1.16, grade: [1.01, 1, 0.99], weight: 3,
  },
  "high haze": {
    // A thin veil drawn over the whole sky: it pales out without darkening anything.
    cloudCover: 0.25, cloudDark: 0.05, cloudSpeed: 0.6,
    flatten: 0.55, zenithTint: [1.1, 1.15, 1.3], horizonTint: [1.06, 1.08, 1.12], groundTint: [1.06, 1.04, 1.0],
    sun: 1.0, glow: 1.25, ambient: 1.15, lamps: 0,
    fogDensity: 0.0022, fogTint: 0.3, mist: 0.004, rain: 0, wind: 0.25, gloom: 0,
    exposure: 0.92, saturation: 0.9, contrast: 1.1, grade: [1.02, 1.01, 0.98], weight: 3,
  },
  overcast: {
    cloudCover: 0.96, cloudDark: 0.45, cloudSpeed: 1.2,
    flatten: 1, zenithTint: [1.63, 1.85, 2.17], horizonTint: [0.96, 1.02, 1.08], groundTint: [0.73, 0.73, 0.77],
    sun: 0.15, glow: 0.3, ambient: 2.45, lamps: 0.05,
    fogDensity: 0.0035, fogTint: 0.6, mist: 0.012, rain: 0, wind: 0.55, gloom: 0.6,
    exposure: 1.22, saturation: 0.72, contrast: 1.02, grade: [0.98, 1, 1.03], weight: 3,
  },
  rain: {
    cloudCover: 1.0, cloudDark: 0.85, cloudSpeed: 2.4,
    flatten: 1, zenithTint: [0.76, 0.87, 1.09], horizonTint: [0.52, 0.57, 0.64], groundTint: [0.4, 0.4, 0.43],
    sun: 0.08, glow: 0.1, ambient: 2.2, lamps: 0.25,
    fogDensity: 0.005, fogTint: 0.8, mist: 0.016, rain: 1, wind: 0.9, gloom: 1,
    exposure: 1.4, saturation: 0.65, contrast: 1.08, grade: [0.94, 0.99, 1.06], weight: 2,
  },
  fog: {
    cloudCover: 0.75, cloudDark: 0.2, cloudSpeed: 0.3,
    flatten: 1, zenithTint: [2.83, 3.1, 3.48], horizonTint: [1.2, 1.26, 1.31], groundTint: [1.33, 1.37, 1.4],
    sun: 0.27, glow: 0.8, ambient: 1.8, lamps: 0.1,
    fogDensity: 0.011, fogTint: 1.0, mist: 0.022, rain: 0, wind: 0.15, gloom: 0.7,
    exposure: 1.05, saturation: 0.6, contrast: 0.95, grade: [0.98, 1, 1.02], weight: 2,
  },
  "storm light": {
    // Black cloud overhead with the sun still under its edge: the whole point is contrast.
    cloudCover: 0.72, cloudDark: 0.95, cloudSpeed: 3.0,
    flatten: 0.85, zenithTint: [0.82, 0.92, 1.25], horizonTint: [0.77, 0.72, 0.69], groundTint: [0.6, 0.57, 0.57],
    sun: 1.25, glow: 1.2, ambient: 2.35, lamps: 0.1,
    fogDensity: 0.003, fogTint: 0.4, mist: 0.012, rain: 0.15, wind: 1, gloom: 0.9,
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
    this.cloudOffset[0] = (this.cloudOffset[0] + dt * 0.0022 * p.cloudSpeed * 0.8) % 64;
    this.cloudOffset[1] = (this.cloudOffset[1] + dt * 0.0022 * p.cloudSpeed * 0.6) % 64;
  }

  uniforms(): Record<string, number | number[]> {
    const p = this.params;
    return {
      uSunDir: this.sky.sunDir,
      uLightDir: this.sky.lightDir,
      uSunColor: p.sunColor.map((c) => c * p.sunInt),
      uZenith: p.zenith,
      uHorizon: p.horizon,
      uGroundCol: p.ground,
      uSunGlow: p.sunGlow,
      uAmbient: p.ambient,
      uCloudCover: p.cloudCover,
      uCloudDark: p.cloudDark,
      uCloudOffset: this.cloudOffset,
      uFogColor: p.fogColor,
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
