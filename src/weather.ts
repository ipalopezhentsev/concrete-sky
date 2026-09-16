// Weather and mood: named states that blend smoothly into each other.

import { lerp, lerp3, smooth, type Vec3 } from "./math";

interface State {
  sunElev: number;
  sunAzim: number;
  sunColor: Vec3;
  sunInt: number;
  sunGlow: number;
  zenith: Vec3;
  horizon: Vec3;
  ground: Vec3;
  ambient: number;
  cloudCover: number;
  cloudDark: number;
  cloudSpeed: number;
  fogDensity: number;
  fogColor: Vec3;
  fogTint: number;
  mist: number;
  rain: number;
  night: number;
  exposure: number;
  saturation: number;
  contrast: number;
  grade: Vec3;
  wind: number;
  gloom: number;
  weight: number;
}

// All colours are linear HDR.
export const STATES: Record<string, State> = {
  "clear sky": {
    sunElev: 48, sunAzim: 35, sunColor: [1.0, 0.96, 0.88], sunInt: 3.2, sunGlow: 1.0,
    zenith: [0.05, 0.18, 0.62], horizon: [0.42, 0.6, 0.88], ground: [0.3, 0.3, 0.3],
    ambient: 0.55, cloudCover: 0.42, cloudDark: 0.1, cloudSpeed: 1.0,
    fogDensity: 0.0012, fogColor: [0.55, 0.66, 0.84], fogTint: 0.1, mist: 0.004,
    rain: 0, night: 0, exposure: 0.95, saturation: 1.1, contrast: 1.1, grade: [1, 1, 1],
    wind: 0.35, gloom: 0, weight: 5,
  },
  "drifting cumulus": {
    sunElev: 40, sunAzim: 60, sunColor: [1.0, 0.95, 0.86], sunInt: 3.4, sunGlow: 1.0,
    zenith: [0.04, 0.15, 0.55], horizon: [0.42, 0.57, 0.82], ground: [0.28, 0.28, 0.28],
    ambient: 0.55, cloudCover: 0.6, cloudDark: 0.35, cloudSpeed: 1.6,
    fogDensity: 0.0015, fogColor: [0.58, 0.68, 0.82], fogTint: 0.15, mist: 0.005,
    rain: 0, night: 0, exposure: 1.0, saturation: 1.05, contrast: 1.08, grade: [1, 1, 1.02],
    wind: 0.5, gloom: 0.15, weight: 4,
  },
  "white noon": {
    sunElev: 72, sunAzim: 10, sunColor: [1.0, 0.98, 0.94], sunInt: 3.6, sunGlow: 1.3,
    zenith: [0.16, 0.34, 0.8], horizon: [0.78, 0.84, 0.92], ground: [0.34, 0.33, 0.31],
    ambient: 0.65, cloudCover: 0.25, cloudDark: 0.05, cloudSpeed: 0.6,
    fogDensity: 0.0022, fogColor: [0.8, 0.84, 0.9], fogTint: 0.3, mist: 0.004,
    rain: 0, night: 0, exposure: 0.85, saturation: 0.9, contrast: 1.1, grade: [1.02, 1.01, 0.98],
    wind: 0.25, gloom: 0, weight: 2,
  },
  overcast: {
    sunElev: 45, sunAzim: 40, sunColor: [0.85, 0.87, 0.9], sunInt: 0.5, sunGlow: 0.3,
    zenith: [0.3, 0.34, 0.4], horizon: [0.56, 0.59, 0.63], ground: [0.22, 0.22, 0.23],
    ambient: 1.35, cloudCover: 0.96, cloudDark: 0.45, cloudSpeed: 1.2,
    fogDensity: 0.0035, fogColor: [0.52, 0.55, 0.6], fogTint: 0.6, mist: 0.012,
    rain: 0, night: 0, exposure: 1.15, saturation: 0.72, contrast: 1.02, grade: [0.98, 1, 1.03],
    wind: 0.55, gloom: 0.6, weight: 3,
  },
  rain: {
    sunElev: 40, sunAzim: 40, sunColor: [0.7, 0.75, 0.82], sunInt: 0.25, sunGlow: 0.1,
    zenith: [0.14, 0.16, 0.2], horizon: [0.3, 0.33, 0.37], ground: [0.12, 0.12, 0.13],
    ambient: 1.2, cloudCover: 1.0, cloudDark: 0.85, cloudSpeed: 2.4,
    fogDensity: 0.005, fogColor: [0.28, 0.31, 0.35], fogTint: 0.8, mist: 0.016,
    rain: 1, night: 0.25, exposure: 1.35, saturation: 0.65, contrast: 1.08, grade: [0.94, 0.99, 1.06],
    wind: 0.9, gloom: 1, weight: 2,
  },
  fog: {
    sunElev: 30, sunAzim: 110, sunColor: [0.95, 0.93, 0.88], sunInt: 0.9, sunGlow: 0.8,
    zenith: [0.52, 0.57, 0.64], horizon: [0.7, 0.73, 0.76], ground: [0.4, 0.41, 0.42],
    ambient: 1.0, cloudCover: 0.75, cloudDark: 0.2, cloudSpeed: 0.3,
    fogDensity: 0.011, fogColor: [0.64, 0.67, 0.71], fogTint: 1.0, mist: 0.022,
    rain: 0, night: 0.05, exposure: 1.05, saturation: 0.6, contrast: 0.95, grade: [0.98, 1, 1.02],
    wind: 0.15, gloom: 0.7, weight: 2,
  },
  "golden hour": {
    sunElev: 7, sunAzim: 250, sunColor: [1.0, 0.6, 0.3], sunInt: 2.6, sunGlow: 1.8,
    zenith: [0.08, 0.16, 0.42], horizon: [0.95, 0.6, 0.4], ground: [0.28, 0.22, 0.2],
    ambient: 0.55, cloudCover: 0.48, cloudDark: 0.25, cloudSpeed: 0.8,
    fogDensity: 0.002, fogColor: [0.85, 0.6, 0.45], fogTint: 0.2, mist: 0.012,
    rain: 0, night: 0.12, exposure: 0.95, saturation: 1.1, contrast: 1.1, grade: [1.04, 0.99, 0.94],
    wind: 0.3, gloom: 0.25, weight: 3,
  },
  "storm light": {
    sunElev: 16, sunAzim: 200, sunColor: [1.0, 0.82, 0.6], sunInt: 4.0, sunGlow: 1.2,
    zenith: [0.15, 0.17, 0.23], horizon: [0.45, 0.42, 0.4], ground: [0.18, 0.17, 0.17],
    ambient: 1.3, cloudCover: 0.72, cloudDark: 0.95, cloudSpeed: 3.0,
    fogDensity: 0.003, fogColor: [0.35, 0.36, 0.38], fogTint: 0.4, mist: 0.012,
    rain: 0.15, night: 0.1, exposure: 1.1, saturation: 0.9, contrast: 1.12, grade: [1.02, 1, 0.98],
    wind: 1, gloom: 0.9, weight: 2,
  },
  "blue hour": {
    sunElev: -5, sunAzim: 280, sunColor: [0.25, 0.35, 0.6], sunInt: 0.6, sunGlow: 0.9,
    zenith: [0.006, 0.013, 0.045], horizon: [0.06, 0.075, 0.14], ground: [0.03, 0.03, 0.04],
    ambient: 1.1, cloudCover: 0.35, cloudDark: 0.4, cloudSpeed: 0.6,
    fogDensity: 0.0028, fogColor: [0.06, 0.08, 0.14], fogTint: 0.3, mist: 0.015,
    rain: 0, night: 1, exposure: 1.3, saturation: 0.85, contrast: 1.05, grade: [0.97, 1, 1.05],
    wind: 0.3, gloom: 0.5, weight: 2,
  },
};

export const ORDER = Object.keys(STATES);

function blend(a: State, b: State, t: number): State {
  const out = { ...a };
  for (const k of Object.keys(a) as (keyof State)[]) {
    const va = a[k], vb = b[k];
    (out as Record<string, unknown>)[k] = Array.isArray(va)
      ? lerp3(va as Vec3, vb as Vec3, t)
      : lerp(va as number, vb as number, t);
  }
  // azimuth takes the short way round
  const da = ((b.sunAzim - a.sunAzim + 540) % 360) - 180;
  out.sunAzim = a.sunAzim + da * t;
  return out;
}

function direction(elevDeg: number, azimDeg: number): Vec3 {
  const e = (elevDeg * Math.PI) / 180, a = (azimDeg * Math.PI) / 180;
  return [Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)];
}

export class Weather {
  private src: State;
  private dst: State;
  private blendT = 1;
  private blendTime = 20;
  private hold = 50 + Math.random() * 30;
  params: State;
  wet: number;
  cycle = true;
  name: string;
  changed: string | null;
  private cloudOffset: [number, number] = [Math.random() * 10, Math.random() * 10];

  constructor(start = "clear sky") {
    this.name = start;
    this.src = this.dst = this.params = STATES[start];
    this.wet = this.params.rain;
    this.changed = start;
  }

  goTo(name: string, duration: number): void {
    this.src = this.params;
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
    if (this.blendT < 1) this.blendT = Math.min(1, this.blendT + dt / this.blendTime);
    else if (this.cycle) {
      this.hold -= dt;
      if (this.hold <= 0) this.goTo(this.pickNext(), 15 + Math.random() * 15);
    }
    this.params = blend(this.src, this.dst, smooth(this.blendT));
    const p = this.params;
    const rate = p.rain > this.wet ? 0.36 : 0.075;
    this.wet += (p.rain - this.wet) * Math.min(1, dt * rate);
    this.cloudOffset[0] = (this.cloudOffset[0] + dt * 0.0022 * p.cloudSpeed * 0.8) % 64;
    this.cloudOffset[1] = (this.cloudOffset[1] + dt * 0.0022 * p.cloudSpeed * 0.6) % 64;
  }

  uniforms(): Record<string, number | number[]> {
    const p = this.params;
    return {
      uSunDir: direction(p.sunElev, p.sunAzim),
      uLightDir: direction(Math.max(p.sunElev, 12), p.sunAzim),
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
