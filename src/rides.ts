// Everything about vehicles from the player's side: boarding, driving, flying,
// shooting, and the cameras for each. Also home to the hunters, who chase
// whatever the player is in.

import { Combat } from "./effects/combat";
import { Particles } from "./effects/particles";
import { Hunters, type Quarry } from "./hunters";
import type { Vec3 } from "./math";
import type { Colliders, Player } from "./player";
import { Lifts } from "./lifts";
import { Pedestrians, type Avoid } from "./pedestrians";
import { Boat } from "./vehicles/boat";
import { Metro, metroCycle, onTrack, trackOff, trainAt, TRAIN } from "./vehicles/metro";
import { Car, type RoadSurface } from "./vehicles/car";
import { Flyer } from "./vehicles/flyer";
import { Knocks } from "./vehicles/knocks";
import { Parking } from "./vehicles/parking";
import { InstanceList, Traffic } from "./vehicles/traffic";
import type { VehicleLists } from "./renderer";
import { PLAT_RISE, rideAt, type Station } from "./city/plan";
import type { World } from "./world";

const REACH = 1.6; // how close (to the body) you must be to get in
/**
 * How much heavier the car the player drives counts as than the one it hits. Equal masses
 * share a crash equally, which is the truth and no fun: a car driven into traffic at speed
 * stopped half dead. Every driving game that feels right cheats here, and so does this one.
 */
const HEFT = 3;

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
  /** Cars knocked loose from the traffic or the kerb, until they come to rest. */
  readonly knocks = new Knocks(this.traffic, this.parking);
  readonly hunters: Hunters;
  /** People on the pavements. */
  readonly pedestrians: Pedestrians;
  flyer: Flyer | null = null;
  car: Car | null = null;
  boat: Boat | null = null;
  metro: Metro | null = null;
  cockpit = false;
  private worldVersion = -1;
  private time = 0;
  /** The stations the city has streamed in; see World.stations. */
  private stations: Station[] = [];
  private carLookYaw = 0;
  private carLookPitch = 0;
  private lookIdle = 0;
  private combined = new WeakMap<Float32Array, { b: Float32Array; out: Float32Array }>();
  readonly lifts = new Lifts();
  private liftList = new InstanceList(64);
  /** The one vehicle drawn from the inside, when the camera is sitting in it. */
  private insideList = new InstanceList(1);
  private insideKind: "car" | "van" | "flyer" | null = null;
  private withLifts = new WeakMap<Float32Array, WeakMap<Float32Array, Float32Array>>();
  private joined = new WeakMap<Float32Array, WeakMap<Float32Array, Float32Array>>();

  constructor(private world: World, private player: Player) {
    this.hunters = new Hunters(this);
    this.pedestrians = new Pedestrians(world.colliders);
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

  /** Two sets of boxes as one, kept for as long as both are the same arrays. */
  private join(a: Float32Array, b: Float32Array): Float32Array {
    if (b.length === 0) return a;
    let byB = this.joined.get(a);
    if (!byB) this.joined.set(a, (byB = new WeakMap()));
    let out = byB.get(b);
    if (!out) {
      out = new Float32Array(a.length + b.length);
      out.set(a);
      out.set(b, a.length);
      byB.set(b, out);
    }
    return out;
  }

  /**
   * What a car drives into and cannot move: the city, the lifts, parked flyers and boats. Not
   * parked cars — those it knocks aside (see vehicles/knocks.ts).
   */
  readonly carColliders: Colliders = (x, z) =>
    this.join(this.join(this.world.colliders(x, z), this.parking.boxes(x, z, false)), this.lifts.boxes(x, z));

  /** The hunters' cars still on the road. */
  private hunterCars(): Car[] {
    const out: Car[] = [];
    for (const h of this.hunters.list) if (h.car && !h.dead) out.push(h.car);
    return out;
  }

  /** Into the driver's seat. */
  private board(car: Car): Car {
    car.mass *= HEFT;
    car.tumbles = false;
    this.car = car;
    return car;
  }

  /**
   * The road surface under a point, for whatever rides along it rather than standing on it.
   *
   * The same plane the carriageway is drawn from and the traffic drives on; see `RoadSurface`
   * in vehicles/car.ts for why a car cannot take this off collision instead.
   */
  readonly road: RoadSurface = rideAt;

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
    return this.flyer !== null || this.car !== null || this.boat !== null || this.metro !== null;
  }

  /** Position that drives world streaming and sound. */
  get focus(): Vec3 {
    return this.flyer?.pos ?? this.car?.pos ?? this.boat?.pos ?? this.player.pos;
  }

  get speedNorm(): number {
    return this.flyer?.speedNorm ?? this.car?.speedNorm
      ?? (this.boat ? Math.min(1, Math.abs(this.boat.speed) / 13) : undefined)
      ?? this.player.speedNorm;
  }

  sync(): void {
    if (this.world.version === this.worldVersion) return;
    this.worldVersion = this.world.version;
    this.parking.sync(this.world.pads(), this.world.parkedCars(), this.world.boats());
    this.stations = [...this.world.stations()];
    this.lifts.sync(this.world.lifts());
    this.pedestrians.sync(this.world.lifts(), this.stations);
  }

  /**
   * A train standing at the platform the runner is on, with its doors open: which way it is
   * going, and the station it is standing at.
   *
   * Reach is generous on purpose. The platform is between the two tracks, so anywhere on it
   * is beside one train or the other, and a passenger should not have to stand on a mark.
   */
  private atTrain(): { st: Station; dir: 1 | -1 } | null {
    const [x, y, z] = this.player.pos;
    for (const st of this.stations) {
      if (Math.abs(st.x - x) > TRAIN || Math.abs(st.z - z) > TRAIN) continue;
      if (Math.abs(y - (st.y + PLAT_RISE)) > 2.5) continue;
      for (const dir of [1, -1] as const) {
        if (!metroCycle(this.time, dir, true).stopped) continue;
        if (trainAt(st.axis, st.line, st.k, dir, this.time) !== st.s) continue;
        const door = onTrack(st.axis, st.line, st.s, trackOff(dir));
        // within the length of the train, and on the platform rather than out in the tunnel
        if (Math.hypot(door.pos[0] - x, door.pos[2] - z) < TRAIN / 2) return { st, dir };
      }
    }
    return null;
  }

  /** What E would do right now, for the on-screen prompt. */
  promptText(): string {
    if (this.metro) {
      const st = this.metro.stop;
      return st ? `E  step out at ${st.name}` : "";
    }
    if (this.flyer) return this.flyer.canExit ? "E  step out" : "";
    if (this.car) return this.car.canExit ? "E  step out" : "";
    if (this.boat) return "E  step ashore";
    const p = this.player.pos;
    const parked = this.parking.nearest(p[0], p[1], p[2], REACH);
    if (parked) return parked.kind === "flyer" ? "E  board flyer" : parked.kind === "boat" ? "E  board boat" : "E  get in";
    if (this.traffic.nearestCar(p[0], p[1], p[2], REACH + 1)) return "E  take this car";
    const train = this.atTrain();
    if (train) {
      const dest = new Metro(train.st.axis, train.st.line, train.dir, train.st.k, this.time).next;
      return dest ? `E  board the train for ${dest.name}` : "E  board the train";
    }
    return "";
  }

  /** The E key. Returns a message if nothing could be done. */
  interact(): string | null {
    const pl = this.player;
    if (this.metro) {
      const spot = this.metro.exitSpot();
      if (!spot) return "the train is between stations";
      pl.pos = spot;
      pl.vel = [0, 0, 0];
      this.metro = null;
      return null;
    }
    if (this.boat) {
      const b = this.boat;
      if (Math.abs(b.speed) > 1.5) return "stop first";
      this.parking.drop("boat", b.pos, b.yaw, [0.42, 0.44, 0.46]);
      pl.pos = b.exitSpot();
      pl.vel = [0, 0, 0];
      pl.yaw = b.yaw;
      pl.pitch = 0;
      this.boat = null;
      return null;
    }
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
      if (parked.kind === "boat") {
        this.boat = new Boat(parked.x, parked.y, parked.z, parked.yaw);
      } else if (parked.kind === "flyer") {
        this.flyer = new Flyer(parked.x, parked.y, parked.z, parked.yaw, parked.color);
        pl.pitch = -0.15;
      } else {
        this.board(new Car(parked.x, parked.y, parked.z, parked.yaw, parked.kind === "van", parked.color));
      }
      pl.yaw = parked.yaw;
      this.carLookYaw = this.carLookPitch = 0;
      return null;
    }
    const moving = this.traffic.nearestCar(p[0], p[1], p[2], REACH + 1);
    if (moving) {
      this.traffic.removed.add(moving.key);
      this.board(new Car(moving.pos[0], moving.pos[1], moving.pos[2], moving.yaw, moving.van, moving.color));
      pl.yaw = moving.yaw;
      this.carLookYaw = this.carLookPitch = 0;
      return null;
    }
    const train = this.atTrain();
    if (train) {
      const ride = new Metro(train.st.axis, train.st.line, train.dir, train.st.k, this.time);
      // step on where you were standing, so boarding does not shuffle you down the platform
      const door = onTrack(train.st.axis, train.st.line, train.st.s, trackOff(train.dir));
      const ahead = (p[0] - door.pos[0]) * Math.sin(door.yaw) + (p[2] - door.pos[2]) * Math.cos(door.yaw);
      ride.along = Math.max(-TRAIN / 2 + 2.5, Math.min(TRAIN / 2 - 2.5, ahead)) * train.dir;
      this.metro = ride;
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
  spawnCar(color: Vec3 = [0.55, 0.16, 0.12], van = false): Car {
    const p = this.player.pos;
    return this.board(new Car(p[0], p[1], p[2], this.player.yaw, van, color));
  }

  /** Start in a boat where the player stands (test hook, demo). */
  spawnBoat(): Boat {
    const p = this.player.pos;
    this.boat = new Boat(p[0], p[1], p[2], this.player.yaw);
    return this.boat;
  }

  /** Drop the current vehicle without parking it (demo cuts). */
  leave(): void {
    this.flyer = this.car = null;
    this.boat = null;
    this.metro = null;
    this.carLookYaw = this.carLookPitch = 0;
    this.cockpit = false;
  }

  /** Vehicle simulation for this frame (before the traffic of this frame is known). */
  drive(dt: number, c: Controls, time = 0): void {
    this.time = time;
    const pl = this.player;
    if (this.metro) {
      pl.look(c.mouseDX, c.mouseDY);
      const at = this.metro.update(dt, time, c.moveX, c.moveZ);
      pl.pos = at.pos;
      pl.vel = [0, 0, 0];
      return;
    }
    if (this.flyer) {
      pl.look(c.mouseDX, c.mouseDY);
      const was: Vec3 = [...this.flyer.pos];
      this.flyer.update(dt, {
        moveX: c.moveX, moveZ: c.moveZ, up: c.climb ?? (c.up ? 1 : 0) - (c.down ? 1 : 0), boost: c.sprint,
      }, pl.yaw, pl.pitch, this.colliders);
      this.ram(was, this.flyer);
      pl.pos = [...this.flyer.pos];
    } else if (this.car) {
      const car = this.car;
      const bodies = this.knocks.near(car, this.hunterCars());
      car.update(dt, { throttle: c.moveZ, steer: c.moveX, handbrake: c.up, boost: c.sprint }, this.carColliders, undefined, this.road, bodies);
      if (car.impact > 6 && car.contact) this.bang(car.contact, car.impact);
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
    } else if (this.boat) {
      const boat = this.boat;
      boat.update(dt, { moveX: c.moveX, moveZ: c.moveZ });
      this.carLookYaw -= c.mouseDX * 0.0022;
      this.carLookPitch = Math.max(-0.6, Math.min(0.5, this.carLookPitch - c.mouseDY * 0.0022));
      pl.yaw = boat.yaw + this.carLookYaw;
      pl.pitch = this.carLookPitch;
      // The helm is up on the wheelhouse rather than down on the deck: from the deck
      // the wheelhouse is the whole view ahead, and from the height of its roof the
      // funnel stands in the middle of that view. This clears the top of the funnel and
      // stands to starboard of it, so the way ahead is open.
      const rx = Math.cos(boat.yaw), rz = -Math.sin(boat.yaw);
      pl.pos = [boat.pos[0] + rx * 0.5, boat.pos[1] + 2.35, boat.pos[2] + rz * 0.5];
    }
    // whatever was knocked loose goes on sliding, whoever is or is not at the wheel
    this.knocks.update(dt, this.carColliders, this.road, [this.car, ...this.hunterCars()], this.focus);
    for (const b of this.knocks.bangs) this.bang(b.at, b.impact);
  }

  /** Metal meeting metal: sparks, and a crunch once it is hard enough to hear over the engine. */
  private bang(at: Vec3, impact: number): void {
    this.particles.sparks(at, Math.min(30, Math.round(impact)));
    if (impact > 12) this.combat.events.hits.push(at);
  }

  /**
   * A flyer flown into one of the air traffic's, between `was` and where it is now: the other
   * goes down, and the one that hit it loses a good part of its way.
   */
  private ram(was: Vec3, f: Flyer): void {
    const hit = this.traffic.flyerAlong(was, f.pos, 2.6);
    if (!hit) return;
    this.traffic.removed.add(hit.key);
    const v = f.vel;
    this.combat.wreckFlyer(hit.pos, [hit.vel[0] + v[0] * 0.7, hit.vel[1] + v[1] * 0.7, hit.vel[2] + v[2] * 0.7], hit.yaw, hit.color, false);
    for (let k = 0; k < 3; k++) v[k] = v[k] * 0.55 + hit.vel[k] * 0.15;
  }

  /** What the hunters are after. */
  private quarry(): Quarry {
    if (this.flyer) return { pos: this.flyer.pos, vel: this.flyer.vel, mode: "flyer", yaw: this.flyer.yaw };
    if (this.car) {
      const c = this.car;
      const [vx, vz] = c.velocity();
      return { pos: c.pos, vel: [vx, c.vy, vz], mode: "car", yaw: c.yaw, van: c.van };
    }
    if (this.boat) {
      const b = this.boat;
      return { pos: b.pos, vel: [Math.sin(b.yaw) * b.speed, 0, Math.cos(b.yaw) * b.speed], mode: "foot", yaw: b.yaw };
    }
    const p = this.player;
    return { pos: p.pos, vel: p.vel, mode: "foot", yaw: p.yaw };
  }

  /** Whoever people on the pavement step out of the way of: the runner, and anything driven at them. */
  private inTheWay(): Avoid[] {
    const out: Avoid[] = [];
    if (this.car) out.push({ x: this.car.pos[0], z: this.car.pos[2], r: this.car.van ? 3.4 : 2.9 });
    else if (!this.riding) out.push({ x: this.player.pos[0], z: this.player.pos[2], r: 0.8 });
    for (const h of this.hunters.list) {
      if (h.dead || h.flyer) continue;
      const p = h.pos;
      out.push({ x: p[0], z: p[2], r: h.car ? 2.9 : 0.8 });
    }
    return out;
  }

  /** Traffic, hunters, weapons and effects; call after drive() and once the camera is known. */
  update(dt: number, time: number, cam: RideCamera, fire: boolean): void {
    this.time = time;
    // which train, if any, is to be drawn from the inside
    const m = this.metro;
    this.traffic.ridden = m ? { axis: m.axis, line: m.line, dir: m.dir, slot: m.slot } : null;
    this.traffic.update(time, cam.eye, cam.fwd);
    this.pedestrians.update(time, cam.eye, cam.fwd, this.inTheWay());
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
    this.hunters.kits.update(dt, this.quarry(), cam);
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
        return { eye: [f.pos[0] + s * 0.32, f.pos[1] + 1.4, f.pos[2] + c * 0.32], fwd, roll: f.roll * 0.6, fov: 72 + f.speedNorm * 14 };
      }
      const eye = chase([f.pos[0], f.pos[1] + 1.7, f.pos[2]], [-fwd[0], -fwd[1], -fwd[2]], 9, 1.6, this.colliders);
      return { eye, fwd, roll: f.roll * 0.25, fov: 74 + f.speedNorm * 16 };
    }
    if (this.car) {
      const car = this.car;
      const c = Math.cos(car.yaw), s = Math.sin(car.yaw);
      if (this.cockpit) {
        // The driver's seat: behind the wheel of a car, and well forward in the cab of a
        // van, where the screen is in front of the driver rather than a load bay away.
        const ahead = car.van ? 1.5 : 0.1;
        const eye: Vec3 = [car.pos[0] + s * ahead + c * 0.38, car.pos[1] + (car.van ? 1.65 : 1.26), car.pos[2] + c * ahead - s * 0.38];
        return { eye, fwd, roll: car.roll, fov: 70 + car.speedNorm * 14 };
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
    this.parking.instances({ flyer: t.flyers, car: t.cars, van: t.vans, boat: t.boats }, eye, 300);
    if (this.boat) {
      const v = this.boat;
      t.boats.push(v.pos[0], v.pos[1], v.pos[2], v.yaw, 0, 0, [0.42, 0.44, 0.46]);
    }
    // In cockpit view the vehicle the camera is in is drawn from the inside instead.
    // The outside of one is a sealed shell with mirrored glass, so from the seat it was
    // a slab of paint across the bottom of the screen and nothing else.
    this.insideList.clear();
    this.insideKind = null;
    if (this.flyer) {
      const f = this.flyer;
      if (this.cockpit) this.insideKind = "flyer";
      const list = this.cockpit ? this.insideList : t.flyers;
      list.push(f.pos[0], f.pos[1], f.pos[2], f.yaw, f.pitch, f.roll, f.color);
    }
    if (this.car) {
      const c = this.car;
      if (this.cockpit) this.insideKind = c.van ? "van" : "car";
      const list = this.cockpit ? this.insideList : c.van ? t.vans : t.cars;
      list.push(c.pos[0], c.pos[1], c.pos[2], c.yaw, c.pitch, c.roll, c.color);
    }
    this.knocks.draw(t.cars, t.vans);
    this.combat.drawWrecks(t.flyers, t.cars, t.vans);
    this.hunters.draw(t.flyers, t.cars, t.vans);
    this.hunters.kits.draw(eye);
    this.lifts.instances(this.liftList, eye, 400);
  }

  /** Everything the renderer draws with vehicle meshes. */
  get vehicleLists(): VehicleLists {
    const t = this.traffic;
    return {
      cars: t.cars, vans: t.vans, flyers: t.flyers, boats: t.boats, trains: t.trains, cabins: t.cabins, cabinEnds: t.cabinEnds,
      figures: this.hunters.figures, walkers: this.pedestrians.lists, lifts: this.liftList, kits: this.hunters.kits.list,
      inside: this.insideKind ? { kind: this.insideKind, list: this.insideList } : undefined,
    };
  }
}
