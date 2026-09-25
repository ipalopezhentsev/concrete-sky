// River craft: the launch the player takes, and the barges tied up along the quays.
//
// A boat is not a car with different numbers. It has no gravity and no ground to stand on —
// it sits on the surface of whatever river it is in, and what stops it is the bank rather
// than anything it drives into. So it steers like a hull: it turns about itself, it carries
// its way when the throttle comes off, and it slides rather than grips.

import { riverNear, RIVER_HALF, waterLevel } from "../city/network";
import type { Vec3 } from "../math";

/** Half extents of a launch, for boarding, collision and the wake. */
export const BOAT_DIMS = { hx: 1.9, hz: 5.4, h: 2.4 };

const DRIVE = 13;
const REVERSE = 5;
const TURN = 0.85; // radians a second at speed
const DRAG = 0.5;

export interface BoatInput {
  moveX: number; // helm, +1 = starboard
  moveZ: number; // throttle
}

export class Boat {
  pos: Vec3;
  yaw: number;
  speed = 0;
  /** How far the hull is from the nearest bank; 0 once it is aground. */
  clearance = RIVER_HALF;

  constructor(x: number, y: number, z: number, yaw: number) {
    this.pos = [x, y, z];
    this.yaw = yaw;
  }

  update(dt: number, input: BoatInput): void {
    const want = input.moveZ > 0 ? DRIVE * input.moveZ : REVERSE * input.moveZ;
    this.speed += (want - this.speed) * (1 - Math.exp(-DRAG * dt));
    // the helm only bites while there is water going past the rudder
    const bite = Math.min(1, Math.abs(this.speed) / 4);
    this.yaw += input.moveX * TURN * bite * dt * Math.sign(this.speed || 1);

    const nx = this.pos[0] + Math.sin(this.yaw) * this.speed * dt;
    const nz = this.pos[2] + Math.cos(this.yaw) * this.speed * dt;

    // A boat is held by its river, not by collision boxes: leave the channel and it grounds.
    // Steering back off the bank has to keep working, so only the move that would take it
    // further out is refused.
    const r = riverNear(nx, nz, RIVER_HALF + 120);
    const room = r ? RIVER_HALF - 3.5 - r.dist : -1;
    if (r && (room > 0 || r.dist < this.clearance + RIVER_HALF)) {
      const now = riverNear(this.pos[0], this.pos[2], RIVER_HALF + 120);
      if (room > 0 || (now && r.dist <= now.dist)) {
        this.pos[0] = nx;
        this.pos[2] = nz;
        this.pos[1] = waterLevel(r.line) + 1.2;
        this.clearance = Math.max(0, room);
      } else {
        this.speed *= 0.25;
      }
    } else {
      this.speed *= 0.25;
    }
  }

  /** Where a rider steps off: onto the deck, level with the gunwale. */
  exitSpot(): Vec3 {
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    return [this.pos[0] + rx * (BOAT_DIMS.hx + 0.7), this.pos[1] + 0.4, this.pos[2] + rz * (BOAT_DIMS.hx + 0.7)];
  }
}
