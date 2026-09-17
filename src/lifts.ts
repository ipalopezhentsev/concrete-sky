// Lifts: open platforms that shuttle between two stops on a fixed timetable. Like the traffic,
// a lift's height is a pure function of time, so nothing is simulated or saved.

import type { Lift } from "./city/generate";
import type { Player } from "./player";
import type { InstanceList } from "./vehicles/traffic";
import type { Vec3 } from "./math";

export const LIFT_SPEED = 3.5; // m/s at the fastest
export const LIFT_WAIT = 5; // seconds standing at each stop
export const LIFT_THICK = 0.4;
const RADIUS = 0.35; // the runner's

const ease = (t: number) => t * t * (3 - 2 * t);

/** Seconds a lift takes between its stops (the eased ride peaks at LIFT_SPEED). */
export function liftTravel(l: Lift): number {
  return (1.5 * (l.y1 - l.y0)) / LIFT_SPEED;
}

/** Height of the platform top at time t, and whether it is moving. */
export function liftState(l: Lift, t: number): { y: number; moving: boolean } {
  const travel = liftTravel(l);
  const period = 2 * (travel + LIFT_WAIT);
  let p = (((t + l.phase * period) % period) + period) % period;
  // wait at the bottom, go up, wait at the top, come down
  if (p < LIFT_WAIT) return { y: l.y0, moving: false };
  p -= LIFT_WAIT;
  if (p < travel) return { y: l.y0 + (l.y1 - l.y0) * ease(p / travel), moving: true };
  p -= travel;
  if (p < LIFT_WAIT) return { y: l.y1, moving: false };
  p -= LIFT_WAIT;
  return { y: l.y1 - (l.y1 - l.y0) * ease(p / travel), moving: true };
}

const EMPTY = new Float32Array(0);

export class Lifts {
  private list: Lift[] = [];
  private time = 0;
  private cache = new Map<string, Float32Array>();

  sync(lifts: Iterable<Lift>): void {
    this.list = [...lifts];
    this.cache.clear();
  }

  /** Move every lift to time t (call once per frame, before anything collides). */
  update(t: number): void {
    this.time = t;
    this.cache.clear();
  }

  /** Platforms near (x, z) as collision boxes; the same array for the rest of the frame. */
  boxes(x: number, z: number): Float32Array {
    const key = `${Math.round(x / 40)},${Math.round(z / 40)}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const out: number[] = [];
    for (const l of this.list) {
      if (Math.abs(l.x0 - x) > 80 || Math.abs(l.z0 - z) > 80) continue;
      const { y } = liftState(l, this.time);
      out.push(l.x0, y - LIFT_THICK, l.z0, l.x1, y, l.z1);
    }
    const boxes = out.length ? Float32Array.from(out) : EMPTY;
    this.cache.set(key, boxes);
    return boxes;
  }

  /**
   * Keeps a runner with a lift: while it moves, whoever stands on it stays inside its edges,
   * and anyone it comes down on (or who ended up just under its top) is put on top of it.
   */
  carry(p: Player): void {
    const [x, feet, z] = p.pos;
    for (const l of this.list) {
      if (x + RADIUS <= l.x0 || x - RADIUS >= l.x1 || z + RADIUS <= l.z0 || z - RADIUS >= l.z1) continue;
      const { y, moving } = liftState(l, this.time);
      if (feet > y + 0.05 || feet < y - LIFT_THICK - 1.8) continue;
      if (feet < y) {
        p.pos[1] = y;
        p.vel[1] = Math.max(p.vel[1], 0);
        p.grounded = true;
      }
      if (moving) {
        p.pos[0] = Math.min(l.x1 - RADIUS, Math.max(l.x0 + RADIUS, x));
        p.pos[2] = Math.min(l.z1 - RADIUS, Math.max(l.z0 + RADIUS, z));
      }
      return;
    }
  }

  /** Platform instances within `radius` of the eye. */
  instances(list: InstanceList, eye: Vec3, radius: number): void {
    list.clear();
    for (const l of this.list) {
      const cx = (l.x0 + l.x1) / 2, cz = (l.z0 + l.z1) / 2;
      if (Math.abs(cx - eye[0]) > radius || Math.abs(cz - eye[2]) > radius) continue;
      // the colour's alpha seeds the concrete texture, so it stays fixed per lift
      list.push(cx, liftState(l, this.time).y, cz, 0, 0, 0, WHITE, l.phase);
    }
  }
}

const WHITE = [1, 1, 1];
