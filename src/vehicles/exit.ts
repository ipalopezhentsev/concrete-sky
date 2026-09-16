// Finding a free place to stand next to a vehicle.

import type { Vec3 } from "../math";
import type { Colliders } from "../player";

const R = 0.35;

/**
 * Tries positions around a vehicle (offsets in its local frame: [right, forward])
 * and returns feet position of the first one where a person fits, at roughly the
 * vehicle's level (never a drop), or null.
 */
export function exitSpot(pos: Vec3, yaw: number, offsets: [number, number][], colliders: Colliders): Vec3 | null {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const right: [number, number] = [-c, s];
  const fwd: [number, number] = [s, c];
  const boxes = colliders(pos[0], pos[2]);
  for (const [side, ahead] of offsets) {
    const x = pos[0] + right[0] * side + fwd[0] * ahead;
    const z = pos[2] + right[1] * side + fwd[1] * ahead;
    let ground = 0;
    for (let i = 0; i < boxes.length; i += 6) {
      if (boxes[i] < x + R && boxes[i + 3] > x - R && boxes[i + 2] < z + R && boxes[i + 5] > z - R &&
          boxes[i + 4] <= pos[1] + 0.6) ground = Math.max(ground, boxes[i + 4]);
    }
    if (ground < pos[1] - 1.5) continue; // would step off into a drop
    let blocked = false;
    for (let i = 0; i < boxes.length; i += 6) {
      if (boxes[i] < x + R && boxes[i + 3] > x - R && boxes[i + 2] < z + R && boxes[i + 5] > z - R &&
          boxes[i + 1] < ground + 1.8 && boxes[i + 4] > ground + 0.05) {
        blocked = true;
        break;
      }
    }
    if (!blocked) return [x, ground, z];
  }
  return null;
}
