// Everything about vehicles from the player's side: boarding, driving, flying,
// shooting, and the cameras for each. Also home to the hunters, who chase
// whatever the player is in.

import { Combat } from "./effects/combat";
import { Particles } from "./effects/particles";
import { Hunters, type Quarry } from "./hunters";
import type { Vec3 } from "./math";
import type { Colliders, Player } from "./player";
import { Lifts } from "./lifts";
import { Car } from "./vehicles/car";
import { Flyer } from "./vehicles/flyer";
import { Parking } from "./vehicles/parking";
import { InstanceList, Traffic } from "./vehicles/traffic";
import type { VehicleLists } from "./renderer";
import type { World } from "./world";

const REACH = 1.6; // how close (to the body) you must be to get in

export interface Controls {
  moveX: number;
  moveZ: number;
  up: boolean;
  down: boolean;
  sprint: boolean;
  fire: boolean;
  mouseDX: number;
  mouseDY: number;
  /** Analog climb (-1..1) for a flyer; overrides up / down (autopilot). */
  climb?: number;
}

export interface RideCamera {
  eye: Vec3;
  fwd: Vec3;
  roll: number;
  fov: number; // degrees
}

/** Pull a chase camera in when a box sits between the pivot and the wanted position. */
function chase(pivot: Vec3, back: Vec3, full: number, rise: number, colliders: Colliders): Vec3 {
  const boxes = colliders(pivot[0], pivot[2]);
  const at = (t: number): Vec3 => [pivot[0] + back[0] * t, pivot[1] + back[1] * t + (t / full) * rise, pivot[2] + back[2] * t];
  for (let t = 1; t <= full; t += 0.5) {
    const [x, y, z] = at(t);
    for (let i = 0; i < boxes.length; i += 6) {
      if (boxes[i] - 0.3 < x && boxes[i + 3] + 0.3 > x && boxes[i + 1] - 0.3 < y && boxes[i + 4] + 0.3 > y &&
          boxes[i + 2] - 0.3 < z && boxes[i + 5] + 0.3 > z) return at(Math.max(1, t - 0.5));
    }
  }
  return at(full);
}

export class Rides {
  readonly traffic = new Traffic();
  readonly parking = new Parking();
  readonly particles = new Particles();
  readonly combat = new Combat(this.particles);
  readonly hunters: Hunters;
  flyer: Flyer | null = null;
  car: Car | null = null;
  cockpit = false;
  private worldVersion = -1;
  private carLookYaw = 0;
  private carLookPitch = 0;
  private lookIdle = 0;
  private combined = new WeakMap<Float32Array, { b: Float32Array; out: Float32Array }>();
  readonly lifts = new Lifts();
  private liftList = new InstanceList(64);
  private withLifts = new WeakMap<Float32Array, WeakMap<Float32Array, Float32Array>>();

  constructor(private world: World, private player: Player) {
    this.hunters = new Hunters(this);
  }

  /** City collision plus parked vehicles and lift platforms. */
  colliders: Colliders = (x, z) => {
    const still = this.staticColliders(x, z), l = this.lifts.boxes(x, z);
    if (l.length === 0) return still;
    let byLift = this.withLifts.get(still);
    if (!byLift) this.withLifts.set(still, (byLift = new WeakMap()));
    let out = byLift.get(l);
    if (!out) {
      out = new Float32Array(still.length + l.length);
      out.set(still);
      out.set(l, still.length);
      byLift.set(l, out);
    }
    return out;
  };

  private staticColliders: Colliders = (x, z) => {
    const a = this.world.colliders(x, z), b = this.parking.boxes(x, z);
    let c = this.combined.get(a);
    if (!c || c.b !== b) {
      const out = new Float32Array(a.length + b.length);
      out.set(a);
      out.set(b, a.length);
      c = { b, out };
      this.combined.set(a, c);
    }
    return c.out;
  };

  get riding(): boolean {
    return this.flyer !== null || this.car !== null;
  }

  /** Position that drives world streaming and sound. */
  get focus(): Vec3 {
    return this.flyer?.pos ?? this.car?.pos ?? this.player.pos;
  }

  get speedNorm(): number {
    return this.flyer?.speedNorm ?? this.car?.speedNorm ?? this.player.speedNorm;
  }

  sync(): void {
    if (this.world.version === this.worldVersion) return;
    this.worldVersion = this.world.version;
    this.parking.sync(this.world.pads(), this.world.parkedCars());
    this.lifts.sync(this.world.lifts());
  }

  /** What E would do right now, for the on-screen prompt. */
  promptText(): string {
    if (this.flyer) return this.flyer.canExit ? "E  step out" : "";
    if (this.car) return this.car.canExit ? "E  step out" : "";
    const p = this.player.pos;
    const parked = this.parking.nearest(p[0], p[1], p[2], REACH);
    if (parked) return parked.kind === "flyer" ? "E  board flyer" : "E  get in";
    if (this.traffic.nearestCar(p[0], p[1], p[2], REACH + 1)) return "E  take this car";
    return "";
  }

  /** The E key. Returns a message if nothing could be done. */
  interact(): string | null {
    const pl = this.player;
    if (this.flyer || this.car) {
      const v = this.flyer ?? this.car!;
      if (!v.canExit) return this.flyer ? "land first" : "stop first";
      const spot = v.exitSpot(this.colliders);
      if (!spot) return "no room to step out here";
      if (this.flyer) this.parking.drop("flyer", this.flyer.pos, this.flyer.yaw, this.flyer.color);
      else this.parking.drop(this.car!.kind, this.car!.pos, this.car!.yaw, this.car!.color);
      pl.pos = spot;
      pl.vel = [0, 0, 0];
      pl.yaw = v.yaw;
      pl.pitch = 0;
      this.flyer = this.car = null;
      this.cockpit = false;
      return null;
    }
    const p = pl.pos;
    const parked = this.parking.nearest(p[0], p[1], p[2], REACH);
    if (parked) {
      this.parking.remove(parked);
      if (parked.kind === "flyer") {
        this.flyer = new Flyer(parked.x, parked.y, parked.z, parked.yaw, parked.color);
        pl.pitch = -0.15;
      } else {
        this.car = new Car(parked.x, parked.y, parked.z, parked.yaw, parked.kind === "van", parked.color);
      }
      pl.yaw = parked.yaw;
      this.carLookYaw = this.carLookPitch = 0;
      return null;
    }
    const moving = this.traffic.nearestCar(p[0], p[1], p[2], REACH + 1);
    if (moving) {
      this.traffic.removed.add(moving.key);
      this.car = new Car(moving.pos[0], moving.pos[1], moving.pos[2], moving.yaw, moving.van, moving.color);
      pl.yaw = moving.yaw;
      this.carLookYaw = this.carLookPitch = 0;
      return null;
    }
    return null;
  }

  /** Start in a flyer where the player stands (test hook, demo). */
  spawnFlyer(color: Vec3 = [0.9, 0.42, 0.12]): Flyer {
    const p = this.player.pos;
    this.flyer = new Flyer(p[0], p[1], p[2], this.player.yaw, color);
    return this.flyer;
  }

  /** Start in a car where the player stands (test hook, demo). */
  spawnCar(color: Vec3 = [0.55, 0.16, 0.12]): Car {
    const p = this.player.pos;
    this.car = new Car(p[0], p[1], p[2], this.player.yaw, false, color);
    return this.car;
  }

  /** Drop the current vehicle without parking it (demo cuts). */
  leave(): void {
    this.flyer = this.car = null;
    this.cockpit = false;
  }

  /** Vehicle simulation for this frame (before the traffic of this frame is known). */
  drive(dt: number, c: Controls): void {
    const pl = this.player;
    if (this.flyer) {
      pl.look(c.mouseDX, c.mouseDY);
      this.flyer.update(dt, {
        moveX: c.moveX, moveZ: c.moveZ, up: c.climb ?? (c.up ? 1 : 0) - (c.down ? 1 : 0), boost: c.sprint,
      }, pl.yaw, pl.pitch, this.colliders);
      pl.pos = [...this.flyer.pos];
    } else if (this.car) {
      const car = this.car;
      const traffic = this.traffic.carBoxes(car.pos[0], car.pos[2], 30);
      const hunters = this.hunters.carBoxes();
      const obstacles = new Float32Array(traffic.length + hunters.length);
      obstacles.set(traffic);
      obstacles.set(hunters, traffic.length);
      car.update(dt, { throttle: c.moveZ, steer: c.moveX, handbrake: c.up, boost: c.sprint }, this.colliders, obstacles);
      // mouse looks around; the view drifts back behind the car when left alone
      this.carLookYaw -= c.mouseDX * 0.0022;
      this.carLookPitch = Math.max(-0.6, Math.min(0.5, this.carLookPitch - c.mouseDY * 0.0022));
      if (c.mouseDX === 0 && c.mouseDY === 0) this.lookIdle += dt;
      else this.lookIdle = 0;
      if (this.lookIdle > 1.2) {
        const k = Math.min(1, dt * 2);
        this.carLookYaw -= Math.atan2(Math.sin(this.carLookYaw), Math.cos(this.carLookYaw)) * k;
        this.carLookPitch -= this.carLookPitch * k;
      }
      pl.yaw = car.yaw + this.carLookYaw;
      pl.pitch = this.carLookPitch;
      pl.pos = [...car.pos];
    }
  }

  /** What the hunters are after. */
  private quarry(): Quarry {
    if (this.flyer) return { pos: this.flyer.pos, vel: this.flyer.vel, mode: "flyer", yaw: this.flyer.yaw };
    if (this.car) {
      const c = this.car;
      return { pos: c.pos, vel: [Math.sin(c.yaw) * c.speed, c.vy, Math.cos(c.yaw) * c.speed], mode: "car", yaw: c.yaw, van: c.van };
    }
    const p = this.player;
    return { pos: p.pos, vel: p.vel, mode: "foot", yaw: p.yaw };
  }

  /** Traffic, hunters, weapons and effects; call after drive() and once the camera is known. */
  update(dt: number, time: number, cam: RideCamera, fire: boolean): void {
    this.traffic.update(time, cam.eye, cam.fwd);
    const armed = this.hunters.active;
    if (this.flyer && fire) {
      this.combat.trigger(this.flyer.pos, this.flyer.yaw, this.aimPoint(cam), this.flyer.vel);
    } else if (!this.riding && fire && armed) {
      // the runner's sidearm, held low on the right
      const [fx, fy, fz] = cam.fwd;
      const flat = Math.hypot(fx, fz) || 1;
      const muzzle: Vec3 = [cam.eye[0] + fx * 0.6 - (fz / flat) * 0.22, cam.eye[1] + fy * 0.6 - 0.25, cam.eye[2] + fz * 0.6 + (fx / flat) * 0.22];
      this.combat.triggerSidearm(muzzle, this.aimPoint(cam), this.player.vel);
    }
    this.hunters.update(dt, this.quarry(), cam);
    this.combat.update(dt, this.traffic, this.parking, this.colliders, this.hunters);
    if (this.hunters.knock && !this.riding) {
      const k = this.hunters.knock;
      for (let i = 0; i < 3; i++) this.player.vel[i] += k[i];
    }
    if (this.hunters.gotYou) this.caught();
    this.particles.update(dt);
  }

  /** The hunters got the player: whatever they were in goes up, and it's back to the last roof. */
  private caught(): void {
    const q = this.quarry();
    if (this.flyer) this.combat.wreckFlyer(q.pos, q.vel, q.yaw, this.flyer.color, false);
    else if (this.car) this.combat.wreckCar(q.pos, q.yaw, this.car.van, this.car.color, q.vel, false);
    else {
      const c: Vec3 = [q.pos[0], q.pos[1] + 1, q.pos[2]];
      this.particles.sparks(c, 30);
      this.combat.events.hits.push(c);
    }
    this.leave();
    this.player.respawn();
    this.player.pitch = 0;
    this.hunters.reset();
  }

  /** Where the guns converge: the crosshair ray, nudged onto a vehicle close to it. */
  private aimPoint(cam: RideCamera): Vec3 {
    let best: Vec3 | null = null;
    let bestAngle = 0.045; // ~2.5 degrees of aim assist
    const t = this.traffic;
    const consider = (center: Vec3, v: Vec3) => {
      const to: Vec3 = [center[0] - cam.eye[0], center[1] - cam.eye[1], center[2] - cam.eye[2]];
      const dist = Math.hypot(...to);
      if (dist > 450 || dist < 3) return;
      const angle = Math.acos(Math.min(1, (to[0] * cam.fwd[0] + to[1] * cam.fwd[1] + to[2] * cam.fwd[2]) / dist));
      if (angle >= bestAngle) return;
      bestAngle = angle;
      // lead the target by the bolt's flight time
      const flight = dist / 260;
      best = [center[0] + v[0] * flight, center[1] + v[1] * flight, center[2] + v[2] * flight];
    };
    for (const h of this.hunters.list) if (!h.dead) consider(h.center, h.vel);
    for (const [list, lift] of [[t.flyers, 0.8], [t.cars, 0.7], [t.vans, 1.0]] as const) {
      for (let i = 0; i < list.count; i++) {
        if (list.keys[i] < 0) continue;
        const o = i * 10, d = list.data;
        consider([d[o], d[o + 1] + lift, d[o + 2]], t.velocityOf(list.keys[i]));
      }
    }
    return best ?? [cam.eye[0] + cam.fwd[0] * 300, cam.eye[1] + cam.fwd[1] * 300, cam.eye[2] + cam.fwd[2] * 300];
  }

  camera(fwd: Vec3): RideCamera | null {
    if (this.flyer) {
      const f = this.flyer;
      if (this.cockpit) {
        const c = Math.cos(f.yaw), s = Math.sin(f.yaw);
        return { eye: [f.pos[0] + s * 0.35, f.pos[1] + 1.32, f.pos[2] + c * 0.35], fwd, roll: f.roll * 0.6, fov: 76 + f.speedNorm * 14 };
      }
      const eye = chase([f.pos[0], f.pos[1] + 1.7, f.pos[2]], [-fwd[0], -fwd[1], -fwd[2]], 9, 1.6, this.colliders);
      return { eye, fwd, roll: f.roll * 0.25, fov: 74 + f.speedNorm * 16 };
    }
    if (this.car) {
      const car = this.car;
      const c = Math.cos(car.yaw), s = Math.sin(car.yaw);
      if (this.cockpit) {
        // driver's seat, slightly left of centre
        const eye: Vec3 = [car.pos[0] + s * 0.1 + c * 0.38, car.pos[1] + (car.van ? 1.75 : 1.18), car.pos[2] + c * 0.1 - s * 0.38];
        return { eye, fwd, roll: car.roll, fov: 74 + car.speedNorm * 14 };
      }
      const flat = Math.hypot(fwd[0], fwd[2]) || 1;
      const back: Vec3 = [-fwd[0] / flat, -Math.max(-0.2, fwd[1]) * 0.5 - 0.1, -fwd[2] / flat];
      const eye = chase([car.pos[0], car.pos[1] + (car.van ? 2.4 : 1.8), car.pos[2]], back, car.van ? 8 : 7, 1.2, this.colliders);
      return { eye, fwd, roll: car.roll * 0.5, fov: 72 + car.speedNorm * 18 };
    }
    return null;
  }

  /** Vehicles to draw this frame (parked, piloted, wrecks). Traffic is already in the lists. */
  collectInstances(eye: Vec3): void {
    const t = this.traffic;
    this.parking.instances({ flyer: t.flyers, car: t.cars, van: t.vans }, eye, 300);
    if (this.flyer) {
      const f = this.flyer;
      t.flyers.push(f.pos[0], f.pos[1], f.pos[2], f.yaw, f.pitch, f.roll, f.color);
    }
    if (this.car) {
      const c = this.car;
      (c.van ? t.vans : t.cars).push(c.pos[0], c.pos[1], c.pos[2], c.yaw, c.pitch, c.roll, c.color);
    }
    this.combat.drawWrecks(t.flyers, t.cars, t.vans);
    this.hunters.draw(t.flyers, t.cars, t.vans);
    this.lifts.instances(this.liftList, eye, 400);
  }

  /** Everything the renderer draws with vehicle meshes. */
  get vehicleLists(): VehicleLists {
    const t = this.traffic;
    return { cars: t.cars, vans: t.vans, flyers: t.flyers, figures: this.hunters.figures, lifts: this.liftList };
  }
}
