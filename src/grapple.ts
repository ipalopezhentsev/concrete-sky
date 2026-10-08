// The grappling line: fired along the view at anything solid within reach — a ledge, the edge
// of a deck, the underside of a bridge — and then reeled in while it is held, swinging the
// runner under it, and let go to fly on with whatever way they have.
//
// It is a rope, not a winch: it only ever pulls, never pushes, so the runner swings on it and
// can be carried round by their own momentum; reeling in shortens it. The collision boxes say
// what it can catch on, the same ones the runner stands on.

import type { Vec3 } from "./math";
import type { Colliders, Player } from "./player";
import type { Particles } from "./effects/particles";

/**
 * Where a runner could stand in the column at (x, z) at about the level of a lip: the highest
 * top at most a little over it with headroom above, or null. A parapet along the lip is stood
 * on, or stepped down off, however it comes.
 */
function standOn(boxes: Float32Array, x: number, z: number, lip: number): number | null {
  const R = 0.35, H = 1.8;
  let ground = -Infinity;
  for (let i = 0; i < boxes.length; i += 6) {
    if (boxes[i] > x + R || boxes[i + 3] < x - R || boxes[i + 2] > z + R || boxes[i + 5] < z - R) continue;
    if (boxes[i + 4] <= lip + 1.3) ground = Math.max(ground, boxes[i + 4]);
  }
  if (ground < lip - 2) return null;
  for (let i = 0; i < boxes.length; i += 6) {
    if (boxes[i] > x + R || boxes[i + 3] < x - R || boxes[i + 2] > z + R || boxes[i + 5] < z - R) continue;
    if (boxes[i + 1] < ground + H && boxes[i + 4] > ground + 0.05) return null;
  }
  return ground;
}

/** As far as it reaches, and how fast it reels in. */
export const REACH = 70;
const REEL = 15;
/** Where on the runner it pulls from: their hands, a little above the middle. */
const HANDS = 1.3;

export class Grapple {
  /** Where it has caught, or null when it is not out. */
  anchor: Vec3 | null = null;
  /** Caught just under the top of something, which it then pulls the runner up and over: the top's level. */
  private ledge: number | null = null;
  private length = 0;
  /** Hauling up over the lip: from where, to where, and how far through it, 0..1. */
  private climb: { from: Vec3; to: Vec3; t: number } | null = null;

  /** Up and over a lip in progress: the runner is carried, not stepped. */
  get climbing(): boolean {
    return this.climb !== null;
  }

  /**
   * Fire along the view from the eye. Returns where it caught, or null if there was nothing
   * within reach to catch on.
   */
  fire(eye: Vec3, dir: Vec3, colliders: Colliders): Vec3 | null {
    const STEP = 0.25;
    let cell = "", boxes: Float32Array = new Float32Array(0);
    for (let t = 0.6; t <= REACH; t += STEP) {
      const x = eye[0] + dir[0] * t, y = eye[1] + dir[1] * t, z = eye[2] + dir[2] * t;
      const key = `${Math.floor(x / 20)},${Math.floor(z / 20)}`;
      if (key !== cell) {
        cell = key;
        boxes = colliders(x, z);
      }
      for (let i = 0; i < boxes.length; i += 6) {
        if (x < boxes[i] || x > boxes[i + 3] || y < boxes[i + 1] || y > boxes[i + 4] || z < boxes[i + 2] || z > boxes[i + 5]) continue;
        // just short of the surface it hit
        const back = t - STEP;
        const at: Vec3 = [eye[0] + dir[0] * back, eye[1] + dir[1] * back, eye[2] + dir[2] * back];
        // A hit on a face a little under the top of what it hit is a ledge: caught at the lip,
        // so reeling in brings the runner up to where they can climb over.
        const top = boxes[i + 4];
        this.ledge = top - at[1] > 0 && top - at[1] < 3 && boxes[i + 4] - boxes[i + 1] > 0.6 ? top : null;
        if (this.ledge !== null) at[1] = top - 0.25;
        this.anchor = at;
        this.length = Math.hypot(at[0] - eye[0], at[1] - eye[1], at[2] - eye[2]);
        return at;
      }
    }
    return null;
  }

  release(p: Player): void {
    this.anchor = null;
    this.climb = null;
    // let go in the air, the runner keeps the way the swing gave them until they land
    p.swinging = false;
    p.flung = !p.grounded;
  }

  /**
   * Pull the runner, before their own step: shorten the line while it is being reeled, and
   * take away any way they have outwards along it once it is taut.
   */
  pull(dt: number, p: Player, reel: boolean, colliders: Colliders): void {
    const a = this.anchor;
    if (!a) return;
    if (this.climb) {
      // up first, clear of whatever stands along the lip, then in over it and down onto the top
      const c = this.climb;
      c.t = Math.min(1, c.t + dt / 0.55);
      const up = Math.min(1, c.t / 0.55), over = Math.max(0, (c.t - 0.45) / 0.55);
      p.pos[0] = c.from[0] + (c.to[0] - c.from[0]) * over;
      p.pos[2] = c.from[2] + (c.to[2] - c.from[2]) * over;
      p.pos[1] = c.from[1] + (c.to[1] + 1.3 - c.from[1]) * up - 1.3 * over * over;
      p.vel[0] = p.vel[1] = p.vel[2] = 0;
      if (c.t >= 1) {
        p.pos[1] = c.to[1];
        const flat = Math.hypot(c.to[0] - c.from[0], c.to[2] - c.from[2]) || 1;
        p.vel[0] = ((c.to[0] - c.from[0]) / flat) * 2;
        p.vel[2] = ((c.to[2] - c.from[2]) / flat) * 2;
        this.release(p);
        p.flung = false;
      }
      return;
    }
    const hx = p.pos[0], hy = p.pos[1] + HANDS, hz = p.pos[2];
    const dx = a[0] - hx, dy = a[1] - hy, dz = a[2] - hz;
    const dist = Math.hypot(dx, dy, dz) || 1e-3;
    const ux = dx / dist, uy = dy / dist, uz = dz / dist;
    if (reel) this.length = Math.max(1.2, Math.min(this.length, dist) - REEL * dt);
    p.swinging = !p.grounded || dist > this.length;
    if (dist > this.length) {
      // taut: nothing outwards along it, and a pull back in to its length
      const out = -(p.vel[0] * ux + p.vel[1] * uy + p.vel[2] * uz);
      if (out > 0) {
        p.vel[0] += ux * out;
        p.vel[1] += uy * out;
        p.vel[2] += uz * out;
      }
      const k = Math.min(dist - this.length, 4) * 14 * dt;
      p.vel[0] += ux * k;
      p.vel[1] += uy * k + (p.grounded ? 2 : 0);
      p.vel[2] += uz * k;
    }
    // Up at a ledge: over it, onto the first place on top there is room to stand.
    if (this.ledge !== null && dist < 2) {
      const flat = Math.hypot(dx, dz) || 1;
      const fx = dx / flat, fz = dz / flat;
      for (const inset of [0.9, 1.6, 2.4]) {
        const x = a[0] + fx * inset, z = a[2] + fz * inset;
        const boxes = colliders(x, z);
        const ground = standOn(boxes, x, z, this.ledge);
        if (ground === null) continue;
        this.climb = { from: [p.pos[0], p.pos[1], p.pos[2]], to: [x, ground, z], t: 0 };
        return;
      }
      // nowhere to stand up there: hang off it, and let them let go
      this.ledge = null;
    }
  }

  /**
   * The line itself, a thread of light from the runner's hands to where it caught: finer and
   * closer together near the eye, where a thread of beads would otherwise show as beads.
   */
  draw(p: Player, particles: Particles, dt: number): void {
    const a = this.anchor;
    if (!a) return;
    const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
    const h: Vec3 = [p.pos[0] + fx * 0.55 - fz * 0.25, p.pos[1] + HANDS, p.pos[2] + fz * 0.55 + fx * 0.25];
    const len = Math.hypot(a[0] - h[0], a[1] - h[1], a[2] - h[2]);
    let d = 0;
    for (let i = 0; i < 400 && d < len; i++) {
      const t = d / len;
      particles.glow.add({
        pos: [h[0] + (a[0] - h[0]) * t, h[1] + (a[1] - h[1]) * t, h[2] + (a[2] - h[2]) * t],
        vel: [0, 0, 0], life: dt * 1.5, size: Math.min(0.045, 0.012 + d * 0.004), color: [0.45, 0.5, 0.55],
      });
      d += Math.min(0.35, 0.05 + d * 0.03);
    }
  }

}
