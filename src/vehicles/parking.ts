// Vehicles standing still: flyers on landing pads, cars at the kerb, and anything
// the player has parked. Provides collision boxes, instances and lookup.

import type { Pad, ParkedCar } from "../city/generate";
import type { Vec3 } from "../math";
import { BOAT_DIMS } from "./boat";
import { FLYER_PALETTE } from "./flyer";
import { CAR_DIMS } from "./models";
import { h32, type InstanceList } from "./traffic";

export type VehicleKind = "flyer" | "car" | "van" | "boat";

export interface Parked {
  id: string;
  kind: VehicleKind;
  x: number;
  y: number;
  z: number;
  yaw: number;
  color: Vec3;
  wreck?: boolean; // burnt out: still solid, can't be entered
  flipped?: boolean; // lying on its roof
}

/** Axis-aligned bounds of a vehicle footprint rotated by yaw. */
export function footprint(kind: VehicleKind, yaw: number): { hx: number; hz: number; h: number } {
  if (kind === "flyer") return { hx: 1.0, hz: 1.0, h: 1.55 };
  if (kind === "boat") {
    const c = Math.abs(Math.cos(yaw)), s = Math.abs(Math.sin(yaw));
    return { hx: c * BOAT_DIMS.hx + s * BOAT_DIMS.hz, hz: s * BOAT_DIMS.hx + c * BOAT_DIMS.hz, h: BOAT_DIMS.h };
  }
  const d = CAR_DIMS[kind];
  const c = Math.abs(Math.cos(yaw)), s = Math.abs(Math.sin(yaw));
  return { hx: c * d.hx + s * d.hz, hz: s * d.hx + c * d.hz, h: d.h };
}

export class Parking {
  private fromCity = new Map<string, Parked>();
  private dropped = new Map<string, Parked>();
  private gone = new Set<string>(); // city vehicles taken or destroyed
  private dropCount = 0;
  version = 0;
  private boxCache = new Map<string, Float32Array>();
  private boxVersion = -1;

  /** Replace the city-spawned vehicles with those of the currently loaded regions. */
  sync(
    pads: Iterable<Pad & { id: string }>,
    cars: Iterable<ParkedCar & { id: string }>,
    boats: Iterable<Pad & { id: string }> = [],
  ): void {
    this.fromCity.clear();
    for (const p of pads) {
      if (this.gone.has(p.id)) continue;
      const h = h32(p.x | 0, p.z | 0, p.y | 0, 5);
      this.fromCity.set(p.id, {
        id: p.id, kind: "flyer", x: p.x, y: p.y, z: p.z, yaw: p.yaw, color: FLYER_PALETTE[h % FLYER_PALETTE.length],
      });
    }
    for (const c of cars) {
      if (this.gone.has(c.id)) continue;
      this.fromCity.set(c.id, { id: c.id, kind: c.van ? "van" : "car", x: c.x, y: c.y, z: c.z, yaw: c.yaw, color: c.color });
    }
    for (const v of boats) {
      if (this.gone.has(v.id)) continue;
      this.fromCity.set(v.id, { id: v.id, kind: "boat", x: v.x, y: v.y, z: v.z, yaw: v.yaw, color: [0.42, 0.44, 0.46] });
    }
    this.version++;
  }

  *all(): Iterable<Parked> {
    yield* this.fromCity.values();
    yield* this.dropped.values();
  }

  /** Closest vehicle whose body is within reach of a person standing at (x, y, z). */
  nearest(x: number, y: number, z: number, reach: number): Parked | null {
    let best: Parked | null = null;
    let bestD = reach;
    for (const p of this.all()) {
      if (p.wreck || Math.abs(p.y - y) > 2.5) continue;
      const f = footprint(p.kind, p.yaw);
      const dx = Math.max(Math.abs(x - p.x) - f.hx, 0);
      const dz = Math.max(Math.abs(z - p.z) - f.hz, 0);
      const d = Math.hypot(dx, dz);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  /** Remove a vehicle (taken by the player or destroyed). */
  remove(p: Parked): void {
    if (this.fromCity.delete(p.id)) this.gone.add(p.id);
    this.dropped.delete(p.id);
    this.version++;
  }

  drop(kind: VehicleKind, pos: Vec3, yaw: number, color: Vec3, wreck = false, flipped = false): void {
    const id = `drop-${this.dropCount++}`;
    this.dropped.set(id, { id, kind, x: pos[0], y: pos[1], z: pos[2], yaw, color, wreck, flipped });
    this.version++;
  }

  instances(lists: Record<VehicleKind, InstanceList>, eye: Vec3, radius: number): void {
    for (const p of this.all()) {
      if (Math.hypot(p.x - eye[0], p.z - eye[2]) > radius) continue;
      // a flipped body turns about its base, so lift it by its height
      const lift = p.flipped ? footprint(p.kind, 0).h : 0;
      lists[p.kind].push(p.x, p.y + lift, p.z, p.yaw, 0, p.flipped ? Math.PI : 0, p.color, p.kind === "flyer" && !p.wreck ? 0.3 : 0);
    }
  }

  /** Parked cars and vans (not flyers, not wrecks) whose box the segment a->b enters; closest first. */
  carAlong(a: Vec3, b: Vec3, hit: (a: Vec3, b: Vec3, box: Float32Array, i: number) => number): Parked | null {
    let best: Parked | null = null;
    let bestT = Infinity;
    const box = new Float32Array(6);
    for (const p of this.all()) {
      if (p.kind === "flyer" || p.wreck) continue;
      if (Math.min(Math.abs(p.x - a[0]), Math.abs(p.x - b[0])) > 12 || Math.min(Math.abs(p.z - a[2]), Math.abs(p.z - b[2])) > 12) continue;
      const f = footprint(p.kind, p.yaw);
      box.set([p.x - f.hx, p.y, p.z - f.hz, p.x + f.hx, p.y + f.h, p.z + f.hz]);
      const t = hit(a, b, box, 0);
      if (t >= 0 && t < bestT) {
        bestT = t;
        best = p;
      }
    }
    return best;
  }

  /** Collision boxes of parked vehicles near (x, z). */
  boxes(x: number, z: number): Float32Array {
    if (this.boxVersion !== this.version) {
      this.boxCache.clear();
      this.boxVersion = this.version;
    }
    const key = `${Math.round(x / 40)},${Math.round(z / 40)}`;
    const cached = this.boxCache.get(key);
    if (cached) return cached;
    const list: number[] = [];
    for (const p of this.all()) {
      if (Math.abs(p.x - x) > 160 || Math.abs(p.z - z) > 160) continue;
      const f = footprint(p.kind, p.yaw);
      list.push(p.x - f.hx, p.y, p.z - f.hz, p.x + f.hx, p.y + f.h, p.z + f.hz);
    }
    const boxes = Float32Array.from(list);
    this.boxCache.set(key, boxes);
    return boxes;
  }
}
