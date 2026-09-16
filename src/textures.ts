// Procedurally generated, tileable material textures.
// Fields are Float32Array(size * size), row 0 = bottom of the texture (v = 0).
// Albedo layers carry a cavity term in alpha; normal layers carry roughness in alpha.

import { Rng } from "./math";

export const TEX_SIZE = 512;
export const NOISE_SIZE = 256;

type Field = Float32Array;

function valueNoise(rng: Rng, size: number, fx: number, fy = fx): Field {
  const grid = new Float32Array(fx * fy);
  for (let i = 0; i < grid.length; i++) grid[i] = rng.next();
  const out = new Float32Array(size * size);
  const x0 = new Int32Array(size), x1 = new Int32Array(size), sx = new Float32Array(size);
  for (let x = 0; x < size; x++) {
    const t = (x * fx) / size;
    const i = Math.floor(t);
    const f = t - i;
    x0[x] = i % fx;
    x1[x] = (i + 1) % fx;
    sx[x] = f * f * (3 - 2 * f);
  }
  for (let y = 0; y < size; y++) {
    const t = (y * fy) / size;
    const j = Math.floor(t);
    let f = t - j;
    f = f * f * (3 - 2 * f);
    const r0 = (j % fy) * fx;
    const r1 = ((j + 1) % fy) * fx;
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const a = grid[r0 + x0[x]], b = grid[r0 + x1[x]];
      const c = grid[r1 + x0[x]], d = grid[r1 + x1[x]];
      const top = a + (b - a) * sx[x];
      const bot = c + (d - c) * sx[x];
      out[row + x] = top + (bot - top) * f;
    }
  }
  return out;
}

function fbm(rng: Rng, size: number, fx: number, fy = fx, octaves = 5, gain = 0.5): Field {
  const out = new Float32Array(size * size);
  let amp = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    const mx = fx << o, my = fy << o;
    if (mx > size || my > size) break;
    const n = valueNoise(rng, size, mx, my);
    for (let i = 0; i < out.length; i++) out[i] += amp * n[i];
    norm += amp;
    amp *= gain;
  }
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

/** Normalize to [0, 1] using the 1st/99th percentiles. */
function stretch(f: Field): Field {
  const sorted = Float32Array.from(f).sort();
  const lo = sorted[Math.floor(sorted.length * 0.01)];
  const hi = sorted[Math.floor(sorted.length * 0.99)];
  const out = new Float32Array(f.length);
  for (let i = 0; i < f.length; i++) out[i] = Math.min(1, Math.max(0, (f[i] - lo) / (hi - lo + 1e-6)));
  return out;
}

const ss = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

const wrapDist = (a: number, b: number, period: number) => {
  const d = Math.abs(a - b) % period;
  return Math.min(d, period - d);
};

function discs(size: number, centers: [number, number][], radius: number): Field {
  const out = new Float32Array(size * size);
  const r = Math.ceil(radius + 2);
  for (const [cx, cy] of centers) {
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const x = (((Math.round(cx) + dx) % size) + size) % size;
        const y = (((Math.round(cy) + dy) % size) + size) % size;
        const d = Math.hypot(wrapDist(x, cx, size), wrapDist(y, cy, size));
        const v = 1 - ss(radius - 1, radius + 0.8, d);
        const i = y * size + x;
        if (v > out[i]) out[i] = v;
      }
  }
  return out;
}

function speckles(rng: Rng, size: number, density: number): Field {
  const out = new Float32Array(size * size);
  for (let i = 0; i < out.length; i++) {
    if (rng.next() < density) {
      const x = i % size, y = (i / size) | 0;
      out[i] = 1;
      out[y * size + ((x + 1) % size)] = Math.max(out[y * size + ((x + 1) % size)], 0.5);
      out[((y + 1) % size) * size + x] = Math.max(out[((y + 1) % size) * size + x], 0.5);
    }
  }
  return out;
}

class Layer {
  albedo = new Uint8Array(TEX_SIZE * TEX_SIZE * 4);
  normal = new Uint8Array(TEX_SIZE * TEX_SIZE * 4);

  constructor(
    gray: Field,
    rgb: [number, number, number],
    warm: Field,
    height: Field,
    strength: number,
    cavity: Field,
    rough: Field,
  ) {
    const n = TEX_SIZE;
    const u8 = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        const w = warm[i] - 0.5;
        const g = gray[i];
        this.albedo[i * 4] = u8(g * rgb[0] * (1 + 0.05 * w));
        this.albedo[i * 4 + 1] = u8(g * rgb[1]);
        this.albedo[i * 4 + 2] = u8(g * rgb[2] * (1 - 0.05 * w));
        this.albedo[i * 4 + 3] = u8(cavity[i]);
        const dx = (height[y * n + ((x + 1) % n)] - height[y * n + ((x + n - 1) % n)]) * strength;
        const dy = (height[((y + 1) % n) * n + x] - height[((y + n - 1) % n) * n + x]) * strength;
        const len = Math.hypot(dx, dy, 1);
        this.normal[i * 4] = u8((-dx / len) * 0.5 + 0.5);
        this.normal[i * 4 + 1] = u8((-dy / len) * 0.5 + 0.5);
        this.normal[i * 4 + 2] = u8((1 / len) * 0.5 + 0.5);
        this.normal[i * 4 + 3] = u8(rough[i]);
      }
  }
}

function boardFormed(rng: Rng): Layer {
  const n = TEX_SIZE, boards = 32, bh = n / boards;
  const rowTone = Array.from({ length: boards }, () => rng.normal() * 0.035);
  const shifts = Array.from({ length: boards }, () => rng.int(0, n - 1));
  const g1 = valueNoise(rng, n, 6, 128), g2 = valueNoise(rng, n, 12, 64);
  const wobble = fbm(rng, n, 8, 32, 3);
  const joints = Array.from({ length: boards }, () => [rng.int(0, n - 1), rng.int(0, n - 1)]);
  const ties: [number, number][] = [];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) ties.push([64 + 128 * i + (j % 2 ? 32 : 0), 48 + 128 * j]);
  const holes = discs(n, ties, 5);
  const rimsOuter = discs(n, ties, 7.5);
  const blotch = stretch(fbm(rng, n, 4, 4, 6));
  const warm = fbm(rng, n, 2, 2, 3);
  const s1 = valueNoise(rng, n, 64, 3), s2 = valueNoise(rng, n, 128, 6);
  const streakRaw = new Float32Array(n * n);
  for (let i = 0; i < streakRaw.length; i++) streakRaw[i] = s1[i] * 0.7 + s2[i] * 0.3;
  const streak = stretch(streakRaw);
  const streakMask = fbm(rng, n, 3, 2, 3);
  const pits = speckles(rng, n, 0.0035);

  const gray = new Float32Array(n * n), height = new Float32Array(n * n);
  const cavity = new Float32Array(n * n), rough = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    const row = Math.floor(y / bh);
    const pos = y % bh;
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const gx = (x + shifts[row]) % n;
      const grain = g1[y * n + gx] * 0.6 + g2[y * n + gx] * 0.4;
      const seam = pos === 0 ? 1 : 0;
      const fin = pos === 1 && wobble[i] > 0.45 ? 1 : 0;
      const jd = Math.min(wrapDist(x, joints[row][0], n), wrapDist(x, joints[row][1], n));
      const joint = jd < 1 ? 1 : 0;
      const rims = rimsOuter[i] - holes[i];
      const streaks = ss(0.5, 1, streak[i]) * ss(0.45, 0.8, streakMask[i]);
      gray[i] = 0.64 + 0.09 * (blotch[i] - 0.5) + rowTone[row] + 0.07 * (grain - 0.5)
        - 0.13 * streaks - 0.22 * pits[i] - 0.18 * seam - 0.1 * joint - 0.35 * holes[i] - 0.05 * rims;
      height[i] = rowTone[row] * 3 + 0.35 * grain + 0.25 * wobble[i] - seam + 0.5 * fin
        - 0.6 * joint - 1.6 * holes[i] - 0.7 * pits[i] + 0.3 * rims;
      cavity[i] = 1 - Math.min(1, 0.8 * seam + 0.9 * holes[i] + 0.6 * pits[i] + 0.4 * joint);
      rough[i] = 0.85 + 0.1 * grain;
    }
  }
  return new Layer(gray, [0.97, 0.95, 0.9], warm, height, 1.6, cavity, rough);
}

function precastPanel(rng: Rng): Layer {
  const n = TEX_SIZE, panel = n / 2;
  const tones = Array.from({ length: 4 }, () => rng.normal() * 0.035);
  const centers: [number, number][] = [];
  for (const ox of [0, panel]) for (const oy of [0, panel])
    for (const a of [48, panel - 48]) for (const b of [48, panel - 48]) centers.push([ox + a, oy + b]);
  const holes = discs(n, centers, 5.5);
  const plugs = discs(n, centers, 8);
  const fine = fbm(rng, n, 16, 16, 5);
  const blotch = stretch(fbm(rng, n, 3, 3, 6));
  const warm = fbm(rng, n, 2, 2, 3);
  const pores = speckles(rng, n, 0.006);
  const dripNoise = valueNoise(rng, n, 128, 16);
  const drips = new Float32Array(n * n);
  for (const [cx, cy] of centers) {
    const len = rng.uniform(40, 160);
    const width = rng.uniform(3, 7);
    for (let d = 4; d < len; d++) {
      const y = (((cy - d) % n) + n) % n;
      const fade = 1 - d / len;
      for (let dx = -18; dx <= 18; dx++) {
        const x = (((cx + dx) % n) + n) % n;
        const i = y * n + x;
        const v = Math.exp(-((dx / width) ** 2)) * fade * (0.6 + 0.4 * dripNoise[i]);
        if (v > drips[i]) drips[i] = v;
      }
    }
  }
  const bottomNoise = fbm(rng, n, 8, 4, 3);
  const vert = valueNoise(rng, n, 96, 4);
  const vertMask = fbm(rng, n, 4, 2, 3);

  const gray = new Float32Array(n * n), height = new Float32Array(n * n);
  const cavity = new Float32Array(n * n), rough = new Float32Array(n * n);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const px = x % panel, py = y % panel;
      const tone = tones[(y >= panel ? 2 : 0) + (x >= panel ? 1 : 0)];
      const sd = Math.min(px, panel - 1 - px, py, panel - 1 - py);
      const seam = 1 - ss(0.5, 2.5, sd);
      const edgeDirt = 1 - ss(2, 18, sd);
      const bottom = (1 - ss(0, 70, py)) * ss(0.35, 0.7, bottomNoise[i]);
      const vertical = ss(0.55, 0.95, vert[i]) * ss(0.4, 0.8, vertMask[i]);
      gray[i] = 0.68 + tone + 0.06 * (blotch[i] - 0.5) + 0.04 * (fine[i] - 0.5)
        - 0.12 * drips[i] - 0.1 * bottom - 0.08 * vertical - 0.06 * edgeDirt
        - 0.25 * seam - 0.3 * holes[i] + 0.03 * (plugs[i] - holes[i]) - 0.15 * pores[i];
      height[i] = 0.25 * fine[i] - 1.4 * seam - 1.5 * holes[i] - 0.5 * pores[i] + 0.2 * blotch[i];
      cavity[i] = 1 - Math.min(1, 0.9 * seam + 0.9 * holes[i] + 0.5 * pores[i]);
      rough[i] = 0.7 + 0.2 * fine[i];
    }
  return new Layer(gray, [0.95, 0.95, 0.93], warm, height, 1.4, cavity, rough);
}

function asphalt(rng: Rng): Layer {
  const n = TEX_SIZE;
  const agg = valueNoise(rng, n, 256);
  const patches = stretch(fbm(rng, n, 3, 3, 6));
  const patchMask = fbm(rng, n, 2, 2, 4);
  const warm = fbm(rng, n, 2, 2, 3);
  const c1 = fbm(rng, n, 6, 6, 4), c1m = fbm(rng, n, 3, 3, 3);
  const c2 = fbm(rng, n, 10, 10, 3), c2m = fbm(rng, n, 4, 4, 3);
  const oilN = fbm(rng, n, 4, 4, 5);
  const tar = new Float32Array(n * n);
  for (let i = 0; i < tar.length; i++) {
    const a = (1 - ss(0.004, 0.012, Math.abs(c1[i] - 0.5))) * ss(0.45, 0.6, c1m[i]);
    const b = (1 - ss(0.003, 0.008, Math.abs(c2[i] - 0.5))) * ss(0.55, 0.7, c2m[i]);
    tar[i] = Math.min(1, a + b);
  }
  const gray = new Float32Array(n * n), height = new Float32Array(n * n);
  const cavity = new Float32Array(n * n), rough = new Float32Array(n * n);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const a = 0.5 * agg[i] + 0.5 * rng.next();
      const wide = Math.min(1, tar[i] + 0.5 * (tar[((y + 1) % n) * n + x] + tar[y * n + ((x + 1) % n)]));
      const pm = ss(0.62, 0.66, patchMask[i]);
      const oil = ss(0.6, 0.8, oilN[i]) * 0.7;
      gray[i] = Math.max(0.05, 0.31 + 0.06 * (patches[i] - 0.5) + 0.1 * (a - 0.5) + 0.05 * pm - 0.1 * wide - 0.06 * oil);
      height[i] = 0.6 * a - tar[i] - 0.2 * pm;
      cavity[i] = 1 - Math.min(1, 0.8 * tar[i] + 0.3 * (1 - a));
      rough[i] = 0.75 + 0.2 * a - 0.35 * oil;
    }
  return new Layer(gray, [1, 0.99, 0.97], warm, height, 1.1, cavity, rough);
}

function paving(rng: Rng): Layer {
  const n = TEX_SIZE, slab = n / 8;
  const tones = Array.from({ length: 64 }, () => rng.normal() * 0.025);
  const cracked = Array.from({ length: 64 }, () => rng.chance(0.12));
  const dirtN = fbm(rng, n, 16, 16, 3);
  const crackN = fbm(rng, n, 8, 8, 4);
  const fine = fbm(rng, n, 32, 32, 4);
  const blotch = stretch(fbm(rng, n, 4, 4, 5));
  const warm = fbm(rng, n, 2, 2, 3);
  const grit = speckles(rng, n, 0.01);
  const gray = new Float32Array(n * n), height = new Float32Array(n * n);
  const cavity = new Float32Array(n * n), rough = new Float32Array(n * n);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const sx = x % slab, sy = y % slab;
      const id = Math.floor(y / slab) * 8 + Math.floor(x / slab);
      const d = Math.min(sx, slab - 1 - sx, sy, slab - 1 - sy);
      const joint = 1 - ss(0.3, 1.8, d);
      const bevel = 1 - ss(1.5, 4, d);
      const dirt = (1 - ss(1, 10, d)) * dirtN[i];
      const crack = cracked[id] ? 1 - ss(0.004, 0.012, Math.abs(crackN[i] - 0.5)) : 0;
      gray[i] = 0.6 + tones[id] + 0.08 * (blotch[i] - 0.5) + 0.05 * (fine[i] - 0.5)
        - 0.35 * joint - 0.1 * dirt - 0.18 * crack - 0.08 * grit[i];
      height[i] = 0.2 * fine[i] - 1.2 * joint - 0.4 * bevel - 0.8 * crack + tones[id] * 2;
      cavity[i] = 1 - Math.min(1, 0.9 * joint + 0.6 * crack);
      rough[i] = 0.8 + 0.15 * fine[i];
    }
  return new Layer(gray, [0.96, 0.95, 0.92], warm, height, 1.5, cavity, rough);
}

/** R: smooth value noise, G: low-frequency fbm, B: medium noise, A: white noise. */
function shaderNoise(rng: Rng): Uint8Array {
  const n = NOISE_SIZE;
  const r = stretch(valueNoise(rng, n, 16));
  const g = stretch(fbm(rng, n, 4, 4, 4));
  const b = stretch(valueNoise(rng, n, 64));
  const out = new Uint8Array(n * n * 4);
  for (let i = 0; i < n * n; i++) {
    out[i * 4] = Math.round(r[i] * 255);
    out[i * 4 + 1] = Math.round(g[i] * 255);
    out[i * 4 + 2] = Math.round(b[i] * 255);
    out[i * 4 + 3] = Math.floor(rng.next() * 256);
  }
  return out;
}

export interface TextureSet {
  albedo: Uint8Array; // 4 layers stacked
  normal: Uint8Array;
  noise: Uint8Array;
}

export function generateTextures(seed = 7): TextureSet {
  const rng = new Rng(seed);
  const layers = [boardFormed(rng), precastPanel(rng), asphalt(rng), paving(rng)];
  const px = TEX_SIZE * TEX_SIZE * 4;
  const albedo = new Uint8Array(px * layers.length);
  const normal = new Uint8Array(px * layers.length);
  layers.forEach((l, i) => {
    albedo.set(l.albedo, i * px);
    normal.set(l.normal, i * px);
  });
  return { albedo, normal, noise: shaderNoise(rng) };
}
