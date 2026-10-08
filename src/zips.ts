// Ziplines: a cable from a post on a tower roof down across a street to the deck of the block
// on the other side (see `zipline` in city/plan.ts), and the ride down it.
//
// A line is laid when its tower is built, without knowing what stands between its ends, so it
// is tested here against the city's collision once it is near enough for everything round it to
// be streamed in. One with anything in the way of a rider hanging under it is left out: not
// drawn, not ridden.

import type { Vec3 } from "./math";
import type { Colliders } from "./player";
import type { InstanceList } from "./vehicles/traffic";

/** How far below the cable a rider's feet hang. */
export const HANG = 2.3;
/** Top speed down a line, and how hard the air and the trolley hold it back. */
const TOP = 26;
const DRAG = 0.012;

export interface Zip {
  key: string;
  /** The block it is one of a few candidates for, and its place among them: the first clear one is the line. */
  group: number;
  rank: number;
  a: Vec3;
  b: Vec3;
  /** Along the cable, unit, and its length. */
  dir: Vec3;
  len: number;
  /** Whether anything is in the way: undefined until it has been looked at. */
  clear?: boolean;
}

export interface ZipRide {
  zip: Zip;
  /** How far down it, and how fast. */
  s: number;
  v: number;
}

export class Zips {
  private all = new Map<string, Zip>();

  sync(lines: Iterable<[Vec3, Vec3, number]>): void {
    const seen = new Set<string>();
    const ranks = new Map<number, number>();
    for (const [a, b, group] of lines) {
      const key = `${a[0].toFixed(1)},${a[2].toFixed(1)},${b[0].toFixed(1)},${b[2].toFixed(1)}`;
      const rank = ranks.get(group) ?? 0;
      ranks.set(group, rank + 1);
      seen.add(key);
      if (this.all.has(key)) continue;
      const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const len = Math.hypot(...d);
      this.all.set(key, { key, group, rank, a, b, dir: [d[0] / len, d[1] / len, d[2] / len], len });
    }
    for (const k of this.all.keys()) if (!seen.has(k)) this.all.delete(k);
  }

  /**
   * The lines near a point that are clear to ride, testing each against the city the first
   * time it comes within reach: the column a rider hangs in, all the way down, short of the
   * posts at either end.
   */
  near(x: number, z: number, r: number, colliders: Colliders, streamed: (x: number, z: number) => boolean = () => true): Zip[] {
    // each block's candidates in order, and the first of them that is clear
    const chosen = new Map<number, Zip | null>();
    const lines = [...this.all.values()].sort((p, q) => p.rank - q.rank);
    for (const zp of lines) {
      const mx = (zp.a[0] + zp.b[0]) / 2, mz = (zp.a[2] + zp.b[2]) / 2;
      if (Math.hypot(mx - x, mz - z) > r + zp.len / 2) continue;
      if (chosen.get(zp.group)) continue;
      // not judged until everything along it is in: until then it is not there
      if (zp.clear === undefined) {
        if (!streamed(zp.a[0], zp.a[2]) || !streamed(zp.b[0], zp.b[2]) ||
            !streamed((zp.a[0] + zp.b[0]) / 2, (zp.a[2] + zp.b[2]) / 2)) {
          chosen.set(zp.group, null);
          continue;
        }
        zp.clear = clearOf(zp, colliders);
      }
      chosen.set(zp.group, zp.clear ? zp : null);
    }
    return [...chosen.values()].filter((zp): zp is Zip => !!zp);
  }

  /** The cable of each clear line near the eye, two metres at a time. */
  instances(list: InstanceList, posts: InstanceList, eye: Vec3, colliders: Colliders, streamed?: (x: number, z: number) => boolean): void {
    list.clear();
    posts.clear();
    for (const zp of this.near(eye[0], eye[2], 500, colliders, streamed)) {
      const yaw = Math.atan2(zp.dir[0], zp.dir[2]);
      // the arm across the line at either end, the lamp on top lit
      posts.push(zp.a[0], zp.a[1], zp.a[2], yaw + Math.PI / 2, 0, 0, [0.95, 0.55, 0.12], 1);
      posts.push(zp.b[0], zp.b[1], zp.b[2], yaw + Math.PI / 2, 0, 0, [0.95, 0.55, 0.12], 1);
      const pitch = Math.atan2(-zp.dir[1], Math.hypot(zp.dir[0], zp.dir[2]));
      const n = Math.ceil(zp.len / 2);
      for (let i = 0; i < n; i++) {
        const s = Math.min(zp.len - 1, i * 2 + 1);
        list.push(zp.a[0] + zp.dir[0] * s, zp.a[1] + zp.dir[1] * s, zp.a[2] + zp.dir[2] * s, yaw, pitch, 0, [0.3, 0.31, 0.32], 0);
      }
    }
  }

  /** A line whose top post the runner is standing by, ready to clip on. */
  startAt(pos: Vec3, colliders: Colliders, streamed?: (x: number, z: number) => boolean): Zip | null {
    for (const zp of this.near(pos[0], pos[2], 40, colliders, streamed)) {
      if (Math.hypot(zp.a[0] - pos[0], zp.a[2] - pos[2]) < 2.4 && Math.abs(zp.a[1] - 3.4 - pos[1]) < 1.6) return zp;
    }
    return null;
  }
}

/** Whether a rider hanging under a line would hit anything on the way down. */
function clearOf(zp: Zip, colliders: Colliders): boolean {
  for (let s = 4; s < zp.len - 3; s += 1.5) {
    const x = zp.a[0] + zp.dir[0] * s, y = zp.a[1] + zp.dir[1] * s, z = zp.a[2] + zp.dir[2] * s;
    const boxes = colliders(x, z);
    for (let i = 0; i < boxes.length; i += 6) {
      if (x > boxes[i] - 0.5 && x < boxes[i + 3] + 0.5 && z > boxes[i + 2] - 0.5 && z < boxes[i + 5] + 0.5 &&
          boxes[i + 4] > y - HANG - 0.15 && boxes[i + 1] < y + 0.3) return false;
    }
  }
  return true;
}

/**
 * The ride down: gravity down the slope against the drag of the trolley, from standing to its
 * top speed. Returns where the rider's feet are, and whether they have come to the bottom.
 */
export function rideOn(r: ZipRide, dt: number): { pos: Vec3; vel: Vec3; done: boolean } {
  const fall = -r.zip.dir[1];
  r.v = Math.min(TOP, Math.max(0, r.v + (9.8 * fall - DRAG * r.v * r.v) * dt));
  r.s += r.v * dt;
  // slowing into the bottom post rather than hitting it
  const left = r.zip.len - r.s;
  if (left < 6) r.v = Math.min(r.v, Math.max(2, left * 1.5));
  const s = Math.min(r.s, r.zip.len);
  const d = r.zip.dir;
  return {
    pos: [r.zip.a[0] + d[0] * s, r.zip.a[1] + d[1] * s - HANG, r.zip.a[2] + d[2] * s],
    vel: [d[0] * r.v, d[1] * r.v, d[2] * r.v],
    done: left < 1.2,
  };
}
