// A drivable car: arcade handling, box collision, kerb stepping.

import type { Vec3 } from "../math";
import { FLOOR, type Colliders } from "../player";
import { exitSpot } from "./exit";
import { footprint } from "./parking";

export interface DriveInput {
  throttle: number; // -1..1 (S brakes, then reverses)
  steer: number; // -1..1, +1 turns right
  handbrake: boolean;
  boost: boolean;
}

/**
 * The surface a road lays over a point, or null where no road covers it.
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
 * always driven on (see `roadY` in city/plan.ts), and reads collision for the things standing
 * on the road rather than for the road itself.
 */
export type RoadSurface = (x: number, z: number) => number | null;

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

/** The road under the car this frame, and the bands it sets on what collision says. */
interface Road {
  y: number; // the asphalt
  reach: number; // the highest thing the car will climb onto from it
  ceiling: number; // tops at or under this may be the road described in boxes
  floor: number; // ... but only if their undersides reach at least this far below it
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

export class Car {
  pos: Vec3;
  yaw: number;
  speed = 0; // along the car's forward axis
  vy = 0;
  steer = 0;
  pitch = 0;
  roll = 0;
  grounded = true;
  impact = 0; // strength of a collision this frame (for sound)
  readonly van: boolean;
  readonly color: Vec3;

  constructor(x: number, y: number, z: number, yaw: number, van: boolean, color: Vec3) {
    this.pos = [x, y, z];
    this.yaw = yaw;
    this.van = van;
    this.color = color;
  }

  get kind(): "car" | "van" {
    return this.van ? "van" : "car";
  }

  get speedNorm(): number {
    return Math.abs(this.speed) / BOOST_SPEED;
  }

  /**
   * Index of a box in the way here, or -1. A box that is only the road described in boxes is
   * never in the way: the car is already on that surface, whatever collision makes of it.
   */
  private overlapping(
    boxes: Float32Array, x: number, y: number, z: number, yaw: number, road: Road | null, reach: number,
  ): number {
    const f = footprint(this.kind, yaw);
    let top = -1;
    for (let i = 0; i < boxes.length; i += 6) {
      if (boxes[i] < x + f.hx && boxes[i + 3] > x - f.hx && boxes[i + 2] < z + f.hz && boxes[i + 5] > z - f.hz &&
          boxes[i + 1] < y + f.h && boxes[i + 4] > reach && !isRoad(boxes, i, road)) top = Math.max(top, i);
    }
    return top; // index of a blocking box, or -1
  }

  update(dt: number, input: DriveInput, colliders: Colliders, obstacles?: Float32Array, surface?: RoadSurface): void {
    this.impact = 0;
    const world = colliders(this.pos[0], this.pos[2]);
    let boxes = world;
    if (obstacles && obstacles.length) {
      boxes = new Float32Array(world.length + obstacles.length);
      boxes.set(world);
      boxes.set(obstacles, world.length);
    }

    // The asphalt under the car, if it is on a road. Taken once, at the car's own middle, and
    // held for the whole step: a stretch of road is a plane, so over one frame's travel it
    // cannot be out by more than the gradient times a car's length. A road *above* the car —
    // the overpass it is driving under — is not the road it is on, so a surface out of reach
    // upward is no surface at all.
    const under = surface?.(this.pos[0], this.pos[2]) ?? null;
    const road: Road | null = under === null || under > this.pos[1] + STEP ? null
      : { y: under, reach: under + ROAD_STEP, ceiling: under + ROAD_SLACK, floor: under - ROAD_DEEP };
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

    // steering: less lock at speed; the handbrake tightens turns
    const lock = (input.handbrake ? 0.8 : 0.55) / (1 + Math.abs(this.speed) * 0.05);
    this.steer += (input.steer * lock - this.steer) * Math.min(1, dt * 6);
    const yawRate = (-this.speed * Math.tan(this.steer)) / WHEELBASE;
    const newYaw = this.yaw + yawRate * dt;
    if (this.overlapping(boxes, this.pos[0], this.pos[1], this.pos[2], newYaw, road, reach) < 0) this.yaw = newYaw;

    // move with sub-steps, one axis at a time
    const dx = Math.sin(this.yaw) * this.speed * dt;
    const dz = Math.cos(this.yaw) * this.speed * dt;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 0.3));
    for (let s = 0; s < steps; s++) {
      for (const [axis, d] of [[0, dx / steps], [2, dz / steps]] as const) {
        const before = this.pos[axis];
        this.pos[axis] += d;
        if (this.overlapping(boxes, this.pos[0], this.pos[1], this.pos[2], this.yaw, road, reach) >= 0) {
          this.pos[axis] = before;
          this.impact = Math.max(this.impact, Math.abs(this.speed));
          this.speed *= -0.25;
        }
      }
    }

    // Vertical: settle on the highest surface under the car (kerbs are stepped over). On a road
    // that is the asphalt itself, and the treads collision stands it on are skipped — taking the
    // highest of them instead put the car on the uphill corner of the box its nose happened to
    // reach, which changes as it moves and as it turns, so the ride was a tremor the length of
    // every sloping street. What is still read off collision here is everything that is not the
    // road: a ramp up off it, a deck, a roof, the ground where the road runs out.
    const f = footprint(this.kind, this.yaw);
    let ground = road?.y ?? FLOOR;
    for (let i = 0; i < boxes.length; i += 6) {
      if (boxes[i] < this.pos[0] + f.hx && boxes[i + 3] > this.pos[0] - f.hx &&
          boxes[i + 2] < this.pos[2] + f.hz && boxes[i + 5] > this.pos[2] - f.hz &&
          boxes[i + 4] <= reach && !isRoad(boxes, i, road)) ground = Math.max(ground, boxes[i + 4]);
    }
    if (this.pos[1] <= ground + 1e-3) {
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

    // body motion
    const accel = input.throttle * (this.speed >= 0 ? 1 : -1);
    this.pitch += (-accel * 0.025 - this.pitch) * Math.min(1, dt * 5);
    this.roll += (Math.max(-0.08, Math.min(0.08, yawRate * this.speed * 0.004)) - this.roll) * Math.min(1, dt * 5);
  }

  get canExit(): boolean {
    return Math.abs(this.speed) < 2 && this.grounded;
  }

  exitSpot(colliders: Colliders): Vec3 | null {
    const f = this.van ? 1.05 : 1.0;
    return exitSpot(this.pos, this.yaw, [[-1.9 * f, 0.4], [1.9 * f, 0.4], [0, -3.4 * f], [0, 3.4 * f]], colliders);
  }
}
