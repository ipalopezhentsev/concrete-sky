// Berths: the flyers waiting on the landing pads, the cars at the kerb and the launches tied up
// along the quays — and the people who take them out and bring them back.
//
// Like everything else that moves here on its own, this is a function of the clock. Each
// berth goes round the same cycle every few minutes, from its own point in it: most of the
// time the vehicle is just parked there; then someone comes along the pavement or the deck,
// gets in and goes — the flyer lifts off and climbs away over the roofs, the car pulls out and
// drives off down the street, the launch swings out into the channel — and a while later one
// comes back the same way, and whoever is in it gets out and walks off.
//
// While it is out it is not in the parking at all: nothing to draw there, to hit or to take.
// The runner can still have it, though. Nobody takes a vehicle out from under someone standing
// beside it, nothing lands on a berth the runner is standing on or has left something on, and
// a berth seen for the first time is left parked whatever its clock says, so the flyer by the
// spawn is there to be taken.

import { ARTERY_HALF, blockAt, RIVER_HALF, riverFrame, riverNear, streetsOf, type Street, type Vec2 } from "./city/network";
import { deckOf, pavementAt, rideAt } from "./city/plan";
import { worldSeed, type Vec3 } from "./math";
import { PACE, Path, type Pedestrians } from "./pedestrians";
import type { Colliders } from "./player";
import { CAR_DIMS } from "./vehicles/models";
import type { Parked, Parking, VehicleKind } from "./vehicles/parking";
import { h32, type InstanceList, type Traffic } from "./vehicles/traffic";

type Kind = "flyer" | "car" | "boat";

/** How a kind of berth spends its cycle, in seconds. */
interface Plan {
  period: number;
  /** How often a cycle has anyone come for it at all. */
  chance: number;
  /** Walking to it, and away from it at the end. */
  walk: number;
  /** Getting in before it moves, and out once it has stopped. */
  board: number;
  /** From the berth to out of sight, and back again. */
  trip: number;
  away: number;
}

const PLANS: Record<Kind, Plan> = {
  flyer: { period: 330, chance: 0.25, walk: 24, board: 3, trip: 55, away: 30 },
  car: { period: 420, chance: 0.4, walk: 22, board: 4, trip: 45, away: 80 },
  boat: { period: 660, chance: 0.5, walk: 0, board: 4, trip: 150, away: 100 },
};

/** Out to here a berth is followed; it covers the parked vehicles drawn, which is 300. */
const REACH = 330;
/** Out to here moving vehicles are drawn, by kind. */
const SHOWN: Record<VehicleKind, number> = { flyer: 600, car: 320, van: 320, boat: 820 };
/** How far clear of a berth the runner has to be for anything to come or go from it, by kind. */
const ROOM: Record<Kind, number> = { flyer: 4, car: 4, boat: 9 };
/** The river traffic's lanes, off the middle of the channel; see `rivers` in traffic.ts. */
const RIVER_LANE = RIVER_HALF * 0.3;
/** How steeply a flyer climbs on once it is on its way: metres up for each metre across. */
const CLIMB = 0.15;

/** A flyer's way out: which way it goes, how high it climbs first, and how long that takes. */
interface Flight {
  heading: number;
  climb: number;
  rise: number;
}

/** A launch's way out from where it is moored: which river, how far along it, how far across. */
interface Sail {
  line: number;
  s0: number;
  o: number;
}

interface Berth {
  p: Parked;
  kind: Kind;
  id: number;
  /** Where in its cycle it was at time 0, 0..1. */
  phase: number;
  /** Seen before; the first time it is, it stays put for the cycle. */
  seen: boolean;
  /** The cycle it is kept parked through. */
  hold: number;
  /** Came back to find its place taken: away until nobody is about to see it turn up. */
  empty: boolean;
  /** The cycle the ways below were worked out for; undefined until they are asked for, null if there is none. */
  cycle: number;
  walkIn?: Path | null;
  walkOff?: Path | null;
  out?: Flight | Path | Sail | null;
  back?: Flight | Path | Sail | null;
}

interface Shown {
  kind: VehicleKind;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  color: Vec3;
}

const ease = (t: number) => t * t * (3 - 2 * t);

/** Metres gone `t` seconds after setting off: speeding up at `a` to `v`, then holding it. */
function gone(t: number, a: number, v: number): number {
  if (t <= 0) return 0;
  const ta = v / a;
  return t < ta ? 0.5 * a * t * t : 0.5 * a * ta * ta + v * (t - ta);
}

function lerpAngle(a: number, b: number, t: number): number {
  return a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;
}

export class Berths {
  private berths = new Map<string, Berth>();
  private near: Berth[] = [];
  private nearAt: Vec3 = [Infinity, 0, 0];
  private nearTime = -Infinity;
  private shown: Shown[] = [];
  private seed = worldSeed() ^ 0xbe47;
  private place = { x: 0, y: 0, z: 0, yaw: 0 };

  constructor(private parking: Parking, private peds: Pedestrians, private traffic: Traffic, private colliders: Colliders) {}

  /**
   * Work out the frame: which berths are out, where what is out has got to, and the people
   * walking to and from them. `runner` is where the runner is on foot, or null; `ridden`
   * where whatever they are riding is, or null.
   */
  update(time: number, eye: Vec3, runner: Vec3 | null, ridden: Vec3 | null): void {
    if (this.seed !== (worldSeed() ^ 0xbe47)) {
      this.seed = worldSeed() ^ 0xbe47;
      this.berths.clear();
      this.nearTime = -Infinity;
    }
    this.shown.length = 0;
    if (Math.hypot(eye[0] - this.nearAt[0], eye[2] - this.nearAt[2]) > 20 || time - this.nearTime > 1) this.gather(eye, time);
    const out = new Set<string>();
    for (const b of this.near) {
      if (this.parking.has(b.p.id)) this.step(b, time, eye, runner, ridden, out);
    }
    this.parking.setOut(out);
    this.crews(eye);
  }

  /** What is out and moving this frame, by kind and where (test hook). */
  trips(): { kind: VehicleKind; pos: Vec3 }[] {
    return this.shown.map((v) => ({ kind: v.kind, pos: [v.x, v.y, v.z] }));
  }

  /** The moving vehicles, into the lists they are drawn from. */
  draw(lists: Record<VehicleKind, InstanceList>, eye: Vec3): void {
    for (const v of this.shown) {
      if (Math.hypot(v.x - eye[0], v.z - eye[2]) > SHOWN[v.kind]) continue;
      lists[v.kind].push(v.x, v.y, v.z, v.yaw, v.pitch, 0, v.color, 1);
    }
  }

  /** The berths in reach; asked again every second or so, and when the eye has moved a way. */
  private gather(eye: Vec3, time: number): void {
    this.nearAt = [...eye];
    this.nearTime = time;
    this.near = [];
    for (const p of this.parking.city()) {
      if (Math.abs(p.x - eye[0]) > REACH || Math.abs(p.z - eye[2]) > REACH) continue;
      let b = this.berths.get(p.id);
      if (!b) {
        const kind: Kind = p.kind === "flyer" ? "flyer" : p.kind === "boat" ? "boat" : "car";
        const id = h32(Math.round(p.x * 10), Math.round(p.z * 10), Math.round(p.y), kind.length);
        b = { p, kind, id, phase: (h32(id, 1, 2, this.seed) & 0xffff) / 0x10000, seen: false, hold: NaN, empty: false, cycle: NaN };
        this.berths.set(p.id, b);
      }
      // the parking makes its vehicles afresh whenever the world streams in more of the city
      b.p = p;
      this.near.push(b);
    }
    if (this.berths.size > 4000) {
      const keep = new Set(this.near);
      for (const [k, b] of this.berths) if (!keep.has(b)) this.berths.delete(k);
    }
  }

  private step(b: Berth, time: number, eye: Vec3, runner: Vec3 | null, ridden: Vec3 | null, out: Set<string>): void {
    const plan = PLANS[b.kind], p = b.p;
    const u = time / plan.period + b.phase;
    const c = Math.floor(u), tau = (u - c) * plan.period;
    const a0 = plan.period - 2 * (plan.walk + plan.board + plan.trip) - plan.away;
    const a1 = a0 + plan.walk, a2 = a1 + plan.board, a3 = a2 + plan.trip, a4 = a3 + plan.away, a5 = a4 + plan.trip, a6 = a5 + plan.board;
    const fresh = !b.seen;
    b.seen = true;
    const happens = (h32(b.id, c, 3, this.seed) & 0xffff) / 0x10000 < plan.chance;
    if (b.empty) {
      // it stays away until it can come back with nobody there to see it appear
      const far = Math.hypot(p.x - eye[0], p.z - eye[2]) > 90;
      if (far && !this.taken(b, runner, ridden) && (tau < a0 || !happens)) b.empty = false;
      else {
        out.add(p.id);
        return;
      }
    }
    if (b.hold === c || tau < a0 || !happens) return;
    // Just come into reach, so whatever its clock says it has been here all along. That also
    // keeps a quarter of the city coming into reach at once from laying out every trip in it
    // in the same frame.
    if (fresh) {
      b.hold = c;
      return;
    }
    if (b.cycle !== c) {
      b.cycle = c;
      b.walkIn = b.walkOff = b.out = b.back = undefined;
    }
    // somewhere for a car or a launch to go, and to come back from; a flyer can always go up
    if (b.kind !== "flyer" && (!this.way(b, c, "out") || !this.way(b, c, "back"))) {
      b.hold = c;
      return;
    }
    if (tau < a2) {
      // nobody takes it out from beside the runner
      if (this.by(b, runner, ridden, 7)) {
        b.hold = c;
        return;
      }
      if (tau < a1) this.walker(b, "in", tau - a0, c);
      else if (b.kind === "boat") this.crew(b, p.x, p.y, p.z, p.yaw, (tau - a1) / plan.board, c);
      return;
    }
    if (tau < a3) {
      out.add(p.id);
      this.moving(b, "out", tau - a2, c);
      return;
    }
    // coming back, so somewhere to come back to — decided while it is still a way off
    if (tau < a4 + plan.trip * 0.6 && this.taken(b, runner, ridden)) {
      b.empty = true;
      out.add(p.id);
      return;
    }
    if (tau < a4) {
      out.add(p.id);
      return;
    }
    if (tau < a5) {
      out.add(p.id);
      this.moving(b, "back", tau - a4, c);
      return;
    }
    if (tau < a6) {
      if (b.kind === "boat") this.crew(b, p.x, p.y, p.z, p.yaw, 1 + (tau - a5) / plan.board, c);
      return;
    }
    this.walker(b, "off", tau - a6, c);
  }

  /** Whether the runner, or what they are riding, is within `r` of a berth. */
  private by(b: Berth, runner: Vec3 | null, ridden: Vec3 | null, r: number): boolean {
    const p = b.p;
    if (runner && Math.abs(runner[1] - p.y) < 3 && Math.hypot(runner[0] - p.x, runner[2] - p.z) < r) return true;
    return !!ridden && Math.abs(ridden[1] - p.y) < 4 && Math.hypot(ridden[0] - p.x, ridden[2] - p.z) < r + 3;
  }

  /** Whether a berth has something on it that is not its own: the runner, or something left there. */
  private taken(b: Berth, runner: Vec3 | null, ridden: Vec3 | null): boolean {
    const p = b.p, r = ROOM[b.kind];
    return this.by(b, runner, ridden, r) || this.parking.occupied(p.x, p.y, p.z, r);
  }

  /** Someone walking to a berth to take it out (`t` seconds into the walk), or away from it once it is back. */
  private walker(b: Berth, way: "in" | "off", t: number, c: number): void {
    if (b.kind === "boat") return;
    const span = PLANS[b.kind].walk;
    let path = way === "in" ? b.walkIn : b.walkOff;
    if (path === undefined) {
      path = this.walkFor(b, way, c);
      // not yet if the loop they come along is not laid out yet
      if (path === undefined) return;
      if (way === "in") b.walkIn = path;
      else b.walkOff = path;
    }
    if (!path) return;
    // getting to the door just as the walk is up, or leaving it as soon as it starts
    const d = way === "in" ? path.len - (span - t) * PACE : t * PACE;
    if (d < 0 || d > path.len) return;
    const q = this.place;
    path.at(d, q);
    this.peds.put(q.x, q.y, q.z, q.yaw, d, h32(b.id, c, 7, this.seed));
  }

  /**
   * The walk between a berth and the nearest loop people walk: along the loop for a while, then
   * off it to the door. Undefined while that loop is not laid out, null if there is no way.
   */
  private walkFor(b: Berth, way: "in" | "off", c: number): Path | null | undefined {
    const p = b.p, h = h32(b.id, c, way === "in" ? 8 : 9, this.seed);
    const f: Vec2 = [Math.sin(p.yaw), Math.cos(p.yaw)], r: Vec2 = [-f[1], f[0]];
    let legs: Vec3[], on: "pave" | "deck" | "roof";
    if (b.kind === "car") {
      // From the pavement, round the back of the car to the driver's door, which is on the
      // side away from the kerb: everything here keeps right, so it is parked on the right.
      const hz = CAR_DIMS[p.kind === "van" ? "van" : "car"].hz;
      const at = (side: number, along: number, kerb: boolean): Vec3 => {
        const x = p.x + r[0] * side + f[0] * along, z = p.z + r[1] * side + f[1] * along;
        return [x, kerb ? pavementAt(x, z) : p.y, z];
      };
      legs = [at(2.6, -hz - 0.9, true), at(1.2, -hz - 0.9, false), at(-1.45, -hz - 0.5, false), at(-1.45, 0.4, false)];
      on = "pave";
    } else {
      // up to the side of the flyer, on whichever side the loop is
      const side = h & 1 ? 1 : -1;
      legs = [[p.x + r[0] * 1.7 * side, p.y, p.z + r[1] * 1.7 * side]];
      const site = blockAt(p.x, p.z);
      on = site && Math.abs(deckOf(site) - p.y) < 1 ? "deck" : "roof";
    }
    const first = legs[0];
    const clear = this.peds.clearNear(first[0], first[2], 12, first[1], b.kind === "car");
    let legLen = 0;
    for (let k = 0; k + 1 < legs.length; k++) legLen += Math.hypot(legs[k + 1][0] - legs[k][0], legs[k + 1][2] - legs[k][2]);
    const lead = Math.max(0, Math.min(30, PLANS[b.kind].walk * PACE - legLen - 4));
    const loop = this.peds.approach(on, first[0], first[1], first[2], lead, h & 2 ? 1 : -1);
    if (loop === null) return undefined;
    const pts: number[] = [...loop];
    for (const l of legs) pts.push(...l);
    // the way off the loop clear of lamps and lifts, short of the last metre to the door
    const n = pts.length / 3;
    const from = Math.max(0, n - legs.length - 1);
    for (let k = from; k + 1 < n; k++) {
      const o = k * 3;
      const len = Math.hypot(pts[o + 3] - pts[o], pts[o + 5] - pts[o + 2]);
      const last = k + 2 === n;
      for (let s = 0; s < len - (last ? 1 : 0); s += 0.5) {
        const t = s / (len || 1);
        if (!clear(pts[o] + (pts[o + 3] - pts[o]) * t, pts[o + 1] + (pts[o + 4] - pts[o + 1]) * t, pts[o + 2] + (pts[o + 5] - pts[o + 2]) * t, 0.25)) return null;
      }
    }
    const path = new Path(pts);
    return way === "in" ? path : path.reversed();
  }

  /** A vehicle on its way out (`t` seconds after setting off) or back (`t` seconds into coming back). */
  private moving(b: Berth, leg: "out" | "back", t: number, c: number): void {
    const p = b.p, trip = PLANS[b.kind].trip;
    const way = this.way(b, c, leg);
    if (!way) return;
    // coming back is going out with the film run backwards
    const s = leg === "out" ? t : trip - t;
    const q = this.place;
    if (b.kind === "flyer") {
      const m = way as Flight;
      const SPOOL = 2;
      let yaw = p.yaw, x = p.x, y = p.y, z = p.z, pitch = 0;
      const face = leg === "out" ? m.heading : m.heading + Math.PI;
      if (s > SPOOL && s < SPOOL + m.rise) {
        const e = (s - SPOOL) / m.rise;
        y += m.climb * ease(e);
        yaw = lerpAngle(p.yaw, face, ease(Math.min(1, e * 1.5)));
      } else if (s >= SPOOL + m.rise) {
        const d = gone(s - SPOOL - m.rise, 2.4, 45);
        x += Math.sin(m.heading) * d;
        z += Math.cos(m.heading) * d;
        y += m.climb + d * CLIMB;
        yaw = face;
        pitch = 0.06;
      }
      this.shown.push({ kind: "flyer", x, y, z, yaw, pitch, color: p.color });
    } else if (b.kind === "car") {
      const path = way as Path;
      path.at(gone(s - 1.5, 2, 9), q);
      this.shown.push({ kind: p.kind, x: q.x, y: q.y, z: q.z, yaw: leg === "out" ? q.yaw : q.yaw + Math.PI, pitch: 0, color: p.color });
    } else {
      const m = way as Sail;
      const d = gone(s - 1, 0.6, 6.5);
      const [x, z] = this.afloat(m, leg, d);
      // heading the way it is going: away from the mooring going out, towards it coming back
      const [nx, nz] = this.afloat(m, leg, leg === "out" ? d + 0.5 : Math.max(0, d - 0.5));
      const yaw = leg === "out" ? Math.atan2(nx - x, nz - z) : d > 0.5 ? Math.atan2(nx - x, nz - z) : p.yaw;
      this.shown.push({ kind: "boat", x, y: p.y, z, yaw, pitch: 0, color: p.color });
      this.crew(b, x, p.y, z, yaw, 1, c);
    }
  }

  /** The way out or back for this cycle, worked out the first time it is asked for. */
  private way(b: Berth, c: number, leg: "out" | "back"): Flight | Path | Sail | null {
    let way = b[leg];
    if (way === undefined) {
      way = b.kind === "flyer" ? this.flight(b, c, leg) : b.kind === "car" ? this.drive(b, c, leg) : this.sail(b);
      b[leg] = way;
    }
    return way;
  }

  /**
   * Which way a flyer goes from its pad: of four headings, the one with the least to climb
   * over in the first few hundred metres, since a pad on a deck has towers all round it.
   */
  private flight(b: Berth, c: number, leg: "out" | "back"): Flight {
    const p = b.p;
    const h = h32(b.id, c, leg === "out" ? 10 : 11, this.seed);
    const base = ((h & 0xffff) / 0x10000) * Math.PI * 2;
    let best: Flight = { heading: base, climb: 200, rise: 25 };
    for (let k = 0; k < 4; k++) {
      const heading = base + (k * Math.PI) / 2;
      const hx = Math.sin(heading), hz = Math.cos(heading);
      let climb = 14;
      for (let d = 4; d <= 640 && climb < best.climb; d += 8) {
        const x = p.x + hx * d, z = p.z + hz * d;
        const boxes = this.colliders(x, z);
        for (let o = 0; o < boxes.length; o += 6) {
          if (x < boxes[o] - 3 || x > boxes[o + 3] + 3 || z < boxes[o + 2] - 3 || z > boxes[o + 5] + 3) continue;
          // over it with room to spare, at the height it will have climbed to by then
          climb = Math.max(climb, boxes[o + 4] + 6 - p.y - d * CLIMB);
        }
      }
      if (climb < best.climb) best = { heading, climb, rise: 5 + climb / 9 };
    }
    return best;
  }

  /**
   * The streets a car drives out along, or comes back along: down the one it is parked in, and
   * at each junction on into one of the others, keeping right all the way. Laid out going away
   * from the kerb either way; a car coming back runs it backwards, so it keeps to the lane
   * that is right for that.
   */
  private drive(b: Berth, c: number, leg: "out" | "back"): Path | null {
    const p = b.p;
    const f: Vec2 = [Math.sin(p.yaw), Math.cos(p.yaw)], r: Vec2 = [-f[1], f[0]];
    const site = blockAt(p.x + r[0] * 5, p.z + r[1] * 5);
    if (!site) return null;
    let cur: Street | null = null, best = 10;
    for (const s of streetsOf(site)) {
      const l = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
      if (l < 1) continue;
      const ux = (s.b[0] - s.a[0]) / l, uz = (s.b[1] - s.a[1]) / l;
      if (Math.abs(ux * f[0] + uz * f[1]) < 0.9) continue;
      const t = Math.max(0, Math.min(l, (p.x - s.a[0]) * ux + (p.z - s.a[1]) * uz));
      const d = Math.hypot(p.x - s.a[0] - ux * t, p.z - s.a[1] - uz * t);
      if (d < best) {
        best = d;
        cur = s;
      }
    }
    if (!cur) return null;
    const away = leg === "out" ? 1 : -1;
    const g: Vec2 = [f[0] * away, f[1] * away];
    // the lane: a car's width off the middle of a side street, between the cars parked along
    // both kerbs; the slow lane of an arterial
    const laneOf = (s: Street) => (s.half >= ARTERY_HALF - 0.5 ? 6 : Math.max(0.4, s.half - 3.7));
    // to the right of the way it is actually driven
    const right = (u: Vec2): Vec2 => [-u[1] * away, u[0] * away];
    const near = (a: Vec2, b2: Vec2) => Math.hypot(a[0] - b2[0], a[1] - b2[1]) < 1.5;
    // A street between two blocks on a bank runs on as far as the middle of the river, which is
    // where the edge between them ends; the road stops at the quay.
    const wet = (a: Vec2) => {
      const r = riverNear(a[0], a[1]);
      return !!r && r.dist < RIVER_HALF + 2;
    };
    let [from, to] = (cur.b[0] - cur.a[0]) * g[0] + (cur.b[1] - cur.a[1]) * g[1] > 0 ? [cur.a, cur.b] : [cur.b, cur.a];
    if (wet(to)) return null;
    let u: Vec2 = [to[0] - from[0], to[1] - from[1]];
    let l = Math.hypot(u[0], u[1]);
    u = [u[0] / l, u[1] / l];
    let lane = laneOf(cur), rv = right(u);
    // out of the space and into the lane over ten metres
    const t0 = (p.x - from[0]) * u[0] + (p.z - from[1]) * u[1] + 10;
    const pts: Vec2[] = [[p.x, p.z], [from[0] + u[0] * t0 + rv[0] * lane, from[1] + u[1] * t0 + rv[1] * lane]];
    let total = l - t0;
    for (let hop = 0; hop < 8; hop++) {
      const opts: { s: Street; end: Vec2; u: Vec2; l: number }[] = [];
      for (const s of [...streetsOf(cur.here), ...streetsOf(cur.other)]) {
        // not into the river
        if (s.half > ARTERY_HALF + 1) continue;
        const [a, e] = near(s.a, to) ? [s.a, s.b] : near(s.b, to) ? [s.b, s.a] : [null, null];
        if (!a || !e || near(e, from) || wet(e) || opts.some((o) => near(o.end, e))) continue;
        const sl = Math.hypot(e[0] - a[0], e[1] - a[1]);
        const su: Vec2 = [(e[0] - a[0]) / sl, (e[1] - a[1]) / sl];
        if (sl < 25 || su[0] * u[0] + su[1] * u[1] < -0.7) continue;
        opts.push({ s, end: e, u: su, l: sl });
      }
      const next = opts.length ? opts[h32(b.id, c * 16 + hop, leg === "out" ? 31 : 32, this.seed) % opts.length] : null;
      // stopping short of the junction, and turning across it into the next street
      const trim = Math.max(cur.half, next?.s.half ?? 0) + 3;
      pts.push([to[0] - u[0] * trim + rv[0] * lane, to[1] - u[1] * trim + rv[1] * lane]);
      if (!next || total > 520) break;
      cur = next.s;
      from = to;
      to = next.end;
      u = next.u;
      l = next.l;
      lane = laneOf(cur);
      rv = right(u);
      pts.push([from[0] + u[0] * trim + rv[0] * lane, from[1] + u[1] * trim + rv[1] * lane]);
      total += l;
    }
    // corners rounded off, then the road under it every two metres
    let line = pts;
    for (let pass = 0; pass < 3; pass++) {
      const next: Vec2[] = [line[0]];
      for (let k = 0; k + 1 < line.length; k++) {
        const [ax, az] = line[k], [bx, bz] = line[k + 1];
        next.push([ax * 0.75 + bx * 0.25, az * 0.75 + bz * 0.25], [ax * 0.25 + bx * 0.75, az * 0.25 + bz * 0.75]);
      }
      next.push(line[line.length - 1]);
      line = next;
    }
    const out: number[] = [];
    let y = p.y;
    for (let k = 0; k + 1 < line.length; k++) {
      const [ax, az] = line[k], [bx, bz] = line[k + 1];
      const m = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 2));
      for (let i = 0; i < m; i++) {
        const x = ax + ((bx - ax) * i) / m, z = az + ((bz - az) * i) / m;
        if (out.length) y = rideAt(x, z, y + 2) ?? y;
        out.push(x, y, z);
      }
    }
    const [ex, ez] = line[line.length - 1];
    out.push(ex, rideAt(ex, ez, y + 2) ?? y, ez);
    // Eased over a few metres: two streets crossing on a slope cannot both be flat and agree,
    // so a junction can have a step in it, which the traffic eases over as well.
    for (let pass = 0; pass < 4; pass++) {
      const ys = out.filter((_, i) => i % 3 === 1);
      for (let i = 1; i + 1 < ys.length; i++) out[i * 3 + 1] = (ys[i - 1] + 2 * ys[i] + ys[i + 1]) / 4;
    }
    const path = new Path(out);
    // into a dead end before it is out of sight: not this time
    return path.len < gone(PLANS.car.trip - 1.5, 2, 9) + 10 ? null : path;
  }

  /** Where a launch lies on its river: how far along it and how far off the middle. */
  private sail(b: Berth): Sail | null {
    const p = b.p;
    const hit = riverNear(p.x, p.z);
    if (!hit) return null;
    let s = p.z, o = 0;
    for (let k = 0; k < 6; k++) {
      const { p: q, dir } = riverFrame(hit.line, s);
      s += (p.x - q[0]) * dir[0] + (p.z - q[1]) * dir[1];
      o = -(p.x - q[0]) * dir[1] + (p.z - q[1]) * dir[0];
    }
    return { line: hit.line, s0: s, o };
  }

  /**
   * Where a launch is `d` metres along its way out from its mooring, or `d` metres short of it
   * coming back. It goes with the river traffic on its own side of the channel, which for half
   * of them is the way they are not facing: those swing round across the channel first.
   */
  private afloat(m: Sail, leg: "out" | "back", d: number): Vec2 {
    const lane = m.o < 0 ? -RIVER_LANE : RIVER_LANE;
    const sign = leg === "out" ? 1 : -1;
    let s: number, o: number;
    if (m.o < 0) {
      s = m.s0 + sign * d;
      o = m.o + (lane - m.o) * ease(Math.min(1, d / 50));
    } else {
      const r = (m.o - lane) / 2;
      if (d < 6) {
        s = m.s0 + sign * d;
        o = m.o;
      } else if (d < 6 + Math.PI * r) {
        const a = (d - 6) / r;
        s = m.s0 + sign * (6 + r * Math.sin(a));
        o = m.o - r * (1 - Math.cos(a));
      } else {
        s = m.s0 + sign * (6 - (d - 6 - Math.PI * r));
        o = lane;
      }
    }
    const { p, dir } = riverFrame(m.line, s);
    return [p[0] - dir[1] * o, p[1] + dir[0] * o];
  }

  /**
   * Whoever takes a launch out, standing on the afterdeck while it is under way: out of the
   * wheelhouse as it casts off (`k` 0..1) and back into it once it is tied up again (1..2).
   */
  private crew(b: Berth, x: number, y: number, z: number, yaw: number, k: number, c: number): void {
    const f: Vec2 = [Math.sin(yaw), Math.cos(yaw)], r: Vec2 = [-f[1], f[0]];
    const t = k < 1 ? k : 2 - k;
    const lx = 0.3 + 0.4 * t, lz = 0.9 - 3.5 * t;
    const walking = k > 0 && k < 2 && k !== 1;
    const face = walking ? (k < 1 ? yaw + Math.PI : yaw) : yaw + Math.PI * 0.6;
    this.peds.put(x + r[0] * lx + f[0] * lz, y + 0.5, z + r[1] * lx + f[1] * lz, face, walking ? t * 3.5 : NaN, h32(b.id, c, 7, this.seed));
  }

  /** People out on the decks of the boats working the river. */
  private crews(eye: Vec3): void {
    const list = this.traffic.boats, d = list.data;
    for (let i = 0; i < list.count; i++) {
      const o = i * 10, x = d[o], y = d[o + 1], z = d[o + 2], yaw = d[o + 3];
      if (Math.hypot(x - eye[0], z - eye[2]) > 200 || list.keys[i] < 0) continue;
      const key = list.keys[i];
      const f: Vec2 = [Math.sin(yaw), Math.cos(yaw)], r: Vec2 = [-f[1], f[0]];
      const h0 = h32(key % 1e9, Math.floor(key / 1e9), 41, this.seed);
      for (let k = 0; k <= h0 % 3; k++) {
        const h = h32(h0, k, 42, this.seed);
        const lx = (((h & 0xff) / 255) * 2 - 1) * 1.1, lz = -4.2 + ((h >>> 8) & 0xff) / 255 * 4.6;
        // out over the side, or ahead
        const face = yaw + ((h >>> 16) % 3 === 0 ? 0 : lx > 0 ? -Math.PI / 2 : Math.PI / 2) + Math.sin(k * 7 + i) * 0.3;
        this.peds.put(x + r[0] * lx + f[0] * lz, y + 0.5, z + r[1] * lx + f[1] * lz, face, NaN, h);
      }
    }
  }
}
