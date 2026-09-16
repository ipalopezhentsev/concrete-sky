// Personal flyers: the one the player pilots, and the ones waiting on landing pads.

import type { Vec3 } from "../math";
import type { Colliders } from "../player";
import { exitSpot } from "./exit";
import { FLYER_HEIGHT } from "./models";

const HALF = 1.7; // horizontal collision half size (covers the rotors)
const CRUISE = 24;
const BOOST = 48;
const CLIMB = 11;
const MAX_STEP = 0.4;

export interface FlyInput {
  moveX: number;
  moveZ: number;
  up: number; // -1..1
  boost: boolean;
}

export const FLYER_PALETTE: Vec3[] = [
  [0.86, 0.85, 0.8],
  [0.9, 0.42, 0.12],
  [0.12, 0.45, 0.5],
  [0.62, 0.1, 0.08],
  [0.9, 0.78, 0.25],
];

function overlaps(b: Float32Array, i: number, x: number, y: number, z: number): boolean {
  return b[i] < x + HALF && b[i + 3] > x - HALF && b[i + 2] < z + HALF && b[i + 5] > z - HALF &&
    b[i + 1] < y + FLYER_HEIGHT && b[i + 4] > y + 0.01;
}

export class Flyer {
  pos: Vec3;
  vel: Vec3 = [0, 0, 0];
  yaw: number;
  pitch = 0; // visual nose tilt
  roll = 0;
  grounded = true;
  speedNorm = 0;
  color: Vec3;

  constructor(x: number, y: number, z: number, yaw: number, color: Vec3) {
    this.pos = [x, y, z];
    this.yaw = yaw;
    this.color = color;
  }

  update(dt: number, input: FlyInput, lookYaw: number, lookPitch: number, colliders: Colliders): void {
    const cy = Math.cos(lookYaw), sy = Math.sin(lookYaw), cp = Math.cos(lookPitch), sp = Math.sin(lookPitch);
    // fly where you look: forward follows the camera pitch
    const fwd: Vec3 = [sy * cp, sp, cy * cp];
    const right: Vec3 = [-cy, 0, sy];
    const speed = input.boost ? BOOST : CRUISE;
    const want: Vec3 = [
      (fwd[0] * input.moveZ + right[0] * input.moveX) * speed,
      fwd[1] * input.moveZ * speed + input.up * CLIMB,
      (fwd[2] * input.moveZ + right[2] * input.moveX) * speed,
    ];
    const k = 1 - Math.exp(-(input.boost ? 1.6 : 2.4) * dt);
    for (let i = 0; i < 3; i++) this.vel[i] += (want[i] - this.vel[i]) * k;
    // a parked flyer settles instead of drifting
    if (this.grounded && this.vel[1] < 0.5 && Math.hypot(want[0], want[2]) < 0.1) {
      this.vel[0] *= 0.8;
      this.vel[2] *= 0.8;
    }

    const boxes = colliders(this.pos[0], this.pos[2]);
    const travel = Math.hypot(...this.vel) * dt;
    const steps = Math.max(1, Math.ceil(travel / MAX_STEP));
    this.grounded = false;
    for (let s = 0; s < steps; s++) {
      this.moveAxis(0, (this.vel[0] * dt) / steps, boxes);
      this.moveAxis(2, (this.vel[2] * dt) / steps, boxes);
      this.moveAxis(1, (this.vel[1] * dt) / steps, boxes);
    }
    if (this.pos[1] <= 0) {
      this.pos[1] = 0;
      if (this.vel[1] < 0) this.vel[1] = 0;
      this.grounded = true;
    }
    // resting contact: probe just below
    if (!this.grounded) {
      for (let i = 0; i < boxes.length; i += 6) {
        if (overlaps(boxes, i, this.pos[0], this.pos[1] - 0.05, this.pos[2])) {
          this.grounded = true;
          break;
        }
      }
    }

    // turn the craft toward the camera heading while moving
    const moving = Math.hypot(input.moveX, input.moveZ) > 0;
    if (moving || !this.grounded) {
      let d = lookYaw - this.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.yaw += d * Math.min(1, dt * 3);
    }
    const cyaw = Math.cos(this.yaw), syaw = Math.sin(this.yaw);
    const localFwd = this.vel[0] * syaw + this.vel[2] * cyaw;
    const localRight = -this.vel[0] * cyaw + this.vel[2] * syaw;
    const targetPitch = this.grounded ? 0 : Math.max(-0.35, Math.min(0.35, localFwd * 0.012 + (want[0] * syaw + want[2] * cyaw - localFwd) * 0.01));
    const targetRoll = this.grounded ? 0 : Math.max(-0.45, Math.min(0.45, -localRight * 0.02));
    this.pitch += (targetPitch - this.pitch) * Math.min(1, dt * 4);
    this.roll += (targetRoll - this.roll) * Math.min(1, dt * 4);
    this.speedNorm = Math.hypot(...this.vel) / BOOST;
  }

  private moveAxis(axis: 0 | 1 | 2, delta: number, boxes: Float32Array): void {
    if (delta === 0) return;
    this.pos[axis] += delta;
    const [x, y, z] = this.pos;
    let limit = delta > 0 ? Infinity : -Infinity;
    let hit = false;
    for (let i = 0; i < boxes.length; i += 6) {
      if (!overlaps(boxes, i, x, y, z)) continue;
      hit = true;
      if (delta > 0) limit = Math.min(limit, boxes[i + axis]);
      else limit = Math.max(limit, boxes[i + axis + 3]);
    }
    if (!hit) return;
    if (axis === 1) {
      this.pos[1] = delta > 0 ? limit - FLYER_HEIGHT - 1e-4 : limit + 1e-4;
      if (delta < 0) this.grounded = true;
    } else {
      this.pos[axis] = delta > 0 ? limit - HALF - 1e-4 : limit + HALF + 1e-4;
    }
    this.vel[axis] = 0;
  }

  /** Can the pilot step out? Needs to be (nearly) resting on something. */
  get canExit(): boolean {
    return this.grounded && Math.hypot(...this.vel) < 4;
  }

  /** A free spot next to the craft where a person can stand, or null. */
  exitSpot(colliders: Colliders): Vec3 | null {
    return exitSpot(this.pos, this.yaw, [[2.8, 0], [-2.8, 0], [0, -3.2], [0, 3.2], [2.8, 2.8], [-2.8, -2.8]], colliders);
  }
}
