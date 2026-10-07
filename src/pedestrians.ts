// Pedestrians: people walking the city. Like the traffic, where each one is is a pure function
// of time — a slot in a stream going round a route — so nothing is simulated or saved, and two
// in the same stream never walk into each other.
//
// A route is one of two kinds. A loop: round a block's pavement, round its deck, round the edge
// of a roof, with a stream each way keeping right of the line. Or a way somewhere and back: up
// a block's stair to its deck, or down a subway entrance to the platform. That is laid out as
// a loop too — up one side and down the other — with a stop at each end, where everyone goes
// off to a spot of their own and stands a while (looking out over the parapet; waiting for a
// train) before they turn back.
//
// The way round a loop is worked out once, when it first comes near: a line under two metres
// in from the edge, which swings in round anything standing in it (a lamp, a lift, the opening
// of a subway stair, a parked flyer) and back out again past it.

import type { Lift, Pad, Roof } from "./city/generate";
import { blocksIn, grain, type Site, type Vec2 } from "./city/network";
import {
  deckOf, groundAt, inEntrance, pavementAt, pavementOf, shrink, stairOf, stationWay, WALK, type Station,
} from "./city/plan";
import { worldSeed, type Vec3 } from "./math";
import type { Colliders } from "./player";
import { WALKER_STRIDES } from "./vehicles/models";
import { h32, InstanceList } from "./vehicles/traffic";

/** Distance between samples of a route. */
const STEP = 0.5;
/**
 * Kerb to the middle of the pavement walk; the two directions keep to either side of it.
 * Between the lamp columns (0.8 m in from the kerb) and the foot of the stair up to the deck
 * (2.5 m in).
 */
const MID = 1.7;
/** Kerb to the middle of the deck walk: clear of the parapet, and of a parked flyer's nose. */
const DECK_MID = WALK - 0.9 + 1.3;
const LANE = 0.33;
/** How quickly a loop swings in round something: across per metre along. */
const RAMP = 0.6;
/** Half a body's width, and the heights a body fills above what it stands on. */
const BODY = 0.3, KNEE = 0.3, HEAD = 1.8;
/** Out to here people are drawn; past it they are a few pixels. */
const RADIUS = 170;
/** A full walk cycle, left foot and right, in metres. */
const CYCLE = 1.5;
/** Most milliseconds a frame may spend laying out new routes. */
const BUDGET = 2;
/** Roughly how fast people walk, for turning a stop's seconds into metres along the route. */
const PACE = 1.35;

/** Coats: what a city like this wears, with the odd bright one. */
const COATS: Vec3[] = [
  [0.16, 0.16, 0.17], [0.3, 0.29, 0.27], [0.22, 0.24, 0.3], [0.42, 0.38, 0.3], [0.36, 0.22, 0.15],
  [0.24, 0.27, 0.2], [0.52, 0.5, 0.46], [0.1, 0.1, 0.11], [0.2, 0.14, 0.12], [0.62, 0.18, 0.12],
  [0.7, 0.55, 0.16], [0.14, 0.32, 0.36],
];

/** How busy the streets are through the day, hour by hour, 0..1. */
const DAY = [0.12, 0.08, 0.05, 0.04, 0.05, 0.1, 0.25, 0.6, 0.95, 0.85, 0.7, 0.75,
  0.85, 0.8, 0.7, 0.72, 0.8, 0.95, 1, 0.85, 0.65, 0.5, 0.35, 0.2];

/** Somewhere one person goes from a stop to stand: the way there, x y z, and which way they face. */
interface Spot {
  pts: Float32Array;
  len: number;
  face: number;
}

/** A stop on a route: how long everyone spends at it, in metres walked, and where they stand. */
interface Stop {
  len: number;
  spots: Spot[];
}

interface Route {
  /** Samples along the route: x, z, surface height, heading. */
  x: Float32Array;
  z: Float32Array;
  y: Float32Array;
  yaw: Float32Array;
  /** Samples nobody can stand on (the loop could not get round something there). */
  blocked: Uint8Array;
  n: number;
  /** How far along each sample starts, counting any stop at the ones before it; n + 1 long. */
  at: Float32Array;
  len: number;
  /** Stops, by the sample they are at. */
  stops: Map<number, Stop>;
  /** Clear spots off a loop where people stand about: x, z, y, facing. */
  stands: number[];
  /** A stream each way keeping right of the line, or one stream along a line already laid to the right. */
  both: boolean;
  /** Metres between people in a stream, and how much that varies from one stream to the next. */
  gap: number;
  spread: number;
  id: number;
  busy: number;
  /** Underground, so it is the one kind seen from the subway. */
  below: boolean;
}

const EMPTY: Route = {
  x: new Float32Array(0), z: new Float32Array(0), y: new Float32Array(0), yaw: new Float32Array(0),
  blocked: new Uint8Array(0), n: 0, at: new Float32Array(1), len: 0, stops: new Map(), stands: [],
  both: true, gap: 1, spread: 0, id: 0, busy: 0, below: false,
};

/** Someone in the way, who people step aside from. */
export interface Avoid {
  x: number;
  y: number;
  z: number;
  r: number;
}

/** Where a person is this frame. */
interface Place {
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Metres walked, for the stride; NaN while they stand. */
  stride: number;
}

/** What a stander or a stop's spot may not stand in, worked out for a patch of the city. */
type Clear = (x: number, y: number, z: number, pad: number) => boolean;

/** The shape of a loop, and what it is for. */
interface LoopKind {
  /** Outline to the middle of the walk. */
  inset: number;
  /** The furthest in from the middle a walk will swing to get round something. */
  swing: number;
  /** The walk is on the pavement, so it goes round the lifts and the subway entrances too. */
  ground: boolean;
  both: boolean;
  stands: boolean;
  gap: number;
  spread: number;
  busy: number;
}

const PAVEMENT: LoopKind = { inset: MID, swing: WALK - 0.9 - MID, ground: true, both: true, stands: true, gap: 7, spread: 3, busy: 1 };
const DECK: LoopKind = { inset: DECK_MID, swing: 3.4, ground: false, both: true, stands: true, gap: 13, spread: 8, busy: 0.55 };
const ROOF: LoopKind = { inset: 0.6, swing: 0, ground: false, both: false, stands: false, gap: 22, spread: 14, busy: 0.3 };

export class Pedestrians {
  /** Bodies by pose, one list per entry of WALKER_STRIDES. */
  readonly lists = WALKER_STRIDES.map(() => new InstanceList(256));
  /** Hour of the day, which sets how many are out. */
  hour = 12;
  /** 0..1: rain keeps some of them in. */
  rain = 0;
  private routes = new Map<string, Route>();
  private lifts: Lift[] = [];
  private stations: Station[] = [];
  private pads: Pad[] = [];
  private roofs: Roof[] = [];
  private near: { key: string; jobs: { key: string; make: () => Route; d: number }[] } = { key: "", jobs: [] };
  private seed = worldSeed() ^ 0x5eed;
  private spot: Place = { x: 0, y: 0, z: 0, yaw: 0, stride: 0 };

  constructor(private colliders: Colliders) {}

  /** What the world has streamed in that people walk round, down into or up onto. */
  sync(lifts: Iterable<Lift>, stations: Iterable<Station>, pads: Iterable<Pad>, roofs: Iterable<Roof>): void {
    this.lifts = [...lifts];
    this.stations = [...stations];
    this.pads = [...pads];
    this.roofs = [...roofs];
    this.near.key = "";
  }

  update(time: number, eye: Vec3, fwd: Vec3, avoid: Avoid[]): void {
    for (const l of this.lists) l.clear();
    if (this.seed !== (worldSeed() ^ 0x5eed)) {
      this.seed = worldSeed() ^ 0x5eed;
      this.routes.clear();
      this.near.key = "";
    }
    // in the subway there is nobody above to see, and from the street nobody below but down
    // the stair, which the way down the entrance is
    const under = eye[1] < groundAt(eye[0], eye[2]) - 3;
    const jobs = this.jobsNear(eye);
    const crowd = DAY[Math.floor(this.hour) % 24] * (1 - (this.hour % 1)) + DAY[Math.ceil(this.hour) % 24] * (this.hour % 1);
    const ahead = (x: number, y: number, z: number) =>
      (x - eye[0]) * fwd[0] + (y - eye[1]) * fwd[1] + (z - eye[2]) * fwd[2] > -3;

    const start = performance.now();
    for (const job of jobs) {
      let w = this.routes.get(job.key);
      if (!w) {
        // laid out a few at a time, nearest first, so coming into a new quarter never stalls
        if (performance.now() - start > BUDGET) continue;
        w = job.make();
        this.routes.set(job.key, w);
      }
      if (w.n === 0 || (under && !w.below)) continue;
      // the rain keeps people off the street, but not out of the subway
      const busy = crowd * (w.below ? 1 : 1 - 0.55 * this.rain);
      this.walkers(w, time, busy, eye, ahead, avoid);
      this.standers(w, time, busy, eye, ahead, avoid);
    }
    if (this.routes.size > 1500) {
      const keep = new Set(jobs.map((j) => j.key));
      for (const k of this.routes.keys()) if (!keep.has(k)) this.routes.delete(k);
    }
  }

  /** The routes in reach, nearest first; asked again only when the eye has moved a way. */
  private jobsNear(eye: Vec3): { key: string; make: () => Route }[] {
    const key = `${Math.round(eye[0] / 20)},${Math.round(eye[2] / 20)}`;
    if (this.near.key === key) return this.near.jobs;
    const reach = RADIUS + 150;
    const jobs: { key: string; make: () => Route; d: number }[] = [];
    const far = (x: number, z: number) => Math.hypot(x - eye[0], z - eye[2]);
    for (const s of blocksIn(eye[0] - RADIUS, eye[2] - RADIUS, eye[0] + RADIUS, eye[2] + RADIUS)) {
      const d = far(s.p[0], s.p[1]);
      if (d > reach) continue;
      jobs.push({ key: `p${s.key}`, make: () => this.loopOf(s, PAVEMENT), d });
      jobs.push({ key: `d${s.key}`, make: () => this.loopOf(s, DECK), d: d + 20 });
      jobs.push({ key: `s${s.key}`, make: () => this.stairRoute(s), d: d + 10 });
    }
    for (const st of this.stations) {
      const d = Math.min(far(st.x, st.z), far(st.shaftX, st.shaftZ));
      if (d < reach) jobs.push({ key: `t${st.axis},${st.line},${st.k}`, make: () => this.stationRoute(st), d });
    }
    for (const r of this.roofs) {
      const [x, z] = r.poly[0];
      const d = far(x, z);
      if (d < RADIUS + 60) jobs.push({ key: `r${x.toFixed(1)},${z.toFixed(1)},${r.y.toFixed(1)}`, make: () => this.roofRoute(r), d: d + 40 });
    }
    jobs.sort((a, b) => a.d - b.d);
    this.near = { key, jobs };
    return jobs;
  }

  /** The people walking a route: a stream each way round a loop, or one along a way and back. */
  private walkers(w: Route, time: number, busy: number, eye: Vec3, ahead: (x: number, y: number, z: number) => boolean, avoid: Avoid[]): void {
    const still = WALKER_STRIDES.indexOf(0);
    for (const dir of w.both ? [1, -1] as const : [1] as const) {
      const h0 = h32(w.id, dir > 0 ? 1 : 2, 0, this.seed);
      const speed = 1.15 + ((h0 & 0xff) / 255) * 0.4;
      const spacing = w.gap + ((h0 >>> 8) & 0xff) / 255 * w.spread;
      const slots = Math.max(1, Math.floor(w.len / spacing));
      const gap = w.len / slots;
      const shift = dir * speed * time;
      for (let k = 0; k < slots; k++) {
        const h = h32(w.id, dir > 0 ? 3 : 4, k, this.seed);
        if ((h & 0xffff) / 0x10000 >= busy * w.busy) continue;
        const along = k * gap + (((h >>> 16) & 0xff) / 255) * gap * 0.5 + shift;
        const s = ((along % w.len) + w.len) % w.len;
        const p = this.place(w, s, k, time);
        if (!p) continue;
        let { x, z, yaw } = p;
        if (Math.abs(x - eye[0]) > RADIUS || Math.abs(z - eye[2]) > RADIUS) continue;
        if (!ahead(x, p.y, z)) continue;
        if (dir < 0) yaw += Math.PI;
        if (w.both) {
          // keep right, as the cars do: right of facing (sin, cos) is (-cos, sin)
          const lane = LANE + (((h >>> 24) & 0xf) / 15 - 0.5) * 0.04;
          x -= Math.cos(yaw) * lane;
          z += Math.sin(yaw) * lane;
        }
        [x, z] = stepAside(x, p.y, z, avoid);
        const coat = COATS[(h >>> 4) % COATS.length];
        if (Number.isNaN(p.stride)) {
          this.lists[still].push(x, p.y, z, yaw, 0, 0, coat, 1);
          continue;
        }
        const phase = (p.stride / CYCLE + ((h >>> 8) & 0xff) / 255) * Math.PI * 2;
        const swing = Math.sin(phase);
        const bob = (1 - Math.abs(swing)) * 0.03;
        const pose = Math.round((swing + 1) * 2);
        this.lists[pose].push(x, p.y + bob, z, yaw, 0, 0, coat, 1);
      }
    }
  }

  /** Where someone `s` metres along a route is, or null where nobody can be. */
  private place(w: Route, s: number, k: number, time: number): Place | null {
    // the sample whose stretch this is
    let lo = 0, hi = w.n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (w.at[mid] <= s) lo = mid;
      else hi = mid - 1;
    }
    const i = lo, j = (i + 1) % w.n, p = this.spot;
    let into = s - w.at[i];
    const stop = w.stops.get(i);
    if (stop) {
      if (into < stop.len) return this.stopped(w, i, stop, into, k, time);
      into -= stop.len;
    }
    if (w.blocked[i] || w.blocked[j]) return null;
    const t = Math.min(1, into / Math.max(1e-3, w.at[i + 1] - w.at[i] - (stop?.len ?? 0)));
    p.x = w.x[i] + (w.x[j] - w.x[i]) * t;
    p.z = w.z[i] + (w.z[j] - w.z[i]) * t;
    p.y = w.y[i] + (w.y[j] - w.y[i]) * t;
    p.yaw = lerpAngle(w.yaw[i], w.yaw[j], t);
    p.stride = s;
    return p;
  }

  /**
   * Someone at a stop, `into` metres of its length in: walking out to a spot of their own,
   * standing there, or walking back to go on. Each slot has its own spot, so nobody arriving
   * walks into somebody already standing.
   */
  private stopped(w: Route, i: number, stop: Stop, into: number, k: number, time: number): Place {
    const p = this.spot;
    const spot = stop.spots[(k * 7) % stop.spots.length];
    const out = into < spot.len, back = into > stop.len - spot.len;
    if (!out && !back) {
      const n = spot.pts.length;
      p.x = spot.pts[n - 3];
      p.y = spot.pts[n - 2];
      p.z = spot.pts[n - 1];
      p.yaw = spot.face + Math.sin(time * 0.3 + k) * 0.25;
      p.stride = NaN;
      return p;
    }
    let d = out ? into : stop.len - into;
    const q = spot.pts;
    for (let o = 0; o + 3 < q.length; o += 3) {
      const l = Math.hypot(q[o + 3] - q[o], q[o + 5] - q[o + 2]);
      if (d <= l || o + 6 >= q.length) {
        const t = l > 0 ? Math.min(1, d / l) : 1;
        p.x = q[o] + (q[o + 3] - q[o]) * t;
        p.y = q[o + 1] + (q[o + 4] - q[o + 1]) * t;
        p.z = q[o + 2] + (q[o + 5] - q[o + 2]) * t;
        p.yaw = Math.atan2(q[o + 3] - q[o], q[o + 5] - q[o + 2]) + (out ? 0 : Math.PI);
        p.stride = w.at[i] + into;
        return p;
      }
      d -= l;
    }
    p.x = w.x[i];
    p.y = w.y[i];
    p.z = w.z[i];
    p.yaw = w.yaw[i];
    p.stride = NaN;
    return p;
  }

  /** People standing about off a loop: on their own, or two facing each other. */
  private standers(w: Route, time: number, busy: number, eye: Vec3, ahead: (x: number, y: number, z: number) => boolean, avoid: Avoid[]): void {
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
        const [x, z] = stepAside(x0 + fz * d, y, z0 - fx * d, avoid);
        const yaw = pair ? face + (p === 0 ? -Math.PI / 2 : Math.PI / 2) + turn * 0.3 : face + turn;
        this.lists[still].push(x, y, z, yaw, 0, 0, COATS[((hs >>> 4) + p * 5) % COATS.length], 1);
      }
    }
  }

  /**
   * What stands in a patch of the city at body height, gathered once for the patch. The
   * collision is the city's own, so anything a runner bumps into a walker goes round; on the
   * pavement so are the lifts and the openings of the subway stairs, and anywhere a parked
   * flyer.
   */
  private clearIn(x0: number, z0: number, x1: number, z1: number, lo: number, hi: number, ground: boolean): Clear {
    const boxes: number[] = [];
    const seen = new Set<Float32Array>();
    for (let x = x0; x < x1 + 60; x += 60) {
      for (let z = z0; z < z1 + 60; z += 60) {
        const b = this.colliders(Math.min(x, x1), Math.min(z, z1));
        if (seen.has(b)) continue;
        seen.add(b);
        for (let o = 0; o < b.length; o += 6) {
          if (b[o + 3] < x0 - 1 || b[o] > x1 + 1 || b[o + 5] < z0 - 1 || b[o + 2] > z1 + 1) continue;
          if (b[o + 4] < lo + KNEE || b[o + 1] > hi + HEAD) continue;
          boxes.push(b[o], b[o + 1], b[o + 2], b[o + 3], b[o + 4], b[o + 5]);
        }
      }
    }
    const lifts = ground ? this.lifts.filter((l) => l.x1 > x0 - 1 && l.x0 < x1 + 1 && l.z1 > z0 - 1 && l.z0 < z1 + 1) : [];
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, span = Math.hypot(x1 - x0, z1 - z0) / 2;
    const stations = ground ? this.stations.filter((st) => Math.hypot(st.shaftX - cx, st.shaftZ - cz) < span + 80) : [];
    const pads = this.pads.filter((p) => p.x > x0 - 3 && p.x < x1 + 3 && p.z > z0 - 3 && p.z < z1 + 3 && p.y > lo - 2 && p.y < hi + 2);
    return (x, y, z, pad) => {
      for (let o = 0; o < boxes.length; o += 6) {
        if (x > boxes[o] - pad && x < boxes[o + 3] + pad && z > boxes[o + 2] - pad && z < boxes[o + 5] + pad &&
            boxes[o + 4] > y + KNEE && boxes[o + 1] < y + HEAD) return false;
      }
      for (const l of lifts) if (x > l.x0 - pad && x < l.x1 + pad && z > l.z0 - pad && z < l.z1 + pad) return false;
      for (const st of stations) if (inEntrance(st, x, z, pad + 0.4)) return false;
      // a flyer's fuselage; its rotors are over a walker's head
      for (const p of pads) if (Math.abs(p.y - y) < 1.5 && Math.hypot(p.x - x, p.z - z) < 1.3 + pad) return false;
      return true;
    };
  }

  /** The loop round a block's pavement or its deck. */
  private loopOf(site: Site, kind: LoopKind): Route {
    const poly = pavementOf(site);
    if (!poly) return EMPTY;
    const surface = kind.ground ? pavementAt : (() => { const E = deckOf(site); return () => E; })();
    return this.loop(poly, kind, surface, site.p, grain(site.p[0], site.p[1]));
  }

  /** The way round the edge of a roof, between the parapet line and the plant room. */
  private roofRoute(roof: Roof): Route {
    return this.loop(roof.poly, ROOF, () => roof.y, roof.poly[0], 1);
  }

  /** Lay out a loop `kind.inset` in from an outline. */
  private loop(poly: Vec2[], kind: LoopKind, surface: (x: number, z: number) => number, at: Vec2, grain: number): Route {
    const line = shrink(poly, kind.inset);
    if (line.length < 3) return EMPTY;
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

    // the line itself, and which way is in from the edge at each point of it
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

    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity, lo = Infinity, hi = -Infinity;
    for (const p of poly) {
      x0 = Math.min(x0, p[0]);
      z0 = Math.min(z0, p[1]);
      x1 = Math.max(x1, p[0]);
      z1 = Math.max(z1, p[1]);
    }
    const py = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      py[i] = surface(px[i], pz[i]);
      lo = Math.min(lo, py[i]);
      hi = Math.max(hi, py[i]);
    }
    const free = this.clearIn(x0, z0, x1, z1, lo, hi, kind.ground);
    const clear = (x: number, z: number, pad: number) => free(x, surface(x, z), z, pad);

    // How far in each point has to swing: the least that clears both lanes, and then eased
    // so the walk bends round a thing rather than jumping sideways at it.
    const wide = kind.both ? LANE + 0.02 : 0;
    const swing = new Float32Array(n), blocked = new Uint8Array(n);
    const fits = (i: number, e: number) =>
      clear(px[i] - nx[i] * (wide - e), pz[i] - nz[i] * (wide - e), BODY) &&
      clear(px[i] + nx[i] * e, pz[i] + nz[i] * e, BODY) &&
      clear(px[i] + nx[i] * (e + wide), pz[i] + nz[i] * (e + wide), BODY);
    for (let i = 0; i < n; i++) {
      let e = 0;
      while (e <= kind.swing && !fits(i, e)) e += 0.25;
      if (e > kind.swing) {
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
    let x: Float32Array = new Float32Array(n), z: Float32Array = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      x[i] = px[i] + nx[i] * swing[i];
      z[i] = pz[i] + nz[i] * swing[i];
    }
    // corners rounded off, so nobody turns ninety degrees on the spot
    [x, z] = smooth(x, z, 6, true);
    // where it still runs into something, nobody is drawn: the swing could not find a way
    // past, or the ramp brought it in somewhere the eased line no longer clears
    for (let i = 0; i < n; i++) if (!blocked[i] && !clear(x[i], z[i], BODY - 0.1)) blocked[i] = 1;
    const y = new Float32Array(n), yaw = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      y[i] = surface(x[i], z[i]);
      const a = (i + n - 2) % n, b = (i + 2) % n;
      yaw[i] = Math.atan2(x[b] - x[a], z[b] - z[a]);
    }

    // A few places to stand: in from the walk where nothing is, facing out over the edge.
    const stands: number[] = [];
    const r = h32(Math.round(at[0]), Math.round(at[1]), Math.round(kind.inset * 10) + 7, this.seed);
    const count = kind.stands ? 1 + Math.floor(n * STEP / 45) : 0;
    for (let k = 0; k < count; k++) {
      const i = Math.floor(((h32(r, k, 8, this.seed) & 0xffff) / 0x10000) * n);
      if (swing[i] > 0) continue;
      const e = LANE + 1.2 + ((h32(r, k, 9, this.seed) & 0xff) / 255) * 1.5;
      const sx = px[i] + nx[i] * e, sz = pz[i] + nz[i] * e;
      if (!clear(sx, sz, 0.9)) continue;
      stands.push(sx, sz, surface(sx, sz), Math.atan2(-nx[i], -nz[i]));
    }

    const at_ = new Float32Array(n + 1);
    for (let i = 0; i <= n; i++) at_[i] = i * step;
    return {
      x, z, y, yaw, blocked, n, at: at_, len: n * step, stops: new Map(), stands,
      both: kind.both, gap: kind.gap, spread: kind.spread, id: r, busy: kind.busy * (0.35 + 0.65 * grain), below: false,
    };
  }

  /** Up a block's stair to its deck and back: a stop at the foot, and one at the top. */
  private stairRoute(site: Site): Route {
    const way = stairOf(site);
    if (!way) return EMPTY;
    const foot = way[0], top = way[way.length - 1], edge = way[way.length - 2];
    const h = h32(Math.round(site.p[0]), Math.round(site.p[1]), 11, this.seed);
    const low = this.clearIn(foot[0] - 4, foot[2] - 4, foot[0] + 4, foot[2] + 4, foot[1] - 1, foot[1] + 1, true);
    const high = this.clearIn(top[0] - 5, top[2] - 5, top[0] + 5, top[2] + 5, top[1] - 1, top[1] + 1, false);
    // at the top they go and look out over the parapet the stair came in through
    const out = Math.atan2(edge[0] - top[0], edge[2] - top[2]);
    const atFoot = spotsAround(foot, 0.8, 2.2, 8, h, (x, z) => low(x, pavementAt(x, z), z, 0.5), pavementAt, NaN);
    const atTop = spotsAround(top, 0.8, 3.2, 10, h ^ 0x9e37, (x, z) => high(x, top[1], z, 0.5), () => top[1], out);
    return this.wayRoute(way, { len: 8 * PACE + 2 * longest(atFoot), spots: atFoot }, { len: 22 * PACE + 2 * longest(atTop), spots: atTop },
      { gap: 26, spread: 14, busy: 0.4 * (0.35 + 0.65 * grain(site.p[0], site.p[1])), id: h, below: false });
  }

  /**
   * Down into a station and back: a stop just off the top of the entrance, and one on the
   * platform, where everyone goes off along it to wait.
   */
  private stationRoute(st: Station): Route {
    const sw = stationWay(st);
    const way = sw.way.slice();
    const h = h32(st.axis, st.line, st.k, this.seed ^ 0x57a7);
    const top = way[1];
    const street = this.clearIn(top[0] - 12, top[2] - 12, top[0] + 12, top[2] + 12, top[1] - 1.5, top[1] + 1, true);
    const onStreet = (x: number, z: number) => street(x, pavementAt(x, z), z, 0.5);
    // off the end of the opening, if it is pavement there and not the wall of a block
    if (!onStreet(way[0][0], way[0][2])) way.shift();
    const atStreet = way[0] === sw.way[0]
      ? spotsAround(way[0], 0.8, 2.4, 8, h, onStreet, pavementAt, NaN)
      : [{ pts: new Float32Array(way[0]), len: 0, face: 0 }];

    // the platform: spots up and down it, clear of the stair and of the edges, and the ones
    // on the far side of the stair got to down the side of it
    const wait = way[way.length - 1];
    const [w0] = sw.well;
    const ends = [sw.platform(-sw.hall, 0), sw.platform(sw.hall, 0)];
    const plat = this.clearIn(
      Math.min(ends[0][0], ends[1][0]) - 8, Math.min(ends[0][2], ends[1][2]) - 8,
      Math.max(ends[0][0], ends[1][0]) + 8, Math.max(ends[0][2], ends[1][2]) + 8, wait[1] - 0.5, wait[1] + 0.5, false);
    const spots: Spot[] = [];
    for (let k = 0; spots.length < 32 && k < 96; k++) {
      const r = h32(h, k, 12, this.seed);
      const m = -sw.hall + 5 + ((r & 0xffff) / 0x10000) * (2 * sw.hall - 10);
      const side = (r >>> 16) & 1 ? 1 : -1;
      const off = side * (((r >>> 17) & 0xff) / 255) * 4.4;
      const [sx, sy, sz] = sw.platform(m, off);
      if (!plat(sx, sy, sz, 0.45)) continue;
      const pts: number[] = [...wait];
      if (m > w0 - 3) {
        // past the foot of the stair: down the side of it
        if (Math.abs(off) < sw.half + 0.8) continue;
        pts.push(...sw.platform(w0 - 3, side * (sw.half + 1.3)), ...sw.platform(Math.max(m, w0 - 3), side * (sw.half + 1.3)));
      }
      pts.push(sx, sy, sz);
      // facing the track on their own side, or down the platform for the train
      const [ex, , ez] = sw.platform(m, side * 7);
      const [ax, , az] = sw.platform(m + 1, off);
      const face = (r >>> 25) % 3 === 0
        ? Math.atan2(ax - sx, az - sz) + ((r >>> 27) & 1 ? Math.PI : 0)
        : Math.atan2(ex - sx, ez - sz);
      spots.push(spot(pts, face));
    }
    if (!spots.length) spots.push(spot([...wait], 0));
    return this.wayRoute(way, { len: 4 * PACE + 2 * longest(atStreet), spots: atStreet }, { len: 50 * PACE + 2 * longest(spots), spots },
      { gap: 8, spread: 4, busy: 0.85, id: h, below: true });
  }

  /**
   * A way somewhere and back, laid out as a loop: out along the right of the line, a stop at
   * the far end, back along the other side and a stop at the start.
   */
  private wayRoute(way: Vec3[], first: Stop, last: Stop, o: { gap: number; spread: number; busy: number; id: number; below: boolean }): Route {
    // the line through the way's points, every STEP across the ground
    const cx: number[] = [], cy: number[] = [], cz: number[] = [];
    for (let k = 0; k + 1 < way.length; k++) {
      const [ax, ay, az] = way[k], [bx, by, bz] = way[k + 1];
      const l = Math.hypot(bx - ax, bz - az);
      const m = Math.max(1, Math.round(l / STEP));
      for (let i = 0; i < m; i++) {
        const t = i / m;
        cx.push(ax + (bx - ax) * t);
        cy.push(ay + (by - ay) * t);
        cz.push(az + (bz - az) * t);
      }
    }
    const end = way[way.length - 1];
    cx.push(end[0]);
    cy.push(end[1]);
    cz.push(end[2]);
    const m = cx.length - 1;
    if (m < 4) return EMPTY;
    let [sx, sz] = smooth(Float32Array.from(cx), Float32Array.from(cz), 3, false);
    // out along the right of it, back along the other side
    const n = 2 * m;
    const x = new Float32Array(n), y = new Float32Array(n), z = new Float32Array(n);
    for (let j = 0; j <= m; j++) {
      const a = Math.max(0, j - 1), b = Math.min(m, j + 1);
      const yaw = Math.atan2(sx[b] - sx[a], sz[b] - sz[a]);
      const rx = -Math.cos(yaw) * LANE, rz = Math.sin(yaw) * LANE;
      const ends = j === 0 || j === m;
      x[j] = sx[j] + (ends ? 0 : rx);
      z[j] = sz[j] + (ends ? 0 : rz);
      y[j] = cy[j];
      if (!ends) {
        x[n - j] = sx[j] - rx;
        z[n - j] = sz[j] - rz;
        y[n - j] = cy[j];
      }
    }
    [sx, sz] = [x, z];
    const yaw = new Float32Array(n), at = new Float32Array(n + 1);
    for (let i = 0; i < n; i++) {
      const b = (i + 1) % n;
      yaw[i] = Math.atan2(sx[b] - sx[i], sz[b] - sz[i]);
    }
    const stops = new Map<number, Stop>([[0, first], [m, last]]);
    for (let i = 0; i < n; i++) {
      const b = (i + 1) % n;
      const flat = Math.hypot(sx[b] - sx[i], sz[b] - sz[i]);
      // slower on the stairs
      const cost = flat * (Math.abs(y[b] - y[i]) > 0.2 * flat ? 1.4 : 1);
      at[i + 1] = at[i] + (stops.get(i)?.len ?? 0) + Math.max(cost, 0.05);
    }
    return {
      x: sx, z: sz, y, yaw, blocked: new Uint8Array(n), n, at, len: at[n], stops, stands: [],
      both: false, gap: o.gap, spread: o.spread, id: o.id, busy: o.busy, below: o.below,
    };
  }
}

/** Spots a few metres round a point where someone can stand, each with its walk out from it. */
function spotsAround(
  p: Vec3, r0: number, r1: number, count: number, seed: number, ok: (x: number, z: number) => boolean,
  ground: (x: number, z: number) => number, face: number,
): Spot[] {
  const out: Spot[] = [];
  for (let k = 0; out.length < count && k < count * 4; k++) {
    const h = h32(seed, k, 13, 0);
    const a = ((h & 0xffff) / 0x10000) * Math.PI * 2;
    const r = r0 + (((h >>> 16) & 0xff) / 255) * (r1 - r0);
    const x = p[0] + Math.sin(a) * r, z = p[2] + Math.cos(a) * r;
    // and the way there clear as well
    if (!ok(x, z) || !ok((p[0] + x) / 2, (p[2] + z) / 2)) continue;
    const f = Number.isNaN(face) ? a : face + (((h >>> 24) & 0xff) / 255 - 0.5) * 1.2;
    out.push(spot([p[0], p[1], p[2], x, ground(x, z), z], f));
  }
  if (!out.length) out.push(spot([...p], Number.isNaN(face) ? 0 : face));
  return out;
}

function spot(pts: number[], face: number): Spot {
  let len = 0;
  for (let o = 0; o + 3 < pts.length; o += 3) len += Math.hypot(pts[o + 3] - pts[o], pts[o + 5] - pts[o + 2]);
  return { pts: Float32Array.from(pts), len, face };
}

const longest = (spots: Spot[]) => spots.reduce((m, s) => Math.max(m, s.len), 0);

const dist = (a: Vec2, b: Vec2) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** A line eased by averaging each point with its neighbours; the ends stay put unless it is a loop. */
function smooth(x: Float32Array, z: Float32Array, passes: number, loop: boolean): [Float32Array, Float32Array] {
  const n = x.length;
  for (let pass = 0; pass < passes; pass++) {
    const sx = new Float32Array(n), sz = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      if (!loop && (i === 0 || i === n - 1)) {
        sx[i] = x[i];
        sz[i] = z[i];
        continue;
      }
      const a = (i + n - 1) % n, b = (i + 1) % n;
      sx[i] = (x[a] + 2 * x[i] + x[b]) / 4;
      sz[i] = (z[a] + 2 * z[i] + z[b]) / 4;
    }
    x = sx;
    z = sz;
  }
  return [x, z];
}

function lerpAngle(a: number, b: number, t: number): number {
  return a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;
}

/** Pushed out of the way of whoever is in it, as far as the edge of their room. */
function stepAside(x: number, y: number, z: number, avoid: Avoid[]): [number, number] {
  for (const a of avoid) {
    if (Math.abs(y - a.y) > 2) continue;
    const dx = x - a.x, dz = z - a.z;
    const d = Math.hypot(dx, dz);
    if (d >= a.r) continue;
    if (d < 1e-3) return [x + a.r, z];
    x = a.x + (dx / d) * a.r;
    z = a.z + (dz / d) * a.r;
  }
  return [x, z];
}
