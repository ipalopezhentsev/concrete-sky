// The outlines the map view is drawn from: block polygons, arterials, railways and rivers.
//
// The plan is already everything the map needs — the streets are the ground the blocks leave
// between them, exactly as they are on the ground — so nothing here invents a second, simpler
// city to draw. It only asks the network the same questions the builder does and hands back
// flat arrays.
//
// The two halves cost wildly different amounts. A block outline is a convex polygon clipped
// against every seed within reach, which runs to a couple of milliseconds each, and a map
// covers a few square kilometres of them: those are cut into tiles and worked out in the
// worker pool that builds the city. The arterials, railways and rivers are splines through a
// handful of hashed junctions, cheap enough to walk again every time the map is redrawn.

import { artery, ARTERY, arteryLines, blocksIn, cellOf, riverAt, riverLines, RIVER_STEP } from "./network";
import { hasRail, hasSubway, railStationsNear, railWay, stationsNear } from "./plan";

/** Side of one tile of block outlines, in metres. */
export const MAP_TILE = 800;
/**
 * How far out of its own tile a block may reach. A cell grows until it meets its neighbours,
 * so where the grain is coarse one can stand a long way from the seed it grew out of, and the
 * map has to read this far beyond the view or blocks drop out along its edges.
 */
export const MAP_REACH = 400;

/**
 * The block outlines of one tile, packed as a vertex count followed by that many x, z pairs.
 *
 * A block belongs to the tile its seed falls in, however far its polygon reaches out of it.
 * That way no block is worked out twice and none goes missing at a seam — which is the whole
 * reason the tile is defined on the seeds rather than on the polygons.
 */
export function mapTile(tx: number, tz: number): Float32Array {
  const x0 = tx * MAP_TILE, z0 = tz * MAP_TILE;
  const out: number[] = [];
  for (const site of blocksIn(x0, z0, x0 + MAP_TILE, z0 + MAP_TILE)) {
    if (site.p[0] < x0 || site.p[0] >= x0 + MAP_TILE) continue;
    if (site.p[1] < z0 || site.p[1] >= z0 + MAP_TILE) continue;
    const poly = cellOf(site);
    if (!poly || poly.length < 3) continue;
    out.push(poly.length);
    for (const p of poly) out.push(p[0], p[1]);
  }
  return new Float32Array(out);
}

/**
 * The subway entrances in one tile, as x, z pairs.
 *
 * These travel with the block outlines because they belong to the same question: what is in
 * this square of city. The map used to take them from the regions streamed in around the
 * runner instead, which reach a kilometre — so a map zoomed out past that drew the subway
 * lines, which are a hashed spline and cost nothing, and not one station on them.
 *
 * A station belongs to the tile its entrance stands in, whichever tile the platform below it
 * is under, so none is drawn twice and none falls down a seam.
 */
export function mapStations(tx: number, tz: number): Float32Array {
  const x0 = tx * MAP_TILE, z0 = tz * MAP_TILE;
  const out: number[] = [];
  // asked about the platforms, which stand within their own entrance's offset of the entrance
  for (const st of stationsNear(x0 + MAP_TILE / 2, z0 + MAP_TILE / 2, MAP_TILE * 0.71 + 100)) {
    if (st.mouthX < x0 || st.mouthX >= x0 + MAP_TILE) continue;
    if (st.mouthZ < z0 || st.mouthZ >= z0 + MAP_TILE) continue;
    out.push(st.mouthX, st.mouthZ);
  }
  return new Float32Array(out);
}

/**
 * The ways up to the elevated railway in one tile: the foot of each station's stair towers,
 * one either side of the road, x and z each. That is where you go in, as the entrance is on
 * the subway, so that is what the map marks.
 */
export function mapRailStations(tx: number, tz: number): Float32Array {
  const x0 = tx * MAP_TILE, z0 = tz * MAP_TILE;
  const out: number[] = [];
  for (const st of railStationsNear(x0 + MAP_TILE / 2, z0 + MAP_TILE / 2, MAP_TILE * 0.71 + 60)) {
    for (const side of [1, -1] as const) {
      const [x, , z] = railWay(st, side).way[1];
      if (x < x0 || x >= x0 + MAP_TILE || z < z0 || z >= z0 + MAP_TILE) continue;
      out.push(x, z);
    }
  }
  return new Float32Array(out);
}

/**
 * A road or watercourse to draw: a run of x, z pairs, and what else rides this alignment —
 * a railway over it, a subway under it. Both follow arterials, and never the same one.
 */
export interface Route {
  pts: Float32Array;
  rail: boolean;
  tube: boolean;
}

/** Samples per span of spline. Fine enough that a bend reads as a curve at any map scale. */
const STEPS = 20;

/** Every arterial passing within `r` of a point, each carrying its railway if it has one. */
export function arterialRoutes(cx: number, cz: number, r: number): Route[] {
  const out: Route[] = [];
  for (const axis of [0, 1] as const) {
    const across = axis === 0 ? cz : cx, along = axis === 0 ? cx : cz;
    for (const line of arteryLines(across, r)) {
      // A junction wanders up to a third of the lattice spacing along its own road, so the
      // span before the first one in range still reaches into it — as does the one after.
      const k0 = Math.floor((along - r) / ARTERY) - 1, k1 = Math.floor((along + r) / ARTERY) + 1;
      const pts = new Float32Array((k1 - k0) * STEPS * 2 + 2);
      let i = 0;
      for (let k = k0; k <= k1; k++)
        for (let s = 0; s < STEPS && (k < k1 || s < 1); s++) {
          const p = artery(axis, line, k + s / STEPS);
          pts[i++] = p[0];
          pts[i++] = p[1];
        }
      out.push({ pts, rail: hasRail(axis, line), tube: hasSubway(axis, line) });
    }
  }
  return out;
}

/** Every river running within `r` of a point, as its centreline. */
export function riverRoutes(cx: number, cz: number, r: number): Float32Array[] {
  const out: Float32Array[] = [];
  for (const line of riverLines(cx, r)) {
    const k0 = Math.floor((cz - r) / RIVER_STEP) - 1, k1 = Math.floor((cz + r) / RIVER_STEP) + 1;
    const pts = new Float32Array((k1 - k0) * STEPS * 2 + 2);
    let i = 0;
    for (let k = k0; k <= k1; k++)
      for (let s = 0; s < STEPS && (k < k1 || s < 1); s++) {
        const p = riverAt(line, k + s / STEPS);
        pts[i++] = p[0];
        pts[i++] = p[1];
      }
    out.push(pts);
  }
  return out;
}
