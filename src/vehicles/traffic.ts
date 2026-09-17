// Ambient traffic. Every lane is an endless stream: a vehicle's position is a pure
// function of its slot index and time, so nothing needs simulating or saving and
// vehicles in the same lane never overlap.
//
// Cars drive on the north-south avenues (x = i * CELL) and on both kinds of elevated
// expressway. East-west streets only have parked cars, so ground traffic never
// crosses. Flyers use air corridors above the streets, at altitudes that clear
// every bridge; north-south and east-west corridors sit at different heights.

import { CELL } from "../city/generate";
import { hashInt, worldSeed, type Vec3 } from "../math";
import { PAINT_COLORS } from "./models";

export const INSTANCE_LAYOUT = [3, 3, 4]; // position, rotation (yaw, pitch, roll), colour (rgb, lights)
const STRIDE = 10;

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
const AVENUE_LANES: Lane[] = [
  { offset: -2.5, dir: 1, speed: 15, spacing: 34, density: 0.55, y: 0, bob: 0 },
  { offset: -6.0, dir: 1, speed: 10, spacing: 26, density: 0.5, y: 0, bob: 0 },
  { offset: 2.5, dir: -1, speed: 15, spacing: 34, density: 0.55, y: 0, bob: 0 },
  { offset: 6.0, dir: -1, speed: 10, spacing: 26, density: 0.5, y: 0, bob: 0 },
];
const EXPRESS_LANES = (y: number): Lane[] => [
  { offset: -2.0, dir: 1, speed: 30, spacing: 55, density: 0.5, y, bob: 0 },
  { offset: -4.6, dir: 1, speed: 23, spacing: 40, density: 0.5, y, bob: 0 },
  { offset: 2.0, dir: -1, speed: 30, spacing: 55, density: 0.5, y, bob: 0 },
  { offset: 4.6, dir: -1, speed: 23, spacing: 40, density: 0.5, y, bob: 0 },
];
const AIR_LANES = (y: number, speed: number): Lane[] => [
  { offset: -3.5, dir: 1, speed, spacing: 75, density: 0.35, y, bob: 1.6 },
  { offset: 3.5, dir: -1, speed: speed * 0.85, spacing: 75, density: 0.35, y: y + 4, bob: 1.6 },
];
const AIR_NS = [...AIR_LANES(48, 24), ...AIR_LANES(92, 30)];
const AIR_EW = [...AIR_LANES(68, 26), ...AIR_LANES(118, 34)];
const EXPRESS_NS = EXPRESS_LANES(8.1);
const EXPRESS_EW = EXPRESS_LANES(11.4);

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
  /** Slots whose vehicle was taken or destroyed; they stay empty. */
  readonly removed = new Set<number>();
  private velocities = new Map<number, Vec3>();
  private readonly seed = worldSeed() ^ 77;
  private expressCache = new Map<string, boolean>();

  private hasExpress(axis: "ns" | "ew", line: number): boolean {
    const k = `${axis}${line}`;
    let v = this.expressCache.get(k);
    if (v === undefined) {
      v = axis === "ns" ? hashInt(line, 7) % 5 === 0 : hashInt(line, 8) % 5 === 0;
      this.expressCache.set(k, v);
    }
    return v;
  }

  update(time: number, eye: Vec3, fwd: Vec3): void {
    this.cars.clear();
    this.vans.clear();
    this.flyers.clear();
    this.velocities.clear();
    const ahead = (x: number, y: number, z: number, margin: number) =>
      (x - eye[0]) * fwd[0] + (y - eye[1]) * fwd[1] + (z - eye[2]) * fwd[2] > -margin;

    // lines of both orientations near the viewer
    const span = (r: number, c: number) => [Math.floor((c - r) / CELL), Math.ceil((c + r) / CELL)];
    const [x0, x1] = span(AIR_RADIUS, eye[0]);
    const [z0, z1] = span(AIR_RADIUS, eye[2]);

    for (let i = x0; i <= x1; i++) {
      const lineX = i * CELL;
      const near = Math.abs(lineX - eye[0]) < CAR_RADIUS;
      if (near) {
        this.stream(time, "ns", i, lineX, eye[2], AVENUE_LANES, CAR_RADIUS, ahead, 0);
        if (this.hasExpress("ns", i)) this.stream(time, "ns", i, lineX, eye[2], EXPRESS_NS, CAR_RADIUS, ahead, 1);
      }
      this.stream(time, "ns", i, lineX, eye[2], AIR_NS, AIR_RADIUS, ahead, 2);
    }
    for (let j = z0; j <= z1; j++) {
      const lineZ = j * CELL;
      if (Math.abs(lineZ - eye[2]) < CAR_RADIUS && this.hasExpress("ew", j))
        this.stream(time, "ew", j, lineZ, eye[0], EXPRESS_EW, CAR_RADIUS, ahead, 3);
      this.stream(time, "ew", j, lineZ, eye[0], AIR_EW, AIR_RADIUS, ahead, 4);
    }
  }

  private stream(
    time: number, axis: "ns" | "ew", line: number, lineCoord: number, center: number, lanes: Lane[], radius: number,
    ahead: (x: number, y: number, z: number, m: number) => boolean, kind: number,
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
        // offsets are written for north-south lines; keeping right flips on east-west ones
        const across = lineCoord + (axis === "ns" ? lane.offset : -lane.offset);
        const x = axis === "ns" ? across : s;
        const z = axis === "ns" ? s : across;
        const bob = lane.bob ? Math.sin(time * 0.6 + k * 1.7) * lane.bob : 0;
        const y = lane.y + bob;
        if (!ahead(x, y, z, 40)) continue;
        // yaw faces the direction of travel: +z is 0, +x is +pi/2
        const yaw = axis === "ns" ? (lane.dir > 0 ? 0 : Math.PI) : lane.dir > 0 ? Math.PI / 2 : -Math.PI / 2;
        const v = lane.dir * lane.speed;
        this.velocities.set(key, axis === "ns" ? [0, 0, v] : [v, 0, 0]);
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
