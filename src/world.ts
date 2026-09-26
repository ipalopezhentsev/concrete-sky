// Streams city regions around the runner: generation happens in a worker pool,
// meshes are uploaded as they arrive, and collision boxes are served per cell.

import { buildPlanRegion } from "./city/plan";
import { CELL, REGION, REGION_CELLS, VERTEX_LAYOUT, type CellRange, type Lift, type Pad, type ParkedCar, type RegionMesh } from "./city/generate";
import { Mesh, type GL } from "./gl";
import { aabbVisible, type Vec3 } from "./math";
import type { TextureSet } from "./textures";
import type { WorkerRequest } from "./worker";

export const LOAD_RADIUS = 950;
const UNLOAD_RADIUS = 1200;
const DETAIL_DISTANCE = 230; // small boxes (steps, rails, fins) are sub-pixel beyond this
const FAR_DISTANCE = 700; // beyond this only the boxes that still read as shapes are drawn

interface Region {
  mesh: Mesh;
  pads: (Pad & { id: string })[];
  lamps: number[];
  cars: (ParkedCar & { id: string })[];
  lifts: Lift[];
  boats: (Pad & { id: string })[];
  groundCount: number;
  cells: CellRange[];
  lo: Vec3;
  hi: Vec3;
  center: [number, number];
  /** Grid cells this region put colliders into — its own, and a few of its neighbours'. */
  touched: string[];
}

const key = (rx: number, rz: number) => `${rx},${rz}`;

export class World {
  private regions = new Map<string, Region>();
  // Colliders per grid cell, kept per region: a block or bridge that straddles a region seam
  // lands boxes in the neighbour's cells too, and neither region may overwrite the other's.
  private cells = new Map<string, Map<string, Float32Array>>();
  private pending = new Set<string>();
  private workers: Worker[] = [];
  private busy: number[] = [];
  private collideCache = new Map<string, Float32Array>(); // 3x3 cell neighbourhoods, most recent last
  // Block outlines for the map, tile by tile. They outlive the regions they overlap — a map
  // is worth having for ground the runner has left — so they are kept on their own count.
  private mapCache = new Map<string, Float32Array>();
  private mapBusy = new Set<string>();
  private mapQueue: string[] = [];
  /** Bumped whenever a map tile arrives, so the map knows to draw itself again. */
  mapVersion = 0;
  stats = { regions: 0, drawn: 0, pending: 0, tris: 0 };
  /** Scales the distance at which small detail boxes stop being drawn (diagnostic knob). */
  detailScale = 1;
  /** Same, for the tier of smaller structural boxes. */
  farScale = 1;
  /** Build-time removal of faces buried inside other boxes (diagnostic knob). */
  faceCull = true;
  /** Bumped whenever regions are added or removed. */
  version = 0;

  /**
   * The street lamps nearest a point, as x, y, z triples, nearest first: the renderer lights
   * the network city's streets from these, since there is no lamp grid to work them out from.
   */
  lampsNear(x: number, z: number, n: number): Float32Array {
    const found: [number, number, number, number][] = [];
    for (const r of this.regions.values()) {
      if (Math.abs(r.center[0] - x) > REGION * 1.5 || Math.abs(r.center[1] - z) > REGION * 1.5) continue;
      const l = r.lamps;
      for (let i = 0; i < l.length; i += 3) found.push([(l[i] - x) ** 2 + (l[i + 2] - z) ** 2, l[i], l[i + 1], l[i + 2]]);
    }
    found.sort((a, b) => a[0] - b[0]);
    const out = new Float32Array(n * 3).fill(-1e5);
    for (let i = 0; i < Math.min(n, found.length); i++) out.set(found[i].slice(1), i * 3);
    return out;
  }

  *pads(): Iterable<Pad & { id: string }> {
    for (const r of this.regions.values()) yield* r.pads;
  }

  *parkedCars(): Iterable<ParkedCar & { id: string }> {
    for (const r of this.regions.values()) yield* r.cars;
  }

  *lifts(): Iterable<Lift> {
    for (const r of this.regions.values()) yield* r.lifts;
  }

  *boats(): Iterable<Pad & { id: string }> {
    for (const r of this.regions.values()) yield* r.boats;
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

  /**
   * Block outlines for the tiles asked for, those that are ready, with the rest queued.
   *
   * The whole list is given every time and replaces the last one, nearest first, so the map
   * always works outward from wherever it is centred now rather than finishing an errand it
   * was sent on two zoom levels ago.
   */
  mapTiles(want: [number, number][]): Float32Array[] {
    const out: Float32Array[] = [];
    this.mapQueue.length = 0;
    for (const [tx, tz] of want) {
      const k = key(tx, tz);
      const hit = this.mapCache.get(k);
      if (hit) out.push(hit);
      else if (!this.mapBusy.has(k)) this.mapQueue.push(k);
    }
    return out;
  }

  /** True while any tile the map last asked for is still being worked out. */
  get mapBusyCount(): number {
    return this.mapQueue.length + this.mapBusy.size;
  }

  private onMessage(worker: number, data: { type: string; mesh?: RegionMesh; tx?: number; tz?: number; blocks?: Float32Array }): void {
    if (data.type === "map" && data.blocks) {
      this.busy[worker]--;
      const k = key(data.tx!, data.tz!);
      this.mapBusy.delete(k);
      // a few hundred tiles is a city twenty kilometres across; older ones can go
      if (this.mapCache.size > 400) this.mapCache.clear();
      this.mapCache.set(k, data.blocks);
      this.mapVersion++;
      return;
    }
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
    // The region's box is the union of what it actually holds. A fixed pad round its square
    // was enough for the grid city, but on the network a block belongs to the region its seed
    // is in and can reach a hundred metres and more into the next, and the ground there lies
    // well below zero: cull on the square and whole pavements vanish as the view turns.
    const lo: Vec3 = [x0 - pad, -1, z0 - pad];
    const hi: Vec3 = [x0 + REGION + pad, m.maxHeight + 1, z0 + REGION + pad];
    for (const c of m.cells)
      for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a], c.lo[a]);
        hi[a] = Math.max(hi[a], c.hi[a]);
      }
    const rk = key(m.rx, m.rz);
    const touched: string[] = [];
    for (const c of m.colliders) {
      const ck = key(c.ci, c.cj);
      let cell = this.cells.get(ck);
      if (!cell) this.cells.set(ck, (cell = new Map()));
      cell.set(rk, c.boxes);
      touched.push(ck);
    }
    this.regions.set(rk, {
      mesh: new Mesh(this.gl, m.vertices, VERTEX_LAYOUT, m.indices, this.gl.TRIANGLES, m.positions),
      pads: m.pads,
      lamps: m.lamps,
      cars: m.cars,
      lifts: m.lifts,
      boats: m.boats,
      groundCount: m.groundCount,
      cells: m.cells,
      lo,
      hi,
      center: [x0 + REGION / 2, z0 + REGION / 2],
      touched,
    });
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
      this.workers[w].postMessage({ type: "region", rx: i, rz: j, seed: this.seed, faceCull: this.faceCull } satisfies WorkerRequest);
    }
    // Map tiles share the pool, but only ever go to a worker with nothing else to do. A tile
    // is a couple of square kilometres of Voronoi and takes a good fraction of a second; the
    // city streaming in around the runner cannot be made to queue behind one.
    while (this.mapQueue.length) {
      const w = this.busy.indexOf(0);
      if (w < 0) break;
      const k = this.mapQueue.shift()!;
      const [tx, tz] = k.split(",").map(Number);
      this.mapBusy.add(k);
      this.busy[w]++;
      this.workers[w].postMessage({ type: "map", tx, tz, seed: this.seed } satisfies WorkerRequest);
    }
    for (const [k, r] of this.regions) {
      const [i, j] = k.split(",").map(Number);
      if (this.distance(i, j, x, z) > UNLOAD_RADIUS) {
        r.mesh.dispose();
        this.regions.delete(k);
        this.version++;
        this.collideCache.clear();
        for (const ck of r.touched) {
          const cell = this.cells.get(ck);
          cell?.delete(k);
          if (cell && cell.size === 0) this.cells.delete(ck);
        }
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
        const rx = Math.floor(i / REGION_CELLS), rz = Math.floor(j / REGION_CELLS);
        if (!this.regions.has(key(rx, rz))) {
          // not streamed in yet: build synchronously (rare)
          this.add(buildPlanRegion(rx, rz, this.faceCull));
        }
        const cell = this.cells.get(key(i, j));
        if (cell) for (const boxes of cell.values()) parts.push(boxes);
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
  draw(planes: Float64Array[], eye: Vec3, lodScale = 1, record = true, depthOnly = false): void {
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
    const detailDist = DETAIL_DISTANCE * lodScale * this.detailScale;
    const farDist = FAR_DISTANCE * lodScale * this.farScale;
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
      // the tiers sit next to each other in the index buffer, so a near cell's three
      // ranges merge back into a single draw below
      b.push(c.coarseStart, c.coarseCount);
      if (dist < farDist) b.push(c.midStart, c.midCount);
      if (dist < detailDist) b.push(c.detailStart, c.detailCount);
    }
    let indices = 0;
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
      for (let i = 0; i < n; i++) indices += this.counts[i];
      r.mesh.drawRanges(this.starts, this.counts, n, depthOnly);
    }
    if (record) {
      this.stats.drawn = cells;
      this.stats.tris = indices / 3;
    }
  }

  private starts = new Int32Array(256);
  private counts = new Int32Array(256);
}
