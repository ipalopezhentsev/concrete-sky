// A drivable car: arcade handling, box collision, kerb stepping, and knocks between cars.

import type { Vec3 } from "../math";
import { FLOOR, type Colliders } from "../player";
import { exitSpot } from "./exit";
import { CAR_DIMS } from "./models";

export interface DriveInput {
  throttle: number; // -1..1 (S brakes, then reverses)
  steer: number; // -1..1, +1 turns right
  handbrake: boolean;
  boost: boolean;
}

/**
 * The carriageway laid over a point at or below `below`, or null where there is none.
 *
 * Collision cannot answer this, and that is the whole reason it is asked separately. A stretch
 * of street is one tilted slab, but collision only speaks in axis-aligned boxes — so the slab is
 * handed over as a staircase of treads, each given the highest corner the plane reaches anywhere
 * inside it, because collision may never report less solid than there is. On a carriageway that
 * runs across the axes down a flank those treads stand up to a metre proud of their own asphalt,
 * and the land beside the road, cut to sit just under it, stands proud of it too. A car reading
 * its height off that drove up a kerb the length of every street and stopped dead at the joint
 * wherever the next stretch's treads stood lower — which is a road that cannot be driven.
 *
 * So the car rides the plane the asphalt is drawn from, which is the same one the traffic has
 * always driven on (see `rideAt` in city/plan.ts), and reads collision for the things standing
 * on the road rather than for the road itself. `below` keeps the answer to the road *under* the
 * car: a flyover twenty metres up is something to drive beneath, not a surface to be lifted onto.
 */
export type RoadSurface = (x: number, z: number, below: number) => number | null;

/**
 * What still counts as the road rather than as something standing on it: a box whose top is
 * within SLACK of the asphalt and whose underside reaches DEEP below it.
 *
 * Both halves are needed. Height alone is not enough to tell a tread from a parked car, which
 * is only a metre and a half tall — take everything under two metres for road and the street
 * furniture goes soft. But the surface a car might be driving on is always *land*: a ground
 * tile sixteen metres deep, a carriageway six, a bridge bay two. Anything that is on the road
 * instead of being the road sits on top of it and has no depth under it at all.
 *
 * The slack has to be this generous because of how the treads are cut. A ground tile is five
 * metres square and gets the highest corner of its own plane, and a tile under a street that
 * runs across the axes down the steepest flank the city can grow reaches a metre and a half up
 * the road over its own width. That is the tile the car used to stop dead against.
 */
const ROAD_SLACK = 2.0;
const ROAD_DEEP = 1.2;

/**
 * How high a step the car will climb rather than stop at, off a road and on one.
 *
 * A kerb is a kerb wherever the street is level, and on a flank it is whatever the pavement
 * beside it has climbed to — better than half a metre where the ground is steepest, and the
 * same again for the bottom step of a flight up to a podium standing at the kerb. All of it is
 * ankle height to a car and none of it should stop one dead, so on a road the car mounts it and
 * rides over it. Off the road the old kerb's worth is all it gets: a car has no business
 * climbing the city by the steps.
 *
 * The road's allowance is measured from the asphalt and not from wherever the car has got to,
 * which is what keeps it from being a ladder: measured from the car, every step it took raised
 * the next one it was allowed, and a car that touched the bank at the kerb walked up the
 * hillside a step a frame.
 */
const STEP = 0.4;
const ROAD_STEP = 0.6;

/** The steepest fall, per metre travelled, a car keeps its wheels on rather than leaving. */
const STICK = 0.35;

/** The road under the car this frame, and the bands it sets on what collision says. */
interface Road {
  y: number; // the asphalt
  reach: number; // the highest thing the car will climb onto from it
  ceiling: number; // tops at or under this may be the road described in boxes
  floor: number; // ... but only if their undersides reach at least this far below it
}

/**
 * Whether the car, a rectangle of half-length `hl` and half-width `hw` centred on (x, z) and
 * pointing along (fx, fz), overlaps box `i` seen from above.
 *
 * The car as it is, turned. It used to be the square-on box round the turned car, which is the
 * car itself only when it points along an axis — true of every street in the grid city, and of
 * almost none in this one. Going the diagonal, that box is a metre and a half wider than the car
 * on either side, and the car stopped dead against kerbs, walls and parked cars it could be
 * seen to be well clear of.
 */
function touches(boxes: Float32Array, i: number, x: number, z: number, fx: number, fz: number, hl: number, hw: number): boolean {
  const ex = (boxes[i + 3] - boxes[i]) / 2, ez = (boxes[i + 5] - boxes[i + 2]) / 2;
  const dx = boxes[i] + ex - x, dz = boxes[i + 2] + ez - z;
  const ax = Math.abs(fx), az = Math.abs(fz);
  // the four axes that can part them: the world's two and the car's two
  if (Math.abs(dx) >= ex + ax * hl + az * hw) return false;
  if (Math.abs(dz) >= ez + az * hl + ax * hw) return false;
  if (Math.abs(dx * fx + dz * fz) >= hl + ex * ax + ez * az) return false;
  return Math.abs(dx * fz - dz * fx) < hw + ex * az + ez * ax;
}

/** Whether box `i` is the road itself rather than something standing on it. */
function isRoad(boxes: Float32Array, i: number, road: Road | null): boolean {
  return road !== null && boxes[i + 4] <= road.ceiling && boxes[i + 1] < road.floor;
}

const MAX_SPEED = 34;
const BOOST_SPEED = 50;
const REVERSE_SPEED = 9;
const ACCEL = 11;
const BRAKE = 24;
const WHEELBASE = 2.7;
const GRAVITY = 20;

/** How hard, in m/s², tyres hold against sliding sideways, and in rad/s² against a spin. */
const GRIP = 9;
const SPIN_GRIP = 4;
/** The share of the closing speed two cars part with; a car is not a billiard ball. */
const RESTITUTION = 0.25;
/** ... and what a wall hands back of the speed driven into it. */
const WALL_BOUNCE = 0.15;
/** A knock harder than this, in m/s, takes the wheels off the ground. */
const LIFT_FROM = 8;

/** Turns `v` toward zero by at most `by`, without passing it. */
const ease0 = (v: number, by: number) => v - Math.sign(v) * Math.min(Math.abs(v), by);

/**
 * A car: driven by someone, or not.
 *
 * Its velocity is its own and not only the way it points. `speed` is the part along its
 * length, which the engine and brakes work on, and `slip` the part across it, which the tyres
 * scrub away; a knock adds to both, and to `spin`. That is what lets one car be hit by another
 * and go somewhere other than straight ahead, and what lets a car that meets a wall at an angle
 * slide along it rather than stop dead against it.
 */
export class Car {
  pos: Vec3;
  yaw: number;
  speed = 0; // along the car's forward axis
  /** Across the car, along (cos yaw, -sin yaw): which way the nose goes as yaw grows. */
  slip = 0;
  /** Yaw rate from being knocked, on top of what the steering gives. */
  spin = 0;
  vy = 0;
  steer = 0;
  pitch = 0;
  roll = 0;
  /** Roll about its length from being knocked into the air; π is on its roof. */
  tumble = 0;
  tumbleRate = 0;
  /** Whether a hard enough knock can roll it (the one the player drives stays on its wheels). */
  tumbles = true;
  /** Landed on its roof, and stays there. */
  flipped = false;
  /** Burnt out (a wreck shoved along the street). */
  wreck = false;
  /** Relative to a car's; a van is heavier, and the player's car counts as heavier still. */
  mass: number;
  grounded = true;
  impact = 0; // strength of a collision this frame (for sound)
  /** Where the hardest knock this frame landed. */
  contact: Vec3 | null = null;
  /** Called once, the first time it is touched (a car in traffic or at the kerb coming loose). */
  onHit: (() => void) | null = null;
  readonly van: boolean;
  readonly color: Vec3;

  constructor(x: number, y: number, z: number, yaw: number, van: boolean, color: Vec3) {
    this.pos = [x, y, z];
    this.yaw = yaw;
    this.van = van;
    this.color = color;
    this.mass = van ? 1.6 : 1;
  }

  get kind(): "car" | "van" {
    return this.van ? "van" : "car";
  }

  get speedNorm(): number {
    return Math.hypot(this.speed, this.slip) / BOOST_SPEED;
  }

  /** Horizontal velocity in the world. */
  velocity(): [number, number] {
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    return [fx * this.speed + fz * this.slip, fz * this.speed - fx * this.slip];
  }

  setVelocity(vx: number, vz: number): void {
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    this.speed = vx * fx + vz * fz;
    this.slip = vx * fz - vz * fx;
  }

  /** Roll to draw it at, and how far to lift it so that it turns about its middle and not its base. */
  get bodyRoll(): number {
    return this.roll + this.tumble;
  }

  get bodyLift(): number {
    const h = CAR_DIMS[this.kind].h;
    return (1 - Math.cos(this.tumble)) * 0.5 * h + Math.abs(Math.sin(this.tumble)) * 0.9;
  }

  /**
   * A knock: momentum `j` (in car-masses times m/s) delivered at the point (cx, cz).
   *
   * Off-centre it turns the car as well as moving it, which is what spins a car hit at the
   * back. Hard enough and it leaves the ground, rolling if the knock came from the side.
   */
  push(jx: number, jz: number, cx: number, cz: number): void {
    const m = this.mass, [vx, vz] = this.velocity();
    const dvx = jx / m, dvz = jz / m;
    this.setVelocity(vx + dvx, vz + dvz);
    const d = CAR_DIMS[this.kind];
    const inertia = (m * (4 * d.hz * d.hz + 4 * d.hx * d.hx)) / 12;
    const rx = cx - this.pos[0], rz = cz - this.pos[2];
    this.spin = Math.max(-5, Math.min(5, this.spin + (rz * jx - rx * jz) / inertia));
    const knock = Math.hypot(dvx, dvz);
    if (knock > LIFT_FROM) {
      this.vy = Math.max(this.vy, Math.min(7, (knock - LIFT_FROM) * 0.3));
      this.grounded = false;
      if (this.tumbles) {
        const across = dvx * Math.cos(this.yaw) - dvz * Math.sin(this.yaw);
        this.tumbleRate = Math.max(-8, Math.min(8, this.tumbleRate + across * 0.25));
      }
    }
  }

  /** The road under the car, if it is on one, and the bands it sets on what collision says. */
  private roadUnder(surface: RoadSurface | undefined): Road | null {
    const under = surface?.(this.pos[0], this.pos[2], this.pos[1] + STEP) ?? null;
    return under === null ? null
      : { y: under, reach: under + ROAD_STEP, ceiling: under + ROAD_SLACK, floor: under - ROAD_DEEP };
  }

  /**
   * Moves the car aside by (dx, dz) if that does not put it into anything fixed; false if it
   * cannot go. A car already wedged into something is let go anyway: it is stuck either way,
   * and refusing it would make it a wall for whatever is pushing it.
   */
  shift(dx: number, dz: number, colliders: Colliders, surface?: RoadSurface): boolean {
    const road = this.roadUnder(surface);
    const reach = road ? road.reach : this.pos[1] + STEP;
    const boxes = colliders(this.pos[0], this.pos[2]);
    const [x, y, z] = this.pos;
    if (this.overlapping(boxes, x + dx, y, z + dz, this.yaw, road, reach) >= 0 &&
        this.overlapping(boxes, x, y, z, this.yaw, road, reach) < 0) return false;
    this.pos[0] += dx;
    this.pos[2] += dz;
    return true;
  }

  /** The point of this car's footprint nearest (x, z). */
  private nearest(x: number, z: number): [number, number] {
    const d = CAR_DIMS[this.kind], fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const ox = x - this.pos[0], oz = z - this.pos[2];
    const along = Math.max(-d.hz, Math.min(d.hz, ox * fx + oz * fz));
    const across = Math.max(-d.hx, Math.min(d.hx, ox * fz - oz * fx));
    return [this.pos[0] + fx * along + fz * across, this.pos[2] + fz * along - fx * across];
  }

  /**
   * Meets car `b`, if the two overlap: they trade momentum along the side they met at, and `b`
   * is moved out of the way. False if `b` cannot be moved (it is up against a wall), in which
   * case this car has to stay where it was.
   */
  collide(b: Car, colliders: Colliders, surface?: RoadSurface): boolean {
    const da = CAR_DIMS[this.kind], db = CAR_DIMS[b.kind];
    if (this.pos[1] >= b.pos[1] + db.h || b.pos[1] >= this.pos[1] + da.h) return true;
    const dx = b.pos[0] - this.pos[0], dz = b.pos[2] - this.pos[2];
    if (Math.abs(dx) > 8 || Math.abs(dz) > 8) return true;
    const afx = Math.sin(this.yaw), afz = Math.cos(this.yaw), bfx = Math.sin(b.yaw), bfz = Math.cos(b.yaw);
    // the four axes that can part two rectangles: each one's length and width
    let depth = Infinity, nx = 0, nz = 0;
    for (const [ux, uz] of [[afx, afz], [afz, -afx], [bfx, bfz], [bfz, -bfx]]) {
      const ra = da.hz * Math.abs(afx * ux + afz * uz) + da.hx * Math.abs(afz * ux - afx * uz);
      const rb = db.hz * Math.abs(bfx * ux + bfz * uz) + db.hx * Math.abs(bfz * ux - bfx * uz);
      const dist = dx * ux + dz * uz;
      const over = ra + rb - Math.abs(dist);
      if (over <= 0) return true;
      if (over < depth) {
        depth = over;
        nx = dist < 0 ? -ux : ux;
        nz = dist < 0 ? -uz : uz;
      }
    }
    this.onHit?.();
    b.onHit?.();
    this.onHit = b.onHit = null;
    // where they met: each one's middle pulled into the other's footprint, and the two halved
    const [pax, paz] = b.nearest(this.pos[0], this.pos[2]), [pbx, pbz] = this.nearest(b.pos[0], b.pos[2]);
    const cx = (pax + pbx) / 2, cz = (paz + pbz) / 2;
    const [avx, avz] = this.velocity(), [bvx, bvz] = b.velocity();
    const closing = (avx - bvx) * nx + (avz - bvz) * nz;
    if (closing > 0) {
      const j = ((1 + RESTITUTION) * closing) / (1 / this.mass + 1 / b.mass);
      this.push(-j * nx, -j * nz, cx, cz);
      b.push(j * nx, j * nz, cx, cz);
      const at: Vec3 = [cx, Math.max(this.pos[1], b.pos[1]) + 0.6, cz];
      if (closing > this.impact) [this.impact, this.contact] = [closing, at];
      if (closing > b.impact) [b.impact, b.contact] = [closing, at];
    }
    return b.shift(nx * (depth + 0.01), nz * (depth + 0.01), colliders, surface);
  }

  /**
   * Index of a box in the way here, or -1. A box that is only the road described in boxes is
   * never in the way: the car is already on that surface, whatever collision makes of it.
   */
  private overlapping(
    boxes: Float32Array, x: number, y: number, z: number, yaw: number, road: Road | null, reach: number,
  ): number {
    const d = CAR_DIMS[this.kind], fx = Math.sin(yaw), fz = Math.cos(yaw);
    let top = -1;
    for (let i = 0; i < boxes.length; i += 6) {
      if (boxes[i + 1] < y + d.h && boxes[i + 4] > reach && !isRoad(boxes, i, road) &&
          touches(boxes, i, x, z, fx, fz, d.hz, d.hx)) top = Math.max(top, i);
    }
    return top; // index of a blocking box, or -1
  }

  /**
   * One frame. `obstacles` are boxes that do not give way; `bodies` are other cars, which do —
   * they are knocked aside rather than stopped at.
   */
  update(
    dt: number, input: DriveInput, colliders: Colliders, obstacles?: Float32Array, surface?: RoadSurface, bodies?: readonly Car[],
  ): void {
    this.impact = 0;
    this.contact = null;
    const world = colliders(this.pos[0], this.pos[2]);
    let boxes = world;
    if (obstacles && obstacles.length) {
      boxes = new Float32Array(world.length + obstacles.length);
      boxes.set(world);
      boxes.set(obstacles, world.length);
    }

    // The asphalt under the car, if it is on a road. Taken once, at the car's own middle, and
    // held for the whole step: a stretch of road is a plane, so over one frame's travel it
    // cannot be out by more than the gradient times a car's length.
    const road = this.roadUnder(surface);
    /** The highest thing the car will climb onto from where it is: anything over this is a wall. */
    const reach = road ? road.reach : this.pos[1] + STEP;

    // longitudinal
    const top = input.boost ? BOOST_SPEED : MAX_SPEED;
    if (input.throttle > 0) {
      if (this.speed < 0) this.speed = Math.min(0, this.speed + BRAKE * dt);
      else if (this.speed < top) this.speed = Math.min(top, this.speed + ACCEL * (input.boost ? 1.4 : 1) * input.throttle * dt);
    } else if (input.throttle < 0) {
      if (this.speed > 0) this.speed = Math.max(0, this.speed - BRAKE * dt);
      else this.speed = Math.max(-REVERSE_SPEED, this.speed - ACCEL * 0.6 * dt);
    }
    if (input.handbrake) this.speed -= Math.sign(this.speed) * Math.min(Math.abs(this.speed), 16 * dt);
    const drag = 0.18 * this.speed * dt + Math.sign(this.speed) * (input.throttle === 0 ? 2.5 : 0.3) * dt;
    this.speed = Math.abs(drag) > Math.abs(this.speed) ? 0 : this.speed - drag;
    if (this.speed > top) this.speed -= Math.min(this.speed - top, 8 * dt);
    // the tyres scrub out whatever sideways slide and spin a knock left, once they are on the ground
    if (this.grounded) {
      this.slip = ease0(this.slip, GRIP * dt);
      this.spin = ease0(this.spin, SPIN_GRIP * dt);
    }

    // steering: less lock at speed; the handbrake tightens turns
    const lock = (input.handbrake ? 0.8 : 0.55) / (1 + Math.abs(this.speed) * 0.05);
    this.steer += (input.steer * lock - this.steer) * Math.min(1, dt * 6);
    const yawRate = (-this.speed * Math.tan(this.steer)) / WHEELBASE;
    const newYaw = this.yaw + (yawRate + this.spin) * dt;
    if (this.overlapping(boxes, this.pos[0], this.pos[1], this.pos[2], newYaw, road, reach) < 0) {
      // Steering swings the velocity round with the car, which is what steering is for. A spin
      // does not: the car turns on the spot and goes on sliding the way it was going, until the
      // tyres have scrubbed the slide out.
      this.yaw += yawRate * dt;
      const [vx, vz] = this.velocity();
      this.yaw = newYaw;
      this.setVelocity(vx, vz);
    } else this.spin = 0;

    // Move in sub-steps, one axis at a time. A wall takes only the part of the velocity driven
    // into it, so a car that meets one at an angle runs on along it. Another car is knocked.
    const [vx0, vz0] = this.velocity();
    const steps = Math.max(1, Math.ceil((Math.hypot(vx0, vz0) * dt) / 0.3));
    const h = dt / steps;
    for (let s = 0; s < steps; s++) {
      const x0 = this.pos[0], z0 = this.pos[2];
      for (const axis of [0, 2] as const) {
        const v = this.velocity(), along = axis === 0 ? v[0] : v[1];
        if (along === 0) continue;
        const before = this.pos[axis];
        this.pos[axis] += along * h;
        if (this.overlapping(boxes, this.pos[0], this.pos[1], this.pos[2], this.yaw, road, reach) >= 0) {
          this.pos[axis] = before;
          this.impact = Math.max(this.impact, Math.abs(along));
          if (axis === 0) this.setVelocity(-v[0] * WALL_BOUNCE, v[1]);
          else this.setVelocity(v[0], -v[1] * WALL_BOUNCE);
        }
      }
      if (bodies) {
        for (const b of bodies) {
          if (b === this || this.collide(b, colliders, surface)) continue;
          this.pos[0] = x0;
          this.pos[2] = z0;
        }
      }
    }

    // Vertical: settle on the highest surface under the car (kerbs are stepped over). On a road
    // that is the asphalt itself, and the treads collision stands it on are skipped — taking the
    // highest of them instead put the car on the uphill corner of the box its nose happened to
    // reach, which changes as it moves and as it turns, so the ride was a tremor the length of
    // every sloping street. What is still read off collision here is everything that is not the
    // road: a ramp up off it, a deck, a roof, the ground where the road runs out.
    const d = CAR_DIMS[this.kind], fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    let ground = road?.y ?? FLOOR;
    for (let i = 0; i < boxes.length; i += 6) {
      if (boxes[i + 4] <= reach && boxes[i + 4] > ground && !isRoad(boxes, i, road) &&
          touches(boxes, i, this.pos[0], this.pos[2], fx, fz, d.hz, d.hx)) ground = boxes[i + 4];
    }
    // Going downhill the road falls away under the car every frame, and a car let go of each
    // time it did fell from a standstill, landed a few frames later and was let go again: down
    // any steep street at speed, a run of hops a third of a metre high. On the ground it stays
    // on whatever falls no faster than a steep road can under it, and carries the road's own
    // fall with it, so over the top of a real crest it still leaves the ground as it should.
    // A car knocked upward (vy > 0) is on its way off the ground and is not held to it.
    const drop = this.pos[1] - ground;
    if (this.grounded && drop > 1e-3 && drop <= Math.abs(this.speed) * dt * STICK + 0.02) {
      this.vy = -drop / dt;
      this.pos[1] = ground;
    } else if (this.pos[1] <= ground + 1e-3 && this.vy <= 0) {
      this.pos[1] = this.pos[1] + (ground - this.pos[1]) * Math.min(1, dt * 20);
      if (Math.abs(this.pos[1] - ground) < 0.01) this.pos[1] = ground;
      this.vy = 0;
      this.grounded = true;
    } else {
      this.vy -= GRAVITY * dt;
      this.pos[1] = Math.max(ground, this.pos[1] + this.vy * dt);
      this.grounded = this.pos[1] <= ground + 1e-3;
      if (this.grounded) this.vy = 0;
    }

    // rolling over in the air; down again, it is on its wheels or on its roof, whichever is nearer
    if (!this.grounded) this.tumble += this.tumbleRate * dt;
    else {
      if (this.tumbleRate !== 0) {
        this.tumble = Math.atan2(Math.sin(this.tumble), Math.cos(this.tumble));
        this.flipped ||= Math.abs(this.tumble) > Math.PI / 2;
        this.tumbleRate = 0;
      }
      const rest = this.flipped ? (this.tumble < 0 ? -Math.PI : Math.PI) : 0;
      this.tumble += (rest - this.tumble) * Math.min(1, dt * 10);
    }

    // body motion
    const accel = input.throttle * (this.speed >= 0 ? 1 : -1);
    this.pitch += (-accel * 0.025 - this.pitch) * Math.min(1, dt * 5);
    this.roll += (Math.max(-0.08, Math.min(0.08, yawRate * this.speed * 0.004)) - this.roll) * Math.min(1, dt * 5);
  }

  get canExit(): boolean {
    return Math.abs(this.speed) < 2 && Math.abs(this.slip) < 2 && this.grounded;
  }

  exitSpot(colliders: Colliders): Vec3 | null {
    const f = this.van ? 1.05 : 1.0;
    return exitSpot(this.pos, this.yaw, [[-1.9 * f, 0.4], [1.9 * f, 0.4], [0, -3.4 * f], [0, 3.4 * f]], colliders);
  }
}
