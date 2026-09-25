// Demo mode: autopilots that run the decks, fly the air corridors and drive the
// cross streets, and a director that cuts between them as the weather moves on.

import { bridgeOn, CELL, deckEdge, PODIUM_LEVELS, podiumCut, podiumHeight } from "./city/generate";
import {
  ARTERY, arteryFrame, arteryLines, RIVER_HALF, riverFrame, riverNear, waterLevel, type Vec2,
} from "./city/network";
import { roadY } from "./city/plan";
import type { Vec3 } from "./math";
import type { Colliders, Player } from "./player";
import type { Controls, Rides } from "./rides";
import type { Boat } from "./vehicles/boat";
import type { Car } from "./vehicles/car";
import { FLYER_PALETTE, type Flyer } from "./vehicles/flyer";
import { PAINT_COLORS } from "./vehicles/models";
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

/** Block-local coordinate of the deck's outer edge on `side`, just inside the parapet. */
const edgeOf = (ci: number, cj: number, side: number) =>
  deckEdge(ci, cj, side) + (side < 2 ? 0.5 : -0.5);
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
    const lines = [0, 1, 2, 3].map((side) => {
      // each side runs between the two deck edges it meets, which is its own pair of setbacks
      const lo = edgeOf(ci, cj, side % 2 === 0 ? 3 : 2) + 1;
      const hi = edgeOf(ci, cj, side % 2 === 0 ? 1 : 0) - 1;
      // hug the edge where possible: the view over the street is the point
      for (let inset = 1.2; inset < 9; inset += 0.1) {
        const local = edgeOf(ci, cj, side) + (side < 2 ? -inset : inset);
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

  /**
   * How the route turns the corner after `side`, going anticlockwise (east -> north -> west
   * -> south): normally the one point where the two running lines cross.
   *
   * Where the corner is cut back, that crossing is out over the street. Rather than move it
   * inboard — which would take the long runs off the lines that were probed clear — the
   * corner is cut by two points that each stay on one line, far enough along it that their
   * distances from the two faces add up to the cut, with a short diagonal between them.
   * Returned as [point on the x line, point on the z line].
   */
  private corner(ci: number, cj: number, side: number): Point[] | null {
    const [e, n, w, s] = this.ring(ci, cj).lines;
    const c = [[e, n], [w, n], [w, s], [e, s]][side];
    if (c[0] === null || c[1] === null) return null;
    const [cx, cz] = c;
    const cut = podiumCut(ci, cj) + 1;
    if (cut <= 1) return [[cx, cz]];
    const [xs, zs] = [[0, 1], [2, 1], [2, 3], [0, 3]][side]; // the faces this corner stands on
    const fx = ci * CELL + edgeOf(ci, cj, xs), fz = cj * CELL + edgeOf(ci, cj, zs);
    const t = cut - Math.abs(cx - fx) - Math.abs(cz - fz);
    if (t <= 0) return [[cx, cz]];
    return [[cx, cz + (zs < 2 ? -t : t)], [cx + (xs < 2 ? -t : t), cz]];
  }

  /** Where the running line meets the bridge on `side`, if the way to the deck edge is clear. */
  private landing(ci: number, cj: number, side: number, offset: number): Point | null {
    const r = this.ring(ci, cj);
    const line = r.lines[side];
    if (line === null) return null;
    const ox = ci * CELL, oz = cj * CELL, mid = CELL / 2 + offset;
    const edge = edgeOf(ci, cj, side);
    const p: Point = side % 2 === 0 ? [line, oz + mid] : [ox + mid, line];
    const e: Point = side % 2 === 0 ? [ox + edge, oz + mid] : [ox + mid, oz + edge];
    return clearPath(this.colliders(p[0], p[1]), p, e, r.deck) ? p : null;
  }

  /** Starting spot on the deck: the south-west corner of its running lines. */
  get start(): Vec3 {
    const c = this.corner(this.ci, this.cj, 2);
    const ox = this.ci * CELL, oz = this.cj * CELL;
    const [x, z] = c?.[0] ?? [ox + edgeOf(this.ci, this.cj, 2) + 1.5, oz + edgeOf(this.ci, this.cj, 3) + 1.5];
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
    const lo = edgeOf(this.ci, this.cj, 2) + 1.5, hi = edgeOf(this.ci, this.cj, 0) - 1.5;
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
      // arriving along an east or west line means meeting the x-line point first
      out.push(...(s % 2 === 0 ? c : [...c].reverse()));
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
// Flying and driving. There is no grid to steer by: an arterial is a spline, and nothing at
// all stands on the straight lines that x = n * CELL and z = n * CELL would aim down — fly or
// drive one of those and you meet the first tower head on. What carries traffic here is the
// arterial, so that is what these follow: a station along the spline, kept honest against
// where the vehicle has actually got to, and a point on the road some way further on to aim
// at.

const CRUISE = 24, CLIMB = 11;
/** Over the road: the level the flyer traffic keeps, and proven clear of the towers. */
const PLAN_FLY = 93;
/** Out past the streamed traffic's lanes, and well inside the carriageway. */
const PLAN_LANE = 9;
const PLAN_DRIVE = 22;

/** The arterial of the given run that passes nearest (x, z), and the station along it. */
function nearestArtery(axis: 0 | 1, x: number, z: number): { line: number; s: number } {
  const across = axis === 0 ? z : x, s = axis === 0 ? x : z;
  let line = 0, best = Infinity;
  for (const l of arteryLines(across, ARTERY)) {
    const { p } = arteryFrame(axis, l, s);
    const d = Math.hypot(p[0] - x, p[1] - z);
    if (d < best) {
      best = d;
      line = l;
    }
  }
  return { line, s };
}

/**
 * A station along an arterial, carried from frame to frame.
 *
 * Integrating the distance travelled would drift, and inverting the spline every frame is
 * more work than it is worth, so each call slides the station to the foot of the
 * perpendicular from wherever the vehicle is now. That is exact enough over a frame and
 * self-correcting over a run.
 */
class Along {
  constructor(
    private frame: (s: number) => { p: Vec2; dir: Vec2 },
    readonly dir: 1 | -1,
    public s: number,
  ) {}

  at(): { p: Vec2; dir: Vec2 } {
    return this.frame(this.s);
  }

  /** The way `by` metres on, after pulling the station into line with (x, z). */
  ahead(x: number, z: number, by: number): { p: Vec2; dir: Vec2 } {
    const here = this.at();
    this.s += (x - here.p[0]) * here.dir[0] + (z - here.p[1]) * here.dir[1];
    return this.frame(this.s + this.dir * by);
  }

  /** Which way to face to travel along it. */
  get heading(): number {
    const d = this.at().dir;
    return Math.atan2(d[0] * this.dir, d[1] * this.dir);
  }
}

/** Flies an arterial's air corridor. */
export class PlanFlyPilot {
  private at: Along;
  private axis: 0 | 1;
  private line: number;

  constructor(x: number, z: number, axis: 0 | 1, dir: 1 | -1) {
    const { line, s } = nearestArtery(axis, x, z);
    this.axis = axis;
    this.line = line;
    this.at = new Along((t) => arteryFrame(axis, line, t), dir, s);
  }

  private road(x: number, z: number): number {
    return roadY(this.axis, this.line, this.at.s, x, z);
  }

  /** Where to put the flyer, and which way to face it. */
  get start(): { pos: Vec3; yaw: number } {
    const f = this.at.at();
    return { pos: [f.p[0], this.road(f.p[0], f.p[1]) + PLAN_FLY, f.p[1]], yaw: this.at.heading };
  }

  steer(f: Flyer, look: { yaw: number; pitch: number }, dt: number): Pilot {
    const aim = this.at.ahead(f.pos[0], f.pos[2], 70);
    look.yaw = turnToward(look.yaw, Math.atan2(aim.p[0] - f.pos[0], aim.p[1] - f.pos[2]), 1.4, dt);
    look.pitch = turnToward(look.pitch, -0.05, 0.8, dt);
    const want = this.road(f.pos[0], f.pos[2]) + PLAN_FLY;
    const vy = clamp((want - f.pos[1]) * 0.8, -10, 10);
    const climb = clamp((vy - Math.sin(look.pitch) * CRUISE) / CLIMB, -1, 1);
    return { moveX: 0, moveZ: 1, up: false, down: false, sprint: false, fire: false, climb };
  }
}

/** Drives an arterial, in a lane outside the streamed traffic's. */
export class PlanDrivePilot {
  private at: Along;
  private axis: 0 | 1;
  private line: number;
  private stall = 0;
  private tries = 0;
  /** How far across the road this attempt is running, after being stopped by something. */
  private shift = 0;
  waiting = false;
  /** Four shunts without a clear run between them: nothing here works, cut the scene. */
  get stuck(): boolean {
    return this.tries >= 4;
  }

  constructor(x: number, z: number, axis: 0 | 1, dir: 1 | -1) {
    const { line, s } = nearestArtery(axis, x, z);
    this.axis = axis;
    this.line = line;
    this.at = new Along((t) => arteryFrame(axis, line, t), dir, s);
  }

  private road(x: number, z: number): number {
    return roadY(this.axis, this.line, this.at.s, x, z);
  }

  /** The point in this pilot's lane abreast of a frame on the road. */
  private lane(f: { p: Vec2; dir: Vec2 }): Vec2 {
    // traffic running with the station keeps the negative side, so this sits beyond it
    const off = -PLAN_LANE * this.at.dir + this.shift;
    return [f.p[0] - f.dir[1] * off, f.p[1] + f.dir[0] * off];
  }

  get start(): { pos: Vec3; yaw: number } {
    const [x, z] = this.lane(this.at.at());
    return { pos: [x, this.road(x, z) + 0.4, z], yaw: this.at.heading };
  }

  steer(car: Car, dt: number): Pilot {
    const [tx, tz] = this.lane(this.at.ahead(car.pos[0], car.pos[2], 24));
    const heading = Math.atan2(tx - car.pos[0], tz - car.pos[2]);
    const steer = clamp(-wrap(heading - car.yaw) * 2.5, -1, 1);

    // Shunting out of it. A carriageway here is not always something a car can drive the
    // whole width of — the ground under it is cut into terraces, and a riser taller than a
    // kerb stops a car dead. Held on the throttle it would sit against that riser for the
    // rest of the scene, which is what it did. So: back off, take a different line across the
    // road, and come at it again; and if that keeps failing, say so and let the director cut.
    if (car.speed > 12) this.tries = 0; // a clear run: whatever stopped it is behind it
    this.stall = car.speed < 1.5 ? this.stall + dt : 0;
    if (this.stall > 0.5) {
      if (this.stall > 2.2) {
        this.stall = 0;
        this.tries++;
        this.shift = this.tries % 2 === 0 ? 0 : (this.tries % 4 < 2 ? -4 : 4);
      }
      return { moveX: -steer, moveZ: -1, up: false, down: false, sprint: false, fire: false };
    }
    return {
      moveX: steer,
      moveZ: clamp((PLAN_DRIVE - car.speed) * 0.4, -1, 1),
      up: false, down: false, sprint: false, fire: false,
    };
  }
}

/** Runs a river, keeping to one side of the channel. */
export class SailPilot {
  private at: Along;
  private line: number;

  /** The river nearest (x, z), or null where there is none to sail. */
  static near(x: number, z: number, dir: 1 | -1): SailPilot | null {
    const hit = riverNear(x, z, 900);
    return hit ? new SailPilot(hit.line, z, dir) : null;
  }

  private constructor(line: number, s: number, dir: 1 | -1) {
    this.line = line;
    this.at = new Along((t) => riverFrame(line, t), dir, s);
  }

  /** The point in this boat's lane abreast of a frame on the water. */
  private lane(f: { p: Vec2; dir: Vec2 }): Vec2 {
    const off = -RIVER_HALF * 0.3 * this.at.dir;
    return [f.p[0] - f.dir[1] * off, f.p[1] + f.dir[0] * off];
  }

  get start(): { pos: Vec3; yaw: number } {
    const [x, z] = this.lane(this.at.at());
    return { pos: [x, waterLevel(this.line) + 1.2, z], yaw: this.at.heading };
  }

  steer(b: Boat): Pilot {
    const [tx, tz] = this.lane(this.at.ahead(b.pos[0], b.pos[2], 55));
    const heading = Math.atan2(tx - b.pos[0], tz - b.pos[2]);
    // the helm bites less the slower she goes, so this leans on it harder than a car's
    return {
      moveX: clamp(wrap(heading - b.yaw) * 1.8, -1, 1),
      moveZ: 1,
      up: false, down: false, sprint: false, fire: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Director

type Scene = "fly" | "run" | "drive" | "sail";
const SCENES: { kind: Scene; seconds: number }[] = [
  { kind: "fly", seconds: 36 },
  { kind: "run", seconds: 30 },
  { kind: "drive", seconds: 26 },
  { kind: "sail", seconds: 24 },
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
  private fly: PlanFlyPilot | null = null;
  private drive: PlanDrivePilot | null = null;
  private sail: SailPilot | null = null;
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
    // A river scene needs a river, and not every block has one within reach. Where there is
    // none, the scene is passed over rather than cut to and abandoned.
    let sail: SailPilot | null = null;
    for (let tries = 0; tries < SCENES.length; tries++) {
      this.index = (this.index + 1) % SCENES.length;
      if (SCENES[this.index].kind !== "sail") break;
      sail = SailPilot.near(fx, fz, Math.random() < 0.5 ? 1 : -1);
      if (sail) break;
    }
    const scene = SCENES[this.index];
    this.kind = scene.kind;
    this.time = 0;
    this.left = scene.seconds;
    this.run = this.fly = this.drive = this.sail = null;
    pl.vel = [0, 0, 0];
    if (scene.kind === "run") {
      this.run = new RunPilot(Math.floor(fx / CELL), Math.floor(fz / CELL), rides.colliders);
      pl.pos = this.run.start;
      pl.yaw = Math.PI / 2;
      pl.pitch = -0.06;
    } else if (scene.kind === "fly") {
      const dir = Math.random() < 0.5 ? 1 : -1;
      const pilot = new PlanFlyPilot(fx, fz, Math.random() < 0.5 ? 1 : 0, dir);
      const { pos, yaw } = pilot.start;
      pl.pos = pos;
      pl.yaw = yaw;
      pl.pitch = -0.05;
      this.fly = pilot;
      const f = rides.spawnFlyer(pick(FLYER_PALETTE));
      f.grounded = false;
      f.vel = [Math.sin(pl.yaw) * CRUISE, 0, Math.cos(pl.yaw) * CRUISE];
    } else if (scene.kind === "sail" && sail) {
      const { pos, yaw } = sail.start;
      pl.pos = pos;
      pl.yaw = yaw;
      pl.pitch = 0;
      this.sail = sail;
      rides.spawnBoat();
    } else {
      const dir = Math.random() < 0.5 ? 1 : -1;
      const pilot = new PlanDrivePilot(fx, fz, Math.random() < 0.5 ? 1 : 0, dir);
      const { pos, yaw } = pilot.start;
      pl.pos = pos;
      pl.yaw = yaw;
      pl.pitch = 0;
      this.drive = pilot;
      const car = rides.spawnCar(pick(PAINT_COLORS));
      car.speed = 16;
    }
    this.check = { time: 0, pos: [...pl.pos] };
    this.weather.next(5);
  }

  /** Drive this frame's controls (and the look direction) from the autopilot. */
  update(dt: number, c: Controls): void {
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
      pilot = this.fly.steer(rides.flyer, pl, dt);
    } else if (this.drive && rides.car) {
      pilot = this.drive.steer(rides.car, dt);
      failed = this.drive.stuck;
      if (this.drive.waiting) this.check.time = 0;
    } else if (this.sail && rides.boat) {
      pilot = this.sail.steer(rides.boat);
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
