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

const MAX_SPEED = 34;
const BOOST_SPEED = 50;
const REVERSE_SPEED = 9;
const ACCEL = 11;
const BRAKE = 24;
const WHEELBASE = 2.7;
const STEP = 0.4;
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

  private overlapping(boxes: Float32Array, x: number, y: number, z: number, yaw: number): number {
    const f = footprint(this.kind, yaw);
    let top = -1;
    for (let i = 0; i < boxes.length; i += 6) {
      if (boxes[i] < x + f.hx && boxes[i + 3] > x - f.hx && boxes[i + 2] < z + f.hz && boxes[i + 5] > z - f.hz &&
          boxes[i + 1] < y + f.h && boxes[i + 4] > y + STEP) top = Math.max(top, i);
    }
    return top; // index of a blocking box, or -1
  }

  update(dt: number, input: DriveInput, colliders: Colliders, obstacles?: Float32Array): void {
    this.impact = 0;
    const world = colliders(this.pos[0], this.pos[2]);
    let boxes = world;
    if (obstacles && obstacles.length) {
      boxes = new Float32Array(world.length + obstacles.length);
      boxes.set(world);
      boxes.set(obstacles, world.length);
    }

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
    if (this.overlapping(boxes, this.pos[0], this.pos[1], this.pos[2], newYaw) < 0) this.yaw = newYaw;

    // move with sub-steps, one axis at a time
    const dx = Math.sin(this.yaw) * this.speed * dt;
    const dz = Math.cos(this.yaw) * this.speed * dt;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 0.3));
    for (let s = 0; s < steps; s++) {
      for (const [axis, d] of [[0, dx / steps], [2, dz / steps]] as const) {
        const before = this.pos[axis];
        this.pos[axis] += d;
        if (this.overlapping(boxes, this.pos[0], this.pos[1], this.pos[2], this.yaw) >= 0) {
          this.pos[axis] = before;
          this.impact = Math.max(this.impact, Math.abs(this.speed));
          this.speed *= -0.25;
        }
      }
    }

    // vertical: settle on the highest surface under the car (kerbs are stepped over)
    const f = footprint(this.kind, this.yaw);
    let ground = FLOOR;
    for (let i = 0; i < boxes.length; i += 6) {
      if (boxes[i] < this.pos[0] + f.hx && boxes[i + 3] > this.pos[0] - f.hx &&
          boxes[i + 2] < this.pos[2] + f.hz && boxes[i + 5] > this.pos[2] - f.hz &&
          boxes[i + 4] <= this.pos[1] + STEP) ground = Math.max(ground, boxes[i + 4]);
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
