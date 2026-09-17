// Procedurally generated, tileable material textures.
// Fields are Float32Array(size * size), row 0 = bottom of the texture (v = 0), so "down" on a wall is -y.
// Albedo layers carry a cavity term in alpha; normal layers carry roughness in alpha.

import { Rng } from "./math";

export const TEX_SIZE = 512;
export const NOISE_SIZE = 256;

/** Layer order in the texture arrays (shared with the city shader). */
export const enum Layer {
  Board = 0, // board-formed concrete
  Precast = 1, // precast panels
  Asphalt = 2,
  Paving = 3,
  Ribbed = 4, // bush-hammered ribbed ("corduroy") concrete
  Cast = 5, // plywood-formed cast-in-place concrete
}
export const TEX_LAYERS = 6;

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

const wrap = (v: number, n: number) => ((v % n) + n) % n;

const wrapDist = (a: number, b: number, period: number) => {
  const d = Math.abs(a - b) % period;
  return Math.min(d, period - d);
};

/** Soft discs (max-combined); `aspect` stretches them along x. */
function discs(size: number, centers: [number, number][], radius: number, aspect = 1): Field {
  const out = new Float32Array(size * size);
  const ry = Math.ceil(radius + 2), rx = Math.ceil(radius * aspect + 2);
  for (const [cx, cy] of centers) {
    for (let dy = -ry; dy <= ry; dy++)
      for (let dx = -rx; dx <= rx; dx++) {
        const x = wrap(Math.round(cx) + dx, size);
        const y = wrap(Math.round(cy) + dy, size);
        const d = Math.hypot(wrapDist(x, cx, size) / aspect, wrapDist(y, cy, size));
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

/** Aggregate stones: `mask` is coverage, `tone` a signed brightness per stone. */
function stones(rng: Rng, size: number, count: number, rMin: number, rMax: number): { mask: Field; tone: Field } {
  const mask = new Float32Array(size * size), tone = new Float32Array(size * size);
  for (let k = 0; k < count; k++) {
    const cx = rng.uniform(0, size), cy = rng.uniform(0, size);
    const r = rng.uniform(rMin, rMax), sq = rng.uniform(0.7, 1.3);
    const t = rng.uniform(-1, 1);
    const R = Math.ceil(r * 1.4 + 1);
    for (let dy = -R; dy <= R; dy++)
      for (let dx = -R; dx <= R; dx++) {
        const d = Math.hypot(dx * sq, dy / sq);
        const v = 1 - ss(r - 0.7, r + 0.5, d);
        if (v <= 0) continue;
        const i = wrap(Math.floor(cy) + dy, size) * size + wrap(Math.floor(cx) + dx, size);
        if (v > mask[i]) {
          mask[i] = v;
          tone[i] = t;
        }
      }
  }
  return { mask, tone };
}

/**
 * Stains running down from sources: each source (x, y) gets a streak `len` pixels long that
 * narrows and fades as it runs, wandering a little sideways.
 */
function runs(rng: Rng, size: number, sources: [number, number][], len: [number, number], width: [number, number], jitter: Field): Field {
  const out = new Float32Array(size * size);
  for (const [cx, cy] of sources) {
    const L = rng.uniform(len[0], len[1]);
    const w0 = rng.uniform(width[0], width[1]);
    const strength = rng.uniform(0.5, 1);
    let x = cx;
    for (let d = 1; d < L; d++) {
      const y = wrap(Math.round(cy - d), size);
      x += (jitter[y * size + wrap(Math.round(x), size)] - 0.5) * 0.6;
      const fade = (1 - d / L) ** 1.3 * strength;
      const w = w0 * (0.5 + 0.5 * (1 - d / L));
      const R = Math.ceil(w * 2.2);
      for (let dx = -R; dx <= R; dx++) {
        const px = wrap(Math.round(x) + dx, size);
        const i = y * size + px;
        const v = Math.exp(-((dx / w) ** 2)) * fade * (0.6 + 0.4 * jitter[i]);
        if (v > out[i]) out[i] = v;
      }
    }
  }
  return out;
}

/** Vertical rain streaks: thin, long and patchy. */
function rainStreaks(rng: Rng, size: number, fx: number, fy: number): Field {
  const s1 = valueNoise(rng, size, fx, fy), s2 = valueNoise(rng, size, fx * 2, fy * 2);
  const mask = fbm(rng, size, 3, 2, 3);
  const raw = new Float32Array(size * size);
  for (let i = 0; i < raw.length; i++) raw[i] = s1[i] * 0.7 + s2[i] * 0.3;
  const s = stretch(raw);
  const out = new Float32Array(size * size);
  for (let i = 0; i < out.length; i++) out[i] = ss(0.5, 1, s[i]) * ss(0.4, 0.8, mask[i]);
  return out;
}

const RUST: [number, number, number] = [0.5, 0.3, 0.17];
const BLOOM: [number, number, number] = [0.93, 0.93, 0.9];
const GRIME: [number, number, number] = [0.3, 0.31, 0.27];

interface LayerFields {
  gray: Field;
  rgb: [number, number, number];
  warm: Field;
  height: Field;
  strength: number;
  cavity: Field;
  rough: Field;
  rust?: Field; // 0..1 rust stain
  bloom?: Field; // 0..1 efflorescence (white salt)
  grime?: Field; // 0..1 dark green-grey dirt
}

class TexLayer {
  albedo = new Uint8Array(TEX_SIZE * TEX_SIZE * 4);
  normal = new Uint8Array(TEX_SIZE * TEX_SIZE * 4);

  constructor(f: LayerFields) {
    const n = TEX_SIZE;
    const { gray, rgb, warm, height, strength, cavity, rough, rust, bloom, grime } = f;
    const u8 = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        const w = warm[i] - 0.5;
        const g = gray[i];
        let r = g * rgb[0] * (1 + 0.05 * w), gr = g * rgb[1], b = g * rgb[2] * (1 - 0.05 * w);
        if (grime) {
          const k = grime[i];
          r += (GRIME[0] * g - r) * k; gr += (GRIME[1] * g - gr) * k; b += (GRIME[2] * g - b) * k;
        }
        if (bloom) {
          const k = bloom[i];
          r += (BLOOM[0] - r) * k; gr += (BLOOM[1] - gr) * k; b += (BLOOM[2] - b) * k;
        }
        if (rust) {
          const k = rust[i];
          const t = 0.55 + 0.6 * g;
          r += (RUST[0] * t - r) * k; gr += (RUST[1] * t - gr) * k; b += (RUST[2] * t - b) * k;
        }
        this.albedo[i * 4] = u8(r);
        this.albedo[i * 4 + 1] = u8(gr);
        this.albedo[i * 4 + 2] = u8(b);
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

/** Board heights (in pixels) that add up to exactly `n`. */
function boardRows(rng: Rng, n: number): number[] {
  const rows: number[] = [];
  let used = 0;
  while (n - used > 26) {
    const h = rng.pick([12, 14, 16, 16, 18, 20]);
    rows.push(h);
    used += h;
  }
  const rest = n - used;
  if (rest >= 12) rows.push(rest);
  else rows[rows.length - 1] += rest;
  return rows;
}

// Tile: 4 m. Boards of 10-16 cm with real wood grain and knots, staggered butt joints, a lift
// line, form-tie holes (some plugged, some rusting), honeycombing along a few seams, rain streaks
// and salt bloom.
function boardFormed(rng: Rng): TexLayer {
  const n = TEX_SIZE;
  const heights = boardRows(rng, n);
  const rowOf = new Int32Array(n), posOf = new Int32Array(n);
  {
    let y = 0;
    heights.forEach((h, r) => {
      for (let k = 0; k < h; k++, y++) {
        rowOf[y] = r;
        posOf[y] = k;
      }
    });
  }
  const B = heights.length;
  const rowTone = Array.from({ length: B }, () => rng.normal() * 0.04);
  const rowGrain = Array.from({ length: B }, () => rng.uniform(0.5, 1.4));
  const shifts = Array.from({ length: B }, () => rng.int(0, n - 1));
  const joints = Array.from({ length: B }, () => [rng.int(0, n - 1), rng.int(0, n - 1)]);
  const g1 = valueNoise(rng, n, 6, 128), g2 = valueNoise(rng, n, 12, 256), g3 = valueNoise(rng, n, 24, 64);
  const wobble = fbm(rng, n, 8, 32, 3);
  const warp = fbm(rng, n, 4, 16, 3);

  // knots: stretched discs with a ring of disturbed grain
  const knotCenters: [number, number][] = [];
  for (let k = 0; k < 26; k++) knotCenters.push([rng.uniform(0, n), rng.uniform(0, n)]);
  const knots = discs(n, knotCenters, 2.2, 2.2);
  const knotRings = discs(n, knotCenters, 5, 2.6);

  // form ties on a 0.75 m grid, a little off true
  const ties: [number, number][] = [];
  const tieKind: number[] = [];
  for (let i = 0; i < 5; i++)
    for (let j = 0; j < 4; j++) {
      ties.push([51 + 102.4 * i + (j % 2 ? 51 : 0) + rng.uniform(-3, 3), 64 + 128 * j + rng.uniform(-2, 2)]);
      tieKind.push(rng.next());
    }
  const openTies = ties.filter((_, k) => tieKind[k] < 0.65);
  const plugTies = ties.filter((_, k) => tieKind[k] >= 0.65);
  const holes = discs(n, openTies, 4.5);
  const plugs = discs(n, plugTies, 6.5);
  const rims = discs(n, ties, 7.5);
  const jitter = valueNoise(rng, n, 64, 64);
  const rust = runs(rng, n, openTies.filter(() => rng.chance(0.55)).map(([x, y]) => [x, y - 3]), [30, 150], [1.5, 3.5], jitter);

  const blotch = stretch(fbm(rng, n, 4, 4, 6));
  const warm = fbm(rng, n, 2, 2, 3);
  const streak = rainStreaks(rng, n, 64, 3);
  const pits = speckles(rng, n, 0.004);
  // honeycombing: dense voids in patches along some seams
  const combMask = fbm(rng, n, 6, 6, 3);
  const combPits = speckles(rng, n, 0.08);
  const bloomN = fbm(rng, n, 16, 3, 3);
  const liftY = rng.int(200, 300);

  const gray = new Float32Array(n * n), height = new Float32Array(n * n);
  const cavity = new Float32Array(n * n), rough = new Float32Array(n * n);
  const bloom = new Float32Array(n * n), rustF = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    const row = rowOf[y], pos = posOf[y], bh = heights[row];
    const edge = Math.min(pos, bh - 1 - pos);
    const lift = 1 - ss(0, 3, Math.abs(y - liftY));
    const liftBelow = y < liftY ? ss(liftY - 40, liftY, y) : 0;
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const gx = (x + shifts[row]) % n;
      // grain: stretched noise plus growth-ring stripes bent by the warp field and around knots
      const ringsPhase = (y + warp[i] * 18 + knotRings[i] * 6) * 1.7 + row * 3.1;
      const rings = Math.sin(ringsPhase) * 0.5 + 0.5;
      const grain = (g1[y * n + gx] * 0.45 + g2[y * n + gx] * 0.3 + g3[y * n + gx] * 0.25) * 0.7 + rings * 0.3 * rowGrain[row];
      const seam = pos === 0 ? 1 : 0;
      const fin = pos === 1 && wobble[i] > 0.5 ? 1 : 0;
      const jd = Math.min(wrapDist(x, joints[row][0], n), wrapDist(x, joints[row][1], n));
      const joint = 1 - ss(0.3, 1.3, jd);
      const nearSeam = 1 - ss(0, 4, edge);
      const comb = nearSeam * ss(0.68, 0.78, combMask[i]) * combPits[i];
      const rim = rims[i] - Math.max(holes[i], plugs[i]);
      const s = streak[i];
      gray[i] = 0.63 + 0.1 * (blotch[i] - 0.5) + rowTone[row] + 0.075 * (grain - 0.5) * rowGrain[row]
        - 0.07 * knots[i] - 0.15 * s - 0.22 * pits[i] - 0.3 * comb - 0.2 * seam - 0.1 * joint
        - 0.4 * holes[i] + 0.04 * plugs[i] - 0.05 * rim - 0.08 * lift - 0.04 * liftBelow;
      height[i] = rowTone[row] * 3 + 0.45 * grain * rowGrain[row] + 0.25 * wobble[i] - seam + 0.6 * fin
        - 0.6 * joint - 1.8 * holes[i] - 0.3 * plugs[i] - 0.8 * pits[i] - 1.2 * comb + 0.3 * rim
        + 0.4 * knots[i] - 0.5 * lift;
      cavity[i] = 1 - Math.min(1, 0.8 * seam + 0.95 * holes[i] + 0.6 * pits[i] + 0.8 * comb + 0.4 * joint + 0.3 * lift);
      rough[i] = 0.84 + 0.1 * grain - 0.05 * plugs[i];
      bloom[i] = 0.3 * ss(0.6, 0.85, bloomN[i]) * (1 - ss(0, 30, Math.abs(y - liftY + 12))) + 0.12 * fin;
      rustF[i] = Math.min(1, rust[i] * 0.75);
    }
  }
  return new TexLayer({ gray, rgb: [0.97, 0.95, 0.9], warm, height, strength: 1.7, cavity, rough, rust: rustF, bloom });
}

// Tile: 6 m, 3 m panels. Chamfered joints with chipped arrises, lifting-anchor recesses (some
// rusting), exposed aggregate showing through, drips from the anchors and dirt along the bottom.
function precastPanel(rng: Rng): TexLayer {
  const n = TEX_SIZE, panel = n / 2;
  const tones = Array.from({ length: 4 }, () => rng.normal() * 0.04);
  const centers: [number, number][] = [];
  for (const ox of [0, panel]) for (const oy of [0, panel])
    for (const a of [48, panel - 48]) for (const b of [48, panel - 48]) centers.push([ox + a + rng.uniform(-1.5, 1.5), oy + b + rng.uniform(-1.5, 1.5)]);
  const holes = discs(n, centers, 5.5);
  const plugs = discs(n, centers, 8);
  const fine = fbm(rng, n, 16, 16, 5);
  const blotch = stretch(fbm(rng, n, 3, 3, 6));
  const warm = fbm(rng, n, 2, 2, 3);
  const pores = speckles(rng, n, 0.006);
  const agg = stones(rng, n, 2600, 0.8, 2.2);
  const aggShow = fbm(rng, n, 6, 6, 4);
  const jitter = valueNoise(rng, n, 64, 64);
  const drips = runs(rng, n, centers, [40, 170], [2.5, 6], jitter);
  const rust = runs(rng, n, centers.filter(() => rng.chance(0.3)), [20, 90], [1.2, 2.5], jitter);
  const bottomNoise = fbm(rng, n, 8, 4, 3);
  const vert = rainStreaks(rng, n, 96, 4);
  const chipN = valueNoise(rng, n, 96, 96);

  const gray = new Float32Array(n * n), height = new Float32Array(n * n);
  const cavity = new Float32Array(n * n), rough = new Float32Array(n * n);
  const grime = new Float32Array(n * n), rustF = new Float32Array(n * n);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const px = x % panel, py = y % panel;
      const tone = tones[(y >= panel ? 2 : 0) + (x >= panel ? 1 : 0)];
      const sd = Math.min(px, panel - 1 - px, py, panel - 1 - py);
      // chipped arris: the joint eats into the panel where the noise says so
      const chip = ss(0.72, 0.9, chipN[i]) * 3;
      const seam = 1 - ss(0.5, 2.5 + chip, sd);
      const chamfer = 1 - ss(2 + chip, 5 + chip, sd);
      const edgeDirt = 1 - ss(2, 18, sd);
      const bottom = (1 - ss(0, 70, py)) * ss(0.35, 0.7, bottomNoise[i]);
      const show = ss(0.45, 0.75, aggShow[i]) * agg.mask[i];
      gray[i] = 0.68 + tone + 0.07 * (blotch[i] - 0.5) + 0.04 * (fine[i] - 0.5) + 0.07 * show * agg.tone[i]
        - 0.13 * drips[i] - 0.06 * vert[i] - 0.06 * edgeDirt - 0.05 * chamfer
        - 0.25 * seam - 0.3 * holes[i] + 0.03 * (plugs[i] - holes[i]) - 0.15 * pores[i];
      height[i] = 0.25 * fine[i] - 1.4 * seam - 0.6 * chamfer - 1.5 * holes[i] - 0.5 * pores[i]
        + 0.2 * blotch[i] + 0.35 * show;
      cavity[i] = 1 - Math.min(1, 0.9 * seam + 0.9 * holes[i] + 0.5 * pores[i] + 0.2 * chamfer);
      rough[i] = 0.7 + 0.2 * fine[i] + 0.1 * show;
      grime[i] = 0.35 * bottom + 0.1 * vert[i];
      rustF[i] = rust[i] * 0.7;
    }
  return new TexLayer({ gray, rgb: [0.95, 0.95, 0.93], warm, height, strength: 1.5, cavity, rough, grime, rust: rustF });
}

function asphalt(rng: Rng): TexLayer {
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
  return new TexLayer({ gray, rgb: [1, 0.99, 0.97], warm, height, strength: 1.1, cavity, rough });
}

// Tile: 4 m, 0.5 m slabs. Worn, some cracked or chipped, dirt and moss in the joints, stains.
function paving(rng: Rng): TexLayer {
  const n = TEX_SIZE, slab = n / 8;
  const tones = Array.from({ length: 64 }, () => rng.normal() * 0.03);
  const cracked = Array.from({ length: 64 }, () => rng.chance(0.14));
  const sunk = Array.from({ length: 64 }, () => (rng.chance(0.15) ? rng.uniform(0.3, 1) : 0));
  const dirtN = fbm(rng, n, 16, 16, 3);
  const crackN = fbm(rng, n, 8, 8, 4);
  const fine = fbm(rng, n, 32, 32, 4);
  const blotch = stretch(fbm(rng, n, 4, 4, 5));
  const warm = fbm(rng, n, 2, 2, 3);
  const grit = speckles(rng, n, 0.01);
  const agg = stones(rng, n, 3000, 0.6, 1.6);
  const stainN = fbm(rng, n, 5, 5, 4);
  const mossN = fbm(rng, n, 12, 12, 3);
  const gray = new Float32Array(n * n), height = new Float32Array(n * n);
  const cavity = new Float32Array(n * n), rough = new Float32Array(n * n);
  const grime = new Float32Array(n * n);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const sx = x % slab, sy = y % slab;
      const id = Math.floor(y / slab) * 8 + Math.floor(x / slab);
      const d = Math.min(sx, slab - 1 - sx, sy, slab - 1 - sy);
      const joint = 1 - ss(0.3, 1.8, d);
      const bevel = 1 - ss(1.5, 4, d);
      const dirt = (1 - ss(1, 10, d)) * dirtN[i];
      const crack = cracked[id] ? 1 - ss(0.004, 0.014, Math.abs(crackN[i] - 0.5)) : 0;
      const stain = ss(0.62, 0.8, stainN[i]);
      gray[i] = 0.6 + tones[id] + 0.08 * (blotch[i] - 0.5) + 0.05 * (fine[i] - 0.5) + 0.05 * agg.mask[i] * agg.tone[i]
        - 0.35 * joint - 0.12 * dirt - 0.2 * crack - 0.08 * grit[i] - 0.1 * stain - 0.05 * sunk[id];
      height[i] = 0.2 * fine[i] - 1.2 * joint - 0.4 * bevel - 0.8 * crack + tones[id] * 2 - 0.3 * sunk[id] + 0.15 * agg.mask[i];
      cavity[i] = 1 - Math.min(1, 0.9 * joint + 0.6 * crack);
      rough[i] = 0.8 + 0.15 * fine[i] - 0.15 * stain;
      grime[i] = Math.min(1, (0.8 * (1 - ss(0.5, 4, d)) + 0.5 * crack) * ss(0.35, 0.6, mossN[i]) + 0.2 * dirt);
    }
  return new TexLayer({ gray, rgb: [0.96, 0.95, 0.92], warm, height, strength: 1.5, cavity, rough, grime });
}

// Tile: 3 m, 16 ribs (~19 cm). Cast ribs whose faces were hammered off to expose the aggregate
// (Rudolph's "corduroy"), with smooth form-faced grooves collecting grime.
function ribbed(rng: Rng): TexLayer {
  const n = TEX_SIZE, P = 32;
  const edgeN = valueNoise(rng, n, 16, 96);
  const hammer = fbm(rng, n, 64, 64, 3);
  const pocks = speckles(rng, n, 0.05);
  const agg = stones(rng, n, 7000, 0.7, 2.4);
  const blotch = stretch(fbm(rng, n, 3, 5, 6));
  const warm = fbm(rng, n, 2, 2, 3);
  const streak = rainStreaks(rng, n, 128, 4);
  const grooveDirt = fbm(rng, n, 2, 4, 4);
  const ribTone = Array.from({ length: n / P }, () => rng.normal() * 0.02);
  const liftY = rng.int(150, 350);
  const gray = new Float32Array(n * n), height = new Float32Array(n * n);
  const cavity = new Float32Array(n * n), rough = new Float32Array(n * n);
  const grime = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    const lift = 1 - ss(0, 2.5, Math.abs(y - liftY));
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const k = Math.floor(x / P);
      const px = (x % P) + 0.5;
      // distance from the rib centre, with broken, irregular edges
      const half = 9 + (edgeN[i] - 0.5) * 4;
      const dc = Math.abs(px - P / 2);
      const rib = 1 - ss(half - 1.2, half + 1.2, dc);
      const slope = ss(half, half + 4, dc); // sloped rib flank into the groove
      const groove = ss(half + 3, half + 5.5, dc);
      const face = rib * ss(0.35, 0.65, agg.mask[i] + 0.2);
      const h = rib * (1 + 0.35 * hammer[i] - 0.4 * pocks[i]) + (1 - rib) * (1 - slope) * 0.6 + 0.12 * agg.mask[i] * rib;
      gray[i] = 0.6 + 0.08 * (blotch[i] - 0.5) + ribTone[k]
        + rib * (0.05 * (hammer[i] - 0.5) + 0.12 * agg.tone[i] * agg.mask[i] - 0.18 * pocks[i])
        - 0.14 * slope - 0.16 * groove - 0.14 * streak[i] * (0.6 + 0.4 * groove) - 0.12 * lift;
      height[i] = h * 2.2 - 0.5 * lift;
      cavity[i] = 1 - Math.min(1, 0.55 * groove + 0.5 * pocks[i] * rib + 0.2 * slope + 0.3 * lift);
      rough[i] = 0.93 - 0.2 * groove + 0.05 * face;
      grime[i] = groove * ss(0.4, 0.75, grooveDirt[i]) * 0.55;
    }
  }
  return new TexLayer({ gray, rgb: [0.96, 0.95, 0.91], warm, height, strength: 1.6, cavity, rough, grime });
}

// Tile: 4.8 m. Plywood form panels of 1.2 x 2.4 m, each with its own absorbency and a ghost of
// the veneer grain, grout fins at the joints, tie holes on a 0.6 m grid, bugholes that gather
// under the top of each pour, water stains and rust runs.
function castInPlace(rng: Rng): TexLayer {
  const n = TEX_SIZE, pw = 128, ph = 256;
  const tones = Array.from({ length: 8 }, () => rng.normal() * 0.045);
  const grainDir = Array.from({ length: 8 }, () => rng.chance(0.5));
  const veneer = fbm(rng, n, 3, 12, 4), veneerV = fbm(rng, n, 12, 3, 4);
  const warp = fbm(rng, n, 6, 6, 3);
  const fine = fbm(rng, n, 24, 24, 4);
  const blotch = stretch(fbm(rng, n, 3, 3, 6));
  const warm = fbm(rng, n, 2, 2, 3);
  const ties: [number, number][] = [];
  for (let c = 0; c < 4; c++)
    for (const oy of [0, ph])
      for (const ty of [52, 128, 204])
        for (const tx of [32, 96]) ties.push([c * pw + tx, oy + ty]);
  const holes = discs(n, ties, 4);
  const cones = discs(n, ties, 7);
  const jitter = valueNoise(rng, n, 64, 64);
  const rust = runs(rng, n, ties.filter(() => rng.chance(0.18)).map(([x, y]) => [x, y - 3]), [25, 120], [1.2, 2.8], jitter);
  const stain = runs(rng, n, Array.from({ length: 14 }, () => [rng.uniform(0, n), rng.uniform(0, n)] as [number, number]), [60, 260], [6, 16], jitter);
  const bugs = speckles(rng, n, 0.003);
  const bugBig = discs(n, Array.from({ length: 70 }, () => [rng.uniform(0, n), rng.uniform(0, n)] as [number, number]), 1.6);
  const finN = valueNoise(rng, n, 96, 96);
  const streak = rainStreaks(rng, n, 80, 3);
  const bloomN = fbm(rng, n, 10, 4, 3);
  const gray = new Float32Array(n * n), height = new Float32Array(n * n);
  const cavity = new Float32Array(n * n), rough = new Float32Array(n * n);
  const rustF = new Float32Array(n * n), bloom = new Float32Array(n * n);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const c = Math.floor(x / pw), r = Math.floor(y / ph), id = r * 4 + c;
      const px = x % pw, py = y % ph;
      const d = Math.min(px, pw - 1 - px, py, ph - 1 - py);
      const joint = 1 - ss(0.2, 1.4, d);
      const fin = joint * ss(0.55, 0.75, finN[i]);
      const vg = grainDir[id] ? veneer[i] : veneerV[i];
      const ghost = Math.sin((vg + warp[i] * 0.3) * 60) * 0.5 + 0.5;
      // bugholes collect under the top of each panel row (where air rose in the pour)
      const topBand = ss(ph * 0.55, ph * 0.95, py);
      const bug = Math.min(1, bugs[i] * (0.3 + topBand) + bugBig[i] * (0.4 + 0.8 * topBand));
      const cone = cones[i] - holes[i];
      gray[i] = 0.66 + tones[id] + 0.07 * (blotch[i] - 0.5) + 0.03 * (fine[i] - 0.5) + 0.025 * (ghost - 0.5)
        - 0.12 * joint + 0.08 * fin - 0.45 * holes[i] - 0.06 * cone - 0.2 * bug
        - 0.16 * stain[i] - 0.1 * streak[i];
      height[i] = 0.15 * fine[i] + 0.06 * ghost - 0.6 * joint + 1.1 * fin - 1.6 * holes[i] - 0.4 * cone - 1.2 * bug;
      cavity[i] = 1 - Math.min(1, 0.5 * joint + 0.95 * holes[i] + 0.7 * bug + 0.2 * cone);
      rough[i] = 0.72 + 0.12 * fine[i] + 0.08 * stain[i];
      rustF[i] = rust[i] * 0.8;
      bloom[i] = 0.25 * ss(0.62, 0.85, bloomN[i]) * (1 - ss(0, 40, py)) + 0.25 * fin;
    }
  return new TexLayer({ gray, rgb: [0.96, 0.955, 0.93], warm, height, strength: 1.4, cavity, rough, rust: rustF, bloom });
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
  albedo: Uint8Array; // TEX_LAYERS layers stacked
  normal: Uint8Array;
  noise: Uint8Array;
}

export function generateTextures(seed = 7): TextureSet {
  const rng = new Rng(seed);
  // the shader noise comes first so it stays the same whatever the material recipes do
  const noise = shaderNoise(rng);
  const layers = [boardFormed(rng), precastPanel(rng), asphalt(rng), paving(rng), ribbed(rng), castInPlace(rng)];
  const px = TEX_SIZE * TEX_SIZE * 4;
  const albedo = new Uint8Array(px * layers.length);
  const normal = new Uint8Array(px * layers.length);
  layers.forEach((l, i) => {
    albedo.set(l.albedo, i * px);
    normal.set(l.normal, i * px);
  });
  return { albedo, normal, noise };
}
