// Where the sun is, and what the sky looks like from that alone.
//
// The city keeps a clock. The sun's direction, its colour and strength, the sky gradient,
// how dark it is and when the lamps come on all follow from the hour; the weather
// (src/weather.ts) only tints and dims what this produces, so every mood reads right at
// any time of day.

import { clamp, lerp, lerp3, smooth, type Vec3 } from "./math";

/** Real seconds in a full day: one real minute is one hour in the city. */
export const DAY_SECONDS = 1440;

// The city stands at a northern latitude in midsummer: the sun rises well north of east,
// crosses high in the south and sets north of west, and the night is short.
const LATITUDE = 42;
const DAY_OF_YEAR = 172;

// Once the sun is this far down its afterglow is gone, and the moon — always full and
// always opposite the sun, so it rises as the sun sets — becomes the light in the street.
const MOON_BELOW = -6;
const MOON_FULL = -13;
const MOON_COLOR: Vec3 = [0.42, 0.5, 0.78];
const MOON_INT = 0.5;

const RAD = Math.PI / 180;

/** Hour of the day, wrapped into [0, 24). */
export const wrapHour = (h: number) => ((h % 24) + 24) % 24;

/** "07:35", from a fractional hour. */
export function clockText(hour: number): string {
  const h = wrapHour(hour);
  const m = Math.floor((h % 1) * 60);
  return `${String(Math.floor(h)).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Sun elevation and compass azimuth (degrees, from north through east) at a local solar
 * hour. The usual spherical-astronomy solution, with the equation of time left out — noon
 * is 12:00 sharp, which is what a clock in a game should mean.
 */
export function sunAt(hour: number): { elev: number; azim: number } {
  const dec = -23.44 * RAD * Math.cos((2 * Math.PI * (DAY_OF_YEAR + 10)) / 365.24);
  const phi = LATITUDE * RAD;
  const H = (wrapHour(hour) - 12) * 15 * RAD;
  const sinE = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H);
  const e = Math.asin(clamp(sinE, -1, 1));
  const cosA = (Math.sin(dec) - sinE * Math.sin(phi)) / Math.max(Math.cos(e) * Math.cos(phi), 1e-6);
  const a = Math.acos(clamp(cosA, -1, 1));
  return { elev: e / RAD, azim: (H > 0 ? 2 * Math.PI - a : a) / RAD };
}

/** A unit vector from elevation and compass azimuth: north is +Z, east is +X. */
export function direction(elevDeg: number, azimDeg: number): Vec3 {
  const e = elevDeg * RAD, a = azimDeg * RAD;
  return [Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)];
}

/**
 * The hour at which the sun stands at this elevation, on the way up (morning) or on the
 * way down (evening). Elevation falls monotonically from noon to midnight, so a bisection
 * finds it; an elevation the sun never reaches that day gives back noon or midnight.
 */
export function hourAtElevation(elev: number, evening: boolean): number {
  let lo = 12, hi = 24;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (sunAt(mid).elev > elev) lo = mid;
    else hi = mid;
  }
  const h = (lo + hi) / 2;
  return evening ? h : wrapHour(24 - h);
}

/** One entry in the table below: the sky with the sun at this elevation. */
interface Key {
  elev: number;
  sunColor: Vec3;
  sunInt: number;
  sunGlow: number;
  zenith: Vec3;
  horizon: Vec3;
  ground: Vec3;
  fog: Vec3;
  ambient: number;
  night: number;
  exposure: number;
}

/**
 * The day, keyed by sun elevation rather than by the clock: the same table then serves
 * both dawn and dusk, and it stays right whatever the latitude and season above say.
 * All colours are linear HDR. `night` is what brings on the street lamps, the lit windows
 * and the stars; `ambient` and `exposure` are how far the eye opens as the light goes.
 */
const KEYS: Key[] = [
  {
    // Deepest night. Not as dark as the real thing: the runner still has to read a parapet
    // and a gap two blocks off, so the floor sits at about half the blue hour's sky.
    elev: -20, sunColor: [0.5, 0.6, 0.9], sunInt: 0, sunGlow: 0.5,
    zenith: [0.0035, 0.0075, 0.024], horizon: [0.03, 0.038, 0.07], ground: [0.022, 0.022, 0.03],
    fog: [0.035, 0.045, 0.08], ambient: 1.4, night: 1, exposure: 1.5,
  },
  {
    elev: -9, sunColor: [0.35, 0.42, 0.7], sunInt: 0, sunGlow: 0.7,
    zenith: [0.0055, 0.011, 0.036], horizon: [0.05, 0.058, 0.1], ground: [0.026, 0.026, 0.034],
    fog: [0.055, 0.065, 0.11], ambient: 1.3, night: 1, exposure: 1.42,
  },
  {
    elev: -4, sunColor: [0.25, 0.35, 0.6], sunInt: 0, sunGlow: 0.9,
    zenith: [0.008, 0.017, 0.055], horizon: [0.08, 0.088, 0.15], ground: [0.03, 0.03, 0.04],
    fog: [0.07, 0.085, 0.145], ambient: 1.12, night: 0.92, exposure: 1.3,
  },
  {
    elev: -1, sunColor: [0.85, 0.42, 0.26], sunInt: 0.18, sunGlow: 1.45,
    zenith: [0.022, 0.05, 0.16], horizon: [0.34, 0.24, 0.26], ground: [0.07, 0.06, 0.065],
    fog: [0.3, 0.24, 0.28], ambient: 0.95, night: 0.6, exposure: 1.15,
  },
  {
    elev: 2, sunColor: [1.0, 0.44, 0.2], sunInt: 1.2, sunGlow: 2.0,
    zenith: [0.045, 0.1, 0.3], horizon: [0.9, 0.46, 0.3], ground: [0.17, 0.13, 0.13],
    fog: [0.7, 0.44, 0.34], ambient: 0.8, night: 0.3, exposure: 1.02,
  },
  {
    elev: 7, sunColor: [1.0, 0.62, 0.32], sunInt: 2.6, sunGlow: 1.8,
    zenith: [0.08, 0.16, 0.42], horizon: [0.95, 0.6, 0.4], ground: [0.28, 0.22, 0.2],
    fog: [0.85, 0.6, 0.45], ambient: 0.6, night: 0.1, exposure: 0.96,
  },
  {
    elev: 14, sunColor: [1.0, 0.8, 0.56], sunInt: 3.0, sunGlow: 1.3,
    zenith: [0.06, 0.17, 0.52], horizon: [0.72, 0.64, 0.66], ground: [0.3, 0.27, 0.25],
    fog: [0.72, 0.66, 0.7], ambient: 0.57, night: 0.02, exposure: 0.95,
  },
  {
    elev: 30, sunColor: [1.0, 0.92, 0.8], sunInt: 3.2, sunGlow: 1.05,
    zenith: [0.05, 0.18, 0.6], horizon: [0.5, 0.62, 0.86], ground: [0.3, 0.3, 0.29],
    fog: [0.6, 0.68, 0.84], ambient: 0.55, night: 0, exposure: 0.95,
  },
  {
    elev: 50, sunColor: [1.0, 0.96, 0.88], sunInt: 3.3, sunGlow: 1.0,
    zenith: [0.05, 0.18, 0.62], horizon: [0.42, 0.6, 0.88], ground: [0.3, 0.3, 0.3],
    fog: [0.55, 0.66, 0.84], ambient: 0.55, night: 0, exposure: 0.93,
  },
  {
    elev: 72, sunColor: [1.0, 0.98, 0.94], sunInt: 3.6, sunGlow: 1.1,
    zenith: [0.1, 0.28, 0.75], horizon: [0.62, 0.74, 0.92], ground: [0.34, 0.33, 0.31],
    fog: [0.68, 0.76, 0.9], ambient: 0.6, night: 0, exposure: 0.88,
  },
];

/** The sky the clock alone asks for, before any weather. */
export interface Daylight {
  hour: number;
  /** Sun elevation and compass azimuth, in degrees; the sun is down below zero. */
  elev: number;
  azim: number;
  /** How far the moon has taken over from the sun: 0 by day, 1 in the small hours. */
  moon: number;
  /** Towards the sun (or the moon): where the sky draws a disc and a glow. */
  sunDir: Vec3;
  /** The same, held above the horizon so shadows never stretch to infinity. */
  lightDir: Vec3;
  sunColor: Vec3;
  sunInt: number;
  sunGlow: number;
  zenith: Vec3;
  horizon: Vec3;
  ground: Vec3;
  fog: Vec3;
  ambient: number;
  night: number;
  exposure: number;
}

function keyAt(elev: number): Key {
  const last = KEYS[KEYS.length - 1];
  if (elev <= KEYS[0].elev) return KEYS[0];
  if (elev >= last.elev) return last;
  let i = 0;
  while (KEYS[i + 1].elev < elev) i++;
  const a = KEYS[i], b = KEYS[i + 1];
  // eased across the segment, so the light never changes pace at a table entry
  const t = smooth((elev - a.elev) / (b.elev - a.elev));
  return {
    elev,
    sunColor: lerp3(a.sunColor, b.sunColor, t),
    sunInt: lerp(a.sunInt, b.sunInt, t),
    sunGlow: lerp(a.sunGlow, b.sunGlow, t),
    zenith: lerp3(a.zenith, b.zenith, t),
    horizon: lerp3(a.horizon, b.horizon, t),
    ground: lerp3(a.ground, b.ground, t),
    fog: lerp3(a.fog, b.fog, t),
    ambient: lerp(a.ambient, b.ambient, t),
    night: lerp(a.night, b.night, t),
    exposure: lerp(a.exposure, b.exposure, t),
  };
}

/**
 * The sky at an hour.
 *
 * The handover to the moon is a cut, not a blend — two nearly opposite directions cannot be
 * interpolated through. It happens at the one elevation where both lights are out: the sun's
 * own strength reaches zero a few degrees above it and the moon's climbs from zero below it,
 * so nothing on screen jumps.
 */
export function daylight(hour: number): Daylight {
  const { elev, azim } = sunAt(hour);
  const k = keyAt(elev);
  const moonlit = elev < MOON_BELOW;
  const bodyElev = moonlit ? -elev : elev;
  const bodyAzim = moonlit ? azim + 180 : azim;
  // The disc and its light come up together over the seven degrees below the handover.
  const moon = moonlit ? smooth((MOON_BELOW - elev) / (MOON_BELOW - MOON_FULL)) : 0;
  return {
    hour: wrapHour(hour),
    elev,
    azim,
    moon,
    sunDir: direction(bodyElev, bodyAzim),
    // A low sun already rakes the city hard; below 12° the shadows would run for kilometres
    // and off the edge of the shadow map, so the light that casts them stops descending.
    lightDir: direction(Math.max(bodyElev, 12), bodyAzim),
    sunColor: moonlit ? MOON_COLOR : k.sunColor,
    sunInt: moonlit ? MOON_INT * moon : k.sunInt,
    sunGlow: k.sunGlow,
    zenith: k.zenith,
    horizon: k.horizon,
    ground: k.ground,
    fog: k.fog,
    ambient: k.ambient,
    night: k.night,
    exposure: k.exposure,
  };
}
