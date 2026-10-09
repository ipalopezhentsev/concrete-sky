// The river, as it is to someone in it: where the water stands, and the ways out of it.
//
// The water is not a thing anyone collides with — it is laid as a surface with nothing solid
// under it but the bed (see `river` in plan.ts). So whether the runner is in it is a question
// put to the river's own line, the same one the quays and the water are built from, and the
// ladders up the quay wall are found the same way rather than looked for among the boxes:
// they are not solid, so a swimmer can come up the wall on them and nobody on the quay trips
// over their handles.

import { QUAY_RISE, RIVER_HALF, riverFrame, riverNear, waterLevel, type Vec2 } from "./city/network";
import { BAY, LADDERS, quayBay, WATER_STEPS } from "./city/plan";

/** What a runner needs to know about water near them. */
export interface Water {
  /** The surface of the water at (x, z), or null where there is none. */
  level(x: number, z: number): number | null;
  /** A ladder up the wall within reach of (x, z): how high it climbs, and which way is out over the top. */
  ladder(x: number, z: number): { top: number; out: Vec2 } | null;
}

/** How near the middle of the rungs a swimmer has to be to take hold. */
const GRAB = 1.2;

export const river: Water = {
  level(x, z) {
    const r = riverNear(x, z, RIVER_HALF + 2);
    return r && r.dist < RIVER_HALF ? waterLevel(r.line) : null;
  },

  ladder(x, z) {
    const r = riverNear(x, z, RIVER_HALF + 2);
    if (!r || r.dist < RIVER_HALF - GRAB - 0.5) return null;
    // how far down the river this is, as the quay counts it: the foot of the perpendicular
    let s = z;
    for (let i = 0; i < 6; i++) {
      const { p, dir } = riverFrame(r.line, s);
      s += (x - p[0]) * dir[0] + (z - p[1]) * dir[1];
    }
    const k = Math.round((s / BAY - 0.5) / LADDERS) * LADDERS;
    if (k % WATER_STEPS === 0) return null;
    const { p, dir } = quayBay(r.line, k);
    const n: Vec2 = [-dir[1], dir[0]];
    const side = (x - p[0]) * n[0] + (z - p[1]) * n[1] > 0 ? 1 : -1;
    const ex = p[0] + n[0] * RIVER_HALF * side, ez = p[1] + n[1] * RIVER_HALF * side;
    if (Math.hypot(x - ex, z - ez) > GRAB) return null;
    return { top: waterLevel(r.line) + QUAY_RISE, out: [n[0] * side, n[1] * side] };
  },
};
