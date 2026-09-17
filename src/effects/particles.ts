// Camera-facing particles for fire, sparks and smoke. Two populations: glowing
// (additive) and smoke (alpha blended).

import type { Vec3 } from "../math";

export const PARTICLE_INSTANCE_LAYOUT = [4, 4]; // position + size, colour + alpha

export interface Emit {
  pos: Vec3;
  vel: Vec3;
  life: number;
  size: number;
  grow?: number; // size change per second
  color: Vec3; // HDR for glowing particles
  alpha?: number;
  drag?: number;
  gravity?: number; // m/s^2, negative rises
}

class Pool {
  private pos: Float32Array;
  private vel: Float32Array;
  private info: Float32Array; // life, maxLife, size, grow, drag, gravity, alpha
  private color: Float32Array;
  count = 0;
  out: Float32Array;

  constructor(private capacity: number) {
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.info = new Float32Array(capacity * 7);
    this.color = new Float32Array(capacity * 3);
    this.out = new Float32Array(capacity * 8);
  }

  add(e: Emit): void {
    let i = this.count;
    if (i >= this.capacity) i = Math.floor(Math.random() * this.capacity); // overwrite a random one
    else this.count++;
    this.pos.set(e.pos, i * 3);
    this.vel.set(e.vel, i * 3);
    this.info.set([e.life, e.life, e.size, e.grow ?? 0, e.drag ?? 0, e.gravity ?? 0, e.alpha ?? 1], i * 7);
    this.color.set(e.color, i * 3);
  }

  update(dt: number): void {
    let n = 0;
    for (let i = 0; i < this.count; i++) {
      const I = i * 7;
      const life = this.info[I] - dt;
      if (life <= 0) continue;
      // compact live particles to the front
      if (n !== i) {
        this.pos.copyWithin(n * 3, i * 3, i * 3 + 3);
        this.vel.copyWithin(n * 3, i * 3, i * 3 + 3);
        this.info.copyWithin(n * 7, I, I + 7);
        this.color.copyWithin(n * 3, i * 3, i * 3 + 3);
      }
      const N = n * 7, P = n * 3;
      this.info[N] = life;
      const drag = Math.exp(-this.info[N + 4] * dt);
      this.vel[P] *= drag;
      this.vel[P + 1] = this.vel[P + 1] * drag - this.info[N + 5] * dt;
      this.vel[P + 2] *= drag;
      this.pos[P] += this.vel[P] * dt;
      this.pos[P + 1] += this.vel[P + 1] * dt;
      this.pos[P + 2] += this.vel[P + 2] * dt;
      this.info[N + 2] = Math.max(0.01, this.info[N + 2] + this.info[N + 3] * dt);
      n++;
    }
    this.count = n;
  }

  /** Fill the instance buffer; returns the instance count. */
  write(glow: boolean): number {
    for (let i = 0; i < this.count; i++) {
      const I = i * 7, o = i * 8;
      const t = this.info[I] / this.info[I + 1]; // 1 at birth, 0 at death
      const fade = glow ? t * t : Math.min(1, t * 2) * Math.min(1, (1 - t) * 8);
      this.out[o] = this.pos[i * 3];
      this.out[o + 1] = this.pos[i * 3 + 1];
      this.out[o + 2] = this.pos[i * 3 + 2];
      this.out[o + 3] = this.info[I + 2];
      this.out[o + 4] = this.color[i * 3];
      this.out[o + 5] = this.color[i * 3 + 1];
      this.out[o + 6] = this.color[i * 3 + 2];
      this.out[o + 7] = this.info[I + 6] * fade;
    }
    return this.count;
  }
}

export class Particles {
  readonly glow = new Pool(3000);
  readonly smoke = new Pool(2000);

  update(dt: number): void {
    this.glow.update(dt);
    this.smoke.update(dt);
  }

  private rand(): Vec3 {
    // uniform direction
    const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u);
    return [r * Math.cos(a), u, r * Math.sin(a)];
  }

  explosion(p: Vec3, base: Vec3 = [0, 0, 0], scale = 1): void {
    for (let i = 0; i < 70 * scale; i++) {
      const d = this.rand(), s = (6 + Math.random() * 22) * scale;
      this.glow.add({
        pos: p, vel: [base[0] + d[0] * s, base[1] + d[1] * s, base[2] + d[2] * s], life: 0.4 + Math.random() * 0.8,
        size: (0.8 + Math.random() * 1.8) * scale, grow: -0.6, color: [9, 3.2 + Math.random() * 2, 0.8], drag: 2.5, gravity: 4,
      });
    }
    for (let i = 0; i < 30 * scale; i++) {
      const d = this.rand(), s = 30 + Math.random() * 30;
      this.glow.add({
        pos: p, vel: [d[0] * s, d[1] * s + 5, d[2] * s], life: 0.6 + Math.random() * 0.9, size: 0.18,
        color: [12, 7, 3], drag: 0.8, gravity: 18,
      });
    }
    for (let i = 0; i < 28 * scale; i++) {
      const d = this.rand(), s = 3 + Math.random() * 7;
      this.smoke.add({
        pos: [p[0] + d[0] * 2, p[1] + d[1] * 2, p[2] + d[2] * 2], vel: [d[0] * s, d[1] * s + 2, d[2] * s],
        life: 2.5 + Math.random() * 3, size: 2 + Math.random() * 2, grow: 2.2, color: [0.08, 0.075, 0.07],
        alpha: 0.75, drag: 1.2, gravity: -1.5,
      });
    }
    // the flash
    this.glow.add({ pos: p, vel: [0, 0, 0], life: 0.25, size: 14 * scale, grow: 20, color: [16, 9, 4] });
  }

  /** Fire and smoke trailing a burning wreck. */
  burn(p: Vec3, vel: Vec3): void {
    const j = (s: number) => (Math.random() - 0.5) * s;
    this.glow.add({
      pos: [p[0] + j(1), p[1] + j(1), p[2] + j(1)], vel: [vel[0] * 0.3 + j(3), vel[1] * 0.3 + 2, vel[2] * 0.3 + j(3)],
      life: 0.35 + Math.random() * 0.3, size: 0.9 + Math.random(), grow: 1.5, color: [7, 2.2, 0.5], drag: 2,
    });
    this.smoke.add({
      pos: [p[0] + j(1), p[1] + j(1), p[2] + j(1)], vel: [j(2), 1.5, j(2)],
      life: 3 + Math.random() * 2, size: 1.2, grow: 1.8, color: [0.06, 0.06, 0.06], alpha: 0.6, drag: 0.8, gravity: -0.8,
    });
  }

  sparks(p: Vec3, n = 12): void {
    for (let i = 0; i < n; i++) {
      const d = this.rand(), s = 4 + Math.random() * 10;
      this.glow.add({
        pos: p, vel: [d[0] * s, d[1] * s + 2, d[2] * s], life: 0.2 + Math.random() * 0.4, size: 0.12,
        color: [10, 6, 2], drag: 1, gravity: 15,
      });
    }
  }

  /** A short glowing streak for a bolt in flight. */
  tracer(p: Vec3, color: Vec3): void {
    this.glow.add({ pos: p, vel: [0, 0, 0], life: 0.12, size: 0.35, grow: -1.5, color });
  }

  muzzle(p: Vec3, vel: Vec3, color: Vec3 = [6, 9, 12]): void {
    this.glow.add({ pos: p, vel, life: 0.07, size: 1.1, grow: 4, color });
  }
}
