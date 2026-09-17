// Demo mode: autopilots that run the decks, fly the air corridors and drive the
// cross streets, and a director that cuts between them as the weather moves on.

import { bridgeOn, CELL, INSET, PODIUM_LEVELS, podiumHeight, STREET } from "./city/generate";
import type { Vec3 } from "./math";
import type { Colliders, Player } from "./player";
import type { Controls, Rides } from "./rides";
import type { Car } from "./vehicles/car";
import { FLYER_PALETTE, type Flyer } from "./vehicles/flyer";
import { PAINT_COLORS } from "./vehicles/models";
import type { Traffic } from "./vehicles/traffic";
import type { Weather } from "./weather";

/** What an autopilot presses this frame. */
export type Pilot = Omit<Controls, "mouseDX" | "mouseDY">;

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const turnToward = (from: number, to: number, rate: number, dt: number) =>
  from + clamp(wrap(to - from), -rate * dt, rate * dt);

// ---------------------------------------------------------------------------
// Running: round the edge of each podium deck and over its bridges. Vents and
// facade stairs vary per block, so each side's line is probed for a clear path.

export const DECK_EDGE = STREET / 2 + INSET - 0.5; // block-local coordinate of the deck's outer edge
export const SIDE_STEP = [[1, 0], [0, 1], [-1, 0], [0, -1]]; // east, north, west, south
const CLEARANCE = 0.5; // runner radius plus a margin

/** Can a runner on a deck at height y go straight from a to b without bumping into anything? */
function clearPath(boxes: Float32Array, a: [number, number], b: [number, number], y: number): boolean {
  const x0 = Math.min(a[0], b[0]) - CLEARANCE, x1 = Math.max(a[0], b[0]) + CLEARANCE;
  const z0 = Math.min(a[1], b[1]) - CLEARANCE, z1 = Math.max(a[1], b[1]) + CLEARANCE;
  for (let i = 0; i < boxes.length; i += 6) {
    if (boxes[i] < x1 && boxes[i + 3] > x0 && boxes[i + 2] < z1 && boxes[i + 5] > z0 &&
        boxes[i + 4] > y + 0.5 && boxes[i + 1] < y + 2) return false;
  }
  return true;
}

/** A deck's running lines: world x of the east / west sides, z of the north / south ones (null if blocked). */
export interface Ring {
  lines: (number | null)[];
  deck: number;
}

type Point = [number, number];

export class RunPilot {
  private route: Point[] = [];
  private from = 2; // side we came in on (we start at the south-west corner)
  /** Bridges crossed so far. */
  crossings = 0;
  /**
   * Bridge hops from a block to where the runner wants to be. When set, the pilot
   * heads that way instead of wandering, and stops once no bridge gets it closer.
   */
  toward: ((ci: number, cj: number) => number) | null = null;

  constructor(
    private ci: number, private cj: number, private colliders: Colliders, private rand = Math.random,
    private rings = new Map<string, Ring>(), // shareable between pilots in the same city
  ) {}

  private ring(ci: number, cj: number): Ring {
    const key = `${ci},${cj}`;
    let r = this.rings.get(key);
    if (r) return r;
    const ox = ci * CELL, oz = cj * CELL, deck = podiumHeight(ci, cj);
    const boxes = this.colliders(ox + CELL / 2, oz + CELL / 2);
    const lo = DECK_EDGE + 1, hi = CELL - DECK_EDGE - 1;
    const lines = [0, 1, 2, 3].map((side) => {
      // hug the edge where possible: the view over the street is the point
      for (let inset = 1.2; inset < 9; inset += 0.1) {
        const local = side < 2 ? CELL - DECK_EDGE - inset : DECK_EDGE + inset;
        const along = side % 2 === 0 ? ox + local : oz + local;
        const a: Point = side % 2 === 0 ? [along, oz + lo] : [ox + lo, along];
        const b: Point = side % 2 === 0 ? [along, oz + hi] : [ox + hi, along];
        if (clearPath(boxes, a, b, deck)) return along;
      }
      return null;
    });
    r = { lines, deck };
    this.rings.set(key, r);
    return r;
  }

  /** Corner after `side` going anticlockwise (east -> north -> west -> south). */
  private corner(ci: number, cj: number, side: number): Point | null {
    const [e, n, w, s] = this.ring(ci, cj).lines;
    const c = [[e, n], [w, n], [w, s], [e, s]][side];
    return c[0] === null || c[1] === null ? null : [c[0], c[1]];
  }

  /** Where the running line meets the bridge on `side`, if the way to the deck edge is clear. */
  private landing(ci: number, cj: number, side: number, offset: number): Point | null {
    const r = this.ring(ci, cj);
    const line = r.lines[side];
    if (line === null) return null;
    const ox = ci * CELL, oz = cj * CELL, mid = CELL / 2 + offset;
    const edge = side < 2 ? CELL - DECK_EDGE : DECK_EDGE;
    const p: Point = side % 2 === 0 ? [line, oz + mid] : [ox + mid, line];
    const e: Point = side % 2 === 0 ? [ox + edge, oz + mid] : [ox + mid, oz + edge];
    return clearPath(this.colliders(p[0], p[1]), p, e, r.deck) ? p : null;
  }

  /** Starting spot on the deck: the south-west corner of its running lines. */
  get start(): Vec3 {
    const c = this.corner(this.ci, this.cj, 2);
    const ox = this.ci * CELL, oz = this.cj * CELL;
    const [x, z] = c ?? [ox + DECK_EDGE + 1.5, oz + DECK_EDGE + 1.5];
    return [x, podiumHeight(this.ci, this.cj), z];
  }

  /** Out of waypoints (with `toward` set: as close as the bridges go). */
  get done(): boolean {
    return this.route.length === 0;
  }

  /** Pick the route up from (x, z) on this block's deck: first onto the nearest running line. */
  joinAt(x: number, z: number): void {
    const [e, n, w, s] = this.ring(this.ci, this.cj).lines;
    const ox = this.ci * CELL, oz = this.cj * CELL;
    const lo = DECK_EDGE + 1.5, hi = CELL - DECK_EDGE - 1.5;
    let side = -1, best = Infinity;
    [e, n, w, s].forEach((line, k) => {
      const d = line === null ? Infinity : Math.abs((k % 2 === 0 ? x : z) - line);
      if (d < best) [best, side] = [d, k];
    });
    if (side < 0) return;
    const line = [e, n, w, s][side]!;
    this.from = side;
    this.route = side % 2 === 0
      ? [[line, clamp(z, s ?? oz + lo, n ?? oz + hi)]]
      : [[clamp(x, w ?? ox + lo, e ?? ox + hi), line]];
  }

  /** Ran off a deck and down into the street. */
  fell(p: Player): boolean {
    return p.pos[1] < PODIUM_LEVELS[0] - 3;
  }

  /** Waypoints round this deck from the entry side to `exit`, or null if a side on the way is blocked. */
  private walk(exit: number, dir: 1 | -1): Point[] | null {
    const out: Point[] = [];
    for (let s = this.from; s !== exit; s = (s + dir + 4) % 4) {
      const c = this.corner(this.ci, this.cj, dir > 0 ? s : (s + 3) % 4);
      if (!c) return null;
      out.push(c);
    }
    return out;
  }

  /** Round this deck to one of its bridges, and across it. */
  private plan(): void {
    const { ci, cj, from } = this;
    const ways: { exit: number; path: Point[] }[] = [];
    for (let exit = 0; exit < 4; exit++) {
      const offset = bridgeOn(ci, cj, exit);
      if (offset === null) continue;
      const out = this.landing(ci, cj, exit, offset);
      const [ni, nj] = [ci + SIDE_STEP[exit][0], cj + SIDE_STEP[exit][1]];
      const into = this.landing(ni, nj, (exit + 2) % 4, offset);
      if (!out || !into) continue;
      const ccw = this.walk(exit, 1), cw = this.walk(exit, -1);
      const paths = [ccw, cw].filter((p): p is Point[] => p !== null).sort((a, b) => a.length - b.length);
      if (paths.length) ways.push({ exit, path: [...paths[0], out, into] });
    }
    if (!ways.length) return; // no way off this block
    let way = ways[0];
    if (this.toward) {
      let best = this.toward(ci, cj);
      let found = false;
      for (const w of ways) {
        const d = this.toward(ci + SIDE_STEP[w.exit][0], cj + SIDE_STEP[w.exit][1]);
        if (d < best) [best, way, found] = [d, w, true];
      }
      if (!found) return;
    } else {
      const onward = ways.filter((w) => w.exit !== from);
      const options = onward.length ? onward : ways;
      const straight = options.find((w) => w.exit === (from + 2) % 4);
      way = straight && this.rand() < 0.4 ? straight : options[Math.floor(this.rand() * options.length)];
    }
    this.route.push(...way.path);
    this.ci += SIDE_STEP[way.exit][0];
    this.cj += SIDE_STEP[way.exit][1];
    this.from = (way.exit + 2) % 4;
    this.crossings++;
  }

  steer(p: Player, dt: number): Pilot {
    const at = (w: Point) => Math.hypot(w[0] - p.pos[0], w[1] - p.pos[2]);
    for (let tries = 0; tries < 3; tries++) {
      while (this.route.length && at(this.route[0]) < 1.2) this.route.shift();
      if (this.route.length) break;
      this.plan();
    }
    const idle: Pilot = { moveX: 0, moveZ: 0, up: false, down: false, sprint: false, fire: false };
    if (!this.route.length) return idle;

    const [tx, tz] = this.route[0];
    const dist = at(this.route[0]);
    const dx = (tx - p.pos[0]) / dist, dz = (tz - p.pos[2]) / dist;
    // the head turns toward the next leg a little before the corner
    const next = this.route[1];
    const look = next && dist < 5 ? next : this.route[0];
    p.yaw = turnToward(p.yaw, Math.atan2(look[0] - p.pos[0], look[1] - p.pos[2]), 2.5, dt);
    p.pitch += (-0.06 - p.pitch) * Math.min(1, dt * 2);

    // move straight at the waypoint whatever the head is doing
    const s = Math.sin(p.yaw), c = Math.cos(p.yaw);
    let bend = 0;
    if (next) bend = Math.abs(wrap(Math.atan2(next[0] - tx, next[1] - tz) - Math.atan2(dx, dz)));
    const sprint = !(dist < 7 && bend > 0.6);
    return {
      moveX: -dx * c + dz * s,
      moveZ: dx * s + dz * c,
      up: sprint && dist > 12 && this.rand() < dt * 0.25, // the odd hop on long straights
      down: false,
      sprint,
      fire: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Flying: along the street corridors, turning at some crossings, shooting
// at air traffic that drifts into the sights.

// cruise heights between the traffic layers (north-south 48/92 m, east-west 68/118 m)
const FLY_HEIGHT = { ns: 60, ew: 82 };
const TURN_MIN_HEIGHT = 70; // east-west corridors are clear from 65 m
const CRUISE = 24, BOOST = 48, CLIMB = 11;

export class FlyPilot {
  axis: "ns" | "ew";
  line: number;
  dir: 1 | -1;
  private turn: { at: number; dir: 1 | -1 } | null = null;
  private decided = NaN;
  private clock = 0;

  constructor(x: number, z: number, axis: "ns" | "ew", dir: 1 | -1, private rand = Math.random) {
    this.axis = axis;
    this.dir = dir;
    this.line = Math.round((axis === "ns" ? x : z) / CELL) * CELL;
  }

  steer(f: Flyer, look: { yaw: number; pitch: number }, dt: number, traffic?: Traffic): Pilot {
    const ns = this.axis === "ns";
    const along = ns ? f.pos[2] : f.pos[0];
    const across = (ns ? f.pos[0] : f.pos[2]) - this.line;
    const next = this.dir > 0 ? Math.ceil((along + 1) / CELL) * CELL : Math.floor((along - 1) / CELL) * CELL;
    const ahead = (next - along) * this.dir;
    if (next !== this.decided) {
      this.decided = next;
      this.turn = ahead > 70 && this.rand() < 0.45 ? { at: next, dir: this.rand() < 0.5 ? 1 : -1 } : null;
    }
    if (this.turn && ahead < 14) {
      // only swing into an east-west corridor high enough to be clear
      if (ns && f.pos[1] < TURN_MIN_HEIGHT) this.turn = null;
      else {
        this.axis = ns ? "ew" : "ns";
        this.line = this.turn.at;
        this.dir = this.turn.dir;
        this.turn = null;
        this.decided = NaN;
        return this.steer(f, look, dt, traffic);
      }
    }

    // head for a point down the corridor
    const aimAlong = along + this.dir * 40;
    const tx = ns ? this.line : aimAlong, tz = ns ? aimAlong : this.line;
    const heading = Math.atan2(tx - f.pos[0], tz - f.pos[2]);
    look.yaw = turnToward(look.yaw, heading, 1.4, dt);
    const boost = !this.turn && ahead > 30 && Math.abs(wrap(heading - look.yaw)) < 0.1;

    // now and then, look for something to shoot a little off the nose
    this.clock += dt;
    let pitch = -0.1;
    let fire = false;
    if (traffic && this.clock % 14 < 6) {
      const eye: Vec3 = [f.pos[0], f.pos[1] + 1.7, f.pos[2]];
      const list = traffic.flyers;
      let best = 0.15;
      for (let i = 0; i < list.count; i++) {
        if (list.keys[i] < 0) continue;
        const o = i * 10, d = list.data;
        const vx = d[o] - eye[0], vy = d[o + 1] + 0.8 - eye[1], vz = d[o + 2] - eye[2];
        const flat = Math.hypot(vx, vz);
        if (flat < 60 || flat > 320) continue;
        const off = Math.abs(wrap(Math.atan2(vx, vz) - look.yaw));
        const elev = Math.atan2(vy, flat);
        if (off < best && Math.abs(elev) < 0.4) {
          best = off;
          pitch = elev;
          fire = off < 0.05 && Math.abs(elev - look.pitch) < 0.05;
        }
      }
    }
    look.pitch = turnToward(look.pitch, pitch, 0.8, dt);

    // hold the corridor's height (climb early for an east-west turn; stay up until lined up)
    let height = FLY_HEIGHT[this.axis];
    if (this.turn && ns) height = FLY_HEIGHT.ew;
    if (Math.abs(across) > 4) height = Math.max(height, f.pos[1]);
    const vy = clamp((height - f.pos[1]) * 0.8, -10, 10);
    const speed = boost ? BOOST : CRUISE;
    const climb = clamp((vy - Math.sin(look.pitch) * speed) / CLIMB, -1, 1);
    return { moveX: 0, moveZ: 1, up: false, down: false, sprint: boost, fire, climb };
  }
}

// ---------------------------------------------------------------------------
// Driving: down an east-west street (they carry no traffic), giving way to the
// avenue traffic at each crossing.

const LANE = 3.5; // keeps right: clear of the expressway piers and the parked cars
const DRIVE_SPEED = 26;
const CROSSING = STREET / 2 + 2.3; // car centre enters / leaves an avenue this far from its line

export class DrivePilot {
  readonly line: number;
  /** Stopped to let avenue traffic pass. */
  waiting = false;

  constructor(z: number, readonly dir: 1 | -1) {
    this.line = Math.round(z / CELL) * CELL;
  }

  get lane(): number {
    return this.line + this.dir * LANE;
  }

  steer(car: Car, traffic: Traffic): Pilot {
    const [x, , z] = car.pos;
    const heading = Math.atan2(this.dir * 18, this.lane - z);
    const steer = clamp(-wrap(heading - car.yaw) * 2.5, -1, 1);

    // the next avenue whose far side is still ahead
    const next = this.dir > 0
      ? Math.ceil((x - CROSSING) / CELL) * CELL
      : Math.floor((x + CROSSING) / CELL) * CELL;
    const d = (next - x) * this.dir;
    let want = DRIVE_SPEED;
    this.waiting = d - CROSSING > 0 && d - CROSSING < 70 && this.blocked(traffic, x, next, car.speed);
    if (this.waiting) want = Math.min(want, Math.sqrt(2 * 9 * Math.max(0, d - CROSSING - 3)));
    return { moveX: steer, moveZ: clamp((want - car.speed) * 0.4, -1, 1), up: false, down: false, sprint: false, fire: false };
  }

  /** Would a car on the avenue at `lineX` be in our lane while we pass over its lane? */
  private blocked(traffic: Traffic, x: number, lineX: number, speed: number): boolean {
    const v = Math.max(0, speed);
    const time = (dist: number) => (v > 20 ? dist / v : (-v + Math.sqrt(v * v + 2 * 11 * Math.max(0, dist))) / 11);
    const lane = this.lane;
    // half a car (or van) length plus half our width, and a little room
    for (const [list, reach] of [[traffic.cars, 3.6], [traffic.vans, 4.2]] as const) {
      for (let i = 0; i < list.count; i++) {
        const o = i * 10, dat = list.data;
        if (list.keys[i] < 0 || Math.abs(dat[o] - lineX) > 8 || dat[o + 1] > 3) continue;
        // our car overlaps that lane while its centre is within 3.4 m of it
        const d = (dat[o] - x) * this.dir;
        const t0 = time(d - 3.4) - 0.35, t1 = time(d + 3.4) + 0.35;
        const cz = dat[o + 2];
        const vz = traffic.velocityOf(list.keys[i])[2];
        if (vz === 0) {
          if (Math.abs(cz - lane) < reach) return true;
          continue;
        }
        const a = (lane - reach - cz) / vz, b = (lane + reach - cz) / vz;
        if (Math.max(a, b) > t0 && Math.min(a, b) < t1) return true;
      }
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Director

type Scene = "fly" | "run" | "drive";
const SCENES: { kind: Scene; seconds: number }[] = [
  { kind: "fly", seconds: 36 },
  { kind: "run", seconds: 30 },
  { kind: "drive", seconds: 26 },
];
const FADE_OUT = 0.8;
const FADE_IN = 1.5;

export class Demo {
  active = false;
  /** 0..1 brightness for the cut to black between scenes. */
  fade = 1;
  kind: Scene | "" = "";
  private index = -1;
  private time = 0;
  private left = 0;
  private run: RunPilot | null = null;
  private fly: FlyPilot | null = null;
  private drive: DrivePilot | null = null;
  private check = { time: 0, pos: [0, 0, 0] as Vec3 };
  private saved = { kills: 0, carKills: 0, cycle: true };

  constructor(private rides: Rides, private player: Player, private weather: Weather) {}

  start(): void {
    if (this.active) return;
    this.active = true;
    const c = this.rides.combat;
    this.saved = { kills: c.kills, carKills: c.carKills, cycle: this.weather.cycle };
    this.weather.cycle = false;
    this.index = -1;
    this.cut();
  }

  /** Hand over as things stand: whatever the demo is riding stays yours. */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.kind = "";
    this.fade = 1;
    const c = this.rides.combat;
    c.kills = this.saved.kills;
    c.carKills = this.saved.carKills;
    this.weather.cycle = this.saved.cycle;
  }

  private cut(): void {
    const { rides, player: pl } = this;
    const [fx, , fz] = rides.focus;
    rides.leave();
    this.index = (this.index + 1) % SCENES.length;
    const scene = SCENES[this.index];
    this.kind = scene.kind;
    this.time = 0;
    this.left = scene.seconds;
    this.run = this.fly = this.drive = null;
    pl.vel = [0, 0, 0];
    if (scene.kind === "run") {
      this.run = new RunPilot(Math.floor(fx / CELL), Math.floor(fz / CELL), rides.colliders);
      pl.pos = this.run.start;
      pl.yaw = Math.PI / 2;
      pl.pitch = -0.06;
    } else if (scene.kind === "fly") {
      const axis = Math.random() < 0.6 ? "ns" : "ew";
      const dir = Math.random() < 0.5 ? 1 : -1;
      const line = Math.round((axis === "ns" ? fx : fz) / CELL) * CELL;
      pl.pos = axis === "ns" ? [line, FLY_HEIGHT.ns, fz] : [fx, FLY_HEIGHT.ew, line];
      pl.yaw = axis === "ns" ? (dir > 0 ? 0 : Math.PI) : dir * Math.PI / 2;
      pl.pitch = -0.1;
      this.fly = new FlyPilot(pl.pos[0], pl.pos[2], axis, dir);
      const f = rides.spawnFlyer(pick(FLYER_PALETTE));
      f.grounded = false;
      f.vel = axis === "ns" ? [0, 0, dir * CRUISE] : [dir * CRUISE, 0, 0];
    } else {
      const dir = Math.random() < 0.5 ? 1 : -1;
      this.drive = new DrivePilot(fz, dir);
      pl.pos = [Math.floor(fx / CELL) * CELL + CELL / 2, 0, this.drive.lane];
      pl.yaw = dir * Math.PI / 2;
      pl.pitch = 0;
      const car = rides.spawnCar(pick(PAINT_COLORS));
      car.speed = 16;
    }
    this.check = { time: 0, pos: [...pl.pos] };
    this.weather.next(5);
  }

  /** Drive this frame's controls (and the look direction) from the autopilot. */
  update(dt: number, c: Controls, traffic: Traffic): void {
    this.time += dt;
    this.left -= dt;
    if (this.left <= 0) this.cut();
    this.fade = clamp(Math.min(this.time / FADE_IN, this.left / FADE_OUT), 0, 1);

    const { rides, player: pl } = this;
    let pilot: Pilot | null = null;
    let failed = false;
    if (this.run) {
      pilot = this.run.steer(pl, dt);
      failed = this.run.fell(pl);
    } else if (this.fly && rides.flyer) {
      pilot = this.fly.steer(rides.flyer, pl, dt, traffic);
    } else if (this.drive && rides.car) {
      pilot = this.drive.steer(rides.car, traffic);
      if (this.drive.waiting) this.check.time = 0;
    }
    Object.assign(c, pilot ?? { moveX: 0, moveZ: 0, up: false, down: false, sprint: false, fire: false });
    c.mouseDX = c.mouseDY = 0;

    // wedged against something: move on to the next scene
    this.check.time += dt;
    if (this.check.time > 3) {
      const p = rides.focus, q = this.check.pos;
      if (Math.hypot(p[0] - q[0], p[2] - q[2]) < 4) failed = true;
      this.check = { time: 0, pos: [...p] };
    }
    if (failed) this.left = Math.min(this.left, FADE_OUT);
  }
}

function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}
