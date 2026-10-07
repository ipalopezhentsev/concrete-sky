// Health kits: white cases with a red cross, turning slowly a hand's width off the ground.
// A hunter brought down sometimes leaves one where they fell — on the ground, or hanging in
// the air where a flyer was shot down — and while the hunt is on one turns up now and then a
// little way ahead of you, on your own level. Walk, drive or fly through one to patch
// yourself up; at full health you pass straight through and it stays for later.

import type { Particles } from "./effects/particles";
import type { Hunters, Quarry, View } from "./hunters";
import type { Vec3 } from "./math";
import { InstanceList } from "./vehicles/traffic";

/** Health one kit gives back. */
export const HEAL = 40;
const LIFE = 75; // seconds a kit lies there
const BLINK = 6; // the last seconds of it, when it flickers
const EVERY = [22, 34]; // seconds between kits put down near the runner
const NEAR = 150; // no new one while this many are already within this range
const MOST_NEAR = 2;
const DROP = 0.5; // the chance a downed hunter leaves one
const REACH = { foot: 1.1, car: 2.6, flyer: 2.8 };
const HOVER = 0.25; // bottom of the case above the ground
const CASE: Vec3 = [0.86, 0.85, 0.82];

interface Kit {
  pos: Vec3; // the ground under it, or for one in the air the point it hangs from
  /** Left by a flyer: it hangs where the flyer went down, and is taken by flying through it. */
  air: boolean;
  age: number;
  spin: number;
}

export class Kits {
  readonly list = new InstanceList(8);
  /** Kits taken so far (for sound and the health bar). */
  taken = 0;
  private kits: Kit[] = [];
  private timer = EVERY[0];
  private time = 0;

  constructor(private hunters: Hunters, private particles: Particles, private rand = Math.random) {}

  get count(): number {
    return this.kits.length;
  }

  clear(): void {
    this.kits.length = 0;
    this.timer = EVERY[0];
  }

  /** Put a kit down on the ground at pos, or leave it hanging there in the air (tests, and where a hunter fell). */
  add(pos: Vec3, air = false): void {
    this.kits.push({ pos: [...pos], air, age: 0, spin: this.rand() * Math.PI * 2 });
  }

  /** Call after the hunters and the bolts of the frame, so the fallen of this frame are known. */
  update(dt: number, q: Quarry, view: View): void {
    const h = this.hunters;
    if (!h.active) return;
    this.time += dt;

    for (const { pos: p, air } of h.fallen) {
      if (this.rand() >= DROP) continue;
      if (air) {
        this.add(p, true);
        continue;
      }
      const y = h.standAt(p[0], p[2], p[1]);
      if (y !== null) this.add([p[0], y, p[2]]);
    }

    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = EVERY[0] + this.rand() * (EVERY[1] - EVERY[0]);
      let near = 0;
      for (const k of this.kits) if (Math.hypot(k.pos[0] - q.pos[0], k.pos[2] - q.pos[2]) < NEAR) near++;
      if (near < MOST_NEAR && q.mode !== "flyer") this.place(q, view);
    }

    const reach = REACH[q.mode];
    for (let i = this.kits.length - 1; i >= 0; i--) {
      const k = this.kits[i];
      k.age += dt;
      const flat = Math.hypot(k.pos[0] - q.pos[0], k.pos[2] - q.pos[2]);
      const rise = q.pos[1] - k.pos[1];
      // one in the air is taken by passing through it, from any side: centre to centre
      const into = k.air
        ? Math.hypot(flat, q.pos[1] + (q.mode === "foot" ? 1 : 0.8) - (k.pos[1] + HOVER + 0.2)) < reach + 0.4
        : flat < reach && rise > -1 && rise < 1.5;
      if (into && h.heal(HEAL)) {
        this.taken++;
        this.burst(k);
        this.kits.splice(i, 1);
      } else if (k.age > LIFE || flat > 320) this.kits.splice(i, 1);
    }
  }

  /** Somewhere ahead of the runner, on their level, in the open. */
  private place(q: Quarry, view: View): void {
    const ahead = Math.atan2(view.fwd[0], view.fwd[2]);
    for (let tries = 0; tries < 30; tries++) {
      const a = ahead + (this.rand() - 0.5) * 2.2;
      const d = 18 + this.rand() * 26;
      const x = q.pos[0] + Math.sin(a) * d, z = q.pos[2] + Math.cos(a) * d;
      const y = this.hunters.standAt(x, z, q.pos[1]);
      if (y === null) continue;
      this.add([x, y, z]);
      return;
    }
  }

  /** A puff of light where one was taken. */
  private burst(k: Kit): void {
    const c: Vec3 = [k.pos[0], k.pos[1] + HOVER + 0.2, k.pos[2]];
    for (let i = 0; i < 24; i++) {
      const a = this.rand() * Math.PI * 2, s = 1 + this.rand() * 2.5;
      this.particles.glow.add({
        pos: c, vel: [Math.cos(a) * s, 2 + this.rand() * 3, Math.sin(a) * s], life: 0.4 + this.rand() * 0.5,
        size: 0.14, color: [6, 1.2, 1], drag: 2, gravity: -1,
      });
    }
    this.particles.glow.add({ pos: c, vel: [0, 0, 0], life: 0.3, size: 1.2, grow: 6, color: [4, 1.4, 1.2] });
  }

  /** Into the list the renderer draws, with a faint red glow so one can be found from across a street. */
  draw(eye: Vec3): void {
    this.list.clear();
    for (const k of this.kits) {
      const left = LIFE - k.age;
      if (left < BLINK && Math.floor(left * 6) % 2 === 0) continue;
      const bob = Math.sin(this.time * 2.2 + k.spin) * 0.06;
      const y = k.pos[1] + HOVER + bob;
      this.list.push(k.pos[0], y, k.pos[2], k.spin + this.time * 1.4, 0, 0, CASE);
      // small up close, where the case speaks for itself; wider further off, where it is a speck
      const dist = Math.hypot(k.pos[0] - eye[0], k.pos[1] - eye[1], k.pos[2] - eye[2]);
      if (dist < 200) {
        const pulse = (0.75 + 0.25 * Math.sin(this.time * 4 + k.spin)) * Math.min(1, dist / 25);
        this.particles.glow.add({
          pos: [k.pos[0], y + 0.2, k.pos[2]], vel: [0, 0, 0], life: 0.03, size: Math.min(1.2, 0.25 + dist * 0.02),
          color: [1.6 * pulse, 0.25 * pulse, 0.2 * pulse],
        });
      }
    }
  }

  /** Where the kits are, for the radar. */
  where(): Vec3[] {
    return this.kits.map((k) => k.pos);
  }
}
