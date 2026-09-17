// Streams city regions around the runner: generation happens in a worker pool,
// meshes are uploaded as they arrive, and collision boxes are served per cell.

import { buildRegion, CELL, REGION, REGION_CELLS, VERTEX_LAYOUT, type CellRange, type Lift, type Pad, type ParkedCar, type RegionMesh } from "./city/generate";
import { Mesh, type GL } from "./gl";
import { aabbVisible, type Vec3 } from "./math";
import type { TextureSet } from "./textures";
import type { WorkerRequest } from "./worker";

export const LOAD_RADIUS = 950;
const UNLOAD_RADIUS = 1200;
const DETAIL_DISTANCE = 230; // small boxes (steps, rails, fins) are sub-pixel beyond this

interface Region {
  mesh: Mesh;
  pads: (Pad & { id: string })[];
  cars: (ParkedCar & { id: string })[];
  lifts: Lift[];
  groundCount: number;
  cells: CellRange[];
  lo: Vec3;
  hi: Vec3;
  center: [number, number];
}

const key = (rx: number, rz: number) => `${rx},${rz}`;

export class World {
  private regions = new Map<string, Region>();
  private cells = new Map<string, Float32Array>();
  private pending = new Set<string>();
  private workers: Worker[] = [];
  private busy: number[] = [];
  private collideCache = new Map<string, Float32Array>(); // 3x3 cell neighbourhoods, most recent last
  stats = { regions: 0, drawn: 0, pending: 0 };
  /** Bumped whenever regions are added or removed. */
  version = 0;

  *pads(): Iterable<Pad & { id: string }> {
    for (const r of this.regions.values()) yield* r.pads;
  }

  *parkedCars(): Iterable<ParkedCar & { id: string }> {
    for (const r of this.regions.values()) yield* r.cars;
  }

  *lifts(): Iterable<Lift> {
    for (const r of this.regions.values()) yield* r.lifts;
  }

  constructor(private gl: GL, private seed: number) {
    const n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (e) => this.onMessage(i, e.data);
      this.workers.push(w);
      this.busy.push(0);
    }
  }

  textures(): Promise<TextureSet> {
    return new Promise((resolve) => {
      const w = this.workers[0];
      const prev = w.onmessage;
      w.onmessage = (e) => {
        if (e.data.type === "textures") {
          w.onmessage = prev;
          resolve(e.data as TextureSet);
        } else prev?.call(w, e);
      };
      w.postMessage({ type: "textures", seed: this.seed } satisfies WorkerRequest);
    });
  }

  private onMessage(worker: number, data: { type: string; mesh?: RegionMesh }): void {
    if (data.type !== "region" || !data.mesh) return;
    this.busy[worker]--;
    const m = data.mesh;
    const k = key(m.rx, m.rz);
    this.pending.delete(k);
    if (!this.regions.has(k)) this.add(m);
  }

  private add(m: RegionMesh): void {
    const x0 = m.rx * REGION, z0 = m.rz * REGION;
    const pad = 36; // bridges and stairs poke into neighbouring regions
    this.regions.set(key(m.rx, m.rz), {
      mesh: new Mesh(this.gl, m.vertices, VERTEX_LAYOUT, m.indices),
      pads: m.pads,
      cars: m.cars,
      lifts: m.lifts,
      groundCount: m.groundCount,
      cells: m.cells,
      lo: [x0 - pad, -1, z0 - pad],
      hi: [x0 + REGION + pad, m.maxHeight + 1, z0 + REGION + pad],
      center: [x0 + REGION / 2, z0 + REGION / 2],
    });
    for (const c of m.colliders) this.cells.set(key(c.ci, c.cj), c.boxes);
    this.collideCache.clear();
    this.version++;
  }

  private distance(rx: number, rz: number, x: number, z: number): number {
    const dx = Math.max(Math.abs(x - (rx + 0.5) * REGION) - REGION / 2, 0);
    const dz = Math.max(Math.abs(z - (rz + 0.5) * REGION) - REGION / 2, 0);
    return Math.hypot(dx, dz);
  }

  /** Queue missing regions (nearest first) and drop far ones. */
  update(x: number, z: number): void {
    const rx = Math.floor(x / REGION), rz = Math.floor(z / REGION);
    const span = Math.ceil(LOAD_RADIUS / REGION);
    const missing: [number, number, number][] = [];
    for (let i = rx - span; i <= rx + span; i++)
      for (let j = rz - span; j <= rz + span; j++) {
        const k = key(i, j);
        if (this.regions.has(k) || this.pending.has(k)) continue;
        const d = this.distance(i, j, x, z);
        if (d <= LOAD_RADIUS) missing.push([d, i, j]);
      }
    missing.sort((a, b) => a[0] - b[0]);
    for (const [, i, j] of missing) {
      const w = this.busy.indexOf(Math.min(...this.busy));
      if (this.busy[w] >= 2) break;
      this.busy[w]++;
      this.pending.add(key(i, j));
      this.workers[w].postMessage({ type: "region", rx: i, rz: j, seed: this.seed } satisfies WorkerRequest);
    }
    for (const [k, r] of this.regions) {
      const [i, j] = k.split(",").map(Number);
      if (this.distance(i, j, x, z) > UNLOAD_RADIUS) {
        r.mesh.dispose();
        this.regions.delete(k);
        this.version++;
        this.collideCache.clear();
        for (let ci = i * REGION_CELLS; ci < (i + 1) * REGION_CELLS; ci++)
          for (let cj = j * REGION_CELLS; cj < (j + 1) * REGION_CELLS; cj++) this.cells.delete(key(ci, cj));
      }
    }
    this.stats.regions = this.regions.size;
    this.stats.pending = this.pending.size;
  }

  /** Resolves once every region within `radius` has been loaded. */
  async ready(x: number, z: number, radius: number, progress: (f: number) => void): Promise<void> {
    for (;;) {
      this.update(x, z);
      const rx = Math.floor(x / REGION), rz = Math.floor(z / REGION);
      const span = Math.ceil(radius / REGION);
      let need = 0, have = 0;
      for (let i = rx - span; i <= rx + span; i++)
        for (let j = rz - span; j <= rz + span; j++)
          if (this.distance(i, j, x, z) <= radius) {
            need++;
            if (this.regions.has(key(i, j))) have++;
          }
      progress(have / need);
      if (have === need) return;
      await new Promise((r) => setTimeout(r, 30));
    }
  }

  colliders = (x: number, z: number): Float32Array => {
    const ci = Math.floor(x / CELL), cj = Math.floor(z / CELL);
    const k = key(ci, cj);
    const cached = this.collideCache.get(k);
    if (cached) return cached;
    const parts: Float32Array[] = [];
    for (let i = ci - 1; i <= ci + 1; i++)
      for (let j = cj - 1; j <= cj + 1; j++) {
        let cell = this.cells.get(key(i, j));
        if (!cell) {
          // not streamed in yet: build synchronously (rare)
          const m = buildRegion(Math.floor(i / REGION_CELLS), Math.floor(j / REGION_CELLS));
          this.add(m);
          cell = this.cells.get(key(i, j))!;
        }
        parts.push(cell);
      }
    const total = parts.reduce((s, p) => s + p.length, 0);
    const out = new Float32Array(total);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    // the runner, hunters and bolts ask about different places in the same frame
    if (this.collideCache.size >= 16) this.collideCache.delete(this.collideCache.keys().next().value!);
    this.collideCache.set(k, out);
    return out;
  };

  /**
   * Draw visible city blocks, nearest first so the depth test rejects hidden
   * surfaces early. Small detail boxes are skipped for distant blocks.
   */
  draw(planes: Float64Array[], eye: Vec3, lodScale = 1, record = true): void {
    const items: [number, Region, CellRange | null][] = [];
    for (const r of this.regions.values()) {
      if (!aabbVisible(planes, r.lo, r.hi)) continue;
      items.push([Math.hypot(eye[0] - r.center[0], eye[2] - r.center[1]) + REGION, r, null]);
      for (const c of r.cells) {
        if (!aabbVisible(planes, c.lo, c.hi)) continue;
        const dx = Math.max(c.lo[0] - eye[0], 0, eye[0] - c.hi[0]);
        const dz = Math.max(c.lo[2] - eye[2], 0, eye[2] - c.hi[2]);
        items.push([Math.hypot(dx, dz), r, c]);
      }
    }
    items.sort((a, b) => a[0] - b[0]);
    // one batched call per region: regions go in order of their nearest cell,
    // and each region's ranges stay nearest first
    const order: Region[] = [];
    const batches = new Map<Region, number[]>();
    const detailDist = DETAIL_DISTANCE * lodScale;
    let cells = 0;
    for (const [dist, r, c] of items) {
      let b = batches.get(r);
      if (!b) {
        b = [];
        batches.set(r, b);
        order.push(r);
      }
      if (!c) {
        b.push(0, r.groundCount);
        continue;
      }
      cells++;
      b.push(c.coarseStart, c.coarseCount);
      if (dist < detailDist) b.push(c.detailStart, c.detailCount);
    }
    for (const r of order) {
      const b = batches.get(r)!;
      if (this.starts.length * 2 < b.length) {
        this.starts = new Int32Array(b.length);
        this.counts = new Int32Array(b.length);
      }
      let n = 0;
      for (let i = 0; i < b.length; i += 2) {
        const start = b[i], count = b[i + 1];
        if (count <= 0) continue;
        // join ranges that follow each other in the index buffer
        if (n > 0 && this.starts[n - 1] + this.counts[n - 1] === start) this.counts[n - 1] += count;
        else {
          this.starts[n] = start;
          this.counts[n++] = count;
        }
      }
      r.mesh.drawRanges(this.starts, this.counts, n);
    }
    if (record) this.stats.drawn = cells;
  }

  private starts = new Int32Array(256);
  private counts = new Int32Array(256);
}
