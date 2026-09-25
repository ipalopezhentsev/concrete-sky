// The road network: an endless, deterministic plan of streets and the blocks between them.
//
// There is no grid here, not even a bent one. Blocks are the Voronoi cells of a scattered set
// of seeds, which is what gives the plan its character: a Voronoi vertex almost always has
// three edges, so junctions are T-shaped the way they are in a city that grew rather than one
// that was set out, and cells come out as polygons of four to seven sides at every size.
//
// Two fields do the rest of the work. Grain decides how many seeds survive in a neighbourhood,
// so quarters range from tight lanes to great open superblocks; reach picks out the streets
// that carry traffic, and gathers them into corridors instead of scattering them.
//
// Everything is a pure function of position, computed from seeds within a few slots, so any
// part of the city can be built without reference to any other — which is what lets regions
// stream in independently.

import { hashInt, worldSeed } from "../math";

// Everything below is remembered between calls, and all of it follows from the world seed:
// change the seed and every cache has to go, or the new city is built on the old one's plan.
const caches: Map<unknown, unknown>[] = [];
let cachedSeed = -1;

/** Registers a cache to be emptied when the seed changes. */
export function rememberBySeed<K, V>(): Map<K, V> {
  const m = new Map<K, V>();
  caches.push(m as Map<unknown, unknown>);
  return m;
}

/** Empties every cache if the world seed has changed since they were filled. */
export function checkSeed(): void {
  const s = worldSeed();
  if (s === cachedSeed) return;
  cachedSeed = s;
  for (const c of caches) c.clear();
}

export type Vec2 = [number, number];

/** Spacing of the lattice of candidate block seeds. Most of them do not survive. */
export const SLOT = 170;
/** Spacing of the arterial armature, and the half-width of the roads that make it up. */
export const ARTERY = 900;
export const ARTERY_HALF = 17;
/** How far a seed sits from its slot centre, as a fraction of SLOT. */
const SCATTER = 0.44;
/** Slots to search around a point when working out whose block it is. */
const REACH = 5;
/** Half-width of an ordinary carriageway, kerb to kerb. */
export const ROAD = 9;

const unit = (h: number) => (h % 4096) / 4095;

/** Smoothly interpolated value noise, in 0..1. */
function smooth(x: number, z: number, salt: number): number {
  const xi = Math.floor(x), zi = Math.floor(z);
  const fx = x - xi, fz = z - zi;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const h = (a: number, b: number) => unit(hashInt(a, b, salt));
  // each corner hashed once and kept: written out inline it asks for two of them twice over,
  // and this is the hottest arithmetic in the place
  const h00 = h(xi, zi), h10 = h(xi + 1, zi), h01 = h(xi, zi + 1), h11 = h(xi + 1, zi + 1);
  const top = h00 + (h10 - h00) * sx;
  const bot = h01 + (h11 - h01) * sx;
  return top + (bot - top) * sz;
}

/**
 * How finely the city is cut up here, 0 for great superblocks and 1 for tight lanes. Two
 * octaves, so a quarter has a character of its own and still varies inside itself.
 */
export function grain(x: number, z: number): number {
  const a = smooth(x / (SLOT * 11), z / (SLOT * 11), 201);
  const b = smooth(x / (SLOT * 3.5), z / (SLOT * 3.5), 202);
  return Math.min(1, Math.max(0, (a * 0.72 + b * 0.28 - 0.18) / 0.62));
}

/**
 * The block seed in slot (i, j), or null where the grain is coarse enough that this one was
 * never planted and its neighbours grew over the space.
 */
const seedCache = rememberBySeed<string, Vec2 | null>();

/** As `plantSeed`, but remembered: every block asks about the same eighty-odd slots. */
export function seed(i: number, j: number): Vec2 | null {
  const key = `${i},${j}`;
  checkSeed();
  const hit = seedCache.get(key);
  if (hit !== undefined) return hit;
  const p = plantSeed(i, j);
  if (seedCache.size > 8192) seedCache.clear();
  seedCache.set(key, p);
  return p;
}

function plantSeed(i: number, j: number): Vec2 | null {
  const cx = (i + 0.5) * SLOT, cz = (j + 0.5) * SLOT;
  const keep = 0.11 + 0.42 * grain(cx, cz) ** 1.5;
  if (unit(hashInt(i, j, 203)) > keep) return null;
  const u = unit(hashInt(i, j, 204)) - 0.5, v = unit(hashInt(i, j, 205)) - 0.5;
  const p: Vec2 = [cx + u * 2 * SCATTER * SLOT, cz + v * 2 * SCATTER * SLOT];
  // a seed in the roadway would leave its block straddling the arterial
  clearOfArteries(p);
  // And well clear of the water, or the block would be built across the river. Further out
  // than the bank seeds themselves, not level with them: a seed at the same distance competes
  // with the pair whose bisector is supposed to be the watercourse, and wins half the time.
  const r = riverNear(p[0], p[1], RIVER_KEEP + 10);
  if (r && r.dist < RIVER_KEEP) {
    const side = Math.sign((p[0] - r.p[0]) * -r.dir[1] + (p[1] - r.p[1]) * r.dir[0]) || 1;
    p[0] = r.p[0] - r.dir[1] * RIVER_KEEP * side;
    p[1] = r.p[1] + r.dir[0] * RIVER_KEEP * side;
  }
  return p;
}

// ---------------------------------------------------------------------------
// The arterial armature
//
// Voronoi on its own gives a plan with no through-routes: every street is one edge between
// two junctions and stops. So a sparse set of long roads is laid over the top, each a spline
// threaded through junctions that wander a long way off a coarse lattice, and the blocks are
// cut back off them. These are the roads you can actually travel down.

/** A junction of the arterial armature: `axis` 0 for a road running east, 1 for one going north. */
const nodeCache = rememberBySeed<number, Vec2>();

function arteryNode(axis: 0 | 1, line: number, k: number): Vec2 {
  // asked for many times a frame by the traffic, and hashing is not free
  const key = ((axis * 4096 + (line & 4095)) * 65536) + (k & 65535);
  checkSeed();
  const hit = nodeCache.get(key);
  if (hit) return hit;
  if (nodeCache.size > 8192) nodeCache.clear();
  const node = arteryNodeFresh(axis, line, k);
  nodeCache.set(key, node);
  return node;
}

function arteryNodeFresh(axis: 0 | 1, line: number, k: number): Vec2 {
  const a = unit(hashInt(axis, line, k, 210)) - 0.5;
  const b = unit(hashInt(axis, line, k, 211)) - 0.5;
  const along = (k + a * 0.5) * ARTERY;
  const across = (line + b * 0.62) * ARTERY;
  return axis === 0 ? [along, across] : [across, along];
}

function catmull(p: Vec2[], t: number): Vec2 {
  const t2 = t * t, t3 = t2 * t;
  const at = (i: 0 | 1) =>
    0.5 * (2 * p[1][i] + (p[2][i] - p[0][i]) * t
      + (2 * p[0][i] - 5 * p[1][i] + 4 * p[2][i] - p[3][i]) * t2
      + (-p[0][i] + 3 * p[1][i] - 3 * p[2][i] + p[3][i]) * t3);
  return [at(0), at(1)];
}

/** A point on an arterial at continuous station `t`, in lattice units along the road. */
export function artery(axis: 0 | 1, line: number, t: number): Vec2 {
  const k = Math.floor(t);
  return catmull([-1, 0, 1, 2].map((n) => arteryNode(axis, line, k + n)), t - k);
}

/**
 * Straight pieces of every arterial passing near (x, z), fine enough to clip a block against.
 *
 * The pieces of one road are built once for each lattice tile it crosses and kept, because
 * every seed and every block asks about the roads around it and re-walking the spline each
 * time is what makes the whole network too slow to build a region with.
 */
export function arteriesNear(
  x: number, z: number, r: number, skip?: { axis: 0 | 1; line: number },
): [Vec2, Vec2][] {
  const out: [Vec2, Vec2][] = [];
  for (const axis of [0, 1] as const) {
    const across = axis === 0 ? z : x, along = axis === 0 ? x : z;
    const l0 = Math.floor((across - r) / ARTERY) - 1, l1 = Math.floor((across + r) / ARTERY) + 1;
    // A span either side of the range the query covers: a junction wanders up to a quarter of
    // the lattice spacing along its own road, so the span before the first one whose index
    // falls in range still reaches into it. Without that margin whole stretches of road were
    // invisible here — nothing was kept clear of them and no block was cut back off them.
    const k0 = Math.floor((along - r) / ARTERY) - 1, k1 = Math.floor((along + r) / ARTERY) + 1;
    for (let line = l0; line <= l1; line++) {
      if (skip && skip.axis === axis && skip.line === line) continue;
      for (let k = k0; k <= k1; k++)
        for (const seg of arterySpan(axis, line, k))
          if (Math.min(seg[0][0], seg[1][0]) < x + r && Math.max(seg[0][0], seg[1][0]) > x - r &&
              Math.min(seg[0][1], seg[1][1]) < z + r && Math.max(seg[0][1], seg[1][1]) > z - r) out.push(seg);
    }
  }
  return out;
}

/**
 * Shoves a seed out of any arterial's roadway it has landed in, leaving `skip` — the road it
 * belongs to, if it is one of a flanking pair — out of the reckoning.
 *
 * Shoving rather than dropping matters: drop it and its neighbours have to stretch over the
 * gap, which leaves great aprons of nothing along every arterial instead of blocks fronting it.
 */
function clearOfArteries(p: Vec2, skip?: { axis: 0 | 1; line: number }): void {
  // clear of the arterial's flanking row, or a seed there would spoil that pair's bisector
  const keep = FLANK + 24;
  for (const [a, b] of arteriesNear(p[0], p[1], keep, skip)) {
    const d = distToSeg(p, a, b);
    if (d >= keep) continue;
    const vx = b[0] - a[0], vz = b[1] - a[1];
    const l = Math.hypot(vx, vz) || 1;
    let nx = -vz / l, nz = vx / l;
    if (nx * (p[0] - a[0]) + nz * (p[1] - a[1]) < 0) {
      nx = -nx;
      nz = -nz;
    }
    p[0] += nx * (keep - d);
    p[1] += nz * (keep - d);
  }
}

const spanCache = rememberBySeed<string, [Vec2, Vec2][]>();

/** The pieces of one arterial between junction `k` and the next. */
function arterySpan(axis: 0 | 1, line: number, k: number): [Vec2, Vec2][] {
  const key = `${axis},${line},${k}`;
  checkSeed();
  const hit = spanCache.get(key);
  if (hit) return hit;
  const out: [Vec2, Vec2][] = [];
  const N = 24; // fine enough that a block clipped against them follows the curve of the road
  let prev = artery(axis, line, k);
  for (let s = 1; s <= N; s++) {
    const p = artery(axis, line, k + s / N);
    out.push([prev, p]);
    prev = p;
  }
  if (spanCache.size > 4096) spanCache.clear();
  spanCache.set(key, out);
  return out;
}

/** Distance from a point to a line piece. */
function distToSeg(p: Vec2, a: Vec2, b: Vec2): number {
  const vx = b[0] - a[0], vz = b[1] - a[1];
  const l2 = vx * vx + vz * vz || 1;
  let t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vz) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + vx * t), p[1] - (a[1] + vz * t));
}

/**
 * A block seed. Ordinary ones come off the lattice; the rest are planted in pairs either side
 * of an arterial, which is the whole trick that makes the armature work.
 *
 * An earlier version generated the arterials separately and clipped the blocks off them, and
 * it never stopped fighting itself — a road would cut a block three hundred metres away and
 * leave aprons of nothing everywhere. Seeding in pairs instead means the bisector between a
 * pair *is* the road: it falls out of the same Voronoi as every other street, needs no
 * clipping at all, and the blocks along it front it properly.
 */
export interface Site {
  key: string;
  p: Vec2;
  /** Set when this seed flanks an arterial: which road, and which side of it. */
  road?: { id: string; side: 1 | -1 };
}

/** How far an arterial's flanking seeds sit from its centreline. */
const FLANK = 58;
/** Stations along one arterial span, setting how often a side street meets it. */
const STATIONS = 8;

/** The pair of seeds flanking one arterial station, and the road they name. */
// Every seed within reach is asked for afresh by each of the eighty-odd cells that could touch
// it, and a flanking pair costs a walk down the spline and a look at every road nearby to be
// shoved clear of. Worked out once and kept, like the junctions they hang off.
const flankCache = rememberBySeed<number, Site[]>();

function flankSites(axis: 0 | 1, line: number, k: number, m: number): Site[] {
  const key = ((axis * 8192 + (line & 8191)) * 65536 + (k & 65535)) * 32 + m;
  checkSeed();
  const hit = flankCache.get(key);
  if (hit) return hit;
  if (flankCache.size > 8192) flankCache.clear();
  const out = flankSitesFresh(axis, line, k, m);
  flankCache.set(key, out);
  return out;
}

function flankSitesFresh(axis: 0 | 1, line: number, k: number, m: number): Site[] {
  const t = k + m / STATIONS;
  const p = artery(axis, line, t);
  const q = artery(axis, line, t + 0.01);
  const vx = q[0] - p[0], vz = q[1] - p[1];
  const l = Math.hypot(vx, vz) || 1;
  const nx = -vz / l, nz = vx / l;
  const id = `${axis},${line}`;
  return [1, -1].map((s) => {
    const q: Vec2 = [p[0] + nx * FLANK * s, p[1] + nz * FLANK * s];
    // Clear of every other arterial, exactly as an ordinary seed is kept clear of all of them.
    // Without this, a road's flanking seeds stand in the roadway of the road it crosses, where
    // they beat that road's own pair to the bisector between them — so the crossed road has no
    // carriageway at the junction at all. What gets built there instead is a block, standing in
    // the middle of the road, with the traffic driving straight into it.
    clearOfArteries(q, { axis, line });
    // a road's own flanking seed has to keep off the water for the same reason every other
    // seed does, or the river loses its banks wherever a road runs beside one
    const r = riverNear(q[0], q[1], RIVER_KEEP + 10);
    if (r && r.dist < RIVER_KEEP) {
      const side = Math.sign((q[0] - r.p[0]) * -r.dir[1] + (q[1] - r.p[1]) * r.dir[0]) || 1;
      q[0] = r.p[0] - r.dir[1] * RIVER_KEEP * side;
      q[1] = r.p[1] + r.dir[0] * RIVER_KEEP * side;
    }
    return { key: `a${id},${k},${m},${s}`, p: q, road: { id, side: s as 1 | -1 } };
  });
}

/** Every seed of either kind whose block could reach (x, z). */
export function sitesNear(x: number, z: number, r: number): Site[] {
  const out: Site[] = [];
  for (let i = Math.floor((x - r) / SLOT); i <= Math.floor((x + r) / SLOT); i++)
    for (let j = Math.floor((z - r) / SLOT); j <= Math.floor((z + r) / SLOT); j++) {
      const p = seed(i, j);
      if (p) out.push({ key: `s${i},${j}`, p });
    }
  for (const axis of [0, 1] as const) {
    const across = axis === 0 ? z : x, along = axis === 0 ? x : z;
    for (let line = Math.floor((across - r) / ARTERY) - 1; line <= Math.floor((across + r) / ARTERY) + 1; line++)
      for (let k = Math.floor((along - r) / ARTERY) - 1; k <= Math.floor((along + r) / ARTERY) + 1; k++)
        for (let m = 0; m < STATIONS; m++)
          for (const s of flankSites(axis, line, k, m))
            if (Math.abs(s.p[0] - x) < r && Math.abs(s.p[1] - z) < r) out.push(s);
  }
  out.push(...riverSitesNear(x, z, r));
  return out;
}

/** Clips a convex polygon to the half-plane nx*x + nz*z <= c. */
function clipHalf(poly: Vec2[], nx: number, nz: number, c: number): Vec2[] {
  const side = (p: Vec2) => nx * p[0] + nz * p[1] - c;
  const out: Vec2[] = [];
  for (let k = 0; k < poly.length; k++) {
    const p = poly[k], q = poly[(k + 1) % poly.length];
    const sp = side(p), sq = side(q);
    if (sp <= 0) out.push(p);
    if ((sp < 0 && sq > 0) || (sp > 0 && sq < 0)) {
      const t = sp / (sp - sq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

/** Clips a convex polygon to the side of the bisector of a-b that a is on. */
function clip(poly: Vec2[], a: Vec2, b: Vec2): Vec2[] {
  const nx = b[0] - a[0], nz = b[1] - a[1];
  return clipHalf(poly, nx, nz, (nx * (a[0] + b[0]) + nz * (a[1] + b[1])) / 2);
}

/** How far a point is from the bisector between two seeds; 0 means it is on the street. */
const offBisector = (mid: Vec2, a: Vec2, b: Vec2) =>
  Math.abs(Math.hypot(mid[0] - a[0], mid[1] - a[1]) - Math.hypot(mid[0] - b[0], mid[1] - b[1]));

/**
 * Half-width of the street along the edge between these two blocks. Two seeds flanking the
 * same arterial face each other across it, and that is the one case that gets the wide road;
 * everything else takes its width from the rank field.
 */
function edgeHalf(here: Site, other: Site | null, mid: Vec2): number {
  if (other?.road && here.road && other.road.id === here.road.id && other.road.side !== here.road.side) {
    // a river gets its quays as well as its water, so the blocks stand back behind them
    return here.road.id.startsWith("r") ? RIVER_HALF + QUAY : ARTERY_HALF;
  }
  const r = rank(mid);
  return r === 2 ? ROAD * 1.35 : r === 0 ? ROAD * 0.55 : ROAD * 0.8;
}

/** Search radius for the seeds that can touch one block. */
const RANGE = SLOT * (REACH + 0.5);

/**
 * The block grown from a seed: its Voronoi cell, pulled back off each of its own edges by
 * half the street that runs along it. Both blocks facing a street work out the same width and
 * each gives up half, which is where the street's width actually comes from.
 */
export function cellOf(here: Site, neighbours?: Site[]): Vec2[] | null {
  const near = neighbours ?? sitesNear(here.p[0], here.p[1], RANGE);
  let poly: Vec2[] = [
    [here.p[0] - RANGE, here.p[1] - RANGE], [here.p[0] + RANGE, here.p[1] - RANGE],
    [here.p[0] + RANGE, here.p[1] + RANGE], [here.p[0] - RANGE, here.p[1] + RANGE],
  ];
  for (const s of near) {
    if (s.key === here.key) continue;
    poly = clip(poly, here.p, s.p);
    if (poly.length < 3) return null;
  }
  // now pull each edge back by its own street
  let land = poly;
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k], b = poly[(k + 1) % poly.length];
    const vx = b[0] - a[0], vz = b[1] - a[1];
    const l = Math.hypot(vx, vz);
    if (l < 1e-6) continue;
    const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    // the neighbour across this edge is the one whose bisector with us the edge lies on
    let other: Site | null = null, best = Infinity;
    for (const s of near) {
      if (s.key === here.key) continue;
      const d = offBisector(mid, here.p, s.p);
      if (d < best) {
        best = d;
        other = s;
      }
    }
    let nx = -vz / l, nz = vx / l;
    if (nx * (mid[0] - here.p[0]) + nz * (mid[1] - here.p[1]) < 0) {
      nx = -nx;
      nz = -nz;
    }
    land = clipHalf(land, nx, nz, nx * mid[0] + nz * mid[1] - edgeHalf(here, other, mid));
    if (land.length < 3) return null;
  }
  return offTheRoad(land, here.p);
}

/**
 * The same outline with every arterial's roadway taken out of it. No block may stand in a road,
 * and this is where that is actually decided.
 *
 * Pulling the edge back off the bisector between a road's flanking pair was supposed to see to
 * it, and where the road runs straight it does, because there the bisector is the road. On a
 * bend it is not: the bisector is one straight line through the station it belongs to, and the
 * road curves away from it. At a crossing it is not either. What stood in the difference was a
 * block built in the middle of the carriageway, with the road running into it and the traffic
 * driving on through — which is not a thing to be tuned down, so it is stated here as the rule
 * it always was, and taken off the outline whatever the Voronoi made of the place.
 */
function offTheRoad(poly: Vec2[], seed: Vec2): Vec2[] | null {
  let radius = 0;
  for (const p of poly) radius = Math.max(radius, Math.hypot(p[0] - seed[0], p[1] - seed[1]));
  // a road further off than the block reaches cannot take anything out of it
  const care = radius + ARTERY_HALF;
  let out = poly;
  for (const [a, b] of arteriesNear(seed[0], seed[1], care)) {
    if (distToSeg(seed, a, b) > care) continue;
    const vx = b[0] - a[0], vz = b[1] - a[1];
    const l = Math.hypot(vx, vz) || 1;
    let nx = -vz / l, nz = vx / l;
    // pointing at the side the block's own seed stands on, which is the side it keeps
    if (nx * (seed[0] - a[0]) + nz * (seed[1] - a[1]) < 0) {
      nx = -nx;
      nz = -nz;
    }
    // keep only what stands a half-width clear of the centreline: n.p >= n.a + ARTERY_HALF
    out = clipHalf(out, -nx, -nz, -(nx * a[0] + nz * a[1] + ARTERY_HALF));
    if (out.length < 3) return null;
  }
  return out;
}

/** Which block covers the point, by the seed nearest it. */
export function blockAt(x: number, z: number): Site | null {
  let best: Site | null = null, bd = Infinity;
  for (const s of sitesNear(x, z, RANGE)) {
    const d = (s.p[0] - x) ** 2 + (s.p[1] - z) ** 2;
    if (d < bd) {
      bd = d;
      best = s;
    }
  }
  return best;
}

/**
 * How much traffic an ordinary street carries, 0 for a back lane and 2 for a main road.
 *
 * Taken from a smooth field rather than a coin toss for each street, so the wide ones line up
 * into corridors that run somewhere instead of being sprinkled over the map.
 */
export function rank(mid: Vec2): 0 | 1 | 2 {
  const f = smooth(mid[0] / (SLOT * 7), mid[1] / (SLOT * 7), 206);
  return f > 0.88 ? 2 : f < 0.5 ? 0 : 1;
}

/** Every block whose polygon could reach into the rectangle. */
export function blocksIn(x0: number, z0: number, x1: number, z1: number): Site[] {
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const r = Math.max(x1 - cx, z1 - cz) + SLOT * 2;
  return sitesNear(cx, cz, r);
}

/**
 * Where an arterial is `s` metres along, and which way it points there — enough to drive a
 * car down it. The station is taken as a straight fraction of the lattice spacing rather than
 * true arc length, so a vehicle drifts a little faster where the spline stretches; over one
 * car length that is not something you can see.
 */
export function arteryFrame(axis: 0 | 1, line: number, s: number): { p: Vec2; dir: Vec2 } {
  const t = s / ARTERY;
  const p = artery(axis, line, t);
  const q = artery(axis, line, t + 0.004);
  const dx = q[0] - p[0], dz = q[1] - p[1];
  const l = Math.hypot(dx, dz) || 1;
  return { p, dir: [dx / l, dz / l] };
}

/** Arterial line indices whose road runs within `r` of the given across-coordinate. */
export function arteryLines(across: number, r: number): number[] {
  const out: number[] = [];
  for (let l = Math.floor((across - r) / ARTERY) - 1; l <= Math.floor((across + r) / ARTERY) + 1; l++) out.push(l);
  return out;
}

// ---------------------------------------------------------------------------
// The ground
//
// Everything in this city is an axis-aligned box, so a hillside is a flight of steps whether
// it means to be one or not: the ground is laid as tiles, each cut to a terrace, and the step
// between two neighbours is the tile's width times the slope. A step the runner cannot climb
// is a wall across the street, which fixes a hard ceiling on how steep any of this may be —
// one terrace over one tile, and not a centimetre more.
//
// That ceiling is the design. Three octaves of noise used to spread it evenly over every
// wavelength, which bought a bump a metre high along every street and not one hill anywhere:
// thirty metres of relief over six kilometres, a grade of under one per cent, nothing you
// could see and nothing you could feel. Here nearly all of it goes to hills that are objects
// rather than an octave — a few hundred metres of flank at the steepest grade the terraces can
// express, planted sparsely enough that there is flat ground between them to see them from —
// and what is left over goes to a long swell that keeps that flat ground from being a plane.

/** Vertical step the ground is cut into. Small enough that a runner can take one. */
export const TERRACE = 0.5;
/** Ground tile. Its width times the steepest slope is the step between two tiles. */
export const TILE = 5;
/**
 * The steepest ground that leaves a step a runner can still take. Nothing here may exceed it,
 * and since these fields add, each one's share of it is named and spent on purpose: a hill and
 * the swell beneath it together come to 0.092, which leaves the margin the terraces round in.
 */
const GRADE = TERRACE / TILE;
/** The hills' share, and the same for the climb out of a river valley behind the quay. */
const HILL_GRADE = GRADE * 0.75;
const BANK_GRADE = GRADE * 0.75;
/** How fast the bank stops holding low ground up out of the water, going inland. */
const LEVEE_GRADE = GRADE * 0.45;

/** Spacing of the lattice the hills are planted on. */
const HILL_SLOT = 1500;
/** Share of slots that grow one. The empty ones are what make the rest read as hills. */
const HILL_ODDS = 0.62;
/** Share of a flank that each of its two roundings takes, at the crown and at the foot. */
const KNEE = 0.18;
/** The steepest point of `flank`, which is what the grade budget has to cover. */
const FLANK_MAX = 1 / (1 - KNEE);

/**
 * A hill's profile across its flank: 0 at the foot, 1 at the crown, straight in between with
 * both ends rounded into it.
 *
 * A dome — smoothstep from foot to crown — is the obvious shape and the wrong one. It is at its
 * steepest halfway up, so the grade budget is spent at one point on the flank and the rest of
 * it comes out shallower than it was allowed to be, which buys a hill a third lower for the
 * same money. This is straight for most of its length: the whole flank sits at the steepest
 * grade the terraces can express, and the hill is as tall as that grade will carry.
 */
function flank(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  if (t < KNEE) return (FLANK_MAX * t * t) / (2 * KNEE);
  if (t > 1 - KNEE) return 1 - (FLANK_MAX * (1 - t) ** 2) / (2 * KNEE);
  return FLANK_MAX * (t - KNEE / 2);
}

/** One rounded mass. A hill is two or three of these, overlapping. */
interface Lobe {
  c: Vec2;
  /** Radius of the foot. */
  r: number;
  /** Height of the crown over the ground it stands on. */
  h: number;
  /** Share of the radius the flank takes; what is left in the middle is the crown. */
  m: number;
}

// Keyed by number rather than by a string of the pair: the traffic asks the height of the
// ground under every car several times a second, each answer looks at nine slots, and building
// nine keys to throw away was costing more than the arithmetic they guard.
const hillSlots = rememberBySeed<number, Lobe[]>();

/**
 * The hill grown in one slot of the lattice, as the lobes it is made of, or nothing where the
 * ground is left flat.
 *
 * One lobe is a cone, and a cone is a circle on the map — which from the air is what it looks
 * like, a row of pudding basins. The lobes fix that for nothing: they are combined by taking
 * the highest, and the steepest point of a maximum is only the steepest of its parts, so a
 * summit with two shoulders running off it costs exactly what the single cone did. Distorting
 * one cone instead — warping the distance, or pulling the foot into an ellipse — would have
 * been paid for in grade, which is the one thing here that cannot be borrowed against.
 */
function hillIn(i: number, j: number): Lobe[] {
  const key = (i & 0xffff) * 65536 + (j & 0xffff);
  const hit = hillSlots.get(key);
  if (hit) return hit;
  const out: Lobe[] = [];
  if (unit(hashInt(i, j, 240)) < HILL_ODDS) {
    const r = 600 + unit(hashInt(i, j, 241)) * 420;
    // well off the slot centre, or the hills line up into rows that show from the air
    const c: Vec2 = [
      (i + 0.5 + (unit(hashInt(i, j, 242)) - 0.5) * 0.8) * HILL_SLOT,
      (j + 0.5 + (unit(hashInt(i, j, 243)) - 0.5) * 0.8) * HILL_SLOT,
    ];
    // Mostly flank, with a small crown on top. A lobe's height is not a number of its own: it
    // is however high a flank that long carries at the grade it is allowed, so the shape
    // decides the height and the budget is never broken by a tall one.
    const m = 0.62 + unit(hashInt(i, j, 244)) * 0.33;
    const top = (rad: number, mid: number) => (HILL_GRADE * rad * mid) / FLANK_MAX;
    out.push({ c, r, h: top(r, m) * (0.78 + 0.22 * unit(hashInt(i, j, 245))), m });
    // the shoulders: lower and smaller, set far enough out to throw a spur off the summit
    for (let k = 0; k < 1 + (hashInt(i, j, 246) % 2); k++) {
      const a = unit(hashInt(i, j, k, 247)) * Math.PI * 2;
      const d = r * (0.36 + unit(hashInt(i, j, k, 248)) * 0.4);
      const sr = r * (0.45 + unit(hashInt(i, j, k, 249)) * 0.35);
      const sm = 0.62 + unit(hashInt(i, j, k, 250)) * 0.33;
      out.push({
        c: [c[0] + Math.cos(a) * d, c[1] + Math.sin(a) * d],
        r: sr, m: sm, h: top(sr, sm) * (0.7 + 0.3 * unit(hashInt(i, j, k, 251))),
      });
    }
  }
  hillSlots.set(key, out);
  return out;
}

// Every lobe that can reach into one slot, gathered once. The height of the ground is asked
// for constantly — by the traffic, and a few thousand times over while a region is cut into
// tiles — and walking the nine neighbouring slots for it, with a map lookup apiece, cost more
// than the arithmetic. This is the same nine slots, flattened and remembered.
const hillReach = rememberBySeed<number, Lobe[]>();

function lobesNear(i: number, j: number): Lobe[] {
  const key = (i & 0xffff) * 65536 + (j & 0xffff);
  const hit = hillReach.get(key);
  if (hit) return hit;
  const out: Lobe[] = [];
  for (let a = i - 1; a <= i + 1; a++)
    for (let b = j - 1; b <= j + 1; b++) out.push(...hillIn(a, b));
  hillReach.set(key, out);
  return out;
}

/**
 * The long swell under the hills: a couple of storeys over a kilometre. Nothing anyone feels
 * underfoot, and what keeps the ground between the hills from reading as a plane.
 */
function swell(x: number, z: number): number {
  return (smooth(x / 1700, z / 1700, 220) - 0.5) * 13
    + (smooth(x / 640, z / 640, 221) - 0.5) * 2.4;
}

/**
 * Height of the ground: the hills, the swell they stand on, and the valley a river cuts down
 * through whatever was there.
 */
export function terrainAt(x: number, z: number): number {
  checkSeed(); // once here, rather than in the slot lookup this calls nine times
  // The highest lobe over this point, never the sum of them: two overlapping masses added
  // together make a flank steeper than either, and the budget has no room for that. Where two
  // meet the taller wins, and the seam between them reads as the saddle it is.
  let over = 0;
  for (const lobe of lobesNear(Math.floor(x / HILL_SLOT), Math.floor(z / HILL_SLOT))) {
    const dx = x - lobe.c[0], dz = z - lobe.c[1];
    if (dx > lobe.r || dx < -lobe.r || dz > lobe.r || dz < -lobe.r) continue; // cheaper than the root
    const d = Math.hypot(dx, dz);
    if (d >= lobe.r) continue;
    const h = lobe.h * flank((1 - d / lobe.r) / lobe.m);
    if (h > over) over = h;
  }
  const land = swell(x, z) + over;
  // A river cuts its own valley: a bed below the water, an embankment out of it, and the
  // ground climbing away behind that. How far the valley reaches depends on how high the land
  // is here — the bank has to climb all of it — so past that distance there is no point
  // looking for a river, because a bank that far off has already risen above this ground.
  const reach = RIVER_HALF + QUAY + Math.max(200, (land + 12) / BANK_GRADE);
  const r = riverNear(x, z, reach);
  if (!r) return land;
  const w = waterLevel(r.line);
  if (r.dist < RIVER_HALF) {
    const t = r.dist / RIVER_HALF;
    return w - 12 * (1 - t * t);
  }
  // Behind the water.s edge the bank is not a slope but an embankment: a wall straight out of
  // the river up to a flat quay, and only past that does the ground climb away to the city.
  const q = r.dist - RIVER_HALF;
  const top = w + QUAY_RISE;
  if (q < QUAY) return top;
  // Out of the quay the ground climbs at a hill's grade until it meets the land, so the bank
  // behind a hill's flank is a long climb and the bank behind flat ground is a short one.
  // Whatever the land is doing, none of it near the water is left under the waterline; that
  // floor eases off going inland, so what it leaves is a bank and not a levee ridge standing
  // over the city behind it.
  const inland = q - QUAY;
  const want = Math.max(land, top + 2 - inland * LEVEE_GRADE);
  return Math.min(want, top + inland * BANK_GRADE);
}

// ---------------------------------------------------------------------------
// Rivers
//
// A river is built the same way an arterial is — a spline with a pair of seeds either side of
// it — because the same trick pays off twice: the Voronoi bisector between the pair is the
// watercourse, so no block is ever built across it and no clipping is needed. The only
// difference is how wide the gap between the two banks is, and that the ground is cut away.

export const RIVER = 2600;
export const RIVER_HALF = 62;
/** Width of the quay between the water.s edge and the building line on each bank. */
export const QUAY = 30;
/** Height of the quay over the water, which is the face of the embankment wall. */
export const QUAY_RISE = 5;
const RIVER_STEP = 950;
/** Bank seed pairs along one river span; they must be close enough to hold the channel. */
const RIVER_STATIONS = 12;
/** How far a bank seed stands back from the water, which is where the quays end up. */
const RIVER_FLANK = RIVER_HALF + 52;
/** How far every other seed is kept from the water, so the bank pair always wins there. */
const RIVER_KEEP = RIVER_FLANK + 48;

/** Surface height of the water in one river. Constant along its length, as still water is. */
export function waterLevel(line: number): number {
  return -17 + (hashInt(line, 234) % 7);
}

function riverNode(line: number, k: number): Vec2 {
  const a = unit(hashInt(line, k, 230)) - 0.5;
  const b = unit(hashInt(line, k, 231)) - 0.5;
  return [line * RIVER + a * 900, k * RIVER_STEP + b * 260];
}

/** A point on a river's centreline at continuous station `t`, in node units along it. */
export function riverAt(line: number, t: number): Vec2 {
  const k = Math.floor(t);
  return catmull([-1, 0, 1, 2].map((n) => riverNode(line, k + n)), t - k);
}

const riverSpans = rememberBySeed<string, [Vec2, Vec2][]>();

function riverSpan(line: number, k: number): [Vec2, Vec2][] {
  const key = `${line},${k}`;
  checkSeed();
  const hit = riverSpans.get(key);
  if (hit) return hit;
  const out: [Vec2, Vec2][] = [];
  const N = 9;
  let prev = riverAt(line, k);
  for (let s = 1; s <= N; s++) {
    const p = riverAt(line, k + s / N);
    out.push([prev, p]);
    prev = p;
  }
  if (riverSpans.size > 4096) riverSpans.clear();
  riverSpans.set(key, out);
  return out;
}

export interface RiverHit {
  line: number;
  dist: number;
  p: Vec2;
  dir: Vec2;
}

/** The nearest river to a point, if one runs close enough to matter there. */
export function riverNear(x: number, z: number, reach = 340): RiverHit | null {
  let best: RiverHit | null = null;
  for (let line = Math.floor((x - reach) / RIVER) - 1; line <= Math.floor((x + reach) / RIVER) + 1; line++) {
    // a river wanders at most this far off its line (the nodes 450, the spline a little more)
    if (Math.abs(x - line * RIVER) > reach + 620) continue;
    for (let k = Math.floor((z - reach) / RIVER_STEP) - 1; k <= Math.floor((z + reach) / RIVER_STEP) + 1; k++)
      for (const [a, b] of riverSpan(line, k)) {
        const vx = b[0] - a[0], vz = b[1] - a[1];
        const l2 = vx * vx + vz * vz || 1;
        const t = Math.max(0, Math.min(1, ((x - a[0]) * vx + (z - a[1]) * vz) / l2));
        const px = a[0] + vx * t, pz = a[1] + vz * t;
        const d = Math.hypot(x - px, z - pz);
        if (!best || d < best.dist) {
          const l = Math.sqrt(l2);
          best = { line, dist: d, p: [px, pz], dir: [vx / l, vz / l] };
        }
      }
  }
  return best && best.dist <= reach ? best : null;
}

/** The pair of seeds flanking one river station, which makes the water a Voronoi edge. */
function riverSites(line: number, k: number, m: number): Site[] {
  const t = k + m / RIVER_STATIONS;
  const p = riverAt(line, t);
  const q = riverAt(line, t + 0.01);
  const vx = q[0] - p[0], vz = q[1] - p[1];
  const l = Math.hypot(vx, vz) || 1;
  const nx = -vz / l, nz = vx / l;
  const id = `r${line}`;
  return [1, -1].map((s) => ({
    key: `${id},${k},${m},${s}`,
    p: [p[0] + nx * RIVER_FLANK * s, p[1] + nz * RIVER_FLANK * s] as Vec2,
    road: { id, side: s as 1 | -1 },
  }));
}

/** Every river bank seed near a point. */
export function riverSitesNear(x: number, z: number, r: number): Site[] {
  const out: Site[] = [];
  for (let line = Math.floor((x - r) / RIVER) - 1; line <= Math.floor((x + r) / RIVER) + 1; line++)
    for (let k = Math.floor((z - r) / RIVER_STEP) - 1; k <= Math.floor((z + r) / RIVER_STEP) + 1; k++)
      for (let m = 0; m < RIVER_STATIONS; m++)
        for (const s of riverSites(line, k, m))
          if (Math.abs(s.p[0] - x) < r && Math.abs(s.p[1] - z) < r) out.push(s);
  return out;
}

/** Where a river is `s` metres along, and which way it flows there. */
export function riverFrame(line: number, s: number): { p: Vec2; dir: Vec2 } {
  const t = s / RIVER_STEP;
  const p = riverAt(line, t);
  const q = riverAt(line, t + 0.004);
  const dx = q[0] - p[0], dz = q[1] - p[1];
  const l = Math.hypot(dx, dz) || 1;
  return { p, dir: [dx / l, dz / l] };
}

/** River line indices running within `r` of the given x. */
export function riverLines(x: number, r: number): number[] {
  const out: number[] = [];
  for (let l = Math.floor((x - r) / RIVER) - 1; l <= Math.floor((x + r) / RIVER) + 1; l++) out.push(l);
  return out;
}

/**
 * The blocks across each edge of this one, with the point on the shared street between them.
 *
 * `cellOf` already works this out to decide how wide each street is; this hands the same
 * answer back so anything spanning between two blocks — a bridge from deck to deck — knows
 * who its far side is and where to aim.
 */
export function neighbours(here: Site): { other: Site; mid: Vec2; normal: Vec2 }[] {
  const near = sitesNear(here.p[0], here.p[1], RANGE);
  let poly: Vec2[] = [
    [here.p[0] - RANGE, here.p[1] - RANGE], [here.p[0] + RANGE, here.p[1] - RANGE],
    [here.p[0] + RANGE, here.p[1] + RANGE], [here.p[0] - RANGE, here.p[1] + RANGE],
  ];
  for (const s of near) {
    if (s.key === here.key) continue;
    poly = clip(poly, here.p, s.p);
    if (poly.length < 3) return [];
  }
  const out: { other: Site; mid: Vec2; normal: Vec2 }[] = [];
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k], b = poly[(k + 1) % poly.length];
    const vx = b[0] - a[0], vz = b[1] - a[1];
    const l = Math.hypot(vx, vz);
    if (l < 12) continue; // too short a frontage to carry anything
    const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    let best: Site | null = null, bd = Infinity;
    for (const s of near) {
      if (s.key === here.key) continue;
      const d = offBisector(mid, here.p, s.p);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    if (!best) continue;
    let nx = -vz / l, nz = vx / l;
    if (nx * (mid[0] - here.p[0]) + nz * (mid[1] - here.p[1]) < 0) {
      nx = -nx;
      nz = -nz;
    }
    out.push({ other: best, mid, normal: [nx, nz] });
  }
  return out;
}

/** One street: the Voronoi edge between two blocks, and half its width. */
export interface Street {
  a: Vec2;
  b: Vec2;
  here: Site;
  other: Site;
  half: number;
}

/**
 * The streets round one block, each the whole edge between it and a neighbour — centreline
 * to centreline, not kerb to kerb — so a street laid along it meets the next at the corner.
 */
const streetCache = rememberBySeed<string, Street[]>();

export function streetsOf(here: Site): Street[] {
  checkSeed();
  const hit = streetCache.get(here.key);
  if (hit) return hit;
  if (streetCache.size > 4096) streetCache.clear();
  const out = streetsFresh(here);
  streetCache.set(here.key, out);
  return out;
}

function streetsFresh(here: Site): Street[] {
  const near = sitesNear(here.p[0], here.p[1], RANGE);
  let poly: Vec2[] = [
    [here.p[0] - RANGE, here.p[1] - RANGE], [here.p[0] + RANGE, here.p[1] - RANGE],
    [here.p[0] + RANGE, here.p[1] + RANGE], [here.p[0] - RANGE, here.p[1] + RANGE],
  ];
  for (const s of near) {
    if (s.key === here.key) continue;
    poly = clip(poly, here.p, s.p);
    if (poly.length < 3) return [];
  }
  const out: Street[] = [];
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k], b = poly[(k + 1) % poly.length];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.5) continue;
    const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    let other: Site | null = null, best = Infinity;
    for (const s of near) {
      if (s.key === here.key) continue;
      const d = offBisector(mid, here.p, s.p);
      if (d < best) {
        best = d;
        other = s;
      }
    }
    if (other) out.push({ a, b, here, other, half: edgeHalf(here, other, mid) });
  }
  return out;
}
