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

/** Planes scaled so that plane·point is the signed distance (needed for sphere tests). */
export function normalizedPlanes(planes: Float64Array[]): Float64Array[] {
  return planes.map((p) => {
    const len = Math.hypot(p[0], p[1], p[2]) || 1;
    return Float64Array.from(p, (v) => v / len);
  });
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

let worldSeedNumber = 1971;

/** Choose which city gets generated (must be set identically in every worker). */
export function setWorldSeed(seed: number): void {
  worldSeedNumber = Math.floor(seed) >>> 0;
}

export function worldSeed(): number {
  return worldSeedNumber;
}

/**
 * 64-bit mix of integers, returned as a non-negative JS number (53 bits).
 *
 * The splitmix64 finaliser, and the seed of everything the city is: which blocks stand
 * where, how tall they are, where the rivers run, which windows are lit. It reads as four
 * lines in BigInt, and did — but it runs tens of millions of times to work out one spawn
 * point or one region, and that was over half of what either cost. So the same 64 bits are
 * carried as two 32-bit halves instead.
 *
 * `h * K` is the awkward part, and it is written out twice below rather than put in a
 * function, because a call here costs more than the arithmetic does. Each multiply splits
 * the low half into 16-bit pieces — the widest product a double still holds exactly — and
 * lets the two cross terms, which can only reach the high word, wrap through Math.imul.
 * Bit for bit the numbers the BigInt version gave, so a seed still brings back its city.
 */
export function hashInt(...values: number[]): number {
  let hi = 0x9e3779b9, lo = (0x7f4a7c15 ^ worldSeedNumber) >>> 0;
  for (let n = 0; n < values.length; n++) {
    const v = Math.trunc(values[n]);
    // two's complement in 64 bits, which is what BigInt.asUintN(64, …) gave
    let vhi: number, vlo: number;
    if (v >= 0) {
      vlo = v >>> 0;
      vhi = Math.floor(v / 4294967296) >>> 0;
    } else {
      const a = -v, al = a >>> 0;
      vlo = -al >>> 0;
      vhi = -(Math.floor(a / 4294967296) + (al !== 0 ? 1 : 0)) >>> 0;
    }
    let ahi = hi ^ vhi, alo = (lo ^ vlo) >>> 0;

    // h *= 0xbf58476d1ce4e5b9
    let a0 = alo & 0xffff, a1 = alo >>> 16;
    let p00 = a0 * 0xe5b9, p01 = a0 * 0x1ce4, p10 = a1 * 0xe5b9;
    let mid = (p00 >>> 16) + (p01 & 0xffff) + (p10 & 0xffff);
    let carry = (mid >>> 16) + (p01 >>> 16) + (p10 >>> 16) + a1 * 0x1ce4;
    let rlo = (((mid & 0xffff) << 16) | (p00 & 0xffff)) >>> 0;
    let rhi = (carry + Math.imul(ahi, 0x1ce4e5b9) + Math.imul(alo, 0xbf58476d)) >>> 0;
    // h ^= h >> 31
    hi = rhi ^ (rhi >>> 31);
    lo = (rlo ^ ((rhi << 1) | (rlo >>> 31))) >>> 0;

    // h *= 0x94d049bb133111eb
    ahi = hi >>> 0;
    alo = lo;
    a0 = alo & 0xffff;
    a1 = alo >>> 16;
    p00 = a0 * 0x11eb;
    p01 = a0 * 0x1331;
    p10 = a1 * 0x11eb;
    mid = (p00 >>> 16) + (p01 & 0xffff) + (p10 & 0xffff);
    carry = (mid >>> 16) + (p01 >>> 16) + (p10 >>> 16) + a1 * 0x1331;
    rlo = (((mid & 0xffff) << 16) | (p00 & 0xffff)) >>> 0;
    rhi = (carry + Math.imul(ahi, 0x133111eb) + Math.imul(alo, 0x94d049bb)) >>> 0;
    // h ^= h >> 29
    hi = (rhi ^ (rhi >>> 29)) >>> 0;
    lo = (rlo ^ ((rhi << 3) | (rlo >>> 29))) >>> 0;
  }
  // h >> 11, as a number: the high word carries 21 bits of it and the low word the rest
  return hi * 2097152 + (lo >>> 11);
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
