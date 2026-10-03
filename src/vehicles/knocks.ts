// Cars knocked loose: out of the traffic stream or off the kerb by something that hit them,
// sliding, spinning or flying until they come to rest and are parked where they stopped.
//
// Traffic and parked cars cost nothing until they are touched — the one is a function of
// time and the other a list of places. Each frame, whatever is driving gets the ones around it
// as cars it can run into (see `near`), and only the ones it actually touches are kept.

import type { Vec3 } from "../math";
import type { Colliders } from "../player";
import { Car, type DriveInput, type RoadSurface } from "./car";
import type { Parking } from "./parking";
import type { InstanceList, Traffic } from "./traffic";

/** Nobody at the wheel: it rolls on with the handbrake as good as on. */
const LOOSE: DriveInput = { throttle: 0, steer: 0, handbrake: true, boost: false };
/** How far from a car others are worth offering it. */
const NEAR = 12;
/** At most this many loose at once; past it, the one loose longest is parked where it is. */
const MAX_LOOSE = 32;

interface Loose {
  car: Car;
  rest: number; // seconds it has been standing still
  age: number;
}

export class Knocks {
  private loose: Loose[] = [];
  /** Hard knocks this frame, where they landed and how hard (for sparks and sound). */
  readonly bangs: { at: Vec3; impact: number }[] = [];

  constructor(private traffic: Traffic, private parking: Parking) {}

  get cars(): Car[] {
    return this.loose.map((l) => l.car);
  }

  private add(car: Car): void {
    this.loose.push({ car, rest: 0, age: 0 });
    if (this.loose.length > MAX_LOOSE) this.settle(this.loose[0]);
  }

  private settle(l: Loose): void {
    const c = l.car;
    this.parking.drop(c.kind, c.pos, c.yaw, c.color, c.wreck || c.flipped, c.flipped);
    this.loose.splice(this.loose.indexOf(l), 1);
  }

  /**
   * The cars around `self` that it could run into: those already loose, those in `others`
   * (the player's, the hunters'), and stand-ins for the traffic and the parked cars there,
   * which come loose — out of the stream, off the kerb — the moment they are touched.
   */
  near(self: Car, others: readonly (Car | null)[] = []): Car[] {
    const [x, , z] = self.pos;
    const close = (px: number, pz: number) => Math.abs(px - x) < NEAR && Math.abs(pz - z) < NEAR;
    const out: Car[] = [];
    for (const l of this.loose) if (l.car !== self && close(l.car.pos[0], l.car.pos[2])) out.push(l.car);
    for (const c of others) if (c && c !== self && close(c.pos[0], c.pos[2])) out.push(c);

    // the traffic as it stood last frame, which is what is on screen
    const t = this.traffic;
    for (const [list, van] of [[t.cars, false], [t.vans, true]] as const) {
      const d = list.data;
      for (let i = 0; i < list.count; i++) {
        const key = list.keys[i], o = i * 10;
        if (key < 0 || t.removed.has(key) || !close(d[o], d[o + 2])) continue;
        const c = new Car(d[o], d[o + 1], d[o + 2], d[o + 3], van, [d[o + 6], d[o + 7], d[o + 8]]);
        const v = t.velocityOf(key);
        c.setVelocity(v[0], v[2]);
        c.onHit = () => {
          t.removed.add(key);
          this.add(c);
        };
        out.push(c);
      }
    }
    for (const p of this.parking.all()) {
      if ((p.kind !== "car" && p.kind !== "van") || !close(p.x, p.z) || Math.abs(p.y - self.pos[1]) > 4) continue;
      const c = new Car(p.x, p.y, p.z, p.yaw, p.kind === "van", p.color);
      c.wreck = !!p.wreck;
      if (p.flipped) {
        c.flipped = true;
        c.tumble = Math.PI;
      }
      c.onHit = () => {
        this.parking.remove(p);
        this.add(c);
      };
      out.push(c);
    }
    return out;
  }

  /** One frame for everything loose. `others` are the cars being driven, which they can hit. */
  update(dt: number, colliders: Colliders, road: RoadSurface, others: readonly (Car | null)[], focus: Vec3): void {
    this.bangs.length = 0;
    // a car knocked loose this frame joins the list and moves from the next
    for (const l of this.loose.slice()) {
      const c = l.car;
      c.update(dt, LOOSE, colliders, undefined, road, this.near(c, others));
      if (c.impact > 6 && c.contact) this.bangs.push({ at: c.contact, impact: c.impact });
      l.age += dt;
      const still = c.grounded && Math.abs(c.speed) < 0.4 && Math.abs(c.slip) < 0.4 && Math.abs(c.spin) < 0.2;
      l.rest = still ? l.rest + dt : 0;
      const far = Math.hypot(c.pos[0] - focus[0], c.pos[2] - focus[2]) > 500;
      if (l.rest > 0.5 || l.age > 30 || far) this.settle(l);
    }
  }

  draw(cars: InstanceList, vans: InstanceList): void {
    for (const { car: c } of this.loose) {
      (c.van ? vans : cars).push(c.pos[0], c.pos[1] + c.bodyLift, c.pos[2], c.yaw, c.pitch, c.bodyRoll, c.color, 0);
    }
  }
}
