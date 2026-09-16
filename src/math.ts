// Small vector / matrix helpers. Matrices are column-major Float32Arrays (GL order).

export type Vec3 = [number, number, number];
export type Mat4 = Float32Array;

export const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smooth = (t: number) => {
  t = clamp(t, 0, 1);
  return t * t * (3 - 2 * t);
};

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export const normalize = (a: Vec3): Vec3 => scale(a, 1 / (length(a) || 1));
export const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/** Build a column-major matrix from rows written in math order. */
export function fromRows(r: number[][]): Mat4 {
  const m = new Float32Array(16);
  for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) m[col * 4 + row] = r[row][col];
  return m;
}

export function mul(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  return out;
}

/** Perspective with reversed, infinite depth (clip z in [0, w], 1 at near). */
export function perspectiveReversed(fovy: number, aspect: number, near: number): Mat4 {
  const f = 1 / Math.tan(fovy / 2);
  return fromRows([
    [f / aspect, 0, 0, 0],
    [0, f, 0, 0],
    [0, 0, 0, near],
    [0, 0, -1, 0],
  ]);
}

/** Regular OpenGL perspective (clip z in [-w, w]); used when clip control is unavailable. */
export function perspective(fovy: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovy / 2);
  return fromRows([
    [f / aspect, 0, 0, 0],
    [0, f, 0, 0],
    [0, 0, (far + near) / (near - far), (2 * far * near) / (near - far)],
    [0, 0, -1, 0],
  ]);
}

/** Orthographic, OpenGL clip range. */
export function ortho(l: number, r: number, b: number, t: number, n: number, f: number): Mat4 {
  return fromRows([
    [2 / (r - l), 0, 0, -(r + l) / (r - l)],
    [0, 2 / (t - b), 0, -(t + b) / (t - b)],
    [0, 0, -2 / (f - n), -(f + n) / (f - n)],
    [0, 0, 0, 1],
  ]);
}

export function viewMatrix(eye: Vec3, right: Vec3, up: Vec3, fwd: Vec3): Mat4 {
  return fromRows([
    [...right, -dot(right, eye)],
    [...up, -dot(up, eye)],
    [-fwd[0], -fwd[1], -fwd[2], dot(fwd, eye)],
    [0, 0, 0, 1],
  ]);
}

/** Frustum planes (a, b, c, d) with inside = positive. Skips near/far as requested. */
export function frustumPlanes(m: Mat4, withNear: boolean, withFar: boolean): Float64Array[] {
  const row = (i: number) => [m[i], m[4 + i], m[8 + i], m[12 + i]];
  const r0 = row(0), r1 = row(1), r2 = row(2), r3 = row(3);
  const planes: number[][] = [
    r3.map((v, i) => v + r0[i]),
    r3.map((v, i) => v - r0[i]),
    r3.map((v, i) => v + r1[i]),
    r3.map((v, i) => v - r1[i]),
  ];
  if (withNear) planes.push(r3.map((v, i) => v + r2[i]));
  if (withFar) planes.push(r3.map((v, i) => v - r2[i]));
  return planes.map((p) => Float64Array.from(p));
}

export function aabbVisible(planes: Float64Array[], lo: Vec3, hi: Vec3): boolean {
  for (const p of planes) {
    const x = p[0] >= 0 ? hi[0] : lo[0];
    const y = p[1] >= 0 ? hi[1] : lo[1];
    const z = p[2] >= 0 ? hi[2] : lo[2];
    if (p[0] * x + p[1] * y + p[2] * z + p[3] < 0) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Deterministic hashing and RNG

const M64 = (1n << 64n) - 1n;
let WORLD_SEED = 1971n;
let worldSeedNumber = 1971;

/** Choose which city gets generated (must be set identically in every worker). */
export function setWorldSeed(seed: number): void {
  worldSeedNumber = Math.floor(seed) >>> 0;
  WORLD_SEED = BigInt(worldSeedNumber);
}

export function worldSeed(): number {
  return worldSeedNumber;
}

/** 64-bit mix of integers, returned as a non-negative JS number (53 bits). */
export function hashInt(...values: number[]): number {
  let h = (0x9e3779b97f4a7c15n ^ WORLD_SEED) & M64;
  for (const v of values) {
    h ^= BigInt.asUintN(64, BigInt(Math.trunc(v)));
    h = (h * 0xbf58476d1ce4e5b9n) & M64;
    h ^= h >> 31n;
    h = (h * 0x94d049bb133111ebn) & M64;
    h ^= h >> 29n;
  }
  return Number(h >> 11n);
}

/** Small seeded PRNG (sfc32). */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number) {
    this.a = seed >>> 0;
    this.b = Math.floor(seed / 4294967296) >>> 0;
    this.c = 0x9e3779b9;
    this.d = 0x85ebca6b ^ (seed >>> 0);
    for (let i = 0; i < 15; i++) this.next();
  }

  next(): number {
    const t = (((this.a + this.b) >>> 0) + this.d) >>> 0;
    this.d = (this.d + 1) >>> 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) >>> 0;
    return t / 4294967296;
  }

  uniform(a: number, b: number): number {
    return a + (b - a) * this.next();
  }

  int(a: number, b: number): number {
    return a + Math.floor(this.next() * (b - a + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }

  normal(): number {
    const u = 1 - this.next();
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}
