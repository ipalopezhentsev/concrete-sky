// Pedestrians: people walking the pavements round the blocks. Like the traffic, where each one
// is is a pure function of time — a slot in a stream going round the block one way or the
// other — so nothing is simulated or saved, and two in the same stream never walk into each
// other.
//
// The way round a block is worked out once, when it first comes near: a line down the
// pavement under two metres in from the kerb, which swings in round anything standing in it
// (a lamp, a lift, the opening of a subway stair) and back out again past it.

import type { Lift } from "./city/generate";
import { blocksIn, grain, type Site, type Vec2 } from "./city/network";
import { groundAt, inEntrance, pavementAt, pavementOf, shrink, WALK, type Station } from "./city/plan";
import { worldSeed, type Vec3 } from "./math";
import type { Colliders } from "./player";
import { WALKER_STRIDES } from "./vehicles/models";
import { h32, InstanceList } from "./vehicles/traffic";

/** Distance between samples of a walk. */
const STEP = 0.5;
/**
 * Kerb to the middle of the walk; the two directions keep to either side of it. Between the
 * lamp columns (0.8 m in from the kerb) and the foot of the stair up to the deck (2.5 m in).
 */
const MID = 1.7;
const LANE = 0.33;
/** The furthest in from the middle a walk will swing to get round something. */
const SWING = WALK - 0.9 - MID;
/** How quickly it swings: across per metre along. */
const RAMP = 0.6;
/** Half a body's width, and the heights a body fills above the pavement. */
const BODY = 0.3, KNEE = 0.3, HEAD = 1.8;
/** Out to here people are drawn; past it they are a few pixels. */
const RADIUS = 170;
/** A full walk cycle, left foot and right, in metres. */
const CYCLE = 1.5;
/** Most milliseconds a frame may spend laying out new walks. */
const BUDGET = 2;

/** Coats: what a city like this wears, with the odd bright one. */
const COATS: Vec3[] = [
  [0.16, 0.16, 0.17], [0.3, 0.29, 0.27], [0.22, 0.24, 0.3], [0.42, 0.38, 0.3], [0.36, 0.22, 0.15],
  [0.24, 0.27, 0.2], [0.52, 0.5, 0.46], [0.1, 0.1, 0.11], [0.2, 0.14, 0.12], [0.62, 0.18, 0.12],
  [0.7, 0.55, 0.16], [0.14, 0.32, 0.36],
];

/** How busy the streets are through the day, hour by hour, 0..1. */
const DAY = [0.12, 0.08, 0.05, 0.04, 0.05, 0.1, 0.25, 0.6, 0.95, 0.85, 0.7, 0.75,
  0.85, 0.8, 0.7, 0.72, 0.8, 0.95, 1, 0.85, 0.65, 0.5, 0.35, 0.2];

interface Walk {
  /** Samples round the block every STEP metres: x, z, pavement height, heading. */
  x: Float32Array;
  z: Float32Array;
  y: Float32Array;
  yaw: Float32Array;
  /** Samples nobody can stand on (the walk could not get round something there). */
  blocked: Uint8Array;
  n: number;
  len: number;
  /** Clear spots off the walk where people stand about: x, z, y, facing. */
  stands: number[];
  /** Ordinal of the block, for hashing. */
  id: number;
  busy: number;
}

const EMPTY: Walk = {
  x: new Float32Array(0), z: new Float32Array(0), y: new Float32Array(0), yaw: new Float32Array(0),
  blocked: new Uint8Array(0), n: 0, len: 0, stands: [], id: 0, busy: 0,
};

/** Someone in the way, who people step aside from. */
export interface Avoid {
  x: number;
  z: number;
  r: number;
}

export class Pedestrians {
  /** Bodies by pose, one list per entry of WALKER_STRIDES. */
  readonly lists = WALKER_STRIDES.map(() => new InstanceList(256));
  /** Hour of the day, which sets how many are out. */
  hour = 12;
  /** 0..1: rain keeps some of them in. */
  rain = 0;
  private walks = new Map<string, Walk>();
  private lifts: Lift[] = [];
  private stations: Station[] = [];
  private near: { key: string; sites: Site[] } = { key: "", sites: [] };
  private seed = worldSeed() ^ 0x5eed;

  constructor(private colliders: Colliders) {}

  /** What the world has streamed in that a walk has to get round. */
  sync(lifts: Iterable<Lift>, stations: Iterable<Station>): void {
    this.lifts = [...lifts];
    this.stations = [...stations];
  }

  update(time: number, eye: Vec3, fwd: Vec3, avoid: Avoid[]): void {
    for (const l of this.lists) l.clear();
    if (this.seed !== (worldSeed() ^ 0x5eed)) {
      this.seed = worldSeed() ^ 0x5eed;
      this.walks.clear();
      this.near.key = "";
    }
    // in the subway there is nobody above to see
    if (eye[1] < groundAt(eye[0], eye[2]) - 3) return;
    const sites = this.sitesNear(eye);
    const crowd = DAY[Math.floor(this.hour) % 24] * (1 - (this.hour % 1)) + DAY[Math.ceil(this.hour) % 24] * (this.hour % 1);
    const busy = crowd * (1 - 0.55 * this.rain);
    const ahead = (x: number, y: number, z: number) =>
      (x - eye[0]) * fwd[0] + (y - eye[1]) * fwd[1] + (z - eye[2]) * fwd[2] > -3;

    const start = performance.now();
    for (const site of sites) {
      let w = this.walks.get(site.key);
      if (!w) {
        // laid out a few at a time, nearest first, so coming into a new quarter never stalls
        if (performance.now() - start > BUDGET) continue;
        w = this.walkOf(site);
        this.walks.set(site.key, w);
      }
      if (w.n === 0) continue;
      this.walkers(w, time, busy, eye, ahead, avoid);
      this.standers(w, time, busy, eye, ahead, avoid);
    }
    if (this.walks.size > 600) {
      const keep = new Set(sites.map((s) => s.key));
      for (const k of this.walks.keys()) if (!keep.has(k)) this.walks.delete(k);
    }
  }

  /** The blocks in reach, nearest first; asked again only when the eye has moved a way. */
  private sitesNear(eye: Vec3): Site[] {
    const key = `${Math.round(eye[0] / 20)},${Math.round(eye[2] / 20)}`;
    if (this.near.key === key) return this.near.sites;
    const sites = blocksIn(eye[0] - RADIUS, eye[2] - RADIUS, eye[0] + RADIUS, eye[2] + RADIUS)
      .map((s) => ({ s, d: Math.hypot(s.p[0] - eye[0], s.p[1] - eye[2]) }))
      .filter((e) => e.d < RADIUS + 150)
      .sort((a, b) => a.d - b.d)
      .map((e) => e.s);
    this.near = { key, sites };
    return sites;
  }

  /** The people walking round one block: a stream each way, at its own pace. */
  private walkers(w: Walk, time: number, busy: number, eye: Vec3, ahead: (x: number, y: number, z: number) => boolean, avoid: Avoid[]): void {
    for (const dir of [1, -1] as const) {
      const h0 = h32(w.id, dir > 0 ? 1 : 2, 0, this.seed);
      const speed = 1.15 + ((h0 & 0xff) / 255) * 0.4;
      const spacing = 7 + ((h0 >>> 8) & 0xff) / 255 * 3;
      const slots = Math.max(1, Math.floor(w.len / spacing));
      const gap = w.len / slots;
      const shift = dir * speed * time;
      for (let k = 0; k < slots; k++) {
        const h = h32(w.id, dir > 0 ? 3 : 4, k, this.seed);
        if ((h & 0xffff) / 0x10000 >= busy * w.busy) continue;
        const along = k * gap + (((h >>> 16) & 0xff) / 255) * gap * 0.5 + shift;
        const s = ((along % w.len) + w.len) % w.len;
        const f = s / STEP;
        const i = Math.floor(f) % w.n, j = (i + 1) % w.n, t = f - Math.floor(f);
        if (w.blocked[i] || w.blocked[j]) continue;
        let x = w.x[i] + (w.x[j] - w.x[i]) * t;
        let z = w.z[i] + (w.z[j] - w.z[i]) * t;
        if (Math.abs(x - eye[0]) > RADIUS || Math.abs(z - eye[2]) > RADIUS) continue;
        const y = w.y[i] + (w.y[j] - w.y[i]) * t;
        if (!ahead(x, y, z)) continue;
        let yaw = lerpAngle(w.yaw[i], w.yaw[j], t);
        if (dir < 0) yaw += Math.PI;
        // keep right, as the cars do: right of facing (sin, cos) is (-cos, sin)
        const lane = LANE + (((h >>> 24) & 0xf) / 15 - 0.5) * 0.04;
        x -= Math.cos(yaw) * lane;
        z += Math.sin(yaw) * lane;
        [x, z] = stepAside(x, z, avoid);
        const phase = (along / CYCLE + ((h >>> 8) & 0xff) / 255) * Math.PI * 2;
        const swing = Math.sin(phase);
        const bob = (1 - Math.abs(swing)) * 0.03;
        const pose = Math.round((swing + 1) * 2);
        this.lists[pose].push(x, y + bob, z, yaw, 0, 0, COATS[(h >>> 4) % COATS.length], 1);
      }
    }
  }

  /** People standing about off the walk: on their own, or two facing each other. */
  private standers(w: Walk, time: number, busy: number, eye: Vec3, ahead: (x: number, y: number, z: number) => boolean, avoid: Avoid[]): void {
    const still = WALKER_STRIDES.indexOf(0);
    const s = w.stands;
    for (let k = 0; k < s.length; k += 4) {
      const h = h32(w.id, 5, k, this.seed);
      // they come and go over a few minutes, rather than standing there all day
      const stay = Math.floor(time / 150 + ((h >>> 20) & 0xff) / 255);
      const hs = h32(w.id, 6, k * 977 + stay, this.seed);
      if ((hs & 0xffff) / 0x10000 >= busy * w.busy * 0.6) continue;
      const x0 = s[k], z0 = s[k + 1], y = s[k + 2], face = s[k + 3];
      if (Math.abs(x0 - eye[0]) > RADIUS || Math.abs(z0 - eye[2]) > RADIUS || !ahead(x0, y, z0)) continue;
      const pair = (hs >>> 16) % 3 === 0;
      const turn = Math.sin(time * 0.3 + k) * 0.25 + (((hs >>> 20) & 0xff) / 255 - 0.5);
      const fx = Math.sin(face), fz = Math.cos(face);
      for (let p = 0; p < (pair ? 2 : 1); p++) {
        // a pair stand a metre apart, each turned to the other
        const d = pair ? (p === 0 ? -0.5 : 0.5) : 0;
        const [x, z] = stepAside(x0 + fz * d, z0 - fx * d, avoid);
        const yaw = pair ? face + (p === 0 ? -Math.PI / 2 : Math.PI / 2) + turn * 0.3 : face + turn;
        this.lists[still].push(x, y, z, yaw, 0, 0, COATS[((hs >>> 4) + p * 5) % COATS.length], 1);
      }
    }
  }

  /** Lay out the way round a block. */
  private walkOf(site: Site): Walk {
    const poly = pavementOf(site);
    const line = poly ? shrink(poly, MID) : [];
    if (!poly || line.length < 3) return EMPTY;
    let len = 0;
    for (let k = 0; k < line.length; k++) len += dist(line[k], line[(k + 1) % line.length]);
    const n = Math.floor(len / STEP);
    if (n < 16) return EMPTY;
    const step = len / n;
    let cx = 0, cz = 0;
    for (const p of poly) {
      cx += p[0] / poly.length;
      cz += p[1] / poly.length;
    }

    // the line itself, and which way is in from the kerb at each point of it
    const px = new Float32Array(n), pz = new Float32Array(n), nx = new Float32Array(n), nz = new Float32Array(n);
    {
      let k = 0, into = 0;
      for (let i = 0; i < n; i++) {
        let s = i * step - into;
        let a = line[k], b = line[(k + 1) % line.length], l = dist(a, b);
        while (s > l && k < line.length - 1) {
          into += l;
          s -= l;
          k++;
          a = line[k];
          b = line[(k + 1) % line.length];
          l = dist(a, b);
        }
        const ux = (b[0] - a[0]) / (l || 1), uz = (b[1] - a[1]) / (l || 1);
        px[i] = a[0] + ux * s;
        pz[i] = a[1] + uz * s;
        let ix = -uz, iz = ux;
        if (ix * (cx - px[i]) + iz * (cz - pz[i]) < 0) {
          ix = -ix;
          iz = -iz;
        }
        nx[i] = ix;
        nz[i] = iz;
      }
    }

    // What stands on the pavement at body height, gathered once for the whole block. The
    // collision is the city's own, so anything a runner bumps into a walker goes round.
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity, lo = Infinity, hi = -Infinity;
    for (const p of poly) {
      x0 = Math.min(x0, p[0]);
      z0 = Math.min(z0, p[1]);
      x1 = Math.max(x1, p[0]);
      z1 = Math.max(z1, p[1]);
    }
    const py = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      py[i] = pavementAt(px[i], pz[i]);
      lo = Math.min(lo, py[i]);
      hi = Math.max(hi, py[i]);
    }
    const boxes: number[] = [];
    const seen = new Set<Float32Array>();
    for (let i = 0; i < n; i += Math.floor(60 / STEP)) {
      const b = this.colliders(px[i], pz[i]);
      if (seen.has(b)) continue;
      seen.add(b);
      for (let o = 0; o < b.length; o += 6) {
        if (b[o + 3] < x0 - 1 || b[o] > x1 + 1 || b[o + 5] < z0 - 1 || b[o + 2] > z1 + 1) continue;
        if (b[o + 4] < lo + KNEE || b[o + 1] > hi + HEAD) continue;
        boxes.push(b[o], b[o + 1], b[o + 2], b[o + 3], b[o + 4], b[o + 5]);
      }
    }
    const lifts = this.lifts.filter((l) => l.x1 > x0 - 1 && l.x0 < x1 + 1 && l.z1 > z0 - 1 && l.z0 < z1 + 1);
    const stations = this.stations.filter((st) => Math.hypot(st.shaftX - cx, st.shaftZ - cz) < Math.hypot(x1 - x0, z1 - z0) / 2 + 80);
    const clear = (x: number, z: number, pad: number): boolean => {
      const y = pavementAt(x, z);
      for (let o = 0; o < boxes.length; o += 6) {
        if (x > boxes[o] - pad && x < boxes[o + 3] + pad && z > boxes[o + 2] - pad && z < boxes[o + 5] + pad &&
            boxes[o + 4] > y + KNEE && boxes[o + 1] < y + HEAD) return false;
      }
      for (const l of lifts) if (x > l.x0 - pad && x < l.x1 + pad && z > l.z0 - pad && z < l.z1 + pad) return false;
      for (const st of stations) if (inEntrance(st, x, z, pad + 0.4)) return false;
      return true;
    };

    // How far in each point has to swing: the least that clears both lanes, and then eased
    // so the walk bends round a thing rather than jumping sideways at it.
    const wide = LANE + 0.02;
    const swing = new Float32Array(n), blocked = new Uint8Array(n);
    const fits = (i: number, e: number) =>
      clear(px[i] - nx[i] * (wide - e), pz[i] - nz[i] * (wide - e), BODY) &&
      clear(px[i] + nx[i] * e, pz[i] + nz[i] * e, BODY) &&
      clear(px[i] + nx[i] * (e + wide), pz[i] + nz[i] * (e + wide), BODY);
    for (let i = 0; i < n; i++) {
      let e = 0;
      while (e <= SWING && !fits(i, e)) e += 0.25;
      if (e > SWING) {
        e = 0;
        blocked[i] = 1;
      }
      swing[i] = e;
    }
    // the ramp, both ways round the loop (twice, since it is a loop)
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n; i++) swing[i] = Math.max(swing[i], swing[(i + n - 1) % n] - RAMP * step);
      for (let i = n - 1; i >= 0; i--) swing[i] = Math.max(swing[i], swing[(i + 1) % n] - RAMP * step);
    }
    let x = new Float32Array(n), z = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      x[i] = px[i] + nx[i] * swing[i];
      z[i] = pz[i] + nz[i] * swing[i];
    }
    // corners rounded off, so nobody turns ninety degrees on the spot
    for (let pass = 0; pass < 6; pass++) {
      const sx = new Float32Array(n), sz = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const a = (i + n - 1) % n, b = (i + 1) % n;
        sx[i] = (x[a] + 2 * x[i] + x[b]) / 4;
        sz[i] = (z[a] + 2 * z[i] + z[b]) / 4;
      }
      x = sx;
      z = sz;
    }
    // where it still runs into something, nobody is drawn: the swing could not find a way
    // past, or the ramp brought it in somewhere the eased line no longer clears
    for (let i = 0; i < n; i++) if (!blocked[i] && !clear(x[i], z[i], BODY - 0.1)) blocked[i] = 1;
    const y = new Float32Array(n), yaw = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      y[i] = pavementAt(x[i], z[i]);
      const a = (i + n - 2) % n, b = (i + 2) % n;
      yaw[i] = Math.atan2(x[b] - x[a], z[b] - z[a]);
    }

    // A few places to stand: in from the walk where nothing is, facing out to the street.
    const stands: number[] = [];
    const r = h32(Math.round(site.p[0]), Math.round(site.p[1]), 7, this.seed);
    const count = 1 + Math.floor(n * STEP / 45);
    for (let k = 0; k < count; k++) {
      const i = Math.floor(((h32(r, k, 8, this.seed) & 0xffff) / 0x10000) * n);
      if (swing[i] > 0) continue;
      const e = MID + LANE + 1.2 + ((h32(r, k, 9, this.seed) & 0xff) / 255) * 1.5;
      const sx = px[i] + nx[i] * (e - MID), sz = pz[i] + nz[i] * (e - MID);
      if (!clear(sx, sz, 0.9)) continue;
      stands.push(sx, sz, pavementAt(sx, sz), Math.atan2(-nx[i], -nz[i]));
    }

    const g = grain(site.p[0], site.p[1]);
    return { x, z, y, yaw, blocked, n, len: n * step, stands, id: r, busy: 0.35 + 0.65 * g };
  }
}

const dist = (a: Vec2, b: Vec2) => Math.hypot(b[0] - a[0], b[1] - a[1]);

function lerpAngle(a: number, b: number, t: number): number {
  return a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;
}

/** Pushed out of the way of whoever is in it, as far as the edge of their room. */
function stepAside(x: number, z: number, avoid: Avoid[]): [number, number] {
  for (const a of avoid) {
    const dx = x - a.x, dz = z - a.z;
    const d = Math.hypot(dx, dz);
    if (d >= a.r) continue;
    if (d < 1e-3) return [x + a.r, z];
    x = a.x + (dx / d) * a.r;
    z = a.z + (dz / d) * a.r;
  }
  return [x, z];
}
