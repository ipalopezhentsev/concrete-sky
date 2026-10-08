// Pedestrians: people walking the city. Like the traffic, where each one is is a pure function
// of time — a slot in a stream going round a route — so nothing is simulated or saved, and two
// in the same stream never walk into each other.
//
// A route is one of two kinds. A loop: round a block's pavement, round its deck, round the edge
// of a roof, with a stream each way keeping right of the line. Or a way somewhere and back: up
// a block's stair to its deck. That is laid out as a loop too — up one side and down the other
// — with a stop at each end, where everyone goes off to a spot of their own and stands a while
// (looking out over the parapet) before they turn back.
//
// The subway is the one place people go somewhere and do not come back. It is worked out from
// the timetable instead: for every train that stands at a platform, a few people come along
// the pavement, down the entrance and out along the platform to wait for it, and step into it
// while it stands there; and a few step off it and go up to the street. Riding a train, there
// are others in it with you, getting on and off at the stops. (The people taking the flyers,
// cars and launches are in berths.ts, which walks them with `put` and `approach`.)
//
// The way round a loop is worked out once, when it first comes near: a line under two metres
// in from the edge, which swings in round anything standing in it (a lamp, a lift, the opening
// of a subway stair, a parked flyer) and back out again past it.

import type { Lift, Pad, Roof } from "./city/generate";
import { blockAt, blocksIn, grain, type Site, type Vec2 } from "./city/network";
import {
  deckOf, groundAt, inEntrance, marketsNear, PLAT_IN, PLAT_OUT, pavementAt, pavementOf, RAIL_TRACK, railWay, shrink, stairOf, stationWay, WALK,
  type RailStation, type Stall, type Station,
} from "./city/plan";
import { worldSeed, type Vec3 } from "./math";
import type { Colliders } from "./player";
import {
  dueAt, FLOOR, metroCycle, onTrack, RAILWAY, SUBWAY, trackOff, trackScale, trainAt, trainId, TRAIN, type LineKind,
} from "./vehicles/metro";
import { CARRIAGE } from "./vehicles/models";
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
export const PACE = 1.35;
/**
 * Off the middle of the platform to just inside the side of a train standing at it: where
 * someone getting on goes out of sight, and someone getting off comes into it.
 */
const EDGE = 7.2;
/** How far along the train from its middle people get on and off: short of either end. */
const BOARD = TRAIN / 2 - 3;
/** Metres of pavement walked to the top of an entrance, or on from it. */
const LEAD = 24;
/** Places to stand in a train, each taken by one passenger after another. */
const SEATS = 18;

/** Coats: what a city like this wears, with the odd bright one. */
const COATS: Vec3[] = [
  [0.16, 0.16, 0.17], [0.3, 0.29, 0.27], [0.22, 0.24, 0.3], [0.42, 0.38, 0.3], [0.36, 0.22, 0.15],
  [0.24, 0.27, 0.2], [0.52, 0.5, 0.46], [0.1, 0.1, 0.11], [0.2, 0.14, 0.12], [0.62, 0.18, 0.12],
  [0.7, 0.55, 0.16], [0.14, 0.32, 0.36],
];

/**
 * How many of a market's stalls are open and how many people are at them, hour by hour, 0..1:
 * a few through the day, and the whole of it from the early evening until after midnight.
 */
const MARKET = [0.4, 0.2, 0.05, 0, 0, 0, 0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.3, 0.3, 0.35, 0.5, 0.7, 0.9, 1, 1, 0.95, 0.8, 0.6];

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

/** A line someone walks: x y z at each point, and how far along each point is in metres walked. */
export class Path {
  readonly pts: Float32Array;
  readonly cum: Float32Array;
  readonly len: number;

  constructor(pts: ArrayLike<number>) {
    this.pts = Float32Array.from(pts);
    const q = this.pts, n = Math.max(1, Math.floor(q.length / 3));
    this.cum = new Float32Array(n);
    for (let i = 1; i < n; i++) {
      const o = i * 3;
      const flat = Math.hypot(q[o] - q[o - 3], q[o + 2] - q[o - 1]);
      // slower on the stairs
      this.cum[i] = this.cum[i - 1] + flat * (Math.abs(q[o + 1] - q[o - 2]) > 0.2 * flat ? 1.4 : 1);
    }
    this.len = this.cum[n - 1];
  }

  /** The same line walked the other way. */
  reversed(): Path {
    const q = this.pts, out: number[] = [];
    for (let o = q.length - 3; o >= 0; o -= 3) out.push(q[o], q[o + 1], q[o + 2]);
    return new Path(out);
  }

  /** Where someone `d` metres along it is, and which way they are going. */
  at(d: number, p: { x: number; y: number; z: number; yaw: number }): void {
    const q = this.pts, c = this.cum, n = c.length;
    if (n < 2) {
      p.x = q[0];
      p.y = q[1];
      p.z = q[2];
      return;
    }
    d = Math.max(0, Math.min(this.len, d));
    let lo = 0, hi = n - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (c[mid] <= d) lo = mid;
      else hi = mid - 1;
    }
    const a = lo * 3, b = a + 3;
    const t = c[lo + 1] > c[lo] ? Math.min(1, (d - c[lo]) / (c[lo + 1] - c[lo])) : 1;
    p.x = q[a] + (q[b] - q[a]) * t;
    p.y = q[a + 1] + (q[b + 1] - q[a + 1]) * t;
    p.z = q[a + 2] + (q[b + 2] - q[a + 2]) * t;
    // the heading of the stretch they are on, or of the last one before it that went anywhere
    for (let o = a; o >= 0; o -= 3) {
      const dx = q[o + 3] - q[o], dz = q[o + 5] - q[o + 2];
      if (dx * dx + dz * dz > 1e-6) {
        p.yaw = Math.atan2(dx, dz);
        return;
      }
    }
  }
}

/** Somewhere to wait on a platform: the way to it from the foot of the stair, and the step from it into the train. */
interface Wait {
  path: Path;
  edge: Path;
  face: number;
}

/** A station's comings and goings, laid out once it is near. */
interface Flow {
  id: number;
  /** The kind of line, whose timetable its people keep to. */
  kind: LineKind;
  /** Down the entrance to the foot of the stair on the platform, and back up, each keeping right. */
  down: Path;
  up: Path;
  /** For each side of the platform, +1 then -1: places to wait for the train on that side. */
  waits: Wait[][];
  /** For each side: ways off its train to the foot of the stair. */
  offs: Path[][];
  /** Where the way meets the pavement, and the walks along the pavement to it from either hand and away from it. */
  street: Vec3;
  leads: { to: Path[]; from: Path[] } | null;
}

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
  /** How busy the streets are this frame, 0..1, before the rain. */
  crowd = 0;
  private routes = new Map<string, Route>();
  private flows = new Map<string, Flow>();
  /** The markets in reach, asked again when the eye has moved a way. */
  private markets: { key: string; list: Stall[][] } = { key: "", list: [] };
  private lifts: Lift[] = [];
  private stations: Station[] = [];
  private railStations: RailStation[] = [];
  private pads: Pad[] = [];
  private roofs: Roof[] = [];
  private near: { key: string; jobs: { key: string; make: () => Route; d: number }[] } = { key: "", jobs: [] };
  private seed = worldSeed() ^ 0x5eed;
  private spot: Place = { x: 0, y: 0, z: 0, yaw: 0, stride: 0 };
  /** The eye, which way it looks, and who is in the way, as of this frame's update. */
  private eye: Vec3 = [0, 0, 0];
  private fwd: Vec3 = [0, 0, 1];
  private avoid: Avoid[] = [];

  constructor(private colliders: Colliders) {}

  /** What the world has streamed in that people walk round, down into or up onto. */
  sync(
    lifts: Iterable<Lift>, stations: Iterable<Station>, pads: Iterable<Pad>, roofs: Iterable<Roof>, railStations: Iterable<RailStation> = [],
  ): void {
    this.lifts = [...lifts];
    this.stations = [...stations];
    this.railStations = [...railStations];
    this.pads = [...pads];
    this.roofs = [...roofs];
    this.near.key = "";
  }

  update(time: number, eye: Vec3, fwd: Vec3, avoid: Avoid[]): void {
    for (const l of this.lists) l.clear();
    if (this.seed !== (worldSeed() ^ 0x5eed)) {
      this.seed = worldSeed() ^ 0x5eed;
      this.routes.clear();
      this.flows.clear();
      this.near.key = "";
    }
    this.eye = eye;
    this.fwd = fwd;
    this.avoid = avoid;
    // in the subway there is nobody above to see, and from the street nobody below but down
    // the stair, which the way down the entrance is
    const under = eye[1] < groundAt(eye[0], eye[2]) - 3;
    const jobs = this.jobsNear(eye);
    const crowd = DAY[Math.floor(this.hour) % 24] * (1 - (this.hour % 1)) + DAY[Math.ceil(this.hour) % 24] * (this.hour % 1);
    this.crowd = crowd;
    const ahead = (x: number, y: number, z: number) =>
      (x - eye[0]) * fwd[0] + (y - eye[1]) * fwd[1] + (z - eye[2]) * fwd[2] > -3;

    const start = performance.now();
    for (const st of this.stations) {
      if (Math.min(Math.hypot(st.x - eye[0], st.z - eye[2]), Math.hypot(st.shaftX - eye[0], st.shaftZ - eye[2])) > RADIUS + 90) continue;
      const key = `${st.axis},${st.line},${st.k}`;
      let f = this.flows.get(key);
      if (!f) {
        if (performance.now() - start > BUDGET) continue;
        f = this.flowOf(st);
        this.flows.set(key, f);
      }
      this.travellers(f, time, crowd);
    }
    for (const st of this.railStations) {
      if (Math.hypot(st.x - eye[0], st.z - eye[2]) > RADIUS + 90) continue;
      for (const side of [1, -1] as const) {
        const key = "r" + st.axis + "," + st.line + "," + st.k + "," + side;
        let f = this.flows.get(key);
        if (!f) {
          if (performance.now() - start > BUDGET) continue;
          f = this.railFlowOf(st, side);
          this.flows.set(key, f);
        }
        this.travellers(f, time, crowd);
      }
    }
    if (this.flows.size > 96) this.flows.clear();
    this.marketgoers(time, eye);
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
      this.walkers(w, time, busy, eye, ahead);
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
  private walkers(w: Route, time: number, busy: number, eye: Vec3, ahead: (x: number, y: number, z: number) => boolean): void {
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
        this.put(x, p.y, z, yaw, p.stride, h);
      }
    }
  }

  /**
   * Draw someone this frame, if they are near enough and in front of the eye: walking, `stride`
   * metres into their walk, or standing still if it is NaN. `h` picks their coat and their step.
   */
  put(x: number, y: number, z: number, yaw: number, stride: number, h: number): void {
    const eye = this.eye, fwd = this.fwd;
    if (Math.abs(x - eye[0]) > RADIUS || Math.abs(z - eye[2]) > RADIUS) return;
    if ((x - eye[0]) * fwd[0] + (y - eye[1]) * fwd[1] + (z - eye[2]) * fwd[2] < -3) return;
    [x, z] = stepAside(x, y, z, this.avoid);
    const coat = COATS[(h >>> 4) % COATS.length];
    if (Number.isNaN(stride)) {
      this.lists[WALKER_STRIDES.indexOf(0)].push(x, y, z, yaw, 0, 0, coat, 1);
      return;
    }
    const phase = (stride / CYCLE + ((h >>> 8) & 0xff) / 255) * Math.PI * 2;
    const swing = Math.sin(phase);
    const bob = (1 - Math.abs(swing)) * 0.03;
    const pose = Math.round((swing + 1) * 2);
    this.lists[pose].push(x, y + bob, z, yaw, 0, 0, coat, 1);
  }

  /**
   * The people of one station, for the trains each way through it. Each train that stands at
   * the platform has its own few to get on and its own few to get off, and each of them is
   * worked out from when that train is in: so someone getting on is somewhere on the way down
   * for a minute or two before it, and someone getting off somewhere on the way up after.
   */
  private travellers(f: Flow, time: number, crowd: number): void {
    const p = this.spot;
    if (!f.leads) f.leads = this.leadsTo(f.street);
    const busy = 0.15 + 0.85 * crowd;
    for (const side of [1, -1] as const) {
      const si = side > 0 ? 0 : 1;
      const waits = f.waits[si], offs = f.offs[si];
      // the train for this side of the platform is the one running on that side's track
      const K = f.kind;
      const now = Math.floor((time + (side > 0 ? 0 : K.period / 2)) / K.period);
      // trains due over the next few minutes, whose people are on their way to meet them, and
      // the ones gone in the last few, whose people are still on their way out
      for (let n = now - 8; n <= now + 10; n++) {
        const due = dueAt(n, side, K);
        if (n <= now + 1) {
          for (let j = 0; j < 4 && offs.length; j++) {
            const h = h32(f.id, n * 2 + si, 100 + j, this.seed);
            if ((h & 0xffff) / 0x10000 >= busy * 0.7) continue;
            const off = offs[(h >>> 16) % offs.length];
            const lead = f.leads?.from[(h >>> 20) & 1];
            let d = (time - due - 0.8 - ((h >>> 24) & 0xff) / 255 * 4) * PACE;
            if (d < 0) continue;
            const stride = d;
            if (d < off.len) off.at(d, p);
            else if ((d -= off.len) < f.up.len) f.up.at(d, p);
            else if (lead && (d -= f.up.len) < lead.len) lead.at(d, p);
            else continue;
            this.put(p.x, p.y, p.z, p.yaw, stride, h);
          }
        }
        if (n < now || !waits.length) continue;
        for (let j = 0; j < 4; j++) {
          const h = h32(f.id, n * 2 + si, j, this.seed);
          if ((h & 0xffff) / 0x10000 >= busy * 0.8) continue;
          const w = waits[(h >>> 16) % waits.length];
          // in through the side of the train while it stands there, having waited a while for it
          const aboard = due + 1.5 + (((h >>> 8) & 0xff) / 255) * (K.dwell - 4);
          const leave = aboard - w.edge.len / PACE;
          const there = leave - 8 - (((h >>> 24) & 0xff) / 255) * 60;
          const set = there - (LEAD + f.down.len + w.path.len) / PACE;
          if (time < set || time > aboard) continue;
          let d = (time - set) * PACE;
          const stride = d;
          if (time >= leave) {
            w.edge.at((time - leave) * PACE, p);
            this.put(p.x, p.y, p.z, p.yaw, (time - leave) * PACE, h);
            continue;
          }
          if (time >= there) {
            w.path.at(w.path.len, p);
            this.put(p.x, p.y, p.z, w.face + Math.sin(time * 0.3 + j) * 0.25, NaN, h);
            continue;
          }
          if (d < LEAD) {
            // along the pavement to the top of the entrance, or out of nowhere at the top of it
            // if the pavement is not laid out yet
            const lead = f.leads?.to[(h >>> 20) & 1];
            if (!lead || d < LEAD - lead.len) continue;
            lead.at(d - (LEAD - lead.len), p);
          } else if ((d -= LEAD) < f.down.len) f.down.at(d, p);
          else w.path.at(d - f.down.len, p);
          this.put(p.x, p.y, p.z, p.yaw, stride, h);
        }
      }
    }
  }

  /**
   * The people of the markets: whoever keeps each stall, behind its counter while it is open,
   * and a few at its front, who come and go every minute or so. Busiest from the early evening
   * until after midnight, and thinner in the rain.
   */
  /**
   * The market playing nearest the eye, for its music: where its middle stall is, and how loud
   * it is from here — none when it is shut, quieter in the rain, gone ninety metres off.
   */
  marketNear(eye: Vec3): { pos: Vec3; level: number } {
    const hr = this.hour % 24;
    const open = MARKET[Math.floor(hr)] * (1 - (hr % 1)) + MARKET[Math.ceil(hr) % 24] * (hr % 1);
    let best: { pos: Vec3; level: number } = { pos: [eye[0], eye[1], eye[2]], level: 0 };
    for (const stalls of this.markets.list) {
      const s = stalls[Math.floor(stalls.length / 2)];
      const d = Math.hypot(s.x - eye[0], s.y + 1.5 - eye[1], s.z - eye[2]);
      const level = Math.max(0, 1 - d / 90) ** 1.5 * Math.min(1, open * 1.4) * (1 - 0.5 * this.rain);
      if (level > best.level) best = { pos: [s.x, s.y + 1.5, s.z], level };
    }
    return best;
  }

  private marketgoers(time: number, eye: Vec3): void {
    const key = `${Math.round(eye[0] / 40)},${Math.round(eye[2] / 40)}`;
    if (this.markets.key !== key) this.markets = { key, list: marketsNear(eye[0], eye[2], RADIUS + 20) };
    const hr = this.hour % 24;
    const open = MARKET[Math.floor(hr)] * (1 - (hr % 1)) + MARKET[Math.ceil(hr) % 24] * (hr % 1);
    const busy = open * (1 - 0.6 * this.rain);
    for (const stalls of this.markets.list) {
      for (const st of stalls) {
        if (Math.abs(st.x - eye[0]) > RADIUS || Math.abs(st.z - eye[2]) > RADIUS) continue;
        const out = Math.atan2(st.n[0], st.n[1]);
        if (((st.id >>> 4) & 0xff) / 255 < open + 0.1) {
          this.put(st.x, groundAt(st.x, st.z), st.z, out + Math.sin(time * 0.2 + st.id) * 0.3, NaN, st.id);
        }
        for (let c = 0; c < 3; c++) {
          const stay = Math.floor(time / 70 + ((st.id >>> (c * 5)) & 31) / 31);
          const h = h32(st.id, c, stay, this.seed);
          if ((h & 0xffff) / 0x10000 >= busy * 0.75) continue;
          const a = ((((h >>> 16) & 0xff) / 255) * 2 - 1) * 1.3;
          const d = 2.2 + (((h >>> 24) & 0xff) / 255) * 1.4;
          const x = st.x + st.t[0] * a + st.n[0] * d, z = st.z + st.t[1] * a + st.n[1] * d;
          this.put(x, groundAt(x, z), z, out + Math.PI + (((h >>> 8) & 0xff) / 255 - 0.5) * 0.8, NaN, h);
        }
      }
    }
  }

  /**
   * The passengers in the train the runner is riding. At every stop some of them get off and
   * others get on, through the side the platform is on, while the train stands there; the
   * rest stay where they are. Who is in each place is worked out from the stops the train has
   * made: whoever got on at the last one, or, if they stayed on there, whoever was in it before.
   */
  riders(train: { axis: 0 | 1; line: number; dir: 1 | -1; slot: number; kind?: LineKind }, time: number, runner: Vec3): void {
    const { axis, line, dir, slot } = train;
    const K = train.kind ?? SUBWAY;
    const { n } = metroCycle(time, dir, true, K);
    // the slot a train runs from steps on by one every cycle; what it started from does not
    const id = trainId(slot, dir, time, K);
    // the last few stops it made, latest first: most slots on a line have no station
    const stops: number[] = [];
    for (let m = n; m > n - 40 && stops.length < 5; m--) if (K.station(axis, line, id + dir * m)) stops.push(m);
    if (!stops.length) return;
    const since = time - dueAt(n, dir, K);
    const doors = stops[0] === n && since < K.dwell;
    const mid = trainAt(axis, line, slot, dir, time, K);
    const scale = trackScale(axis, line, mid);
    const board = (K.cars * CARRIAGE) / 2 - 3;
    // the doors are on the platform's side: towards the middle on the subway, outwards up on the viaduct
    const door = K.doors(dir) * 1.8;
    const avoid = this.avoid;
    this.avoid = [{ x: runner[0], y: runner[1], z: runner[2], r: 0.7 }];
    const busy = 0.15 + 0.75 * this.crowd;
    const stays = (q: number, m: number) => (h32(id, q * 7919 + m, 23, this.seed) & 0xffff) / 0x10000 < 0.55;
    /** Who has the place since the `j`th stop back, or -1 if nobody. */
    const who = (q: number, j: number) => {
      while (j + 1 < stops.length && stays(q, stops[j])) j++;
      const h = h32(id, q * 7919 + stops[j], 22, this.seed);
      return ((h >>> 8) & 0xffff) / 0x10000 < busy ? h : -1;
    };
    const draw = (h: number, walk: number, out: boolean) => {
      const along = ((((h >>> 3) & 0x3ff) / 1023) * 2 - 1) * board;
      const across = ((((h >>> 13) & 0xff) / 255) * 2 - 1) * 0.9;
      // facing across the car, or along it
      const face = (h >>> 21) % 3 === 0 ? (h & 4 ? 0 : Math.PI) : h & 4 ? Math.PI / 2 : -Math.PI / 2;
      // `walk` seconds into getting off (to the door) or on (from it); NaN standing in their place
      const k = Number.isNaN(walk) ? 1 : Math.min(1, (walk * PACE) / Math.abs(door - across));
      const c = out ? across + (door - across) * (Number.isNaN(walk) ? 0 : k) : door + (across - door) * k;
      const at = onTrack(axis, line, mid + along / scale, trackOff(dir, K) + c, K);
      const walking = !Number.isNaN(walk) && k < 1;
      // off to the right of the line is towards a higher offset, which is a quarter turn clockwise
      const yaw = walking ? at.yaw - (Math.sign(out ? door - across : across - door) * Math.PI) / 2 : at.yaw + face;
      this.put(at.pos[0], at.pos[1] + FLOOR, at.pos[2], yaw, walking ? Math.abs(c - across) : NaN, h);
    };
    for (let q = 0; q < SEATS; q++) {
      const now = who(q, 0);
      if (!doors || stays(q, n)) {
        if (now >= 0) draw(now, NaN, false);
        continue;
      }
      // standing at a stop: whoever had the place gets off, then whoever has it now gets on
      const before = stops.length > 1 ? who(q, 1) : -1;
      if (before >= 0) {
        const t = since - 0.5 - (((before >>> 24) & 0xff) / 255) * 2.5;
        if (t < 0) draw(before, NaN, true);
        else if ((t * PACE) / Math.abs(door - ((((before >>> 13) & 0xff) / 255) * 2 - 1) * 0.9) < 1) draw(before, t, true);
      }
      if (now >= 0) {
        const t = since - 4 - (((now >>> 24) & 0xff) / 255) * 3.5;
        if (t >= 0) draw(now, t, false);
      }
    }
    this.avoid = avoid;
  }

  /**
   * A walk along the pavement, deck or roof loop nearest a point, `len` metres of it going
   * `dir` round the loop and ending at the point of it nearest the one asked for: x y z, every
   * half metre. Null if that loop is not laid out yet; empty if there is none to walk.
   */
  approach(on: "pave" | "deck" | "roof", x: number, y: number, z: number, len: number, dir: 1 | -1): number[] | null {
    let key: string | null = null;
    if (on === "roof") {
      for (const r of this.roofs) {
        if (Math.abs(r.y - y) > 1.5 || !inside(r.poly, x, z)) continue;
        const [rx, rz] = r.poly[0];
        key = `r${rx.toFixed(1)},${rz.toFixed(1)},${r.y.toFixed(1)}`;
      }
    } else {
      const site = blockAt(x, z);
      if (site) key = `${on === "pave" ? "p" : "d"}${site.key}`;
    }
    if (!key) return [];
    const w = this.routes.get(key);
    if (!w) return null;
    let best = -1, bd = Infinity;
    for (let i = 0; i < w.n; i++) {
      if (w.blocked[i] || Math.abs(w.y[i] - y) > 2) continue;
      const d = (w.x[i] - x) ** 2 + (w.z[i] - z) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    if (best < 0) return [];
    const out: number[] = [];
    for (let k = Math.round(len / STEP); k >= 0; k--) {
      const i = (((best - dir * k) % w.n) + w.n) % w.n;
      // from the far side of anything it could not get round
      if (w.blocked[i]) out.length = 0;
      else out.push(w.x[i], w.y[i], w.z[i]);
    }
    return out;
  }

  /** What a body standing in a patch of the city would walk into; see `clearIn`. */
  clearNear(x: number, z: number, r: number, y: number, ground: boolean): (x: number, y: number, z: number, pad: number) => boolean {
    return this.clearIn(x - r, z - r, x + r, z + r, y - 1, y + 1, ground);
  }

  /** The walks along the pavement to a point from either hand, if the pavement is laid out there. */
  private leadsTo(p: Vec3): { to: Path[]; from: Path[] } | null {
    const to: Path[] = [], from: Path[] = [];
    for (const dir of [1, -1] as const) {
      const pts = this.approach("pave", p[0], p[1], p[2], LEAD - 3, dir);
      if (!pts) return null;
      const path = new Path([...pts, ...p]);
      to.push(path);
      from.push(path.reversed());
    }
    return { to, from };
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
   * A station's ways: down the entrance and up it again, places to wait along the platform
   * for the train on either side, and ways off each train to the foot of the stair.
   */
  private flowOf(st: Station): Flow {
    const sw = stationWay(st);
    const way = sw.way.slice();
    const id = h32(st.axis, st.line, st.k, this.seed ^ 0x57a7);
    const top = way[1];
    const street = this.clearIn(top[0] - 12, top[2] - 12, top[0] + 12, top[2] + 12, top[1] - 1.5, top[1] + 1, true);
    // off the end of the opening, if it is pavement there and not the wall of a block
    if (!street(way[0][0], pavementAt(way[0][0], way[0][2]), way[0][2], 0.5)) way.shift();
    const [down, up] = lanes(way);

    // the platform: places up and down it, clear of the stair and of the edges, and the ones
    // on the far side of the stair got to down the side of it
    const wait = way[way.length - 1];
    const [w0] = sw.well;
    const ends = [sw.platform(-sw.hall, 0), sw.platform(sw.hall, 0)];
    const plat = this.clearIn(
      Math.min(ends[0][0], ends[1][0]) - 8, Math.min(ends[0][2], ends[1][2]) - 8,
      Math.max(ends[0][0], ends[1][0]) + 8, Math.max(ends[0][2], ends[1][2]) + 8, wait[1] - 0.5, wait[1] + 0.5, false);
    const clear = (p: Vec3) => plat(p[0], p[1], p[2], 0.45);
    /** From the foot of the stair to a point `m` along the platform on one side of it, round the stair if need be. */
    const from = (m: number, side: 1 | -1): number[] => {
      const pts: number[] = [...wait];
      if (m > w0 - 3) pts.push(...sw.platform(w0 - 3, side * (sw.half + 1.3)), ...sw.platform(Math.max(m, w0 - 3), side * (sw.half + 1.3)));
      return pts;
    };
    const waits: Wait[][] = [[], []], offs: Path[][] = [[], []];
    for (const side of [1, -1] as const) {
      const si = side > 0 ? 0 : 1;
      for (let k = 0; waits[si].length < 16 && k < 64; k++) {
        const r = h32(id, k * 2 + si, 12, this.seed);
        const m = (((r & 0xffff) / 0x10000) * 2 - 1) * BOARD;
        const off = side * (0.8 + (((r >>> 17) & 0xff) / 255) * 4.2);
        const at = sw.platform(m, off);
        if (!clear(at)) continue;
        if (m > w0 - 3 && Math.abs(off) < sw.half + 0.8) continue;
        // facing the track the train comes in on, or down the platform for it
        const [ex, , ez] = sw.platform(m, side * 7);
        const [ax, , az] = sw.platform(m + 1, off);
        const face = (r >>> 25) % 3 === 0
          ? Math.atan2(ax - at[0], az - at[2]) + ((r >>> 27) & 1 ? Math.PI : 0)
          : Math.atan2(ex - at[0], ez - at[2]);
        waits[si].push({ path: new Path([...from(m, side), ...at]), edge: new Path([...at, ...sw.platform(m, side * EDGE)]), face });
      }
      for (let k = 0; offs[si].length < 8 && k < 32; k++) {
        const r = h32(id, k * 2 + si, 13, this.seed);
        const m = (((r & 0xffff) / 0x10000) * 2 - 1) * BOARD;
        const out = sw.platform(m, side * (4.4 + ((r >>> 16) & 0xff) / 255));
        if (!clear(out)) continue;
        const pts = [...sw.platform(m, side * EDGE), ...out];
        if (m > w0 - 3) {
          const by = sw.platform(m, side * (sw.half + 1.3));
          if (!clear(by)) continue;
          pts.push(...by);
        }
        const back = from(m, side);
        for (let o = back.length - 3; o >= 0; o -= 3) pts.push(back[o], back[o + 1], back[o + 2]);
        offs[si].push(new Path(pts));
      }
    }
    return { id, kind: SUBWAY, down, up, waits, offs, street: way[0], leads: null };
  }

  /**
   * One side of a station on the elevated railway: up the stair tower from the forecourt and
   * over the footbridge, places to wait along that side's platform, and ways off its train back
   * to the footbridge. The other side is a flow of its own, with its own stair.
   */
  private railFlowOf(st: RailStation, side: 1 | -1): Flow {
    const { way, platform } = railWay(st, side);
    const id = h32(st.axis * 7 + (side > 0 ? 1 : 2), st.line, st.k, this.seed ^ 0x7a11);
    const [down, up] = lanes(way);
    const wait = way[way.length - 1];
    const board = (RAILWAY.cars * CARRIAGE) / 2 - 3;
    // into the side of the train standing on this side's track
    const edge = RAIL_TRACK + 1.05;
    const si = side > 0 ? 0 : 1;
    const waits: Wait[][] = [[], []], offs: Path[][] = [[], []];
    for (let k = 0; k < 16; k++) {
      const r = h32(id, k, 12, this.seed);
      const m = (((r & 0xffff) / 0x10000) * 2 - 1) * board;
      const v = PLAT_IN + 0.9 + (((r >>> 16) & 0xff) / 255) * (PLAT_OUT - PLAT_IN - 1.7);
      const at = platform(m, v);
      // facing the track, or down the platform for the train
      const [ex, , ez] = platform(m, 0), [ax, , az] = platform(m + 1, v);
      const face = (r >>> 25) % 3 === 0
        ? Math.atan2(ax - at[0], az - at[2]) + ((r >>> 27) & 1 ? Math.PI : 0)
        : Math.atan2(ex - at[0], ez - at[2]);
      waits[si].push({ path: new Path([...wait, ...at]), edge: new Path([...at, ...platform(m, edge)]), face });
    }
    for (let k = 0; k < 8; k++) {
      const r = h32(id, k, 13, this.seed);
      const m = (((r & 0xffff) / 0x10000) * 2 - 1) * board;
      offs[si].push(new Path([...platform(m, edge), ...platform(m, PLAT_IN + 1.2 + ((r >>> 16) & 0xff) / 255), ...wait]));
    }
    return { id, kind: RAILWAY, down, up, waits, offs, street: way[0], leads: null };
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

/** A way walked there and back, as two paths keeping to the right of it: there, and back. */
function lanes(way: Vec3[]): [Path, Path] {
  const cx: number[] = [], cy: number[] = [], cz: number[] = [];
  for (let k = 0; k + 1 < way.length; k++) {
    const [ax, ay, az] = way[k], [bx, by, bz] = way[k + 1];
    const m = Math.max(1, Math.round(Math.hypot(bx - ax, bz - az) / STEP));
    for (let i = 0; i < m; i++) {
      cx.push(ax + ((bx - ax) * i) / m);
      cy.push(ay + ((by - ay) * i) / m);
      cz.push(az + ((bz - az) * i) / m);
    }
  }
  const end = way[way.length - 1];
  cx.push(end[0]);
  cy.push(end[1]);
  cz.push(end[2]);
  const [sx, sz] = smooth(Float32Array.from(cx), Float32Array.from(cz), 3, false);
  const n = sx.length, there: number[] = [], back: number[] = [];
  for (let j = 0; j < n; j++) {
    const a = Math.max(0, j - 1), b = Math.min(n - 1, j + 1);
    const yaw = Math.atan2(sx[b] - sx[a], sz[b] - sz[a]);
    const k = j === 0 || j === n - 1 ? 0 : LANE;
    const rx = -Math.cos(yaw) * k, rz = Math.sin(yaw) * k;
    there.push(sx[j] + rx, cy[j], sz[j] + rz);
    back.push(sx[j] - rx, cy[j], sz[j] - rz);
  }
  return [new Path(there), new Path(back).reversed()];
}

/** Whether a point is inside an outline. */
function inside(poly: Vec2[], x: number, z: number): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, az] = poly[i], [bx, bz] = poly[j];
    if ((az > z) !== (bz > z) && x < ((bx - ax) * (z - az)) / (bz - az) + ax) hit = !hit;
  }
  return hit;
}

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
