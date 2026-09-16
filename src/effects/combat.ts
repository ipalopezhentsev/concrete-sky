// Flyer weapons: bolts, hits on other flyers, and burning wrecks that fall and explode.

import type { Vec3 } from "../math";
import type { Colliders } from "../player";
import type { Parking } from "../vehicles/parking";
import type { InstanceList, Traffic } from "../vehicles/traffic";
import type { Particles } from "./particles";

const BOLT_SPEED = 260;
const BOLT_LIFE = 2.2;
const FIRE_INTERVAL = 0.12;
const HIT_RADIUS = 2.4;
const WRECK_GRAVITY = 14;

interface Bolt {
  pos: Vec3;
  vel: Vec3;
  life: number;
}

/** A car blown into the air; it lands as a burnt-out wreck. */
interface CarWreck {
  pos: Vec3;
  vel: Vec3;
  ground: number;
  yaw: number;
  tumble: number; // current roll
  spin: number;
  van: boolean;
  color: Vec3;
}

interface Fire {
  pos: Vec3;
  life: number;
  next: number;
}

interface Wreck {
  pos: Vec3;
  vel: Vec3;
  rot: Vec3; // yaw, pitch, roll
  spin: Vec3;
  color: Vec3;
  age: number;
  smoke: number;
}

/** Entry parameter t (0..1) where segment a->b enters the box, or -1. */
export function segmentBox(a: Vec3, b: Vec3, box: Float32Array, i: number): number {
  let t0 = 0, t1 = 1;
  for (let k = 0; k < 3; k++) {
    const d = b[k] - a[k];
    const lo = box[i + k], hi = box[i + k + 3];
    if (Math.abs(d) < 1e-9) {
      if (a[k] < lo || a[k] > hi) return -1;
      continue;
    }
    let ta = (lo - a[k]) / d, tb = (hi - a[k]) / d;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return -1;
  }
  return t0;
}

function segmentSphere(a: Vec3, b: Vec3, c: Vec3, r: number): boolean {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2] || 1;
  const t = Math.max(0, Math.min(1, ((c[0] - a[0]) * ab[0] + (c[1] - a[1]) * ab[1] + (c[2] - a[2]) * ab[2]) / len2));
  return Math.hypot(a[0] + ab[0] * t - c[0], a[1] + ab[1] * t - c[1], a[2] + ab[2] * t - c[2]) < r;
}

export interface CombatEvents {
  shots: number;
  hits: Vec3[];
  explosions: Vec3[];
}

export class Combat {
  private bolts: Bolt[] = [];
  private wrecks: Wreck[] = [];
  private carWrecks: CarWreck[] = [];
  private fires: Fire[] = [];
  carKills = 0;
  private cooldown = 0;
  private side = 1;
  kills = 0;
  events: CombatEvents = { shots: 0, hits: [], explosions: [] };

  constructor(private particles: Particles) {}

  /** Fire from a flyer if the gun is ready. muzzleBase is the craft's centre. */
  trigger(muzzleBase: Vec3, yaw: number, target: Vec3, inherit: Vec3): void {
    if (this.cooldown > 0) return;
    this.cooldown = FIRE_INTERVAL;
    // alternate between the two front rotor pods
    this.side = -this.side;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const muzzle: Vec3 = [
      muzzleBase[0] + s * 2.0 - c * 1.2 * this.side,
      muzzleBase[1] + 0.9,
      muzzleBase[2] + c * 2.0 + s * 1.2 * this.side,
    ];
    const d: Vec3 = [target[0] - muzzle[0], target[1] - muzzle[1], target[2] - muzzle[2]];
    const len = Math.hypot(...d) || 1;
    const vel: Vec3 = [0, 1, 2].map((k) => (d[k] / len) * BOLT_SPEED + inherit[k]) as Vec3;
    this.bolts.push({ pos: muzzle, vel, life: BOLT_LIFE });
    this.particles.muzzle(muzzle, inherit);
    this.events.shots++;
  }

  private addWreck(pos: Vec3, vel: Vec3, yaw: number, color: Vec3): void {
    const r = () => (Math.random() - 0.5);
    this.wrecks.push({
      pos: [...pos], vel: [vel[0] + r() * 6, vel[1] + 4, vel[2] + r() * 6], rot: [yaw, 0, 0],
      spin: [r() * 3, 1 + Math.random() * 1.5, r() * 5], color: [color[0] * 0.35, color[1] * 0.3, color[2] * 0.3],
      age: 0, smoke: 0,
    });
    this.kills++;
    this.particles.explosion([pos[0], pos[1] + 0.8, pos[2]], vel, 0.45);
    this.events.hits.push([...pos]);
  }

  private addCarWreck(pos: Vec3, yaw: number, van: boolean, color: Vec3, inherit: Vec3): void {
    this.carWrecks.push({
      pos: [...pos], vel: [inherit[0] * 0.5 + (Math.random() - 0.5) * 3, 6 + Math.random() * 3, inherit[2] * 0.5 + (Math.random() - 0.5) * 3],
      ground: pos[1], yaw, tumble: 0, spin: (Math.random() < 0.5 ? -1 : 1) * (4 + Math.random() * 3), van,
      color: [color[0] * 0.18 + 0.02, color[1] * 0.16 + 0.02, color[2] * 0.15 + 0.02],
    });
    this.carKills++;
    const c: Vec3 = [pos[0], pos[1] + 0.9, pos[2]];
    this.particles.explosion(c, [0, 2, 0], 0.8);
    this.events.explosions.push(c);
  }

  update(dt: number, traffic: Traffic, parking: Parking, colliders: Colliders): void {
    this.cooldown -= dt;
    const survivors: Bolt[] = [];
    for (const b of this.bolts) {
      b.life -= dt;
      const a = b.pos;
      const e: Vec3 = [a[0] + b.vel[0] * dt, a[1] + b.vel[1] * dt, a[2] + b.vel[2] * dt];
      this.particles.tracer(a, [3, 6, 14]);
      this.particles.tracer([(a[0] + e[0]) / 2, (a[1] + e[1]) / 2, (a[2] + e[2]) / 2], [3, 6, 14]);

      // flyers in the air corridors
      const hit = traffic.flyerAlong(a, e, HIT_RADIUS);
      if (hit) {
        traffic.removed.add(hit.key);
        this.addWreck(hit.pos, hit.vel, hit.yaw, hit.color);
        continue;
      }
      // parked flyers
      let parkedHit = false;
      for (const p of parking.all()) {
        if (p.kind !== "flyer" || Math.abs(p.x - a[0]) > 12 && Math.abs(p.x - e[0]) > 12) continue;
        if (segmentSphere(a, e, [p.x, p.y + 0.8, p.z], HIT_RADIUS)) {
          parking.remove(p);
          this.addWreck([p.x, p.y, p.z], [0, 0, 0], p.yaw, p.color);
          parkedHit = true;
          break;
        }
      }
      if (parkedHit) continue;

      // cars in traffic and at the kerb (a bolt stops at whichever it meets first)
      const moving = traffic.carAlong(a, e, segmentBox);
      if (moving) {
        traffic.removed.add(moving.key);
        this.addCarWreck(moving.pos, moving.yaw, moving.van, moving.color, moving.vel);
        continue;
      }
      const parkedCar = parking.carAlong(a, e, segmentBox);
      if (parkedCar) {
        parking.remove(parkedCar);
        this.addCarWreck([parkedCar.x, parkedCar.y, parkedCar.z], parkedCar.yaw, parkedCar.kind === "van", parkedCar.color, [0, 0, 0]);
        continue;
      }

      // buildings and ground
      const boxes = colliders(e[0], e[2]);
      let tHit = e[1] < 0 ? Math.max(0, a[1] / (a[1] - e[1])) : 2;
      for (let i = 0; i < boxes.length; i += 6) {
        const t = segmentBox(a, e, boxes, i);
        if (t >= 0 && t < tHit) tHit = t;
      }
      if (tHit <= 1) {
        const p: Vec3 = [a[0] + (e[0] - a[0]) * tHit, a[1] + (e[1] - a[1]) * tHit, a[2] + (e[2] - a[2]) * tHit];
        this.particles.sparks(p);
        continue;
      }
      b.pos = e;
      if (b.life > 0) survivors.push(b);
    }
    this.bolts = survivors;

    // falling wrecks
    const alive: Wreck[] = [];
    for (const w of this.wrecks) {
      w.age += dt;
      w.vel[1] -= WRECK_GRAVITY * dt;
      const drag = Math.exp(-0.3 * dt);
      w.vel[0] *= drag;
      w.vel[2] *= drag;
      for (let k = 0; k < 3; k++) {
        w.pos[k] += w.vel[k] * dt;
        w.rot[k] += w.spin[k] * dt;
      }
      w.smoke -= dt;
      if (w.smoke <= 0) {
        w.smoke = 0.025;
        this.particles.burn([w.pos[0], w.pos[1] + 0.8, w.pos[2]], w.vel);
      }
      const boxes = colliders(w.pos[0], w.pos[2]);
      let crashed = w.pos[1] <= 0 || w.age > 15;
      for (let i = 0; i < boxes.length && !crashed; i += 6) {
        if (boxes[i] < w.pos[0] + 1 && boxes[i + 3] > w.pos[0] - 1 && boxes[i + 2] < w.pos[2] + 1 &&
            boxes[i + 5] > w.pos[2] - 1 && boxes[i + 1] < w.pos[1] + 1 && boxes[i + 4] > w.pos[1]) crashed = true;
      }
      if (crashed) {
        const p: Vec3 = [w.pos[0], Math.max(w.pos[1], 0) + 1, w.pos[2]];
        this.particles.explosion(p, [0, 0, 0], 1);
        this.events.explosions.push(p);
      } else alive.push(w);
    }
    this.wrecks = alive;

    // cars flipping through the air, then left burning
    const flying: CarWreck[] = [];
    for (const w of this.carWrecks) {
      w.vel[1] -= 20 * dt;
      for (let k = 0; k < 3; k++) w.pos[k] += w.vel[k] * dt;
      w.tumble += w.spin * dt;
      if (w.pos[1] <= w.ground && w.vel[1] < 0) {
        w.pos[1] = w.ground;
        // settle on its roof or wheels, whichever is nearer
        const upright = Math.cos(w.tumble) > 0;
        parking.drop(w.van ? "van" : "car", w.pos, w.yaw, w.color, true, !upright);
        this.fires.push({ pos: [w.pos[0], w.pos[1] + 1, w.pos[2]], life: 25 + Math.random() * 10, next: 0 });
        this.particles.sparks([w.pos[0], w.pos[1] + 0.3, w.pos[2]], 20);
        this.events.hits.push([...w.pos]);
      } else flying.push(w);
    }
    this.carWrecks = flying;

    const burning: Fire[] = [];
    for (const f of this.fires) {
      f.life -= dt;
      f.next -= dt;
      if (f.next <= 0) {
        f.next = f.life > 8 ? 0.04 : 0.12; // dies down toward the end
        this.particles.burn(f.pos, [0, 0, 0]);
      }
      if (f.life > 0) burning.push(f);
    }
    this.fires = burning;
  }


  drawWrecks(flyers: InstanceList, cars: InstanceList, vans: InstanceList): void {
    for (const w of this.wrecks) flyers.push(w.pos[0], w.pos[1], w.pos[2], w.rot[0], w.rot[1], w.rot[2], w.color, 0);
    for (const w of this.carWrecks) {
      // tumble about the car's long axis; lift so the body turns around its middle
      const h = w.van ? 2.1 : 1.5;
      const lift = (1 - Math.cos(w.tumble)) * 0.5 * h + Math.abs(Math.sin(w.tumble)) * 0.9;
      (w.van ? vans : cars).push(w.pos[0], w.pos[1] + lift, w.pos[2], w.yaw, 0, w.tumble, w.color, 0);
    }
  }

  /** Take and reset this frame's events (for sound). */
  takeEvents(): CombatEvents {
    const e = this.events;
    this.events = { shots: 0, hits: [], explosions: [] };
    return e;
  }
}
