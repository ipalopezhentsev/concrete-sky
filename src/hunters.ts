// Hunters: figures in dark coats who chase the player through the city. On foot
// they run the decks and follow you over the bridges from block to block; they
// take parked flyers and cars (or a passing one) when you get out of reach, or
// arrive in their own. They shoot. The longer you stay free, the more of them
// come; when they get you, you're back on the last roof you stood on.

import { bridgeOn, CELL, podiumHeight } from "./city/generate";
import { RunPilot, SIDE_STEP, type Ring } from "./demo";
import { BOLT_SPEED, segmentBox, type BoltTargets, type Combat } from "./effects/combat";
import type { Particles } from "./effects/particles";
import type { Vec3 } from "./math";
import { Player, type Colliders } from "./player";
import { Car } from "./vehicles/car";
import { Flyer } from "./vehicles/flyer";
import { footprint, type Parked, type Parking } from "./vehicles/parking";
import { InstanceList, type Traffic } from "./vehicles/traffic";

export const MAX_HEALTH = 100;
const REGEN_DELAY = 5; // seconds without a hit before health comes back
const REGEN = 10; // per second
const MAX_HUNTERS = 5;
const GRACE = 10; // seconds before the first hunter shows up
const COAT: Vec3 = [0.07, 0.07, 0.08];
const BLACK: Vec3 = [0.05, 0.05, 0.06]; // the hunters' own vehicles
const RANGE = { foot: 55, car: 70, flyer: 130 };
const SPREAD = { foot: 0.035, car: 0.05, flyer: 0.022 };
const BURST = { foot: [3, 0.2, 1.5], car: [3, 0.25, 1.8], flyer: [4, 0.12, 1.2] }; // shots, gap, pause
const DAMAGE: Record<Mode, number> = { foot: 7, car: 5, flyer: 5 }; // per bolt, by what you're in
const TOUGHNESS = { foot: 1, car: 3, flyer: 3 };
const LANE_EW = 3.5; // keeps right on a cross street, clear of piers and parked cars
const LANE_NS = 4.25; // between the avenue's traffic lanes

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const turnToward = (from: number, to: number, rate: number, dt: number) =>
  from + clamp(wrap(to - from), -rate * dt, rate * dt);

export type Mode = "foot" | "car" | "flyer";

/** Who is being hunted: the runner, or the vehicle they're in. */
export interface Quarry {
  pos: Vec3; // feet, or the base of the vehicle
  vel: Vec3;
  mode: Mode;
  yaw: number;
  van?: boolean;
}

export interface HuntWorld {
  colliders: Colliders;
  traffic: Traffic;
  parking: Parking;
  combat: Combat;
  particles: Particles;
}

export interface View {
  eye: Vec3;
  fwd: Vec3;
}

export class Hunter {
  readonly body: Player;
  car: Car | null = null;
  flyer: Flyer | null = null;
  hp: number;
  dead = false;
  look = 0; // flyer heading
  orbit = Math.random() * Math.PI * 2;
  orbitDir = Math.random() < 0.5 ? 1 : -1;
  cooldown = 1;
  shots = 0;
  aware = 0; // seconds the quarry has been in sight
  unseen = 0;
  seen = false;
  sightCheck = 0;
  stuck = 0;
  detour = 0;
  detourYaw = 0;
  reverse = 0;
  revSteer = 1;
  ride: Parked | null = null;
  rideCheck = 0;
  pilot: RunPilot | null = null; // over the decks and bridges
  pilotRest = 0;
  plan = 0; // flyer: seconds to the next look at the way ahead
  orbitTo = this.orbit;
  way = { x: 0, z: 0, y: 0, direct: true }; // flyer: where it is heading next
  nearTop = 0; // flyer: tallest thing just ahead
  escape = 0;
  escapeYaw = 0;
  stride = 0;
  speed = 0;
  ram = 0;
  side = 1;

  constructor(pos: Vec3, yaw: number, readonly id: number) {
    this.body = new Player(pos[0], pos[1], pos[2], yaw);
    this.hp = TOUGHNESS.foot;
  }

  get mode(): Mode {
    return this.flyer ? "flyer" : this.car ? "car" : "foot";
  }

  get pos(): Vec3 {
    return this.flyer?.pos ?? this.car?.pos ?? this.body.pos;
  }

  get vel(): Vec3 {
    if (this.flyer) return this.flyer.vel;
    if (this.car) {
      const c = this.car;
      return [Math.sin(c.yaw) * c.speed, c.vy, Math.cos(c.yaw) * c.speed];
    }
    return this.body.vel;
  }

  /** Middle of the body or vehicle (what gets aimed at). */
  get center(): Vec3 {
    const p = this.pos;
    return [p[0], p[1] + (this.flyer ? 0.8 : this.car ? 0.8 : 1.2), p[2]];
  }

  /** Hit box, written into out. */
  box(out: Float32Array): void {
    const [x, y, z] = this.pos;
    if (this.flyer) out.set([x - 2, y - 0.3, z - 2, x + 2, y + 1.9, z + 2]);
    else if (this.car) {
      const f = footprint(this.car.kind, this.car.yaw);
      out.set([x - f.hx, y, z - f.hz, x + f.hx, y + f.h, z + f.hz]);
    } else out.set([x - 0.45, y, z - 0.45, x + 0.45, y + 1.85, z + 0.45]);
  }
}

function boxOf(q: Quarry, out: Float32Array): void {
  const [x, y, z] = q.pos;
  if (q.mode === "flyer") out.set([x - 1.8, y - 0.2, z - 1.8, x + 1.8, y + 1.8, z + 1.8]);
  else if (q.mode === "car") {
    const f = footprint(q.van ? "van" : "car", q.yaw);
    out.set([x - f.hx, y, z - f.hz, x + f.hx, y + f.h, z + f.hz]);
  } else out.set([x - 0.4, y, z - 0.4, x + 0.4, y + 1.8, z + 0.4]);
}

const centerOf = (q: Quarry): Vec3 => [q.pos[0], q.pos[1] + (q.mode === "foot" ? 1.25 : 0.8), q.pos[2]];

export class Hunters implements BoltTargets {
  readonly list: Hunter[] = [];
  /** Figures on foot, by pose: standing, left stride, right stride. */
  readonly figures = [new InstanceList(16), new InstanceList(16), new InstanceList(16)];
  /** Thinking and spawning happen only while this is set (it's off on the title screen and in the demo). */
  active = false;
  /** Bring in new hunters as the pressure builds (tests turn this off). */
  auto = true;
  health = MAX_HEALTH;
  /** 0..1, flashes when you're hit. */
  hurt = 0;
  /** Hits taken so far (for sound). */
  hits = 0;
  kills = 0;
  caught = 0;
  /** Set during the update in which the hunters got you. */
  gotYou = false;
  /** A shove for the runner (from a car), to be applied by the caller. */
  knock: Vec3 | null = null;
  private clock = 0;
  private spawnTimer = GRACE;
  private sinceHit = 99;
  private nextId = 1;
  private quarry: Quarry = { pos: [0, 0, 0], vel: [0, 0, 0], mode: "foot", yaw: 0 };
  private scratch = new Float32Array(6);
  private hops = { key: "", map: new Map<string, number>() };
  private rings = new Map<string, Ring>();
  private tops = new Map<number, number>(); // tallest thing around points on a 3 m grid

  constructor(private w: HuntWorld, private rand = Math.random) {}

  /** How many hunters may be out at once. */
  get pressure(): number {
    return Math.min(MAX_HUNTERS, 2 + Math.floor(this.clock / 45));
  }

  /** Call everyone off (demo, toggled off). */
  clear(): void {
    this.list.length = 0;
    this.health = MAX_HEALTH;
    this.hurt = 0;
    this.clock = 0;
    this.spawnTimer = GRACE;
  }

  /** After they got you: a breather, and the pressure eases off a little. */
  reset(): void {
    this.list.length = 0;
    this.health = MAX_HEALTH;
    this.clock *= 0.5;
    this.spawnTimer = GRACE;
  }

  update(dt: number, q: Quarry, view: View): void {
    this.gotYou = false;
    this.knock = null;
    this.quarry = q;
    if (!this.active) return;
    this.clock += dt;
    this.sinceHit += dt;
    this.hurt = Math.max(0, this.hurt - dt * 1.2);
    if (this.sinceHit > REGEN_DELAY) this.health = Math.min(MAX_HEALTH, this.health + REGEN * dt);

    if (this.auto) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0) {
        this.spawnTimer = 4 + this.rand() * 5;
        if (this.list.length < this.pressure) this.spawn(q, view);
      }
    }

    for (const h of this.list) {
      if (h.dead) continue;
      this.see(h, dt, q);
      if (h.flyer) this.fly(h, dt, q);
      else if (h.car) this.drive(h, dt, q);
      else this.run(h, dt, q);
      if (this.gotYou) break;
    }

    // drop the fallen, and those left far behind
    for (let i = this.list.length - 1; i >= 0; i--) {
      const h = this.list[i];
      const p = h.pos;
      const far = Math.hypot(p[0] - q.pos[0], p[2] - q.pos[2]);
      const hidden = !this.inView(view, h.center);
      const lost = h.unseen > (h.flyer ? 40 : 25) && hidden;
      if (h.dead || far > 420 || p[1] < -5 || lost) this.list.splice(i, 1);
    }
  }

  // --- spawning

  /** Start a hunter on foot at pos (tests, and the spawner). */
  addRunner(pos: Vec3, yaw = 0): Hunter {
    const h = new Hunter(pos, yaw, this.nextId++);
    this.list.push(h);
    return h;
  }

  addFlyer(pos: Vec3, yaw = 0, color: Vec3 = BLACK): Hunter {
    const h = this.addRunner(pos, yaw);
    this.board(h, "flyer", pos, yaw, color);
    h.flyer!.grounded = false;
    return h;
  }

  addCar(pos: Vec3, yaw = 0, color: Vec3 = BLACK, speed = 0): Hunter {
    const h = this.addRunner(pos, yaw);
    this.board(h, "car", pos, yaw, color);
    h.car!.speed = speed;
    return h;
  }

  private board(h: Hunter, kind: "flyer" | "car" | "van", pos: Vec3, yaw: number, color: Vec3): void {
    if (kind === "flyer") {
      h.flyer = new Flyer(pos[0], pos[1], pos[2], yaw, color);
      h.look = yaw;
    } else h.car = new Car(pos[0], pos[1], pos[2], yaw, kind === "van", color);
    h.hp = TOUGHNESS[kind === "flyer" ? "flyer" : "car"];
    h.ride = null;
    h.stuck = h.reverse = 0;
  }

  private spawn(q: Quarry, view: View): void {
    const r = this.rand();
    const street = q.pos[1] < 3;
    const counts = { foot: 0, car: 0, flyer: 0 };
    for (const h of this.list) counts[h.mode]++;
    let order: Mode[];
    if (q.mode === "flyer") order = ["flyer"];
    else if (q.mode === "car") order = r < 0.65 ? ["car", "flyer"] : ["flyer"];
    else if (street) order = r < 0.45 ? ["foot", "car", "flyer"] : r < 0.8 ? ["car", "foot", "flyer"] : ["flyer"];
    else order = r < 0.6 ? ["foot", "flyer"] : ["flyer"];
    // keep the air from filling up when there are other ways to come
    if (order.length > 1 && counts.flyer >= 2) order = order.filter((m) => m !== "flyer");

    for (const mode of order) {
      if (mode === "foot") {
        const p = this.footSpawn(q, view);
        if (p) {
          this.addRunner(p, Math.atan2(q.pos[0] - p[0], q.pos[2] - p[2]));
          return;
        }
      } else if (mode === "car") {
        const s = this.carSpawn(q, view);
        if (s) {
          this.addCar(s.pos, s.yaw, BLACK, 18);
          return;
        }
      } else {
        const s = this.flyerSpawn(q, view);
        const h = this.addFlyer(s.pos, s.yaw);
        h.flyer!.vel = [Math.sin(s.yaw) * 20, 0, Math.cos(s.yaw) * 20];
        return;
      }
    }
  }

  private inView(view: View, p: Vec3): boolean {
    const d: Vec3 = [p[0] - view.eye[0], p[1] - view.eye[1], p[2] - view.eye[2]];
    const len = Math.hypot(...d) || 1;
    return (d[0] * view.fwd[0] + d[1] * view.fwd[1] + d[2] * view.fwd[2]) / len > 0.35;
  }

  /** Feet height of a free standing spot at (x, z) within a metre of level y, or null. */
  private standAt(x: number, z: number, y: number): number | null {
    const boxes = this.w.colliders(x, z);
    const R = 0.6;
    let ground = 0;
    for (let i = 0; i < boxes.length; i += 6) {
      if (boxes[i] < x + R && boxes[i + 3] > x - R && boxes[i + 2] < z + R && boxes[i + 5] > z - R &&
          boxes[i + 4] <= y + 1) ground = Math.max(ground, boxes[i + 4]);
    }
    if (Math.abs(ground - y) > 1) return null;
    for (let i = 0; i < boxes.length; i += 6) {
      if (boxes[i] < x + R && boxes[i + 3] > x - R && boxes[i + 2] < z + R && boxes[i + 5] > z - R &&
          boxes[i + 1] < ground + 2.2 && boxes[i + 4] > ground + 0.05) return null;
    }
    return ground;
  }

  private footSpawn(q: Quarry, view: View): Vec3 | null {
    const back = Math.atan2(-view.fwd[0], -view.fwd[2]);
    for (let tries = 0; tries < 40; tries++) {
      const a = back + (this.rand() - 0.5) * 2.6;
      const d = 22 + this.rand() * 24;
      const x = q.pos[0] + Math.sin(a) * d, z = q.pos[2] + Math.cos(a) * d;
      const y = this.standAt(x, z, q.pos[1]);
      if (y !== null && !this.inView(view, [x, y + 1.2, z])) return [x, y, z];
    }
    return null;
  }

  /** On the cross street nearest the quarry, some way along it, facing them. */
  private carSpawn(q: Quarry, view: View): { pos: Vec3; yaw: number } | null {
    const line = Math.round(q.pos[2] / CELL) * CELL;
    const first = this.rand() < 0.5 ? 1 : -1;
    for (const sgn of [first, -first]) {
      for (const lane of [LANE_EW, -LANE_EW]) {
        const x = q.pos[0] + sgn * (95 + this.rand() * 40);
        const z = line + lane;
        const pos: Vec3 = [x, 0, z];
        if (this.inView(view, [x, 1, z]) && Math.hypot(x - view.eye[0], z - view.eye[2]) < 120) continue;
        const boxes = this.w.colliders(x, z);
        let blocked = false;
        for (let i = 0; i < boxes.length && !blocked; i += 6) {
          blocked = boxes[i] < x + 3 && boxes[i + 3] > x - 3 && boxes[i + 2] < z + 1.3 && boxes[i + 5] > z - 1.3 &&
            boxes[i + 1] < 2.2 && boxes[i + 4] > 0.45;
        }
        if (!blocked) return { pos, yaw: sgn > 0 ? -Math.PI / 2 : Math.PI / 2 };
      }
    }
    return null;
  }

  private flyerSpawn(q: Quarry, view: View): { pos: Vec3; yaw: number } {
    const back = Math.atan2(-view.fwd[0], -view.fwd[2]);
    const a = back + (this.rand() - 0.5) * 2;
    const d = 170 + this.rand() * 60;
    const x = q.pos[0] + Math.sin(a) * d, z = q.pos[2] + Math.cos(a) * d;
    let y = Math.max(q.pos[1] + 20, 45);
    const boxes = this.w.colliders(x, z);
    for (let i = 0; i < boxes.length; i += 6) {
      if (boxes[i] < x + 4 && boxes[i + 3] > x - 4 && boxes[i + 2] < z + 4 && boxes[i + 5] > z - 4) y = Math.max(y, boxes[i + 4] + 8);
    }
    return { pos: [x, y, z], yaw: Math.atan2(q.pos[0] - x, q.pos[2] - z) };
  }

  // --- senses and guns

  /** Is the straight line a -> b free of buildings? */
  private lineClear(a: Vec3, b: Vec3): boolean {
    const boxes = this.w.colliders(a[0], a[2]);
    const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]);
    const y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
    const z0 = Math.min(a[2], b[2]), z1 = Math.max(a[2], b[2]);
    for (let i = 0; i < boxes.length; i += 6) {
      if (boxes[i] > x1 || boxes[i + 3] < x0 || boxes[i + 1] > y1 || boxes[i + 4] < y0 || boxes[i + 2] > z1 || boxes[i + 5] < z0) continue;
      const t = segmentBox(a, b, boxes, i);
      if (t >= 0 && t < 0.97) return false;
    }
    return true;
  }

  private eyeOf(h: Hunter): Vec3 {
    const p = h.pos;
    return [p[0], p[1] + (h.flyer ? 1.2 : h.car ? 1.7 : 1.6), p[2]];
  }

  private see(h: Hunter, dt: number, q: Quarry): void {
    h.sightCheck -= dt;
    if (h.sightCheck <= 0) {
      h.sightCheck = 0.2 + this.rand() * 0.1;
      const eye = this.eyeOf(h), c = centerOf(q);
      const d = Math.hypot(c[0] - eye[0], c[1] - eye[1], c[2] - eye[2]);
      h.seen = d < RANGE[h.mode] * 1.6 && this.lineClear(eye, c);
    }
    if (h.seen) {
      h.aware += dt;
      h.unseen = 0;
    } else {
      h.aware = Math.max(0, h.aware - dt * 2);
      h.unseen += dt;
    }
  }

  /** Fire bursts at the quarry when it's in sight and in range; `facing` is how far off the nose it may be. */
  private shoot(h: Hunter, dt: number, q: Quarry, muzzle: Vec3, facing = true): void {
    h.cooldown -= dt;
    if (h.cooldown > 0 || !h.seen || h.aware < 0.7 || !facing) return;
    const mode = h.mode;
    const c = centerOf(q);
    const dist = Math.hypot(c[0] - muzzle[0], c[1] - muzzle[1], c[2] - muzzle[2]);
    if (dist > RANGE[mode]) return;
    const lead = dist / BOLT_SPEED;
    const spread = SPREAD[mode] * dist;
    const j = () => (this.rand() - 0.5) * 2 * spread;
    const target: Vec3 = [c[0] + q.vel[0] * lead + j(), c[1] + q.vel[1] * lead + j() * 0.6, c[2] + q.vel[2] * lead + j()];
    this.w.combat.shoot(muzzle, target, h.vel, true);
    const [count, gap, pause] = BURST[mode];
    h.shots++;
    if (h.shots >= count) {
      h.shots = 0;
      h.cooldown = pause * (0.8 + this.rand() * 0.6);
    } else h.cooldown = gap;
  }

  private damage(n: number): void {
    if (this.health <= 0) return;
    this.health -= n;
    this.hurt = Math.min(1, this.hurt + n / 20);
    this.sinceHit = 0;
    this.hits++;
    if (this.health <= 0) {
      this.health = 0;
      this.gotYou = true;
      this.caught++;
    }
  }

  // --- on foot

  /** Bridge hops from blocks around the quarry's block to it (breadth-first over the bridges). */
  private hopsTo(ti: number, tj: number): (ci: number, cj: number) => number {
    const key = `${ti},${tj}`;
    if (this.hops.key !== key) {
      const map = new Map<string, number>([[key, 0]]);
      const queue: [number, number][] = [[ti, tj]];
      while (queue.length) {
        const [i, j] = queue.shift()!;
        const d = map.get(`${i},${j}`)!;
        for (let s = 0; s < 4; s++) {
          if (bridgeOn(i, j, s) === null) continue;
          const ni = i + SIDE_STEP[s][0], nj = j + SIDE_STEP[s][1];
          const k = `${ni},${nj}`;
          if (map.has(k) || Math.abs(ni - ti) > 7 || Math.abs(nj - tj) > 7) continue;
          map.set(k, d + 1);
          queue.push([ni, nj]);
        }
      }
      this.hops = { key, map };
    }
    const map = this.hops.map;
    return (ci, cj) => map.get(`${ci},${cj}`) ?? 100 + Math.hypot(ci - ti, cj - tj);
  }

  /** A parked vehicle worth taking to keep up, if there's one close by on our level. */
  private findRide(h: Hunter, q: Quarry): Parked | null {
    const [x, y, z] = h.body.pos;
    const above = q.pos[1] - y;
    const flat = Math.hypot(q.pos[0] - x, q.pos[2] - z);
    const wantFlyer = q.mode === "flyer" || above > 4 || flat > 70;
    const wantCar = y < 1 && q.pos[1] < 3 && (q.mode === "car" || flat > 45);
    if (!wantFlyer && !wantCar) return null;
    let best: Parked | null = null;
    let bestD = 45;
    for (const p of this.w.parking.all()) {
      if (p.wreck || Math.abs(p.y - y) > 1.2) continue;
      if (p.kind === "flyer" ? !wantFlyer && !wantCar : !wantCar) continue;
      const d = Math.hypot(p.x - x, p.z - z) + (p.kind === "flyer" ? 0 : 10);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  private stillParked(p: Parked): boolean {
    for (const o of this.w.parking.all()) if (o === p) return true;
    return false;
  }

  private run(h: Hunter, dt: number, q: Quarry): void {
    const b = h.body;
    const [x, y, z] = b.pos;
    const dx = q.pos[0] - x, dz = q.pos[2] - z;
    const flat = Math.hypot(dx, dz);
    const dy = q.pos[1] - y;

    // rammed by the player's car
    if (q.mode === "car" && Math.hypot(q.vel[0], q.vel[2]) > 5 && flat < 2.6 && Math.abs(dy) < 2) {
      this.kill(h, q.vel);
      return;
    }

    // take a vehicle when the quarry gets out of reach on foot
    h.rideCheck -= dt;
    if (h.rideCheck <= 0) {
      h.rideCheck = 1;
      if (h.ride && !this.stillParked(h.ride)) h.ride = null;
      if (!h.ride) h.ride = this.findRide(h, q);
    }
    if (h.ride) {
      const p = h.ride;
      const f = footprint(p.kind, p.yaw);
      const gap = Math.hypot(Math.max(Math.abs(x - p.x) - f.hx, 0), Math.max(Math.abs(z - p.z) - f.hz, 0));
      if (gap < 1.4) {
        this.w.parking.remove(p);
        this.board(h, p.kind, [p.x, p.y, p.z], p.yaw, p.color);
        return;
      }
    }
    // or pull someone out of a passing car
    if (y < 1 && q.pos[1] < 3 && flat > 30) {
      const moving = this.w.traffic.nearestCar(x, y, z, 2.2);
      if (moving) {
        this.w.traffic.removed.add(moving.key);
        this.board(h, moving.van ? "van" : "car", moving.pos, moving.yaw, moving.color);
        h.car!.speed = Math.hypot(...moving.vel);
        return;
      }
    }

    // on a deck and the quarry is on another block: round the deck and over the bridges
    const ci = Math.floor(x / CELL), cj = Math.floor(z / CELL);
    const ti = Math.floor(q.pos[0] / CELL), tj = Math.floor(q.pos[2] / CELL);
    h.pilotRest -= dt;
    if (!h.pilot && !h.ride && h.pilotRest <= 0 && (ci !== ti || cj !== tj) && Math.abs(y - podiumHeight(ci, cj)) < 0.8) {
      h.pilot = new RunPilot(ci, cj, this.w.colliders, this.rand, this.rings);
      h.pilot.joinAt(x, z);
    }
    if (h.pilot) {
      h.pilot.toward = this.hopsTo(ti, tj);
      const c = h.pilot.steer(b, dt);
      if (h.pilot.done || h.pilot.fell(b) || h.stuck > 2.5 || h.ride) {
        h.pilotRest = h.pilot.done ? 1 : 4;
        h.pilot = null;
        h.stuck = 0;
      } else {
        b.update(dt, { moveX: c.moveX, moveZ: c.moveZ, sprint: true, walk: false, jump: c.up || h.stuck > 0.3 }, this.w.colliders);
        this.stepped(h, dt, true);
        this.shootOnFoot(h, dt, q);
        return;
      }
    }

    let goal: [number, number];
    let move = true;
    if (h.ride) goal = [h.ride.x, h.ride.z];
    else {
      goal = [q.pos[0], q.pos[2]];
      // close enough to shoot from
      if (h.seen && flat < 12 && Math.abs(dy) < 3) move = false;
    }
    let heading = Math.atan2(goal[0] - x, goal[1] - z);
    if (h.detour > 0) {
      h.detour -= dt;
      heading = h.detourYaw;
    }

    // don't run off a ledge unless the quarry is down there
    let edge = false;
    if (move && dy > -3) {
      const px = x + Math.sin(heading) * 1.4, pz = z + Math.cos(heading) * 1.4;
      const boxes = this.w.colliders(px, pz);
      let ground = 0;
      for (let i = 0; i < boxes.length; i += 6) {
        if (boxes[i] < px + 0.3 && boxes[i + 3] > px - 0.3 && boxes[i + 2] < pz + 0.3 && boxes[i + 5] > pz - 0.3 &&
            boxes[i + 4] <= y + 2.5) ground = Math.max(ground, boxes[i + 4]);
      }
      if (ground < y - 2.5) {
        move = false;
        edge = true;
        h.stuck += dt * 3;
      }
    }

    if (h.stuck > 0.9 && h.detour <= 0) {
      h.stuck = 0;
      h.detour = 1 + this.rand();
      const side = this.rand() < 0.5 ? 1 : -1;
      h.detourYaw = Math.atan2(goal[0] - x, goal[1] - z) + side * (1.1 + this.rand() * 0.9);
    }

    // face where we're going; turn to the quarry to shoot
    const face = move ? heading : Math.atan2(dx, dz);
    b.yaw = turnToward(b.yaw, face, 7, dt);
    const s = Math.sin(b.yaw), c = Math.cos(b.yaw);
    const wx = Math.sin(heading), wz = Math.cos(heading);
    b.update(dt, {
      moveX: move ? -wx * c + wz * s : 0,
      moveZ: move ? wx * s + wz * c : 0,
      sprint: flat > 14 || !!h.ride,
      walk: false,
      jump: move && h.stuck > 0.3,
    }, this.w.colliders);
    this.stepped(h, dt, move || edge);
    this.shootOnFoot(h, dt, q);
  }

  /** After a step on foot: stuck tracking and the stride. */
  private stepped(h: Hunter, dt: number, moving: boolean): void {
    const v = h.body.vel;
    h.speed = Math.hypot(v[0], v[2]);
    if (moving && h.speed < 1.2) h.stuck += dt;
    else h.stuck = Math.max(0, h.stuck - dt * 2);
    h.stride += dt * (h.speed * 1.25 + 1);
  }

  /** The gun is held in the right hand, so only fire at what's roughly ahead. */
  private shootOnFoot(h: Hunter, dt: number, q: Quarry): void {
    const b = h.body;
    const s = Math.sin(b.yaw), c = Math.cos(b.yaw);
    const aimOff = Math.abs(wrap(Math.atan2(q.pos[0] - b.pos[0], q.pos[2] - b.pos[2]) - b.yaw));
    const muzzle: Vec3 = [b.pos[0] + s * 0.75 - c * 0.33, b.pos[1] + 1.32, b.pos[2] + c * 0.75 + s * 0.33];
    this.shoot(h, dt, q, muzzle, aimOff < 0.5);
  }

  // --- driving

  private drive(h: Hunter, dt: number, q: Quarry): void {
    const car = h.car!;
    const [x, , z] = car.pos;
    const flat = Math.hypot(q.pos[0] - x, q.pos[2] - z);
    const onStreet = q.pos[1] < 3;

    // where to go: the quarry, or the street spot nearest them
    let gx = q.pos[0], gz = q.pos[2];
    const lx = Math.round(gx / CELL) * CELL, lz = Math.round(gz / CELL) * CELL;
    if (Math.abs(gx - lx) > 7 && Math.abs(gz - lz) > 7) {
      if (Math.abs(gx - lx) < Math.abs(gz - lz)) gx = lx + clamp(gx - lx, -5, 5);
      else gz = lz + clamp(gz - lz, -5, 5);
    }

    // along the street grid: cross street or avenue to the goal's, then along it
    const ax = Math.round(x / CELL) * CELL, az = Math.round(z / CELL) * CELL;
    const onNS = Math.abs(x - ax) < 8, onEW = Math.abs(z - az) < 8;
    const gax = Math.round(gx / CELL) * CELL, gaz = Math.round(gz / CELL) * CELL;
    let wx = gx, wz = gz;
    let direct = false;
    if (onEW && Math.abs(gz - az) < 8) direct = true;
    else if (onNS && Math.abs(gx - ax) < 8) direct = true;
    else if (onNS && ax === gax) [wx, wz] = [ax, gaz];
    else if (onEW) [wx, wz] = [gax, az];
    else if (onNS) [wx, wz] = [ax, gaz];
    else direct = true;
    const toWay = Math.hypot(wx - x, wz - z);
    if (!direct || toWay > 25) {
      // follow a lane toward the waypoint (keeping right) until it's close
      if (onEW && Math.abs(wx - x) > 10 && (!onNS || Math.abs(wz - z) < 8)) {
        const dir = Math.sign(wx - x);
        wz = az + dir * LANE_EW;
        wx = x + dir * Math.min(20, Math.abs(wx - x));
      } else if (onNS && Math.abs(wz - z) > 10) {
        const dir = Math.sign(wz - z);
        wx = ax - dir * LANE_NS;
        wz = z + dir * Math.min(20, Math.abs(wz - z));
      }
    }

    const heading = Math.atan2(wx - x, wz - z);
    let steer = clamp(-wrap(heading - car.yaw) * 2.2, -1, 1);
    const ramming = q.mode !== "flyer" && onStreet && flat < 45;
    let throttle = 1;
    if (!ramming && direct && flat < 30) throttle = clamp((flat - 14) / 10, -1, 1);
    if (Math.abs(wrap(heading - car.yaw)) > 2.4 && Math.abs(car.speed) < 6) {
      // it's behind us: back round
      throttle = -1;
      steer = -steer;
    }
    if (h.reverse > 0) {
      h.reverse -= dt;
      throttle = -1;
      steer = h.revSteer;
    } else if (throttle > 0 && Math.abs(car.speed) < 1.5) {
      h.stuck += dt;
      if (h.stuck > 1) {
        h.stuck = 0;
        h.reverse = 1.1 + this.rand() * 0.5;
        h.revSteer = -Math.sign(steer) || 1;
      }
    } else h.stuck = 0;

    // other hunters' cars and the player's are solid
    const obstacles: number[] = [];
    for (const o of this.list) {
      if (o === h || !o.car || o.dead) continue;
      o.box(this.scratch);
      obstacles.push(...this.scratch);
    }
    if (q.mode === "car") {
      boxOf(q, this.scratch);
      obstacles.push(...this.scratch);
    }
    const boost = flat > 90 && Math.abs(wrap(heading - car.yaw)) < 0.3;
    car.update(dt, { throttle, steer, handbrake: false, boost }, this.w.colliders, Float32Array.from(obstacles));

    // traffic gets shoved off the road
    const f = footprint(car.kind, car.yaw);
    for (const hit of this.w.traffic.carsTouching(car.pos[0] - f.hx, car.pos[2] - f.hz, car.pos[0] + f.hx, car.pos[2] + f.hz, car.pos[1] + 1)) {
      if (Math.abs(car.speed) < 4) {
        h.stuck += dt;
        continue;
      }
      this.w.traffic.removed.add(hit.key);
      this.w.combat.wreckCar(hit.pos, hit.yaw, hit.van, hit.color, hit.vel, false);
      car.speed *= 0.6;
    }

    // running the quarry down
    h.ram -= dt;
    if (h.ram <= 0 && Math.abs(car.speed) > 4) {
      boxOf(q, this.scratch);
      const s = this.scratch;
      const hitCar = q.mode === "car" && car.impact > 5 && flat < 6.5;
      const hitRunner = q.mode === "foot" && s[0] < car.pos[0] + f.hx + 0.3 && s[3] > car.pos[0] - f.hx - 0.3 &&
        s[2] < car.pos[2] + f.hz + 0.3 && s[5] > car.pos[2] - f.hz - 0.3 && s[1] < car.pos[1] + f.h && s[4] > car.pos[1];
      if (hitCar || hitRunner) {
        h.ram = 1.2;
        const v = Math.abs(car.speed);
        this.damage(hitRunner ? 18 + v * 1.2 : v * 0.7);
        if (hitRunner) {
          const push = Math.sign(car.speed) * (6 + v * 0.4);
          this.knock = [Math.sin(car.yaw) * push, 5, Math.cos(car.yaw) * push];
          car.speed *= 0.7;
        }
      }
    }

    // shooting out of the window
    const c = Math.cos(car.yaw), sn = Math.sin(car.yaw);
    const muzzle: Vec3 = [car.pos[0] - c * 0.9, car.pos[1] + (car.van ? 2.3 : 1.7), car.pos[2] + sn * 0.9];
    this.shoot(h, dt, q, muzzle, !ramming || flat > 25);
  }

  // --- flying

  /** Highest box top within 3 m of (x, z), ground being 0 (on a 3 m grid, remembered). */
  private columnTop(x: number, z: number): number {
    const gx = Math.round(x / 3), gz = Math.round(z / 3);
    const key = gx * 100003 + gz;
    let top = this.tops.get(key);
    if (top !== undefined) return top;
    const cx = gx * 3, cz = gz * 3, r = 4.5;
    const boxes = this.w.colliders(cx, cz);
    top = 0;
    for (let i = 0; i < boxes.length; i += 6) {
      if (boxes[i + 4] > top && boxes[i] < cx + r && boxes[i + 3] > cx - r && boxes[i + 2] < cz + r && boxes[i + 5] > cz - r) top = boxes[i + 4];
    }
    if (this.tops.size > 60000) this.tops.clear();
    this.tops.set(key, top);
    return top;
  }

  /** Highest box top along the ground track from (ax, az) toward (bx, bz), looking at most `reach` metres along it. */
  private trackTop(ax: number, az: number, bx: number, bz: number, reach: number): number {
    const len = Math.hypot(bx - ax, bz - az) || 1;
    const span = Math.min(len, reach);
    let top = this.columnTop(ax, az);
    for (let d = 3; d < span + 3; d += 3) {
      const t = Math.min(d, span) / len;
      top = Math.max(top, this.columnTop(ax + (bx - ax) * t, az + (bz - az) * t));
    }
    return top;
  }

  /**
   * Where a flyer heads next for a goal at (gx, gy, gz): straight there when the way is
   * short or low, otherwise along the street canyons, above the bridges and below the towers.
   */
  private flyWay(x: number, z: number, gx: number, gz: number, gy: number): { x: number; z: number; y: number; direct: boolean } {
    const len = Math.hypot(gx - x, gz - z);
    const over = this.trackTop(x, z, gx, gz, 400);
    if (len < 60 || over < 55) return { x: gx, z: gz, y: Math.max(gy, over + 6), direct: true };
    const street = Math.max(gy, 42);
    const ax = Math.round(x / CELL) * CELL, az = Math.round(z / CELL) * CELL;
    const onNS = Math.abs(x - ax) < 6, onEW = Math.abs(z - az) < 6;
    const ahead = (from: number, to: number) => from + clamp(to - from, -45, 45);
    let wx: number, wz: number;
    if (onNS && (!onEW || Math.abs(gz - z) > Math.abs(gx - x))) [wx, wz] = [ax, ahead(z, Math.round(gz / CELL) * CELL)];
    else if (onEW) [wx, wz] = [ahead(x, Math.round(gx / CELL) * CELL), az];
    else if (Math.abs(x - ax) < Math.abs(z - az)) [wx, wz] = [ax, z]; // out to the nearest street
    else [wx, wz] = [x, az];
    return { x: wx, z: wz, y: Math.max(street, this.trackTop(x, z, wx, wz, 60) + 6), direct: false };
  }

  private fly(h: Hunter, dt: number, q: Quarry): void {
    const f = h.flyer!;
    const c = centerOf(q);
    const flat = Math.hypot(c[0] - f.pos[0], c[2] - f.pos[2]);

    // circle the quarry at a standoff, above a runner, level with a flyer
    const R = q.mode === "flyer" ? 34 : 26;
    const H = q.mode === "flyer" ? 2 : q.mode === "car" ? 12 : 15;
    const gy = c[1] + H;
    h.orbit += dt * 0.3 * h.orbitDir;
    const spot = (a: number): [number, number] => [c[0] + Math.sin(a) * R, c[2] + Math.cos(a) * R];
    const hv = Math.hypot(f.vel[0], f.vel[2]);
    h.plan -= dt;
    if (h.plan <= 0) {
      h.plan = 0.3 + this.rand() * 0.1;
      if (flat < 120) {
        // an open spot on the circle with a view of the quarry, preferring one we can get to without going over a building
        let best = Infinity;
        for (let k = 0; k < 12; k++) {
          const a = h.orbit + k * (Math.PI / 6);
          const [x, z] = spot(a);
          if (this.columnTop(x, z) > gy - 3) continue;
          const cost = Math.hypot(x - f.pos[0], z - f.pos[2]) + (this.trackTop(f.pos[0], f.pos[2], x, z, 80) > gy - 3 ? 150 : 0) +
            (this.lineClear([x, gy + 1, z], c) ? 0 : 80);
          if (cost < best) [best, h.orbitTo] = [cost, a];
        }
      } else h.orbitTo = h.orbit;
      h.orbit += wrap(h.orbitTo - h.orbit) * 0.5;
      const [sx, sz] = spot(h.orbit);
      h.way = this.flyWay(f.pos[0], f.pos[2], sx, sz, gy);
      h.nearTop = this.trackTop(f.pos[0], f.pos[2], h.way.x, h.way.z, 12 + hv * 1.5);
    }
    // on the last leg, follow the spot as it moves round
    const [wx, wz] = h.way.direct ? spot(h.orbit) : [h.way.x, h.way.z];
    const tx = wx - f.pos[0], tz = wz - f.pos[2];
    const len = Math.hypot(tx, tz) || 1;

    // face the quarry once near, otherwise the way we're going
    const faceYaw = flat < 160 ? Math.atan2(c[0] - f.pos[0], c[2] - f.pos[2]) : Math.atan2(tx, tz);
    h.look = turnToward(h.look, faceYaw, 2.2, dt);
    let heading = Math.atan2(tx, tz);
    // something just ahead is taller than us: rise first, creeping on
    const rising = f.pos[1] < h.nearTop + 2.5;
    let urge = clamp(len / 14, 0, 1) * (rising ? 0.12 : 1);
    let up = clamp((Math.max(h.way.y, rising ? h.nearTop + 5 : 0) - f.pos[1]) / 5, -1, 1);

    // held down by an overhang: back out and come round another way
    if (h.escape > 0) {
      h.escape -= dt;
      heading = h.escapeYaw;
      urge = 1;
      up = 0;
    } else {
      if (up > 0.5 && f.vel[1] < 1) h.stuck += dt;
      else h.stuck = Math.max(0, h.stuck - dt);
      if (h.stuck > 0.6) {
        h.stuck = 0;
        h.escape = 1 + this.rand();
        h.escapeYaw = heading + Math.PI + (this.rand() - 0.5) * 2;
      }
    }

    // speed along the heading, in the frame the craft is facing
    const rel = heading - h.look;
    const moveZ = Math.cos(rel) * urge, moveX = -Math.sin(rel) * urge;
    f.update(dt, { moveX, moveZ, up, boost: len > 80 && !rising && h.escape <= 0 }, h.look, 0, this.w.colliders);

    const muzzle: Vec3 = [
      f.pos[0] + Math.sin(f.yaw) * 2 - Math.cos(f.yaw) * 1.2 * h.side,
      f.pos[1] + 0.9,
      f.pos[2] + Math.cos(f.yaw) * 2 + Math.sin(f.yaw) * 1.2 * h.side,
    ];
    const before = h.shots;
    this.shoot(h, dt, q, muzzle, Math.abs(wrap(faceYaw - f.yaw)) < 0.3);
    if (h.shots !== before) h.side = -h.side;
  }

  // --- being shot

  private kill(h: Hunter, vel: Vec3): void {
    h.dead = true;
    this.kills++;
    const p = h.pos;
    const { combat, particles } = this.w;
    if (h.flyer) combat.wreckFlyer(p, h.flyer.vel, h.flyer.yaw, h.flyer.color, false);
    else if (h.car) combat.wreckCar(p, h.car.yaw, h.car.van, h.car.color, h.vel, false);
    else {
      const c = h.center;
      particles.explosion(c, [vel[0] * 0.1, 1, vel[2] * 0.1], 0.25);
      particles.sparks(c, 40);
      combat.events.hits.push(c);
    }
  }

  hunterAlong(a: Vec3, b: Vec3): boolean {
    let best: Hunter | null = null;
    let bestT = Infinity;
    for (const h of this.list) {
      if (h.dead) continue;
      const p = h.pos;
      if (Math.min(Math.abs(p[0] - a[0]), Math.abs(p[0] - b[0])) > 12 && Math.abs(p[0] - (a[0] + b[0]) / 2) > 12) continue;
      h.box(this.scratch);
      const t = segmentBox(a, b, this.scratch, 0);
      if (t >= 0 && t < bestT) {
        bestT = t;
        best = h;
      }
    }
    if (!best) return false;
    const e: Vec3 = [a[0] + (b[0] - a[0]) * bestT, a[1] + (b[1] - a[1]) * bestT, a[2] + (b[2] - a[2]) * bestT];
    if (--best.hp <= 0) this.kill(best, [(b[0] - a[0]) * 10, 0, (b[2] - a[2]) * 10]);
    else {
      this.w.particles.sparks(e, 16);
      best.aware = Math.max(best.aware, 1);
    }
    return true;
  }

  playerAlong(a: Vec3, b: Vec3): boolean {
    const q = this.quarry;
    if (!this.active || this.health <= 0) return false;
    boxOf(q, this.scratch);
    if (segmentBox(a, b, this.scratch, 0) < 0) return false;
    this.damage(DAMAGE[q.mode]);
    return true;
  }

  // --- drawing

  draw(flyers: InstanceList, cars: InstanceList, vans: InstanceList): void {
    for (const f of this.figures) f.clear();
    for (const h of this.list) {
      if (h.dead) continue;
      if (h.flyer) {
        const f = h.flyer;
        flyers.push(f.pos[0], f.pos[1], f.pos[2], f.yaw, f.pitch, f.roll, f.color, 1);
      } else if (h.car) {
        const c = h.car;
        (c.van ? vans : cars).push(c.pos[0], c.pos[1], c.pos[2], c.yaw, c.pitch, c.roll, c.color, 1);
      } else {
        const b = h.body;
        const phase = Math.sin(h.stride);
        const pose = h.speed < 0.6 ? 0 : phase > 0 ? 1 : 2;
        const bob = h.speed < 0.6 ? 0 : Math.abs(Math.cos(h.stride)) * 0.05;
        const lean = Math.min(0.18, h.speed * 0.013);
        this.figures[pose].push(b.pos[0], b.pos[1] + bob, b.pos[2], b.yaw, lean, 0, COAT, 1);
      }
    }
  }

  /** Collision boxes of the hunters' cars (for the player's car). */
  carBoxes(): Float32Array {
    const out: number[] = [];
    for (const h of this.list) {
      if (!h.car || h.dead) continue;
      h.box(this.scratch);
      out.push(...this.scratch);
    }
    return Float32Array.from(out);
  }
}
