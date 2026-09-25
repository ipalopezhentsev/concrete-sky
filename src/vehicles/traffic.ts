// Ambient traffic. Every lane is an endless stream: a vehicle's position is a pure
// function of its slot index and time, so nothing needs simulating or saving and
// vehicles in the same lane never overlap.
//
// Cars drive the arterials of the road network, following each one's spline rather than a
// straight line. Flyers use air corridors over the same arterials, at altitudes that clear
// every bridge; north-south and east-west corridors sit at different heights.

import { arteryFrame, arteryLines, RIVER_HALF, riverFrame, riverLines, waterLevel } from "../city/network";
import { hasRail, railY, roadY } from "../city/plan";
import { worldSeed, type Vec3 } from "../math";
import { CARRIAGE, PAINT_COLORS } from "./models";

export const INSTANCE_LAYOUT = [3, 3, 4]; // position, rotation (yaw, pitch, roll), colour (rgb, lights)
export const INSTANCE_STRIDE = 10;
const STRIDE = INSTANCE_STRIDE;

export class InstanceList {
  data: Float32Array;
  keys: number[] = []; // stable identity of each instance (-1 if none)
  count = 0;

  constructor(capacity: number) {
    this.data = new Float32Array(capacity * STRIDE);
  }

  clear(): void {
    this.count = 0;
  }

  push(x: number, y: number, z: number, yaw: number, pitch: number, roll: number, color: ArrayLike<number>, lights = 1, key = -1): void {
    if ((this.count + 1) * STRIDE > this.data.length) {
      const grown = new Float32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    const o = this.count * STRIDE;
    const d = this.data;
    d[o] = x;
    d[o + 1] = y;
    d[o + 2] = z;
    d[o + 3] = yaw;
    d[o + 4] = pitch;
    d[o + 5] = roll;
    d[o + 6] = color[0];
    d[o + 7] = color[1];
    d[o + 8] = color[2];
    d[o + 9] = lights;
    this.keys[this.count] = key;
    this.count++;
  }
}

/** Fast 32-bit hash of small integers. */
export function h32(a: number, b: number, c: number, d: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1) ^ Math.imul(d | 0, 0x85ebca77);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return h >>> 0;
}

interface Lane {
  offset: number; // across the line, in world units
  dir: 1 | -1;
  speed: number;
  spacing: number;
  density: number;
  y: number;
  bob: number;
}

// Cars moving +z keep to the right, which is -x.
/** Working hulls: rust, lead and dirty white, not the paint the cars come in. */
const HULLS: [number, number, number][] = [
  [0.42, 0.44, 0.46], [0.35, 0.33, 0.31], [0.48, 0.30, 0.22], [0.30, 0.36, 0.38], [0.56, 0.55, 0.52],
];

const AVENUE_LANES: Lane[] = [
  { offset: -2.5, dir: 1, speed: 15, spacing: 34, density: 0.55, y: 0, bob: 0 },
  { offset: -6.0, dir: 1, speed: 10, spacing: 26, density: 0.5, y: 0, bob: 0 },
  { offset: 2.5, dir: -1, speed: 15, spacing: 34, density: 0.55, y: 0, bob: 0 },
  { offset: 6.0, dir: -1, speed: 10, spacing: 26, density: 0.5, y: 0, bob: 0 },
];
const AIR_LANES = (y: number, speed: number): Lane[] => [
  { offset: -3.5, dir: 1, speed, spacing: 75, density: 0.35, y, bob: 1.6 },
  { offset: 3.5, dir: -1, speed: speed * 0.85, spacing: 75, density: 0.35, y: y + 4, bob: 1.6 },
];
const AIR_NS = [...AIR_LANES(48, 24), ...AIR_LANES(92, 30)];
const AIR_EW = [...AIR_LANES(68, 26), ...AIR_LANES(118, 34)];

const FLYER_COLORS = [
  [0.85, 0.84, 0.8],
  [0.9, 0.42, 0.12],
  [0.12, 0.45, 0.5],
  [0.62, 0.1, 0.08],
  [0.2, 0.22, 0.25],
];

const CAR_RADIUS = 280;
const AIR_RADIUS = 560;

/** Unique id of a stream slot. */
function slotKey(kind: number, line: number, lane: number, k: number): number {
  return ((kind * 8 + lane) * 65536 + (line + 32768)) * 16777216 + (k + 8388608);
}

export interface TrafficHit {
  key: number;
  pos: Vec3;
  yaw: number;
  vel: Vec3;
  color: Vec3;
}

export class Traffic {
  cars = new InstanceList(512);
  vans = new InstanceList(128);
  flyers = new InstanceList(256);
  boats = new InstanceList(64);
  trains = new InstanceList(64);
  /** Slots whose vehicle was taken or destroyed; they stay empty. */
  readonly removed = new Set<number>();
  private velocities = new Map<number, Vec3>();
  // The height each car is actually shown at, eased toward the road under it. Two carriageways
  // crossing on a slope cannot both be flat and agree, so a junction can still have a step in
  // it; a car reading the surface straight off jumped that step in one frame. Easing is what
  // the car the player drives has always done against the same steps.
  private shown = new Map<number, number>();
  private lastTime = 0;
  private easeStep = 1;
  private readonly seed = worldSeed() ^ 77;

  update(time: number, eye: Vec3, fwd: Vec3): void {
    // how far the shown heights catch up this frame; time can jump when a tab comes back
    this.easeStep = Math.max(0, Math.min(1, (time - this.lastTime) * 10));
    this.lastTime = time;
    if (this.shown.size > 4096) this.shown.clear();
    this.cars.clear();
    this.vans.clear();
    this.flyers.clear();
    this.boats.clear();
    this.trains.clear();
    this.velocities.clear();
    const ahead = (x: number, y: number, z: number, margin: number) =>
      (x - eye[0]) * fwd[0] + (y - eye[1]) * fwd[1] + (z - eye[2]) * fwd[2] > -margin;

    // On the road network there are no straight lines to drive down: the roads that carry
    // traffic are the arterials, and a car's place on one is a point along its spline.
    for (const line of arteryLines(eye[0], AIR_RADIUS)) {
      this.stream(time, "ns", line, 0, eye[2], AVENUE_LANES, CAR_RADIUS, ahead, 0, 1);
      this.stream(time, "ns", line, 0, eye[2], AIR_NS, AIR_RADIUS, ahead, 2, 1);
    }
    for (const line of arteryLines(eye[2], AIR_RADIUS)) {
      this.stream(time, "ew", line, 0, eye[0], AVENUE_LANES, CAR_RADIUS, ahead, 3, 0);
      this.stream(time, "ew", line, 0, eye[0], AIR_EW, AIR_RADIUS, ahead, 4, 0);
    }
    this.railways(time, eye, ahead);
    this.rivers(time, eye, ahead);
  }

  /**
   * Trains on the elevated railways: a few carriages each, one track each way, running along
   * the arterial the viaduct follows at the height of its deck.
   */
  private railways(time: number, eye: Vec3, ahead: (x: number, y: number, z: number, m: number) => boolean): void {
    const SPACING = 1300, SPEED = 26, CARS = 5, R = 900;
    for (const axis of [0, 1] as const) {
      const across = axis === 0 ? eye[2] : eye[0], centre = axis === 0 ? eye[0] : eye[2];
      for (const line of arteryLines(across, R)) {
        if (!hasRail(axis, line)) continue;
        for (const dir of [1, -1] as const) {
          const shift = dir * SPEED * time;
          for (let k = Math.floor((centre - R - shift) / SPACING) - 1; k <= Math.ceil((centre + R - shift) / SPACING); k++) {
            const h = h32(line, 90 + axis * 2 + (dir > 0 ? 0 : 1), k, this.seed);
            if ((h & 0xff) / 256 > 0.75) continue;
            const head = k * SPACING + ((h >>> 8) & 0xff) / 255 * SPACING * 0.4 + shift;
            const color = PAINT_COLORS[(h >>> 16) % PAINT_COLORS.length];
            for (let c = 0; c < CARS; c++) {
              const s = head - dir * c * CARRIAGE;
              if (Math.abs(s - centre) > R) continue;
              const { p, dir: d } = arteryFrame(axis, line, s);
              // keep right: each direction has its own pair of rails
              const off = dir > 0 ? 1.85 : -1.85;
              const x = p[0] - d[1] * off, z = p[1] + d[0] * off;
              const y = railY(axis, line, s) + 0.16;
              if (!ahead(x, y, z, 60)) continue;
              this.trains.push(x, y, z, Math.atan2(d[0] * dir, d[1] * dir), 0, 0, color);
            }
          }
        }
      }
    }
  }

  /**
   * Craft working the rivers: one lane each way, each keeping to its own side of the channel.
   *
   * Laid out like the trains rather than like the road traffic, because a river has no lanes
   * of its own to stream along — just a centreline and two banks. They are slow enough that
   * the wake would be the only thing moving on the water otherwise.
   */
  private rivers(time: number, eye: Vec3, ahead: (x: number, y: number, z: number, m: number) => boolean): void {
    const SPACING = 540, SPEED = 6.5, R = 820, LANE = RIVER_HALF * 0.3;
    for (const line of riverLines(eye[0], R)) {
      const y = waterLevel(line) + 1.2;
      for (const dir of [1, -1] as const) {
        const shift = dir * SPEED * time;
        for (let k = Math.floor((eye[2] - R - shift) / SPACING) - 1; k <= Math.ceil((eye[2] + R - shift) / SPACING); k++) {
          const h = h32(line, 140 + (dir > 0 ? 0 : 1), k, this.seed);
          if ((h & 0xff) / 256 > 0.6) continue;
          const s = k * SPACING + ((h >>> 8) & 0xff) / 255 * SPACING * 0.6 + shift;
          if (Math.abs(s - eye[2]) > R) continue;
          const { p, dir: d } = riverFrame(line, s);
          // keep to the right going down, to the left coming back
          const off = dir > 0 ? -LANE : LANE;
          const x = p[0] - d[1] * off, z = p[1] + d[0] * off;
          if (!ahead(x, y, z, 60)) continue;
          this.boats.push(x, y, z, Math.atan2(d[0] * dir, d[1] * dir), 0, 0, HULLS[(h >>> 16) % HULLS.length]);
        }
      }
    }
  }

  private stream(
    time: number, axis: "ns" | "ew", line: number, lineCoord: number, center: number, lanes: Lane[], radius: number,
    ahead: (x: number, y: number, z: number, m: number) => boolean, kind: number, curve?: 0 | 1,
  ): void {
    const air = kind === 2 || kind === 4;
    lanes.forEach((lane, li) => {
      const shift = lane.dir * lane.speed * time;
      const k0 = Math.floor((center - radius - shift) / lane.spacing) - 1;
      const k1 = Math.ceil((center + radius - shift) / lane.spacing);
      for (let k = k0; k <= k1; k++) {
        const h = h32(line, kind * 16 + li, k, this.seed);
        if ((h & 0xffff) / 0x10000 >= lane.density) continue;
        const key = slotKey(kind, line, li, k);
        if (this.removed.has(key)) continue;
        const jitter = ((h >>> 16) & 0xff) / 255 * lane.spacing * 0.35;
        const s = k * lane.spacing + jitter + shift;
        if (Math.abs(s - center) > radius) continue;
        let x: number, z: number, yaw: number, vx: number, vz: number;
        if (curve !== undefined) {
          // the station runs along the road's own spline, and the lane sits off to one side of it
          const { p, dir } = arteryFrame(curve, line, s);
          const back = lane.dir > 0 ? 1 : -1;
          x = p[0] - dir[1] * lane.offset;
          z = p[1] + dir[0] * lane.offset;
          yaw = Math.atan2(dir[0] * back, dir[1] * back);
          vx = dir[0] * lane.dir * lane.speed;
          vz = dir[1] * lane.dir * lane.speed;
        } else {
          // offsets are written for north-south lines; keeping right flips on east-west ones
          const across = lineCoord + (axis === "ns" ? lane.offset : -lane.offset);
          x = axis === "ns" ? across : s;
          z = axis === "ns" ? s : across;
          yaw = axis === "ns" ? (lane.dir > 0 ? 0 : Math.PI) : lane.dir > 0 ? Math.PI / 2 : -Math.PI / 2;
          vx = axis === "ns" ? 0 : lane.dir * lane.speed;
          vz = axis === "ns" ? lane.dir * lane.speed : 0;
        }
        const bob = lane.bob ? Math.sin(time * 0.6 + k * 1.7) * lane.bob : 0;
        // on the road network the ground is not a plane, and where the road is on a bridge the
        // surface is the deck rather than the riverbed forty metres beneath it
        // the ground is within a few tens of metres of zero, so the cull can go first and only
        // the cars actually in view pay for working out the road under them
        if (!ahead(x, lane.y + bob, z, 80)) continue;
        let ground = 0;
        if (curve !== undefined) {
          // Worked out afresh every frame. It used to be kept until the car had gone a whole
          // metre, which cost nothing while the answer was the flat tread the car stood on —
          // it did not change within a metre anyway. It is a continuous line down the slope
          // now, so holding it for a metre and then catching up is a hop several times a
          // second: the car ran straight and jumped, straight and jumped. The lookup is a
          // microsecond and it is only ever asked for cars already in view.
          const road = roadY(curve, line, s, x, z);
          const was = this.shown.get(key);
          // caught up over about a tenth of a second, and taken as read the first time a car
          // is seen so it does not arrive climbing out of the ground
          const y = was === undefined ? road : was + (road - was) * this.easeStep;
          this.shown.set(key, y);
          // the decks stand up to sixty metres over the street, and flyers at the grid city's
          // heights were flying through them
          ground = air ? y + 45 : y;
        }
        const y = lane.y + bob + ground;
        this.velocities.set(key, [vx, 0, vz]);
        if (air) {
          const color = FLYER_COLORS[h % FLYER_COLORS.length];
          this.flyers.push(x, y, z, yaw, 0.06, Math.sin(time * 0.4 + k) * 0.04, color, 1, key);
        } else {
          const color = PAINT_COLORS[(h >>> 8) % PAINT_COLORS.length];
          // vans are too tall to pass under the upper expressway
          const list = kind === 0 && (h >>> 24) % 7 === 0 ? this.vans : this.cars;
          list.push(x, y, z, yaw, 0, 0, color, 1, key);
        }
      }
    });
  }

  /** Velocity of a stream vehicle seen this frame. */
  velocityOf(key: number): Vec3 {
    return this.velocities.get(key) ?? [0, 0, 0];
  }

  private hitOf(list: InstanceList, i: number): TrafficHit {
    const o = i * STRIDE, d = list.data;
    const key = list.keys[i];
    return {
      key,
      pos: [d[o], d[o + 1], d[o + 2]],
      yaw: d[o + 3],
      vel: this.velocities.get(key) ?? [0, 0, 0],
      color: [d[o + 6], d[o + 7], d[o + 8]],
    };
  }

  /** Nearest moving car or van (from this frame) within reach of a pedestrian. */
  nearestCar(x: number, y: number, z: number, reach: number): (TrafficHit & { van: boolean }) | null {
    let best: (TrafficHit & { van: boolean }) | null = null;
    let bestD = reach;
    for (const [list, van] of [[this.cars, false], [this.vans, true]] as const) {
      for (let i = 0; i < list.count; i++) {
        if (list.keys[i] < 0) continue;
        const o = i * STRIDE;
        if (Math.abs(list.data[o + 1] - y) > 2) continue;
        const d = Math.hypot(list.data[o] - x, list.data[o + 2] - z) - 1.2;
        if (d < bestD) {
          bestD = d;
          best = { ...this.hitOf(list, i), van };
        }
      }
    }
    return best;
  }

  /** Ambient flyers whose body sphere (radius r) the segment a->b passes through; closest first. */
  flyerAlong(a: Vec3, b: Vec3, r: number): TrafficHit | null {
    const list = this.flyers;
    const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2] || 1;
    let best: TrafficHit | null = null;
    let bestT = Infinity;
    for (let i = 0; i < list.count; i++) {
      if (list.keys[i] < 0) continue;
      const o = i * STRIDE, d = list.data;
      const c: Vec3 = [d[o], d[o + 1] + 0.8, d[o + 2]];
      const t = Math.max(0, Math.min(1, ((c[0] - a[0]) * ab[0] + (c[1] - a[1]) * ab[1] + (c[2] - a[2]) * ab[2]) / len2));
      const dist = Math.hypot(a[0] + ab[0] * t - c[0], a[1] + ab[1] * t - c[1], a[2] + ab[2] * t - c[2]);
      if (dist < r && t < bestT) {
        bestT = t;
        best = this.hitOf(list, i);
      }
    }
    return best;
  }

  /** Moving car or van whose box the segment a->b enters (closest first). */
  carAlong(a: Vec3, b: Vec3, hit: (a: Vec3, b: Vec3, box: Float32Array, i: number) => number): (TrafficHit & { van: boolean }) | null {
    let best: (TrafficHit & { van: boolean }) | null = null;
    let bestT = Infinity;
    const box = new Float32Array(6);
    for (const [list, van, hx, hz, h] of [[this.cars, false, 0.98, 2.23, 1.5], [this.vans, true, 1.02, 2.83, 2.1]] as const) {
      for (let i = 0; i < list.count; i++) {
        if (list.keys[i] < 0) continue;
        const o = i * STRIDE, d = list.data;
        if (Math.min(Math.abs(d[o] - a[0]), Math.abs(d[o] - b[0])) > 10 ||
            Math.min(Math.abs(d[o + 2] - a[2]), Math.abs(d[o + 2] - b[2])) > 10) continue;
        const along = Math.abs(Math.sin(d[o + 3])) > 0.5;
        const ex = along ? hz : hx, ez = along ? hx : hz;
        box.set([d[o] - ex, d[o + 1], d[o + 2] - ez, d[o] + ex, d[o + 1] + h, d[o + 2] + ez]);
        const t = hit(a, b, box, 0);
        if (t >= 0 && t < bestT) {
          bestT = t;
          best = { ...this.hitOf(list, i), van };
        }
      }
    }
    return best;
  }

  /** Moving cars and vans whose boxes overlap the area x0..x1, z0..z1 below height top. */
  carsTouching(x0: number, z0: number, x1: number, z1: number, top: number): (TrafficHit & { van: boolean })[] {
    const out: (TrafficHit & { van: boolean })[] = [];
    for (const [list, van, hx, hz] of [[this.cars, false, 0.98, 2.23], [this.vans, true, 1.02, 2.83]] as const) {
      for (let i = 0; i < list.count; i++) {
        const o = i * STRIDE, d = list.data;
        if (list.keys[i] < 0 || d[o + 1] > top) continue;
        const along = Math.abs(Math.sin(d[o + 3])) > 0.5;
        const ex = along ? hz : hx, ez = along ? hx : hz;
        if (d[o] - ex < x1 && d[o] + ex > x0 && d[o + 2] - ez < z1 && d[o + 2] + ez > z0) out.push({ ...this.hitOf(list, i), van });
      }
    }
    return out;
  }

  /** Collision boxes of moving cars near (x, z), for the player's car. */
  carBoxes(x: number, z: number, radius: number): Float32Array {
    const out: number[] = [];
    for (const [list, hx, hz, h] of [[this.cars, 0.98, 2.23, 1.5], [this.vans, 1.02, 2.83, 2.1]] as const) {
      for (let i = 0; i < list.count; i++) {
        const o = i * STRIDE, d = list.data;
        if (list.keys[i] < 0 || Math.abs(d[o] - x) > radius || Math.abs(d[o + 2] - z) > radius) continue;
        const along = Math.abs(Math.sin(d[o + 3])) > 0.5; // travelling along x
        const ex = along ? hz : hx, ez = along ? hx : hz;
        out.push(d[o] - ex, d[o + 1], d[o + 2] - ez, d[o] + ex, d[o + 1] + h, d[o + 2] + ez);
      }
    }
    return Float32Array.from(out);
  }
}
