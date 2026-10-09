// The city built on the road network: every block is a polygon rather than a cell of a grid,
// so the pieces that used to be four axis-aligned boxes are now walls of turned boxes wrapped
// round an outline, with the inside filled by strips that nobody ever sees.

import { hashInt, Rng, type Vec3 } from "../math";
import {
  assembleRegion, Builder, CELL, collidersOf, LIFT_SIZE, REGION, REGION_CELLS, type Part, type RegionMesh,
} from "./generate";
import { Finish, Mat, Win, type Tint } from "./materials";
import { YAW_STEP, yawStep } from "./mesh";
import { PAINT_COLORS } from "../vehicles/models";
import {
  ARTERY, ARTERY_HALF, arteriesNear, arteryFrame, arteryLines, arteryScale, blockAt, blocksIn, cellOf, checkSeed, grain, hasRail,
  hasSubway, forecourtOf, RAIL_SPACING, railStop, type Forecourt, RIVER_HALF, neighbours, QUAY, QUAY_RISE, rememberBySeed, riverFrame, riverLines,
  riverNear, ROAD, streetsOf, SUB_SPACING, TERRACE, terrainAt, TILE, waterLevel,
  type Site, type Street, type Vec2,
} from "./network";

// Wider than the grid city's palette, and deliberately bottom-heavy: a run of near-white
// concrete reads as one mass at distance however varied the massing is, so a good share of
// the blocks are dark enough to separate from their neighbours.
const TINTS: Tint[] = [
  [1.0, 1.0, 1.0], [0.92, 0.93, 0.95], [1.03, 1.0, 0.95], [0.85, 0.85, 0.86],
  [0.62, 0.63, 0.66], [0.52, 0.53, 0.57], [0.44, 0.45, 0.48],
  [0.72, 0.68, 0.62], [0.58, 0.55, 0.52], [0.66, 0.70, 0.72],
];

/**
 * Height of the walkable deck level. Well above the street: the whole point of it is that it
 * is a second city over the top of the first, not a first-floor balcony.
 */
const DECKS = [36, 44, 52, 60];

/** What sort of block this is, which sets how finely it is cut and how high it goes. */
type Kind = "perimeter" | "cluster" | "spire" | "slab" | "yard";

/** Block edge to podium face: the pavement between the kerb and the building line. */
export const WALK = 7;

/** A convex polygon pulled in by `d` on every edge, or empty if nothing is left. */
export function shrink(poly: Vec2[], d: number): Vec2[] {
  let out = poly;
  const centre = centroid(poly);
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k], b = poly[(k + 1) % poly.length];
    const vx = b[0] - a[0], vz = b[1] - a[1];
    const l = Math.hypot(vx, vz);
    if (l < 1e-6) continue;
    let nx = -vz / l, nz = vx / l;
    if (nx * (a[0] - centre[0]) + nz * (a[1] - centre[1]) < 0) {
      nx = -nx;
      nz = -nz;
    }
    const c = nx * a[0] + nz * a[1] - d;
    const next: Vec2[] = [];
    for (let m = 0; m < out.length; m++) {
      const p = out[m], q = out[(m + 1) % out.length];
      const sp = nx * p[0] + nz * p[1] - c, sq = nx * q[0] + nz * q[1] - c;
      if (sp <= 0) next.push(p);
      if ((sp < 0 && sq > 0) || (sp > 0 && sq < 0)) {
        const t = sp / (sp - sq);
        next.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
    out = next;
    if (out.length < 3) return [];
  }
  return out;
}

export function centroid(poly: Vec2[]): Vec2 {
  let x = 0, z = 0;
  for (const p of poly) {
    x += p[0];
    z += p[1];
  }
  return [x / poly.length, z / poly.length];
}

/** Longest distance across the polygon, for deciding how much building it can carry. */
function spanOf(poly: Vec2[]): number {
  let lo = Infinity, hi = -Infinity, lz = Infinity, hz = -Infinity;
  for (const [x, z] of poly) {
    lo = Math.min(lo, x); hi = Math.max(hi, x);
    lz = Math.min(lz, z); hz = Math.max(hz, z);
  }
  return Math.min(hi - lo, hz - lz);
}

/**
 * Walks the polygon in strips across x, giving the z range the polygon covers over each.
 *
 * `inner` picks which range: the part every x in the strip has (so the strips stay inside the
 * outline, for anything a wall will cover) or the part any x has (so they cover it completely,
 * for a deck that is allowed to overhang a little).
 */
function strips(poly: Vec2[], width: number, inner: boolean, fn: (x0: number, z0: number, x1: number, z1: number) => void): void {
  let lo = Infinity, hi = -Infinity;
  for (const [x] of poly) {
    lo = Math.min(lo, x);
    hi = Math.max(hi, x);
  }
  const n = Math.max(1, Math.ceil((hi - lo) / width));
  const step = (hi - lo) / n;
  /** The polygon's z range at one x. */
  const spanAt = (x: number): [number, number] => {
    let a = Infinity, b = -Infinity;
    for (let k = 0; k < poly.length; k++) {
      const p = poly[k], q = poly[(k + 1) % poly.length];
      if ((p[0] <= x && q[0] >= x) || (q[0] <= x && p[0] >= x)) {
        const t = Math.abs(q[0] - p[0]) < 1e-9 ? 0 : (x - p[0]) / (q[0] - p[0]);
        const z = p[1] + (q[1] - p[1]) * t;
        a = Math.min(a, z);
        b = Math.max(b, z);
      }
    }
    return [a, b];
  };
  for (let k = 0; k < n; k++) {
    const xa = lo + k * step, xb = xa + step;
    const [a0, b0] = spanAt(xa + 1e-4), [a1, b1] = spanAt(xb - 1e-4);
    const z0 = inner ? Math.max(a0, a1) : Math.min(a0, a1);
    const z1 = inner ? Math.min(b0, b1) : Math.max(b0, b1);
    if (z1 - z0 > 0.05) fn(xa, z0, xb, z1);
  }
}

/**
 * A polygon extruded from y0 to y1: a wall of turned boxes standing on each edge, and strips
 * filling the inside behind them. The wall is what is seen, so it carries the material; the
 * fill only has to be solid.
 */
export function extrude(
  b: Builder, poly: Vec2[], y0: number, y1: number, mat: Mat, tint: Tint, style = 0,
  opts: { wall?: number; fill?: Mat; strip?: number; detail?: boolean } = {},
): void {
  const T = opts.wall ?? 2.6;
  const face = blunt(poly);
  ring(b, face, y0, y1, T, mat, tint, style, { detail: opts.detail });
  const core = shrink(face, T * 0.8);
  if (core.length >= 3) {
    strips(core, opts.strip ?? 9, true, (x0, z0, x1, z1) =>
      b.box(x0, y0, z0, x1, y1, z1, opts.fill ?? Mat.Board, tint, 0, { detail: false, hidden: true }));
  }
}

/**
 * The same polygon with every corner sharper than a right angle cut back on a chord.
 *
 * A band laid along an edge is a box, so its ends are square, and two square ends cannot meet
 * cleanly at anything but a right angle: at a sharper corner one has to stop short of the
 * other or run out through it. Blunting the outline first means they never have to — see
 * `ring`. It is why sharp-cornered blocks come to a short flat face rather than a point, which
 * at this scale reads as a corner detail and not as a change of plan.
 */
export function blunt(poly: Vec2[], chord = 1.2): Vec2[] {
  const n = poly.length;
  const out: Vec2[] = [];
  for (let k = 0; k < n; k++) {
    const p = poly[(k + n - 1) % n], q = poly[k], s = poly[(k + 1) % n];
    const ax = q[0] - p[0], az = q[1] - p[1], bx = s[0] - q[0], bz = s[1] - q[1];
    const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
    if (la < 1e-6 || lb < 1e-6) {
      out.push(q);
      continue;
    }
    const d = Math.atan2(bz, bx) - Math.atan2(az, ax);
    const half = (Math.PI - Math.abs(Math.atan2(Math.sin(d), Math.cos(d)))) / 2;
    if (half >= Math.PI / 4 - 1e-6) {
      out.push(q); // a right angle or blunter: the bands already meet
      continue;
    }
    // equal legs, so the chord stands square to the bisector and both new corners come out
    // at a right angle plus the half-angle that was there — blunt, whatever the corner was
    const leg = Math.min(chord / 2 / Math.sin(half), la * 0.4, lb * 0.4);
    out.push([q[0] - (ax / la) * leg, q[1] - (az / la) * leg]);
    out.push([q[0] + (bx / lb) * leg, q[1] + (bz / lb) * leg]);
  }
  return out;
}

/** How far each band round a ring is set below the one before it, to break the tie. */
const STAGGER = 0.002;

/**
 * A ring of turned boxes standing on the polygon's edges, `depth` thick and reaching inward.
 *
 * Each band runs the whole length of its edge, which closes the ring only because the outline
 * was blunted first. At a corner of a right angle or more, a band that reaches the corner
 * stays inside the next edge, so the two simply overlap and the corner is solid. At a sharper
 * one it would run out through the next edge instead, and pulling both back far enough to stop
 * that — which is what this did — leaves the corner itself carrying nothing: a wedge of
 * missing roof, missing deck and missing wall at every sharp corner in the city, a metre across
 * at a right angle and fifteen at the sharpest, with the street visible down through it.
 *
 * The overlap puts two tops on the same plane, so each band is set a hair lower than the one
 * before it round the ring. Two millimetres is nothing to look at and everything to the depth
 * test, which otherwise has nothing to choose between them.
 */
function ring(
  b: Builder, poly: Vec2[], y0: number, y1: number, depth: number, mat: Mat, tint: Tint,
  style = 0, opts: { detail?: boolean; gaps?: Vec2[]; gapWide?: number } = {},
): void {
  const centre = centroid(poly);
  const n = poly.length;
  for (let k = 0; k < n; k++) {
    const a = poly[k], c = poly[(k + 1) % n];
    const vx = c[0] - a[0], vz = c[1] - a[1];
    const l = Math.hypot(vx, vz);
    if (l < 0.3) continue;
    let nx = -vz / l, nz = vx / l;
    if (nx * (a[0] - centre[0]) + nz * (a[1] - centre[1]) < 0) {
      nx = -nx;
      nz = -nz;
    }
    const top = Math.max(y0 + 0.001, y1 - k * STAGGER);
    const turn = Math.atan2(vz, vx);
    // What the run is cut into: the whole edge, less a doorway at each point asked for. A
    // parapet is laid round the whole deck, and the stair arrives at the deck over it — with
    // the run unbroken the climb ends at a wall.
    let runs: [number, number][] = [[0, l]];
    for (const g of opts.gaps ?? []) {
      const t = ((g[0] - a[0]) * vx + (g[1] - a[1]) * vz) / l;
      const off = Math.abs((g[0] - a[0]) * nx + (g[1] - a[1]) * nz);
      if (off > (opts.gapWide ?? 4)) continue; // that opening belongs to another side
      const w = (opts.gapWide ?? 4) / 2;
      runs = runs.flatMap(([s0, s1]) =>
        [[s0, Math.min(s1, t - w)], [Math.max(s0, t + w), s1]] as [number, number][]);
    }
    // Never deeper than the polygon is from this edge. A band reaches inward by a fixed amount,
    // and a block narrower than two of them — the slivers left between streets are a few metres
    // across — had its paving run clean out of the far side into the road beyond: five metres of
    // pavement over somebody's carriageway, flat at the sliver's own level, standing a couple of
    // metres over the asphalt it covered wherever the street was on a flank.
    let reach = 0;
    for (const v of poly) reach = Math.max(reach, -(nx * (v[0] - a[0]) + nz * (v[1] - a[1])));
    const d = Math.max(0.05, Math.min(depth, reach));
    for (const [s0, s1] of runs) {
      if (s1 - s0 < 0.3) continue;
      const mx = a[0] + (vx / l) * ((s0 + s1) / 2) - nx * d / 2;
      const mz = a[1] + (vz / l) * ((s0 + s1) / 2) - nz * d / 2;
      b.box(mx - (s1 - s0) / 2, y0, mz - d / 2, mx + (s1 - s0) / 2, top, mz + d / 2,
        mat, tint, style, { turn, detail: opts.detail });
    }
  }
}

/**
 * How far the fill sits below the band that covers its edges.
 *
 * The band is laid *over* the staircase the strips leave, so the two overlap — and with both
 * tops on exactly the same plane the depth test has nothing to choose between them. What that
 * shows as is a scatter of triangles round the edge of every roof, each shaded from whichever
 * box happened to win that pixel, flipping as the camera moves. Dropping the fill puts the
 * band unambiguously on top. The step is buried under the band everywhere but at its inner
 * edge, where five centimetres reads as a joint in the paving.
 */
const FILL_DROP = 0.05;

/**
 * A flat slab over the whole polygon: strips that stay inside the outline, and a band of
 * turned boxes laid along each edge to close it off.
 *
 * The band is not decoration. Strips alone have to over-cover to reach the edges, and on a
 * polygon that is not square to them every edge comes out as a flight of steps — which is why
 * every roof in the city had a sawtooth on it.
 */
export function slab(b: Builder, poly: Vec2[], y0: number, y1: number, mat: Mat, tint: Tint): void {
  const face = blunt(poly);
  ring(b, face, y0, y1, 5, mat, tint, 0, { detail: false });
  // strips no wider than the band is deep, so the staircase they leave at a slanted edge
  // stays under the band that covers it
  const fill = Math.max(y0 + 0.01, y1 - FILL_DROP);
  strips(face, 4.5, true, (x0, z0, x1, z1) => b.box(x0, y0, z0, x1, fill, z1, mat, tint, 0, { detail: false }));
}

/** A parapet standing on the polygon's edge. */
function parapet(b: Builder, poly: Vec2[], y: number, h: number, tint: Tint, gaps: Vec2[] = []): void {
  ring(b, blunt(poly), y, y + h, 0.36, Mat.Board, tint, 0, { gaps, gapWide: 4.4 });
}

export function areaOf(poly: Vec2[]): number {
  let a = 0;
  for (let k = 0; k < poly.length; k++) {
    const p = poly[k], q = poly[(k + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

/** Keeps the part of a convex polygon on one side of a line. */
function half(poly: Vec2[], nx: number, nz: number, c: number): Vec2[] {
  const out: Vec2[] = [];
  for (let k = 0; k < poly.length; k++) {
    const p = poly[k], q = poly[(k + 1) % poly.length];
    const sp = nx * p[0] + nz * p[1] - c, sq = nx * q[0] + nz * q[1] - c;
    if (sp <= 0) out.push(p);
    if ((sp < 0 && sq > 0) || (sp > 0 && sq < 0)) {
      const t = sp / (sp - sq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

/**
 * Cuts a block into plots, each of which gets its own building.
 *
 * This is the whole reason the city stops looking rectangular. Fitting an axis-aligned
 * rectangle into each block and standing a box in it — which is what this did first — gives
 * exactly the old skyline however crooked the streets are, because every building still
 * squares up to the world. Cutting the block itself means every plot inherits the block's own
 * angles, so no two buildings share a facing and none of them line up with anything.
 */
export function subdivide(poly: Vec2[], r: Rng, target: number, depth = 0): Vec2[][] {
  if (depth >= 3 || areaOf(poly) < target) return [poly];
  // cut through the middle, roughly across whichever way the plot is longest
  const angle = r.uniform(0, Math.PI);
  const nx = Math.cos(angle), nz = Math.sin(angle);
  let lo = Infinity, hi = -Infinity;
  for (const p of poly) {
    const d = nx * p[0] + nz * p[1];
    lo = Math.min(lo, d);
    hi = Math.max(hi, d);
  }
  const cut = lo + (hi - lo) * r.uniform(0.35, 0.65);
  const a = half(poly, nx, nz, cut), b = half(poly, -nx, -nz, -cut);
  if (a.length < 3 || b.length < 3 || areaOf(a) < target * 0.3 || areaOf(b) < target * 0.3) return [poly];
  return [...subdivide(a, r, target, depth + 1), ...subdivide(b, r, target, depth + 1)];
}

/** Everything that stands on one block. */
function buildBlock(site: Site, b: Builder): void {
  const poly = cellOf(site);
  if (!poly || poly.length < 3) return;
  const r = new Rng(hashInt(Math.round(site.p[0]), Math.round(site.p[1]), 300));
  const tint = r.pick(TINTS);
  b.finish = r.pick([Finish.Boards, Finish.Boards, Finish.Ribbed, Finish.Cast]);

  // The pavement is the ground's (see `terrain`): the street's own surface carried in to the
  // foot of the podium, so it is level with the road all round. A sliver left between streets
  // is nothing else.
  if (!podiumOf(poly)) return;
  const face = shrink(poly, WALK);
  // The podium is flat, at the level of the street round it; where the street falls away below
  // that it stands on a plinth, and where it climbs above, the pavement runs up its wall.
  const base = blockBase(poly);
  let lowest = base;
  for (const [px, pz] of face) lowest = Math.min(lowest, paveAt(px, pz));
  extrude(b, face, lowest - 16, base, Mat.Board, tint, Finish.Cast, { wall: 4, strip: 14, detail: false });
  slab(b, face, base, base + 0.18, Mat.Paving, [1, 1, 1]);

  const E = base + DECKS[hashInt(Math.round(site.p[0]), Math.round(site.p[1]), 301) % DECKS.length];
  const dens = grain(site.p[0], site.p[1]);

  // What kind of block this is decides how finely it is cut up and how high it goes, so the
  // city reads as quarters rather than one averaged texture repeated everywhere.
  const kind = r.pick<Kind>(dens > 0.55
    ? ["cluster", "cluster", "spire", "perimeter", "slab"]
    : ["perimeter", "slab", "cluster", "yard"]);
  const target = kind === "perimeter" ? 1500 : kind === "cluster" ? 3400 : kind === "slab" ? 9000 : 6000;

  // The podium is one mass carrying one deck over the whole block, and the towers stand on
  // that rather than on the ground. Cutting the block into plots that each ran their own way
  // from the pavement to their own height looked better, but it left nothing continuous to
  // walk on and nowhere for a stair to arrive — and this is a game about running the decks.
  const arcade = base + 5.5;
  extrude(b, face, base + 0.18, arcade, Mat.Board, tint, Finish.Ribbed, { wall: 3.6, strip: 13 });
  extrude(b, face, arcade, E - 1.4, Mat.Windows, tint,
    r.pick([Win.Ribbon, Win.Grid, Win.Punched, Win.Crate]), { wall: 3.2, strip: 13 });
  const deck = shrink(poly, WALK - 0.9);
  slab(b, deck, E - 1.4, E, Mat.Deck, tint);
  const stair = perimeterStair(b, poly, E, tint);
  parapet(b, deck, E, 1.05, tint, stair.arrival ? [stair.arrival] : []);
  // a block whose perimeter is too short to climb has to have the lift, or its deck — and the
  // flyer standing on it — is somewhere nothing can reach
  blockLifts(b, poly, E, tint, stair.treads, !stair.arrived);
  deckBridges(b, site, E, tint);
  deckPads(b, poly, E);

  const plots = subdivide(shrink(face, 4), r, target);
  plots.forEach((plot) => {
    const foot = shrink(plot, r.uniform(1.4, 3.4));
    if (foot.length < 3 || areaOf(foot) < 120) return;

    const low = kind === "yard" ? r.chance(0.55) : r.chance(0.18);
    const roll = r.next();
    const reach = kind === "spire" ? 2.1 : kind === "cluster" ? 1.5 : 1.0;
    const rise = low ? 0
      : roll < 0.4 ? r.uniform(14, 70)
      : roll < 0.78 ? r.uniform(70, 190)
      : roll < 0.95 ? r.uniform(190, 360)
      : r.uniform(360, 620); // the few that carry the skyline
    // capped: the few that ran past a kilometre were in view from everywhere, never culled
    let top = E + Math.min(480, rise * reach * (0.55 + 0.75 * dens));
    const style = r.pick([Win.Ribbon, Win.Grid, Win.Punched, Win.Crate, Win.Slit]);

    // tall buildings step back on the way up instead of going straight to the top
    const stages = rise * reach > 150 ? r.int(2, 4) : 1;
    let y = E, shape = foot;
    if (low) {
      // a low plot is just a raised terrace on the deck, still walkable, and where there is
      // room a landing pad with a flyer waiting on it
      const lift = r.uniform(1.2, 4.5);
      slab(b, foot, E, E + lift, Mat.Deck, tint);
      padOn(b, foot, E + lift, r);
      return;
    }
    // A set-back can run out of plan before it runs out of height: shrinking the shaft again
    // leaves too little to stand a storey on. The height asked for is then not a height this
    // plot can reach, so the building stops where the shaft does — the crown is brought down
    // to it rather than left at the number. Left at the number it was a roof, a penthouse and
    // a lit mast hanging in open sky two hundred metres over a tower that had already ended.
    for (let s = 0; s < stages; s++) {
      const stageTop = s === stages - 1 ? top - 1.4 : y + (top - 1.4 - y) * r.uniform(0.35, 0.6);
      extrude(b, shape, y, stageTop, Mat.Windows, tint, style, { wall: 3.0, strip: 12 });
      y = stageTop;
      if (s === stages - 1) break;
      // whether there is another stage is settled before the cornice, so a cornice is only
      // ever laid between two shafts and never as a shelf on the end of one
      const next = shrink(shape, r.uniform(2.0, 5.0));
      if (next.length < 3 || areaOf(next) < 110) break;
      const ledge = shrink(shape, -0.7); // a cornice standing a little proud of the shaft
      if (ledge.length >= 3) slab(b, ledge, stageTop, stageTop + 1.3, Mat.Panel, tint);
      shape = next;
      y = stageTop + 1.3;
    }
    top = y + 1.4;
    const cap = shrink(shape, r.uniform(-1.4, 0.4));
    if (cap.length < 3) return;
    slab(b, cap, top - 1.4, top, Mat.Deck, tint);
    if (low) {
      parapet(b, cap, top, 1.0, tint);
    } else {
      slab(b, shrink(cap, 1.2), top, top + r.uniform(2, 4.5), Mat.Board, tint);
      b.roofs.push({ y: top, poly: cap });
      const c = centroid(cap);
      if (top - E > 220) {
        // a mast and a light on the ones that stand above everything
        const mast = r.uniform(20, 70);
        b.box(c[0] - 0.45, top + 3, c[1] - 0.45, c[0] + 0.45, top + 3 + mast, c[1] + 0.45, Mat.Metal, tint, 0, { detail: false });
        b.box(c[0] - 0.7, top + 3 + mast, c[1] - 0.7, c[0] + 0.7, top + 4.4 + mast, c[1] + 0.7, Mat.Beacon, tint, 0, { collide: false });
        b.masts.push(c[0], top + 4.4 + mast, c[1]);
      } else if (r.chance(0.4)) {
        b.box(c[0] - 0.6, top + 3, c[1] - 0.6, c[0] + 0.6, top + 3.9, c[1] + 0.6, Mat.Beacon, tint, 0, { collide: false });
      }
    }
  });
  zipline(b, site, E);
}

/** How high each end's post stands over what it stands on: the cable runs between their tops. */
const ZIP_POST_HIGH = 3.4, ZIP_POST_LOW = 3.2;

/**
 * A zipline off the roof of one of the block's towers, down across a street to the deck of the
 * block on the other side. Not on every block — a few in each quarter — and only where the run
 * is long enough to be worth riding and falls steeply enough to carry a rider the whole way.
 *
 * What stands between the two ends is not known here: the block across the street is built on
 * its own, and the towers on this one could be anywhere. So the line is laid regardless, and
 * the game tests it against the city's collision once both ends are streamed in, and leaves it
 * out if anything is in the way (see zips.ts). So it lays a few, and their posts are drawn
 * with whichever one is ridden rather than built here.
 */
function zipline(b: Builder, site: Site, E: number): void {
  const h = hashInt(Math.round(site.p[0]), Math.round(site.p[1]), 368);
  if (h % 100 >= 85) return;
  const roofs = b.roofs.filter((r) => r.y - E > 18);
  if (!roofs.length) return;
  const own = collidersOf(b);
  /** Whether a rider hanging under the cable from a to c would hit anything this block has built. */
  const clear = (a: Vec3, c: Vec3): boolean => {
    const len = Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
    for (let t = 2.5; t < len - 3; t += 1.5) {
      const k = t / len, x = a[0] + (c[0] - a[0]) * k, y = a[1] + (c[1] - a[1]) * k, z = a[2] + (c[2] - a[2]) * k;
      for (let i = 0; i < own.length; i += 6) {
        if (x > own[i] - 0.6 && x < own[i + 3] + 0.6 && z > own[i + 2] - 0.6 && z < own[i + 5] + 0.6 &&
            own[i + 4] > y - 2.7 && own[i + 1] < y + 0.3) return false;
      }
    }
    return true;
  };
  const across = neighbours(site).filter((n) => !riverNear(n.mid[0], n.mid[1], RIVER_HALF + 40));
  const found: { a: Vec3; c: Vec3; score: number }[] = [];
  for (const { other, mid, normal } of across) {
    const poly = cellOf(other);
    if (!poly || poly.length < 3 || !podiumOf(poly)) continue;
    // out over the street onto the far deck's walk, between its parapet and its towers
    const walk = shrink(poly, WALK + 1.6);
    if (walk.length < 3) continue;
    const deck = deckOf(other);
    // Off to one side of the middle of the street, where the bridge between the two decks lands.
    for (const slide of [14, -14, 24, -24]) {
    let target: Vec2 | null = null;
    for (let d = 0; d < 90 && !target; d += 1) {
      const q: Vec2 = [mid[0] + normal[0] * d - normal[1] * slide, mid[1] + normal[1] * d + normal[0] * slide];
      if (inPoly(walk, q[0], q[1])) target = q;
    }
    if (!target) continue;
    for (const roof of roofs) {
      // from the edge of the roof facing that way, inside its rim and clear of the plant room
      const c = centroid(roof.poly);
      const ux = target[0] - c[0], uz = target[1] - c[1], ul = Math.hypot(ux, uz) || 1;
      let edge = 0;
      while (edge < 80 && inPoly(roof.poly, c[0] + (ux / ul) * edge, c[1] + (uz / ul) * edge)) edge += 0.25;
      const sx = c[0] + (ux / ul) * (edge - 0.8), sz = c[1] + (uz / ul) * (edge - 0.8);
      const a: Vec3 = [sx, roof.y + ZIP_POST_HIGH, sz], e: Vec3 = [target[0], deck + ZIP_POST_LOW, target[1]];
      const run = Math.hypot(e[0] - a[0], e[2] - a[2]), slope = (a[1] - e[1]) / run;
      if (run < 40 || run > 280 || slope < 0.12 || slope > 0.75) continue;
      // a fall of about one in three is the ride: steep enough to fly, not so steep it is a drop
      const score = Math.abs(slope - 0.33);
      if (!clear(a, e)) continue;
      found.push({ a, c: e, score });
    }
    }
  }
  // The best few, in order: the game rides the first of them that turns out to be clear all
  // the way down, and the block's number is what ties them together.
  found.sort((x, y) => x.score - y.score);
  for (const f of found.slice(0, 3)) b.zips.push(...f.a, ...f.c, h);
}

// The terrace and the tile live with the terrain field: between them they set the steepest
// ground it is allowed to ask for, and neither can be changed here alone.

/**
 * A rectangle of carriageway and the gradient it was cut to: a stretch of street, or a bay of
 * fill along a main road. These say where the road is and roughly how high; what the surface
 * actually is, everywhere, is `fieldAt`.
 */
interface Lane {
  cx: number;
  cz: number;
  ux: number;
  uz: number;
  hl: number; // half length, along u
  hw: number; // half width, across
  /** Height on the centreline at the middle. */
  y: number;
  /** How much the surface climbs per metre along `u`. */
  grade: number;
  /**
   * How much it climbs per metre across, at either end; see `cutPieces`. Nothing on a main
   * road or fill, which are level across.
   */
  c0: number;
  c1: number;
}

/** One straight gradient of street: a turned rectangle sloping along its own length. */
interface Piece extends Lane {
  street: Street;
  /** Stations along the street this stretch runs between, and the street's length. */
  s0: number;
  s1: number;
  len: number;
  /** Stations of the unbroken run of stretches this one is part of: where the street is laid. */
  run0: number;
  run1: number;
}

/** Surface height of a stretch at a station along its street. */
function pieceYAt(p: Piece, s: number): number {
  const mid = (p.s0 + p.s1) / 2;
  return p.y + p.grade * (Math.max(p.s0, Math.min(p.s1, s)) - mid);
}

/** Height of a lane's own surface under a point, carried on level past its ends and sides. */
function pieceYOn(p: Lane, x: number, z: number): number {
  const dx = x - p.cx, dz = z - p.cz;
  const u = Math.max(-p.hl, Math.min(p.hl, dx * p.ux + dz * p.uz));
  const v = Math.max(-p.hw, Math.min(p.hw, dz * p.ux - dx * p.uz));
  const t = p.hl > 0 ? (u + p.hl) / (2 * p.hl) : 0.5;
  return p.y + p.grade * u + (p.c0 + (p.c1 - p.c0) * t) * v;
}

// Cutting a street into stretches walks its whole length a metre at a time, asking the height
// at every step, and each region asks for the same streets twice — once to cut the ground
// against them and once to lay the ones it owns — as well as for its neighbours' streets along
// every seam. Remembered by the street's own ends, which is what makes it the same street.
const pieceCache = rememberBySeed<string, Piece[]>();

/**
 * A street's surface, cut into flat stretches.
 *
 * Its height is the ground's along its centreline, but each step runs straight across the
 * whole street. The ground tiles did this job before, and a street made of tiles is cut to the
 * ground's own contours: a road of irregular blobs, with steps running every which way.
 */
function piecesOf(st: Street): Piece[] {
  const key = `${st.a[0].toFixed(1)},${st.a[1].toFixed(1)},${st.b[0].toFixed(1)},${st.b[1].toFixed(1)}`;
  checkSeed();
  const hit = pieceCache.get(key);
  if (hit) return hit;
  const out = cutPieces(st);
  if (pieceCache.size > 8192) pieceCache.clear();
  pieceCache.set(key, out);
  return out;
}

/**
 * How far from a corner the junction runs, and how far beyond that the road takes to come back
 * to the ground. The first has to cover the widest carriageway that can meet here, or the far
 * side of it laps over this one again; the second is long enough that making up the difference
 * is an ordinary run of terrace steps rather than a wall.
 */
const JUNCTION = ARTERY_HALF + 2;
const FADE = 22;

/**
 * The height a corner sits at, which every street meeting there has to take if their slabs are
 * to agree where they overlap.
 *
 * Where an arterial runs through it, that road decides, and the rest come to meet it — which is
 * what a side street does at a main road in any case. The corner itself is no use as the
 * reference: it is a Voronoi vertex, which where a street meets an arterial stands off in the
 * block line tens of metres from the carriageway, over ground that on a flank is a metre and a
 * half from the road's. Away from any arterial the corner is the shared point and its own
 * ground is what they all agree on — the ground itself, not the terrace it rounds to, since every
 * street there follows the ground and any offset from it is a difference between them.
 */
function cornerHeight(x: number, z: number): number {
  return arterialAt(x, z, 18) ?? terrainAt(x, z);
}

/**
 * Stretches of arterial near a point, remembered by the cell they fall in.
 *
 * Arterials only, and that is the point of it: a street works out its own height by asking
 * which main road it lies in, so a gather that gave it every street would set it off cutting
 * the very street that was asking. An arterial never asks — it takes the ground it runs over —
 * so this can never come back round on itself.
 */
const arterialCells = rememberBySeed<string, Piece[]>();

function arterialPiecesNear(x: number, z: number): Piece[] {
  const ci = Math.floor(x / PIECE_CELL), cj = Math.floor(z / PIECE_CELL);
  const key = `${ci},${cj}`;
  checkSeed();
  const hit = arterialCells.get(key);
  if (hit) return hit;
  const x0 = ci * PIECE_CELL, z0 = cj * PIECE_CELL, x1 = x0 + PIECE_CELL, z1 = z0 + PIECE_CELL;
  const out: Piece[] = [];
  const seen = new Set<string>();
  for (const site of blocksIn(x0 - 260, z0 - 260, x1 + 260, z1 + 260))
    for (const st of streetsOf(site)) {
      if (st.half < ARTERY_HALF - 0.5 || st.half >= RIVER_HALF) continue;
      const [a, b] = st.a[0] < st.b[0] || (st.a[0] === st.b[0] && st.a[1] <= st.b[1]) ? [st.a, st.b] : [st.b, st.a];
      const k = `${a[0].toFixed(1)},${a[1].toFixed(1)},${b[0].toFixed(1)},${b[1].toFixed(1)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      for (const p of piecesOf(st)) {
        const r = Math.hypot(p.hl, p.hw);
        if (p.cx + r < x0 || p.cx - r > x1 || p.cz + r < z0 || p.cz - r > z1) continue;
        out.push(p);
      }
    }
  if (arterialCells.size > 2048) arterialCells.clear();
  arterialCells.set(key, out);
  return out;
}

/**
 * The arterial carriageway laid over a point, or null where none is. What a side street has to
 * be at wherever it lies in a main road's width, or the two slabs overlap at different levels
 * and one of them is a step in the middle of the other.
 *
 * The carriageway itself, not the ground under the road's centreline: the carriageway is laid
 * along the straight edge between the blocks either side of it, and that runs its own way off
 * the spline the road is drawn from. Reading the spline's ground gave an answer the road was
 * never at, which is a way of disagreeing with it by two and a half metres.
 */
/**
 * The arterial carriageway over a point and how much of a say it has there: all of it inside
 * the road, none of it `feather` metres clear of the kerb.
 *
 * The say is the whole point. Asked as a yes or no — which is what `arterialAt` gives — a
 * street leaving a main road took the road.s surface for one metre and the ground.s for the
 * next, and the metre between them was a slab at a gradient of one in one. That is the wall
 * across the mouth of a side street, and the pit the ground beside it appears to be.
 */
function arterialBlend(x: number, z: number, margin: number, feather: number): { y: number; w: number } | null {
  // Weighed together, never picked between. Taking the highest carriageway and then using
  // that one's weight means the piece that wins can change from one step to the next — a
  // far one with almost no say outranking a near one with all of it — and the answer jumps
  // by the difference between them. Which is the same wall again, in a new place.
  let sum = 0, wsum = 0, most = 0;
  for (const p of arterialPiecesNear(x, z)) {
    const dx = x - p.cx, dz = z - p.cz;
    const out = Math.max(
      Math.abs(dx * p.ux + dz * p.uz) - (p.hl + margin),
      Math.abs(dz * p.ux - dx * p.uz) - (p.hw + margin),
    );
    if (out > feather) continue;
    const t = out <= 0 ? 0 : out / feather;
    const w = 1 - t * t * (3 - 2 * t);
    sum += pieceYOn(p, x, z) * w;
    wsum += w;
    most = Math.max(most, w);
  }
  return wsum > 0 ? { y: sum / wsum, w: most } : null;
}

/**
 * The ground along the centreline of the main roads in `segs` nearest a point, and how much
 * of a say it has there: `arterialBlend` for the fill, which is laid at that height.
 */
function mainBlend(
  segs: [Vec2, Vec2][], x: number, z: number, margin: number, feather: number,
): { y: number; w: number } | null {
  let sum = 0, wsum = 0, most = 0;
  for (const [a, b] of segs) {
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const l2 = dx * dx + dz * dz;
    const t = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2));
    const qx = a[0] + t * dx, qz = a[1] + t * dz;
    const out = Math.hypot(x - qx, z - qz) - (FILL_HALF + margin);
    if (out > feather) continue;
    const u = out <= 0 ? 0 : out / feather;
    const w = 1 - u * u * (3 - 2 * u);
    sum += fillGround(qx, qz) * w;
    wsum += w;
    most = Math.max(most, w);
  }
  return wsum > 0 ? { y: sum / wsum, w: most } : null;
}

/**
 * The level fill is laid at on a main road's centreline: the ground, except near the road's
 * own stretches, where it comes to meet them.
 *
 * A stretch runs along the straight edge between the blocks either side of it, which can stand
 * well off the spline the fill follows, and on a flank the ground under the two is metres
 * apart. Where the blocks ran out and the fill took over, the road stepped by all of that.
 */
function fillGround(x: number, z: number): number {
  const g = terrainAt(x, z);
  const over = arterialBlend(x, z, 0, FADE);
  return over ? g + (over.y - g) * over.w : g;
}

/**
 * How far past a main road's kerb its carriageway still owns the ground: the widest its own
 * structure ever gets, which is the bridge deck at ARTERY_HALF + 2.
 */
const ARTERY_MARGIN = 2.5;

/**
 * Whether a point lies in a main road's carriageway, measured against the road's own straight
 * pieces rather than against the stretches laid along it.
 *
 * `arterialAt` can only answer where the arterial has stretches, and there are three places it
 * has none: where the blocks either side run out and the carriageway is laid as fill instead,
 * over a river, and on the approach ramps up to a bridge. A side street asking only that ran
 * into all three — laid at its own level across a main road that was there after all, so a car
 * on the side street drove through the fill, and under a ramp it came up through the deck.
 *
 * `segs` are the pieces gathered once for the whole street; see `cutPieces`. They are the ones
 * the network already keeps for clipping blocks off these roads, so this costs a few dot
 * products and nothing else — which matters, because it is asked for every metre of every
 * street in the city.
 */
function onArtery(segs: [Vec2, Vec2][], x: number, z: number, ux: number, uz: number): boolean {
  for (const [a, b] of segs) {
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const l2 = dx * dx + dz * dz;
    // A street that meets the main road runs on to just inside the fill's own edge, so that
    // the two overlap; stopping at the margin left a slot of bare ground two metres wide across
    // the mouth of every side street. One running alongside it, in the strip between the road
    // and the blocks cut back off it, keeps the margin and is not laid there at all.
    const along = l2 > 1e-9 && Math.abs(dx * ux + dz * uz) / Math.sqrt(l2) > Math.SQRT1_2;
    const reach = along ? ARTERY_HALF + ARTERY_MARGIN : FILL_HALF - 0.5;
    const t = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2));
    if (Math.hypot(x - (a[0] + t * dx), z - (a[1] + t * dz)) <= reach) return true;
  }
  return false;
}

/**
 * Whether a point is inside any block, kept by a coarse cell.
 *
 * Only the Voronoi cells and the width of the streets round them go into this, so it asks
 * nothing that is worked out from a street's own stretches and can be asked from inside the
 * cutting of them.
 */
const blockCells = rememberBySeed<string, Vec2[][]>();

function inBlock(x: number, z: number): boolean {
  const ci = Math.floor(x / PIECE_CELL), cj = Math.floor(z / PIECE_CELL);
  const key = `${ci},${cj}`;
  checkSeed();
  let near = blockCells.get(key);
  if (!near) {
    near = blocksIn(ci * PIECE_CELL - 260, cj * PIECE_CELL - 260,
      (ci + 1) * PIECE_CELL + 260, (cj + 1) * PIECE_CELL + 260)
      .map((s) => cellOf(s))
      .filter((p): p is Vec2[] => !!p && p.length >= 3);
    if (blockCells.size > 2048) blockCells.clear();
    blockCells.set(key, near);
  }
  return near.some((p) => inPoly(p, x, z));
}

function arterialAt(x: number, z: number, margin: number): number | null {
  let top: number | null = null;
  for (const p of arterialPiecesNear(x, z)) {
    const dx = x - p.cx, dz = z - p.cz;
    if (Math.abs(dx * p.ux + dz * p.uz) > p.hl + margin) continue;
    if (Math.abs(dz * p.ux - dx * p.uz) > p.hw + margin) continue;
    const y = pieceYOn(p, x, z);
    if (top === null || y > top) top = y;
  }
  return top;
}

function cutPieces(st: Street): Piece[] {
  const [ax, az] = st.a, [bx, bz] = st.b;
  const L = Math.hypot(bx - ax, bz - az);
  const ux = (bx - ax) / L, uz = (bz - az) / L;
  // Carried on past each end, far enough to fill the junction out to the corner kerbs — but
  // only where the end is a junction. An arterial is a chain of stretches of its own, some of
  // them shorter than the thirty metres this used to add, so each one was laid straight over
  // its neighbours from end to end: three or four slabs stacked in the same place, flat at
  // three or four different heights, with three and a half metres between the highest and the
  // lowest. That is the lip the cars were leaping onto and the ground they vanished into. The
  // stretches of one road meet at their shared ends and need nothing added.
  const arterial = st.half >= ARTERY_HALF - 0.5;
  const ext = arterial ? 0 : Math.min(st.half * 1.8, 30);
  const hw = st.half + 0.4;
  // Every main road that comes near this street, gathered once for the whole of it rather than
  // per sample: see `onArtery`.
  const mains = arterial ? []
    : arteriesNear((ax + bx) / 2, (az + bz) / 2, L / 2 + ext + ARTERY_HALF + st.half + FADE + 4);
  // The height of the ground on the centreline, the same number the traffic drives on — except
  // near either end, where it holds the height of the corner instead.
  //
  // A carriageway is a flat slab the whole way across, cut to the ground along its own middle.
  // Two of them crossing on a slope therefore disagree about the height of the ground they
  // share: each is flat at its own centreline's, and between them lies the fall across half a
  // road, which on a steep flank is over a metre. What that built was one carriageway lapping
  // over the other — a lip across the road, a car that leapt onto it and dropped off the far
  // side, and anything parked there buried. Every street meeting at a corner takes that
  // corner's height over the whole junction instead, so they agree exactly where they overlap,
  // and eases back to the ground it actually runs over once clear of it. A junction is a flat
  // table in any case; that is what one looks like.
  // An arterial is exempt, because its corners are not junctions: they are the joins between
  // its own consecutive stretches, and both sides of one are the same road taking its height
  // from the same ground. Holding it flat over them instead pushed the carriageway off the
  // ground for eighty metres in every hundred — and then every side street meeting it in
  // between, which does take the ground at the corner they share, disagreed with it by the
  // whole of that. It simply follows the ground, and the streets joining it come to meet it.
  const corners = !arterial;
  // only for a street that has junctions at its ends; an arterial asking would send this round
  // in a circle, since what it would be asking is which arterial it lies in
  const yA = corners ? cornerHeight(ax, az) : 0, yB = corners ? cornerHeight(bx, bz) : 0;
  const dA = corners ? yA - terrainAt(ax, az) : 0, dB = corners ? yB - terrainAt(bx, bz) : 0;
  /**
   * Height on the centreline at a station, and how much the surface climbs per metre across
   * the street there.
   *
   * A street is level across almost everywhere. In a junction it is not: two streets crossing
   * on a flank each carried the ground along their own middles, and where they overlapped they
   * disagreed by the fall across half a road — over a metre at a corner on steep ground. So in
   * the junction, and fading out with it, a street takes the ground's fall across it as well as
   * along it, and past its own ends follows the ground on into the junction rather than holding
   * the corner's height. Every street meeting there is then the ground plus the same offset,
   * which is the same surface, so they agree wherever they overlap.
   */
  /**
   * What the main roads near a station make of it, every COARSE metres: the ground's fall
   * across the street, and for the fill and the stretches of a main road in turn how much say
   * they have, times the height they ask for and times their slope across this street. All of
   * it changes over tens of metres, so it is read this often and interpolated between, which is
   * most of what cutting a street costs saved; kept times the say, since a say of nothing has
   * no height to interpolate.
   */
  const COARSE = 4;
  const coarse = new Map<number, number[]>();
  const mainsAt = (k: number): number[] => {
    const hit = coarse.get(k);
    if (hit) return hit;
    const s = k * COARSE, x = ax + ux * s, z = az + uz * s;
    const out = [fallAcross(x, z, ux, uz)];
    // a main road has no main roads to meet, only others crossing it
    if (!corners) out[0] *= crossingSay(x, z, ux, uz);
    else for (const f of [
      (px: number, pz: number) => mainBlend(mains, px, pz, st.half + 2, FADE),
      (px: number, pz: number) => arterialBlend(px, pz, st.half + 2, FADE),
    ]) {
      const m = f(x, z);
      const l = m && f(x - uz, z + ux), r = m && f(x + uz, z - ux);
      out.push(m ? m.w : 0, m ? m.w * m.y : 0, m && l && r ? (m.w * (l.y - r.y)) / 2 : 0);
    }
    coarse.set(k, out);
    return out;
  };
  const yAt = (s: number): [number, number] => {
    const c = Math.max(0, Math.min(L, s));
    const x = ax + ux * s, z = az + uz * s;
    // An arterial simply follows the ground, and now follows it as a gradient rather than as
    // the terrace it stands nearest. Consecutive stretches of one are separate streets that
    // meet end to end, and both read this at the same point, so they still agree exactly.
    const k0 = Math.floor(s / COARSE), f = s / COARSE - k0;
    const lo = mainsAt(k0), hi = mainsAt(k0 + 1);
    const m = lo.map((v, e) => v + (hi[e] - v) * f);
    if (!corners) return [terrainAt(ax + ux * c, az + uz * c), m[0]];
    // How much each end's junction still has a say here: all of it out to JUNCTION, none of
    // it past JUNCTION + FADE.
    const hold = (d: number) => {
      if (d <= JUNCTION) return 1;
      if (d >= JUNCTION + FADE) return 0;
      const t = (d - JUNCTION) / FADE;
      return 1 - t * t * (3 - 2 * t);
    };
    const wA = hold(c), wB = hold(L - c);
    // What a junction has to be is the *same* for every street meeting there, not level. It
    // was held dead flat at the corner's height for nineteen metres, so wherever the ground
    // fell away inside that the carriageway stayed up and stood on a plinth — a table a
    // metre and a half proud of the land with a cliff round it, which from below is a pit in
    // the middle of the road. Carrying the corner's *offset* from the ground instead, rather
    // than its height, lets every street that shares the corner follow the hill down together.
    const ground = terrainAt(x, z);
    let y = wA + wB >= 1
      ? ground + (dA * wA + dB * wB) / (wA + wB)
      : ground + dA * wA + dB * wB;
    let cross = Math.min(1, wA + wB) * m[0];
    // Where this street lies in a main road it is that road's surface, not its own — a side
    // street leaving an arterial at a shallow angle stays in the carriageway for thirty or
    // forty metres. Eased out over the same distance a junction is, so that leaving the road
    // is a ramp off it rather than the step off its edge that it was. First to the fill, where
    // the main road has no stretches here (see `fillIn`) — without it a side street met the
    // fill as much as a metre and a half above it — then to the stretches.
    //
    // And to its slope across this street's mouth as well as its level: which is mostly the
    // main road's own gradient, running across the end of a street that meets it square.
    // Levelled out instead, a street came into the side of a main road on a flank with one kerb
    // above it and the other below.
    for (const e of [1, 4]) {
      const w = m[e];
      y = y * (1 - w) + m[e + 1];
      cross = cross * (1 - w) + m[e + 2];
    }
    return [y, cross];
  };
  // Nothing is laid over the water, and nothing is laid inside a main road either: where a
  // side street runs into an arterial, the arterial's own carriageway is the junction, and a
  // second slab over the top of it at a slightly different level is a step across the road and
  // the lip a car catches on. The side street stops at the kerb, which is what a side street
  // does, and its approach is already at the main road's level to meet it.
  const wet = (s: number) => {
    const x = ax + ux * s, z = az + uz * s;
    // The main road's carriageway is the junction, wherever it is: laid as its own stretches,
    // filled in where the blocks beside it ran out, or carried over a valley on a bridge whose
    // ramps come down through here. A side street stops at the kerb in all three.
    if (corners && (arterialAt(x, z, 0) !== null || onArtery(mains, x, z, ux, uz))) return true;
    // Past its own ends a street is only there to fill the junction, and a junction is as wide
    // as the roads that meet in it — not as wide as `ext`, which carries the slab up to thirty
    // metres on. Where the overhang has left the junction and run into a block it is asphalt
    // under somebody's pavement: a carriageway the city never draws, which a car is told it may
    // drive on and sinks two metres into.
    if (corners && (s < 0 || s > L) && inBlock(x, z)) return true;
    const r = riverNear(x, z, RIVER_HALF + QUAY + st.half);
    return !!r && r.dist < RIVER_HALF + QUAY + 2;
  };
  const out: Piece[] = [];
  const push = (s0: number, s1: number, ya: number, yb: number, c0: number, c1: number) => {
    const m = (s0 + s1) / 2;
    out.push({
      cx: ax + ux * m, cz: az + uz * m, ux, uz, hl: (s1 - s0) / 2, hw,
      y: (ya + yb) / 2, grade: (yb - ya) / (s1 - s0), c0, c1, street: st, s0, s1, len: L, run0: s0, run1: s1,
    });
  };

  // The whole centreline, a metre at a time, then cut into the fewest straight gradients that
  // stay within SAG of it. Cutting on the terrace instead — a new stretch wherever the rounded
  // ground changed — is what made a road on a flank a flight of half-metre stairs: down the
  // steepest ground the city can grow that is a step every five metres. Each cut lands on a
  // sample both stretches share, so consecutive ones meet exactly and the road stays one
  // surface however the gradient changes.
  const s0 = -ext, s1 = L + ext;
  const n = Math.max(1, Math.round(s1 - s0));
  const ys: number[] = [], cs: number[] = [], dry: boolean[] = [];
  for (let k = 0; k <= n; k++) {
    const s = s0 + ((s1 - s0) * k) / n;
    const [y, c] = yAt(s);
    ys.push(y);
    cs.push(c);
    dry.push(!wet(s));
  }
  const at = (k: number) => s0 + ((s1 - s0) * k) / n;
  let i = 0;
  while (i < n) {
    if (!dry[i]) {
      i++;
      continue;
    }
    let j = i + 1;
    for (; j <= n; j++) {
      if (!dry[j]) break;
      // the straight line from i to j, tested against every sample it passes over, on the
      // centreline and at either kerb
      let off = 0;
      for (let k = i + 1; k < j; k++) {
        const f = (k - i) / (j - i);
        off = Math.max(off, Math.abs(ys[k] - (ys[i] + (ys[j] - ys[i]) * f)) + Math.abs(cs[k] - (cs[i] + (cs[j] - cs[i]) * f)) * hw);
      }
      if (off > SAG) break;
    }
    j--; // the last one that fitted
    if (j <= i) j = i + 1;
    push(at(i), at(j), ys[i], ys[j], cs[i], cs[j]);
    i = j;
  }
  // each stretch learns the run it belongs to: consecutive ones meet exactly end to end
  for (let k = 0; k < out.length;) {
    let e = k;
    while (e + 1 < out.length && out[e + 1].s0 === out[e].s1) e++;
    for (let m = k; m <= e; m++) {
      out[m].run0 = out[k].s0;
      out[m].run1 = out[e].s1;
    }
    k = e + 1;
  }
  return out;
}

/** How much the ground climbs per metre across a road running along (ux, uz) at a point. */
function fallAcross(x: number, z: number, ux: number, uz: number): number {
  return (terrainAt(x - uz, z + ux) - terrainAt(x + uz, z - ux)) / 2;
}

/**
 * How much of the ground's fall across it a main road running along (ux, uz) takes at a point.
 *
 * Where another main road crosses it, all of it, as a street does in a junction (see
 * `cutPieces`): two main roads crossing on a flank, each level across its own width, disagreed
 * at the crossing by the fall across half of one — a metre and more, on a road thirty-five
 * metres wide. Away from a crossing a main road stays level across, as it always was, and so
 * meets the ramps up to its bridges, which are built that way, flush.
 */
/** How far from a river a bridge and its ramps can reach. */
const BRIDGE_REACH = RIVER_HALF + 46 + 24 * 8 + 40;

function crossingSay(x: number, z: number, ux: number, uz: number): number {
  const reach = ARTERY_HALF * 2 + 4, far = reach + FADE;
  let best = Infinity;
  for (const [a, b] of arteriesNear(x, z, far)) {
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const l2 = dx * dx + dz * dz;
    if (l2 < 1e-9) continue;
    // this road itself, or one running alongside it, is no crossing
    if (Math.abs(dx * ux + dz * uz) / Math.sqrt(l2) > 0.8) continue;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2));
    const qx = a[0] + t * dx, qz = a[1] + t * dz;
    const d = Math.hypot(x - qx, z - qz);
    if (d >= best) continue;
    // A crossing near a river may be on a bridge or its ramps, which are level across and have
    // to meet the road flush at their feet; a road tilted to meet the other one there met the
    // foot of a ramp a third of a metre high at one kerb and as low at the other.
    const r = riverNear(qx, qz, BRIDGE_REACH);
    if (r && r.dist < BRIDGE_REACH) continue;
    best = d;
  }
  if (best <= reach) return 1;
  if (best >= far) return 0;
  const t = (best - reach) / FADE;
  return 1 - t * t * (3 - 2 * t);
}

/** How far a stretch of road may depart from the ground it is laid over before it is cut. */
const SAG = 0.06;

/**
 * Every stretch of street touching a rectangle.
 *
 * Gathered from the blocks the rectangle reaches, not from the streets whose middle falls near
 * it. A street belongs, for the purpose of being laid, to whichever region its midpoint is in —
 * but that says nothing about where it *is*. A long edge between two superblocks runs hundreds
 * of metres from its own middle, so gathering by midpoint quietly dropped it: the ground was
 * cut for a road nobody found afterwards, and a car looking for what it stood on found the
 * lower of two overlapping carriageways and drove through the higher one. A stretch is near
 * this rectangle exactly when the blocks it runs between are, which is what this asks.
 */
function streetPieces(x0: number, z0: number, x1: number, z1: number): Piece[] {
  const out: Piece[] = [];
  const seen = new Set<string>();
  for (const site of blocksIn(x0 - 260, z0 - 260, x1 + 260, z1 + 260))
    for (const st of streetsOf(site)) {
      // The water is not a street. Which of the two blocks either side of one is nominally
      // responsible for it is no use here and was actively wrong: take the street only from
      // the lesser-keyed side and it vanishes wherever that side is the block out of reach,
      // so the stretch is dropped though it runs right through this rectangle. Each street is
      // taken once by where it is instead.
      if (st.half >= RIVER_HALF) continue;
      // the same street seen from the block on either side runs the other way round, so the
      // key has to be the pair of ends unordered or every stretch is gathered and laid twice
      const [p, q] = st.a[0] < st.b[0] || (st.a[0] === st.b[0] && st.a[1] <= st.b[1]) ? [st.a, st.b] : [st.b, st.a];
      const key = `${p[0].toFixed(1)},${p[1].toFixed(1)},${q[0].toFixed(1)},${q[1].toFixed(1)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const p of piecesOf(st)) {
        const r = Math.hypot(p.hl, p.hw);
        if (p.cx + r < x0 || p.cx - r > x1 || p.cz + r < z0 || p.cz - r > z1) continue;
        out.push(p);
      }
    }
  return out;
}

/** Streets with their midpoint in a rectangle, each once. */
function streetsIn(x0: number, z0: number, x1: number, z1: number): Street[] {
  const out: Street[] = [];
  for (const site of blocksIn(x0 - 200, z0 - 200, x1 + 200, z1 + 200))
    for (const st of streetsOf(site)) {
      // a street belongs to the block with the lesser key; the river's own edge is its water
      if (st.here.key >= st.other.key || st.half >= RIVER_HALF) continue;
      const mx = (st.a[0] + st.b[0]) / 2, mz = (st.a[1] + st.b[1]) / 2;
      if (mx >= x0 && mx < x1 && mz >= z0 && mz < z1) out.push(st);
    }
  return out;
}

/** Stretches of street near a point, remembered by the cell they fall in. */
const PIECE_CELL = 150;
const cellPieces = rememberBySeed<string, Piece[]>();

function piecesNear(x: number, z: number): Piece[] {
  const ci = Math.floor(x / PIECE_CELL), cj = Math.floor(z / PIECE_CELL);
  const key = `${ci},${cj}`;
  checkSeed();
  const hit = cellPieces.get(key);
  if (hit) return hit;
  const out = streetPieces(ci * PIECE_CELL, cj * PIECE_CELL, (ci + 1) * PIECE_CELL, (cj + 1) * PIECE_CELL);
  if (cellPieces.size > 2048) cellPieces.clear();
  cellPieces.set(key, out);
  return out;
}

/** Whether a lane's rectangle covers a point. */
function laneCovers(l: Lane, x: number, z: number): boolean {
  const dx = x - l.cx, dz = z - l.cz;
  return Math.abs(dx * l.ux + dz * l.uz) <= l.hl && Math.abs(dz * l.ux - dx * l.uz) <= l.hw;
}

/** Whether a stretch of street covers a point: not the fill, and not a bridge. */
function onStretch(x: number, z: number): boolean {
  return piecesNear(x, z).some((p) => laneCovers(p, x, z));
}

// ---------------------------------------------------------------------------
// The road surface
//
// A road used to be its stretches, each laid as a slab of its own: a tilted box at the
// gradient it was cut to. Two slabs meeting anywhere but end to end — at every junction, and
// wherever a side street eased into a main road — were two planes at two heights, and the
// difference between them was a lip across the carriageway. Each fix moved the lip somewhere
// else, because slabs that do not share corners can only ever agree by luck.
//
// So the surface is not the stretches any more. It is one triangulated sheet laid on a grid
// fixed to the world, and each corner of that grid has one height that every triangle round
// it uses. Whatever the stretches say, the sheet cannot step: two triangles that meet share
// the two corners of the edge they meet along. The stretches only say where the road is and
// roughly how high, and the corners take a blend of them.

/**
 * Spacing of the grid the road is laid on. Fixed to the world and a divisor of REGION, so
 * every region asks for the same corners along a seam.
 */
const RGRID = 4;

/** One bay of fill along a main road; see `fillIn`. */
interface Fill extends Lane {
  axis: 0 | 1;
  line: number;
  s: number;
  /** Whether it is laid: false under a bridge's ramps. Worked out the first time it is asked. */
  laid?: boolean;
}

const FILL_STEP = 9;
const FILL_HALF = ARTERY_HALF + 0.4;

/**
 * The bays of fill along every main road that reach a rectangle: carriageway laid straight
 * along an arterial wherever no street was built over it.
 *
 * A street exists here only between two blocks, because that is where the network puts one —
 * so where the blocks either side run out, and they do along every waterfront and wherever the
 * plan thins, the main road would simply stop. Laid at the ground along its centreline, or
 * coming to meet the road's own stretches near them; see `fillGround`. Water is left alone: the bridge owns every station its crossing reaches.
 *
 * Every bay is returned, including the ones under a bridge's ramps, which are not laid (see
 * `laid`): the surface's height may lean on them, but nothing is drawn over them. That keeps
 * the field clear of the crossings, which themselves ask the field how high the road is.
 */
function fillIn(x0: number, z0: number, x1: number, z1: number): Fill[] {
  const out: Fill[] = [];
  // Stations, not coordinates: a station is a fraction of the lattice spacing along a spline
  // whose nodes wander a quarter of that spacing, so the bays over a rectangle can be numbered
  // well outside its own extent. Searching only sixty metres past it missed them, and the
  // road had a hole in it the length of a bay.
  const pad = ARTERY / 4 + 60;
  for (const axis of [0, 1] as const) {
    const across = axis === 0 ? (z0 + z1) / 2 : (x0 + x1) / 2;
    const half = (axis === 0 ? z1 - z0 : x1 - x0) / 2;
    for (const line of arteryLines(across, half + pad)) {
      const from = (axis === 0 ? x0 : z0) - pad, to = (axis === 0 ? x1 : z1) + pad;
      for (let s = Math.floor(from / FILL_STEP) * FILL_STEP; s < to; s += FILL_STEP) {
        const { p, dir, len, chord } = bayOf(axis, line, s, s + FILL_STEP, FILL_HALF);
        const r = Math.hypot(len / 2, FILL_HALF);
        if (p[0] + r < x0 || p[0] - r > x1 || p[1] + r < z0 || p[1] - r > z1) continue;
        const w = riverNear(p[0], p[1], RIVER_HALF + 46);
        if (w && w.dist < RIVER_HALF + 46) continue;
        const a = arteryFrame(axis, line, s).p, c = arteryFrame(axis, line, s + FILL_STEP).p;
        const ya = fillGround(a[0], a[1]), yb = fillGround(c[0], c[1]);
        const across = (q: Vec2) => crossingSay(q[0], q[1], dir[0], dir[1]) * fallAcross(q[0], q[1], dir[0], dir[1]);
        out.push({
          cx: p[0], cz: p[1], ux: dir[0], uz: dir[1], hl: len / 2, hw: FILL_HALF,
          y: (ya + yb) / 2, grade: (yb - ya) / chord, c0: across(a), c1: across(c), axis, line, s,
        });
      }
    }
  }
  return out;
}

/**
 * Whether a lane is drawn and driven on: every stretch, and fill except where a bridge's ramps
 * carry the road over the whole of the bay. A bay a ramp only reaches into is laid, at the foot
 * where the ramp has come down to it — or the road stopped at the last whole bay and the ramp
 * ended in a gap of up to nine metres with nothing beyond it.
 */
function laid(l: Lane): boolean {
  const f = l as Fill;
  if (f.axis === undefined) return true;
  return (f.laid ??= !crossings(f.axis, f.line, Math.floor(f.s / ARTERY))
    .some((c) => f.s >= c.a0 && f.s + FILL_STEP <= c.a1));
}

/**
 * Whether a road is there to come down to: a stretch of street or a bay of fill, laid or not.
 * What a bridge's ramp looks for its foot on, which cannot ask whether the fill is laid, since
 * that is decided by where the ramps are.
 */
function onCarriageway(x: number, z: number): boolean {
  return onStretch(x, z) || lanesNear(x, z).some((l) => (l as Fill).axis !== undefined && laneCovers(l, x, z));
}

/** How far past a cell the lanes kept for it reach: past the furthest any lane has a say. */
const LANE_REACH = RGRID * 3.5 + 1;
const laneCells = rememberBySeed<string, Lane[]>();

/** Every lane, stretch or fill, within LANE_REACH of the cell a point is in. */
function lanesNear(x: number, z: number): Lane[] {
  const ci = Math.floor(x / PIECE_CELL), cj = Math.floor(z / PIECE_CELL);
  const key = `${ci},${cj}`;
  checkSeed();
  const hit = laneCells.get(key);
  if (hit) return hit;
  const x0 = ci * PIECE_CELL - LANE_REACH, z0 = cj * PIECE_CELL - LANE_REACH;
  const x1 = (ci + 1) * PIECE_CELL + LANE_REACH, z1 = (cj + 1) * PIECE_CELL + LANE_REACH;
  const out: Lane[] = [...streetPieces(x0, z0, x1, z1), ...fillIn(x0, z0, x1, z1)];
  if (laneCells.size > 2048) laneCells.clear();
  laneCells.set(key, out);
  return out;
}

/**
 * How a corner's height is blended from the lanes round it: a lane has all of its say on its
 * centreline, a little of it at its edge, and outside it a say that dies away over FADE_OUT and
 * is gone at BLEND_OUT.
 *
 * Inside, so that where two lanes overlap — a junction, a side street running into a main
 * road — neither wins outright and the surface eases from one to the other across the whole of
 * the overlap rather than stepping at the edge of either. Two roads crossing on a flank each
 * carry the ground along their own middles, which disagree by the fall across half a road;
 * eased over a few metres at the kerb that was a forty per cent ramp in the junction.
 *
 * Along a street the say only falls away towards the ends of the run it is laid in, never at
 * the joint between two of its own stretches, which agree there anyway. Fill has no ends to
 * speak of: it runs on into more fill, or into a stretch that has come to meet it.
 *
 * Outside, because a corner of a triangle that is partly
 * road can stand a grid diagonal clear of every lane, and still needs a height that continues
 * the road and not the hillside — the road nearest to it, which is why the say dies away so
 * fast. Given a steady share of it instead, a street across a narrow block reached over and
 * tilted the outer lane of this one by a quarter of a metre.
 */
const BLEND_OUT = RGRID * 3.5;
const FADE_OUT = 0.75;
const EDGE_SAY = 0.05;

function laneWeight(l: Lane, x: number, z: number): number {
  const dx = x - l.cx, dz = z - l.cz;
  const across = l.hw - Math.abs(dz * l.ux - dx * l.uz);
  const p = l as Piece;
  let along = l.hl - Math.abs(dx * l.ux + dz * l.uz), end = Infinity;
  if (p.street) {
    const s = (x - p.street.a[0]) * l.ux + (z - p.street.a[1]) * l.uz;
    end = Math.min(s - p.run0, p.run1 - s);
  }
  const inside = Math.min(along, across, end);
  if (inside < -BLEND_OUT) return 0;
  if (inside < 0) return EDGE_SAY * Math.exp(inside / FADE_OUT);
  const smooth = (t: number) => (t >= 1 ? 1 : t * t * (3 - 2 * t));
  return EDGE_SAY + (1 - EDGE_SAY) * smooth(across / l.hw) * smooth(end / l.hw);
}

const rawCache = rememberBySeed<number, number>();
const nodeCache = rememberBySeed<number, number>();

/** The blend of the lanes at the road grid's corner (i, j), before it is smoothed. */
function rawY(i: number, j: number): number {
  const key = (i + 50000) * 100000 + (j + 50000);
  checkSeed();
  const hit = rawCache.get(key);
  if (hit !== undefined) return hit;
  const x = i * RGRID, z = j * RGRID;
  let sum = 0, wsum = 0;
  for (const l of lanesNear(x, z)) {
    const w = laneWeight(l, x, z);
    if (w <= 0) continue;
    sum += w * pieceYOn(l, x, z);
    wsum += w;
  }
  const y = wsum > 0 ? sum / wsum : terrainAt(x, z);
  if (rawCache.size > 400000) rawCache.clear();
  rawCache.set(key, y);
  return y;
}

/**
 * Height of the road grid's corner (i, j): one number, whoever asks for it.
 *
 * The blend smoothed once over the corners round it. Lanes that disagree — streets meeting on
 * a flank, each pulled its own way by what it is near — still meet without a step, since the
 * sheet is one; but left as they are they meet across a single cell of the grid, which on the
 * worst of them is a ramp of a metre and a half in four. Spread over three cells instead it is
 * a third of that. The kernel is symmetric, so a road that is a straight gradient — nearly all
 * of them, nearly everywhere — comes through it exactly as it was.
 */
function nodeY(i: number, j: number): number {
  const key = (i + 50000) * 100000 + (j + 50000);
  checkSeed();
  const hit = nodeCache.get(key);
  if (hit !== undefined) return hit;
  let y = 0;
  for (let a = -1; a <= 1; a++)
    for (let c = -1; c <= 1; c++) y += rawY(i + a, j + c) * (a ? 1 : 2) * (c ? 1 : 2);
  y /= 16;
  if (nodeCache.size > 400000) nodeCache.clear();
  nodeCache.set(key, y);
  return y;
}

/**
 * The road's surface at a point, whether or not a road is laid there: the grid cell's two
 * triangles, split along the diagonal from its low corner to its high one. Exactly what is
 * drawn (see `roadSurface`), so a vehicle reading it is on the asphalt it can see.
 */
function fieldAt(x: number, z: number): number {
  const gx = x / RGRID, gz = z / RGRID;
  const i = Math.floor(gx), j = Math.floor(gz);
  const fx = gx - i, fz = gz - j;
  const h00 = nodeY(i, j), h11 = nodeY(i + 1, j + 1);
  if (fx >= fz) {
    const h10 = nodeY(i + 1, j);
    return h00 + fx * (h10 - h00) + fz * (h11 - h10);
  }
  const h01 = nodeY(i, j + 1);
  return h00 + fz * (h01 - h00) + fx * (h11 - h01);
}

/**
 * The road surface over a point, or null where no road is laid: a stretch of street or a bay
 * of fill along a main road. Bridges are not in it; see `rideAt`.
 */
export function roadTopAt(x: number, z: number): number | null {
  for (const l of lanesNear(x, z)) if (laneCovers(l, x, z) && laid(l)) return fieldAt(x, z);
  return null;
}

/** The line a vehicle rides along a road, which is the road itself. */
export function roadRideAt(x: number, z: number): number | null {
  return roadTopAt(x, z);
}

/**
 * The road surface over a point where a stretch of street is laid, ignoring fill. What a
 * bridge asks of the roads it comes down among, since whether fill is laid is itself decided
 * by where the bridges are.
 */
function streetTopAt(x: number, z: number): number | null {
  return onStretch(x, z) ? fieldAt(x, z) : null;
}

/** How deep the edge of the road is carried down at a kerb, where it once was a slab's side. */
const SKIRT = 6;

type Frag = Vec2[];

/** The part of a convex polygon where `f` is at most zero. */
function clipHalf(poly: Frag, f: (p: Vec2) => number): Frag {
  const out: Frag = [];
  for (let k = 0; k < poly.length; k++) {
    const p = poly[k], q = poly[(k + 1) % poly.length];
    const fp = f(p), fq = f(q);
    if (fp <= 0) out.push(p);
    if ((fp < 0 && fq > 0) || (fp > 0 && fq < 0)) {
      const t = fp / (fp - fq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

/** The four sides of a lane, as functions that are positive outside each. */
function laneSides(l: Lane): ((p: Vec2) => number)[] {
  const u = (p: Vec2) => (p[0] - l.cx) * l.ux + (p[1] - l.cz) * l.uz;
  const v = (p: Vec2) => (p[1] - l.cz) * l.ux - (p[0] - l.cx) * l.uz;
  return [(p) => u(p) - l.hl, (p) => -u(p) - l.hl, (p) => v(p) - l.hw, (p) => -v(p) - l.hw];
}

/** Twice the signed area of a polygon in x and z. */
function area2(poly: Frag): number {
  let a = 0;
  for (let k = 0; k < poly.length; k++) {
    const p = poly[k], q = poly[(k + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a;
}

const SLIVER = 1e-4;

/** The sides of a convex outline, either way round, as functions that are positive outside each. */
function polySides(poly: Vec2[]): ((p: Vec2) => number)[] {
  const turn = area2(poly) > 0 ? 1 : -1;
  return poly.map((a, k) => {
    const b = poly[(k + 1) % poly.length];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = (b[1] - a[1]) / l * turn, nz = -(b[0] - a[0]) / l * turn;
    return (p: Vec2) => (p[0] - a[0]) * nx + (p[1] - a[1]) * nz;
  });
}

/** A convex polygon less a lane, as the convex pieces left outside it. */
function subtractLane(poly: Frag, l: Lane): Frag[] {
  return subtractSides(poly, laneSides(l));
}

/** A convex polygon less the convex region inside all of `sides`, as the convex pieces left. */
function subtractSides(poly: Frag, sides: ((p: Vec2) => number)[]): Frag[] {
  const out: Frag[] = [];
  let cur = poly;
  for (const side of sides) {
    const outside = clipHalf(cur, (p) => -side(p));
    if (outside.length >= 3 && Math.abs(area2(outside)) > SLIVER) out.push(outside);
    cur = clipHalf(cur, side);
    if (cur.length < 3) break;
  }
  return out;
}

/**
 * The parts of a triangle that lie in a road, as convex pieces that do not overlap: each lane
 * in turn, less every lane before it. A piece is only ever cut out of the triangle, never
 * moved, so it lies in the triangle's plane and meets its neighbours exactly.
 */
function fragments(tri: Frag, lanes: Lane[]): Frag[] {
  for (const l of lanes) if (tri.every((p) => laneCovers(l, p[0], p[1]))) return [tri];
  const out: Frag[] = [];
  const before: Lane[] = [];
  for (const l of lanes) {
    let part = tri;
    for (const side of laneSides(l)) {
      part = clipHalf(part, side);
      if (part.length < 3) break;
    }
    if (part.length < 3 || Math.abs(area2(part)) <= SLIVER) continue;
    let parts = [part];
    for (const m of before) parts = parts.flatMap((q) => subtractLane(q, m));
    before.push(l);
    out.push(...parts);
  }
  return out;
}

/**
 * The road of one region, as one sheet of triangles on the road grid, with its edges carried
 * down at the kerb and collision boxes standing in for it underneath.
 *
 * Each grid cell is split into the same two triangles `fieldAt` reads, and each triangle is
 * cut to the lanes that cover it. The cut only ever takes away: a corner introduced at a kerb
 * is placed on the triangle's own plane, so the surface stays the one sheet whatever the
 * outline of the road does across it. Collision goes to `solid`, which draws nothing: the
 * runner needs the road to stand on, and a car rides the surface itself (see `rideAt`).
 */
function roadSurface(b: Builder, solid: Builder, x0: number, z0: number): void {
  const t: Tint = [1, 1, 1];
  const G = RGRID, N = Math.round(REGION / G);
  const i0 = Math.round(x0 / G), j0 = Math.round(z0 / G);
  const lanes: Lane[] = [
    ...streetPieces(x0 - 2, z0 - 2, x0 + REGION + 2, z0 + REGION + 2),
    ...fillIn(x0 - 2, z0 - 2, x0 + REGION + 2, z0 + REGION + 2),
  ].filter(laid);
  const buckets: Lane[][] = Array.from({ length: N * N }, () => []);
  for (const l of lanes) {
    const ex = Math.abs(l.ux) * l.hl + Math.abs(l.uz) * l.hw, ez = Math.abs(l.uz) * l.hl + Math.abs(l.ux) * l.hw;
    const a0 = Math.max(0, Math.floor((l.cx - ex - x0) / G)), a1 = Math.min(N - 1, Math.floor((l.cx + ex - x0) / G));
    const c0 = Math.max(0, Math.floor((l.cz - ez - z0) / G)), c1 = Math.min(N - 1, Math.floor((l.cz + ez - z0) / G));
    for (let a = a0; a <= a1; a++) for (let c = c0; c <= c1; c++) buckets[a * N + c].push(l);
  }
  const covers = (x: number, z: number) => {
    const a = Math.floor((x - x0) / G), c = Math.floor((z - z0) / G);
    const near = a >= 0 && a < N && c >= 0 && c < N ? buckets[a * N + c] : lanes;
    return near.some((l) => laneCovers(l, x, z));
  };
  const normal = (i: number, j: number): number[] => {
    const gx = (nodeY(i + 1, j) - nodeY(i - 1, j)) / (2 * G);
    const gz = (nodeY(i, j + 1) - nodeY(i, j - 1)) / (2 * G);
    const l = Math.hypot(gx, 1, gz);
    return [-gx / l, 1 / l, -gz / l];
  };

  // Fully covered cells are gathered into runs along z for collision, while they stay level.
  let run: { a: number; c0: number; c1: number; lo: number; hi: number } | null = null;
  const endRun = () => {
    if (!run) return;
    const x = x0 + run.a * G;
    solid.box(x, run.lo - SKIRT, z0 + run.c0 * G, x + G, run.hi, z0 + (run.c1 + 1) * G, Mat.Asphalt, t, 0,
      { hidden: true, detail: false });
    run = null;
  };

  for (let a = 0; a < N; a++) {
    for (let c = 0; c < N; c++) {
      const near = buckets[a * N + c];
      if (!near.length) {
        endRun();
        continue;
      }
      const i = i0 + a, j = j0 + c;
      const X = i * G, Z = j * G;
      const h00 = nodeY(i, j), h10 = nodeY(i + 1, j), h01 = nodeY(i, j + 1), h11 = nodeY(i + 1, j + 1);
      const n00 = normal(i, j), n10 = normal(i + 1, j), n01 = normal(i, j + 1), n11 = normal(i + 1, j + 1);
      // height and normal on either triangle, the same split as `fieldAt`
      const at = (k: number, p: Vec2): number[] => {
        const fx = (p[0] - X) / G, fz = (p[1] - Z) / G;
        const [ha, hb, na, nb] = k === 0 ? [h10, h11, n10, n11] : [h01, h11, n01, n11];
        const y = k === 0 ? h00 + fx * (ha - h00) + fz * (hb - ha) : h00 + fz * (ha - h00) + fx * (hb - ha);
        const [wa, wb] = k === 0 ? [fx - fz, fz] : [fz - fx, fx];
        const w0 = 1 - wa - wb;
        return [y, ...[0, 1, 2].map((e) => n00[e] * w0 + na[e] * wa + nb[e] * wb)];
      };
      const tris: Frag[] = [[[X, Z], [X + G, Z], [X + G, Z + G]], [[X, Z], [X + G, Z + G], [X, Z + G]]];
      const cut = tris.map((tri) => fragments(tri, near).map((f) => (area2(f) < 0 ? f.slice().reverse() : f)));

      for (let k = 0; k < 2; k++)
        for (const f of cut[k]) {
          const v = f.map((p) => {
            const [y, nx, ny, nz] = at(k, p);
            return [p[0], y, p[1], nx, ny, nz, p[0], p[1]];
          });
          // wound to face the sky
          for (let m = 1; m + 1 < v.length; m++) b.tri([v[0], v[m + 1], v[m]], Mat.Asphalt, t);
          // The kerb: every edge with no road beyond it is carried straight down, cut first
          // wherever another lane's edge crosses it, so that each piece is either all road
          // beyond or none.
          for (let e = 0; e < f.length; e++) {
            const p = f[e], q = f[(e + 1) % f.length];
            const dx = q[0] - p[0], dz = q[1] - p[1];
            const len = Math.hypot(dx, dz);
            if (len < 1e-4) continue;
            const ox = dz / len, oz = -dx / len;
            const ts = [0, 1];
            for (const l of near)
              for (const side of laneSides(l)) {
                const fp = side(p), fq = side(q);
                if ((fp < 0 && fq > 0) || (fp > 0 && fq < 0)) ts.push(fp / (fp - fq));
              }
            ts.sort((m, n) => m - n);
            for (let s = 0; s + 1 < ts.length; s++) {
              if (ts[s + 1] - ts[s] < 1e-5) continue;
              const tm = (ts[s] + ts[s + 1]) / 2;
              if (covers(p[0] + dx * tm + ox * 0.05, p[1] + dz * tm + oz * 0.05)) continue;
              const A: Vec2 = [p[0] + dx * ts[s], p[1] + dz * ts[s]];
              const B: Vec2 = [p[0] + dx * ts[s + 1], p[1] + dz * ts[s + 1]];
              const ya = at(k, A)[0], yb = at(k, B)[0];
              const ua = (A[0] * dx + A[1] * dz) / len, ub = (B[0] * dx + B[1] * dz) / len;
              const corner = (P: Vec2, y: number, u: number) => [P[0], y, P[1], ox, 0, oz, u, y];
              const at0 = corner(A, ya, ua), bt = corner(B, yb, ub);
              const bb = corner(B, yb - SKIRT, ub), ab = corner(A, ya - SKIRT, ua);
              b.tri([at0, bt, bb], Mat.Asphalt, t);
              b.tri([at0, bb, ab], Mat.Asphalt, t);
            }
          }
        }

      // Collision. A whole cell is one box, or four where it is steep enough that one would
      // stand proud of the surface; a cell cut at a kerb is sliced a metre at a time so that
      // none of it reaches out over the pavement beside the road.
      const whole = cut.every((fs, k) => fs.length === 1 && fs[0] === tris[k]);
      if (whole) {
        const lo = Math.min(h00, h10, h01, h11), hi = Math.max(h00, h10, h01, h11);
        if (hi - lo <= 0.3) {
          if (run && run.a === a && run.c1 === c - 1 && Math.abs(run.hi - hi) < 0.03) {
            run.c1 = c;
            run.lo = Math.min(run.lo, lo);
            run.hi = Math.max(run.hi, hi);
          } else {
            endRun();
            run = { a, c0: c, c1: c, lo, hi };
          }
          continue;
        }
        endRun();
        const H = G / 2;
        for (const sx of [0, 1])
          for (const sz of [0, 1]) {
            const ys = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, w]) => fieldAt(X + (sx + u) * H, Z + (sz + w) * H));
            solid.box(X + sx * H, Math.min(...ys) - SKIRT, Z + sz * H, X + (sx + 1) * H, Math.max(...ys), Z + (sz + 1) * H,
              Mat.Asphalt, t, 0, { hidden: true, detail: false });
          }
        continue;
      }
      endRun();
      for (let k = 0; k < 2; k++)
        for (const f of cut[k])
          for (let xa = X; xa < X + G - 1e-6; xa++) {
            const xb = xa + 1;
            let part = clipHalf(f, (p) => xa - p[0]);
            part = clipHalf(part, (p) => p[0] - xb);
            if (part.length < 3 || Math.abs(area2(part)) <= SLIVER) continue;
            const zs = part.map((p) => p[1]), ys = part.map((p) => at(k, p)[0]);
            solid.box(xa, Math.min(...ys) - SKIRT, Math.min(...zs), xb, Math.max(...ys), Math.max(...zs),
              Mat.Asphalt, t, 0, { hidden: true, detail: false });
          }
    }
    endRun();
  }
}

/**
 * The furniture of the streets whose middle is in this region: paint, lamps, parked cars. The
 * carriageway under them is `roadSurface`.
 *
 * Every stretch of a street this region owns is furnished, however far the far end of it
 * reaches out of the region, so nothing is dropped at a seam.
 */
function streets(b: Builder, x0: number, z0: number): void {
  for (const st of streetsIn(x0, z0, x0 + REGION, z0 + REGION))
    for (const p of piecesOf(st)) {
      parkAlong(b, p);
      markings(b, p);
      lamps(b, p);
    }
}

/**
 * A thin painted stripe along the street, from station s0 to s1, `off` to one side. Paint lies
 * on the road, so it is laid a grid's width at a time with each length's ends on the surface.
 */
function stripe(b: Builder, p: Piece, s0: number, s1: number, off: number, w: number): void {
  if (s1 - s0 < 0.2) return;
  const [ax, az] = p.street.a;
  const pos = (s: number): Vec2 => [ax + p.ux * s - p.uz * off, az + p.uz * s + p.ux * off];
  const n = Math.ceil((s1 - s0) / RGRID);
  for (let k = 0; k < n; k++) {
    const sa = s0 + ((s1 - s0) * k) / n, sb = s0 + ((s1 - s0) * (k + 1)) / n;
    const [x, z] = pos((sa + sb) / 2), A = pos(sa), B = pos(sb);
    const ya = fieldAt(A[0], A[1]), yb = fieldAt(B[0], B[1]), y = (ya + yb) / 2;
    b.box(x - (sb - sa) / 2, y + 0.01, z - w / 2, x + (sb - sa) / 2, y + 0.03, z + w / 2, Mat.Paint, PAINT_LINE, 0,
      { collide: false, detail: true, turn: Math.atan2(p.uz, p.ux), rise: yb - ya });
  }
}

const PAINT_LINE: Tint = [0.78, 0.77, 0.7];

/**
 * Road markings, as paint on the street itself: a dashed centre line on ordinary streets, and
 * on an arterial a double line down the middle with its lanes dashed either side. Dashes are
 * phased on the street's own stations, so they run on unbroken from one stretch to the next.
 */
function markings(b: Builder, p: Piece): void {
  const st = p.street;
  // An arterial is a chain of short edges, one per pair of flanking blocks, and most of its
  // joins are not junctions at all: its lines run straight through them. Other streets stop
  // their lines short of the crossing.
  const arterial = st.half >= ARTERY_HALF - 0.5;
  const clear = arterial ? 0 : st.half + 2;
  const from = Math.max(p.s0, clear), to = Math.min(p.s1, p.len - clear);
  if (to <= from) return;
  const dashes = (off: number) => {
    for (let s = Math.floor(from / 9) * 9; s < to; s += 9) stripe(b, p, Math.max(s, from), Math.min(s + 3, to), off, 0.15);
  };
  if (arterial) {
    stripe(b, p, from, to, 0.18, 0.12);
    stripe(b, p, from, to, -0.18, 0.12);
    dashes(st.half * 0.5);
    dashes(-st.half * 0.5);
  } else {
    dashes(0);
  }
}

/**
 * Street lamps on the kerb, staggered from side to side, their arms reaching out over the
 * road. The column stands down into the pavement's plinth, whichever is lower.
 */
function lamps(b: Builder, p: Piece): void {
  const st = p.street, [ax, az] = st.a;
  const SPACING = 26, H = 8.5;
  // Spread evenly over the street's clear span, so a short street still gets its lamp: most
  // streets are a block or less, and a fixed pitch from the corner left many of them unlit.
  // One squeezed between junctions stands at the middle, as long as that is off the crossing.
  // An arterial's joins are mostly not junctions at all (see `markings`), and its lamps run on.
  const arterial = st.half >= ARTERY_HALF - 0.5;
  const clear = arterial ? 0 : st.half * 1.6 + 2;
  const span = p.len - 2 * clear;
  if (span < 0 && p.len / 2 < JUNCTION) return;
  const n = Math.max(1, Math.round(span / SPACING));
  for (let k = 0; k < n; k++) {
    const s = span < 0 ? p.len / 2 : clear + ((k + 0.5) * span) / n;
    if (s < p.s0 || s >= p.s1) continue;
    const side = k % 2 === 0 ? 1 : -1;
    const off = side * (st.half + 0.8);
    const x = ax + p.ux * s - p.uz * off, z = az + p.uz * s + p.ux * off;
    const kerb = pieceYAt(p, s);
    const y0 = kerb - 3, top = kerb + H;
    // the arm and head, out over the road
    const reach = -side * 1.8;
    const hx = x - p.uz * reach, hz = z + p.ux * reach;
    const lx = x - p.uz * reach * 1.6, lz = z + p.ux * reach * 1.6;
    // Not under a bridge or the railway: either is lower than a lamp is tall, and the column
    // came up through the deck with its head lit on the road above. The deck has lamps of its
    // own, and under it is dark enough to want none.
    if (overhead(x, z, kerb + 1, top + 0.3) || overhead(hx, hz, kerb + 1, top + 0.3) || overhead(lx, lz, kerb + 1, top + 0.3)) continue;
    b.box(x - 0.13, y0, z - 0.13, x + 0.13, top, z + 0.13, Mat.Metal, [1, 1, 1], 0, { detail: false });
    b.box(hx - 1.1, top - 0.12, hz - 0.1, hx + 1.1, top, hz + 0.1, Mat.Metal, [1, 1, 1], 0,
      { collide: false, detail: true, turn: Math.atan2(p.ux, -p.uz) });
    b.lamps.push(lx, top - 0.3, lz);
    b.box(lx - 0.45, top - 0.2, lz - 0.2, lx + 0.45, top - 0.05, lz + 0.2, Mat.Lamp, [1, 1, 1], 0,
      { collide: false, detail: true, turn: Math.atan2(p.ux, -p.uz) });
  }
}

/**
 * Cars left at the kerb of a side street, both sides, clear of the junctions. The arterials
 * carry the traffic and nobody parks on them.
 */
function parkAlong(b: Builder, p: Piece): void {
  const st = p.street;
  if (st.half >= ARTERY_HALF - 0.5) return;
  const clear = st.half * 1.8 + 4;
  const from = Math.max(p.s0, clear), to = Math.min(p.s1, p.len - clear);
  const [ax, az] = st.a;
  for (let s = Math.ceil(from / 7) * 7; s + 3 <= to; s += 7)
    for (const side of [1, -1]) {
      const h = hashInt(Math.round(ax * 10), Math.round(az * 10), Math.round(s), side, 340);
      if (h % 100 >= 38) continue;
      const off = side * (st.half - 1.6);
      const x = ax + p.ux * s - p.uz * off, z = az + p.uz * s + p.ux * off;
      // facing the way the traffic on that side would go
      const yaw = side > 0 ? Math.atan2(p.ux, p.uz) : Math.atan2(-p.ux, -p.uz);
      // on the road surface itself, which is not this stretch's own gradient near a junction
      const y = roadTopAt(x, z) ?? pieceYAt(p, s);
      b.cars.push({ x, y, z, yaw, van: h % 7 === 0, color: PAINT_COLORS[(h >>> 4) % PAINT_COLORS.length] });
    }
}

/**
 * Landing pads on the deck, on the walk between its parapet and the towers, each turned square
 * to the side it stands along. Every pad has a flyer waiting on it, so this is what makes a
 * flyer something found on most blocks rather than a rarity. Set two thirds of the way along
 * the side: the middle is where a deck bridge lands, and a third of the way is the lift.
 */
function deckPads(b: Builder, poly: Vec2[], E: number): void {
  const c = centroid(poly);
  const sides = poly.map((a, k) => [a, poly[(k + 1) % poly.length]] as const)
    .map(([a, q]) => ({ a, q, len: Math.hypot(q[0] - a[0], q[1] - a[1]) }))
    .filter((e) => e.len >= 40)
    .sort((x, y) => y.len - x.len);
  for (const { a, q, len } of sides.slice(0, 2)) {
    const ux = (q[0] - a[0]) / len, uz = (q[1] - a[1]) / len;
    let nx = -uz, nz = ux;
    const mx = a[0] + (q[0] - a[0]) * 0.68, mz = a[1] + (q[1] - a[1]) * 0.68;
    if (nx * (c[0] - mx) + nz * (c[1] - mz) < 0) {
      nx = -nx;
      nz = -nz;
    }
    // clear of the parapet at the deck's edge, short of the towers standing back from it
    const d = WALK - 0.9 + 3.3;
    const x = mx + nx * d, z = mz + nz * d;
    b.turned(x, z, Math.atan2(uz, ux), () => b.pad(x, E, z, 0));
  }
}

/** A landing pad in the middle of a polygon, if one fits. */
function padOn(b: Builder, poly: Vec2[], y: number, r: Rng): void {
  const [cx, cz] = centroid(poly);
  const h = 3.1;
  if (![[-h, -h], [h, -h], [h, h], [-h, h]].every(([dx, dz]) => inPoly(poly, cx + dx, cz + dz))) return;
  b.pad(cx, y, cz, r.int(0, 3) * Math.PI / 2);
}

/** Ground height at a point, cut to the terrace it stands on. */
export function groundAt(x: number, z: number): number {
  return Math.round(terrainAt(x, z) / TERRACE) * TERRACE;
}

/**
 * The ground for anything that rides along the surface rather than standing on it.
 *
 * A road is cut into half-metre terraces like everything else here. On the flat that is one
 * step every fifty metres and nobody sees it; down a hill flank it is one every five, and a car
 * reading its height straight off the ground drops half a metre three times a second.
 *
 * Which of those it is depends on nothing but the slope, so that is what this asks. Where the
 * ground is level the tread is tens of metres wide and a car sits on it exactly, as it always
 * did. Where the treads have closed up shorter than the car itself there is no longer a step to
 * sit on, and it rides the slope they were cut from instead — never more than a quarter of a
 * metre off the surface, and without a single jolt in it.
 */
function rideY(x: number, z: number): number {
  // The ground itself. This used to slide between the terrace and the true height according
  // to the slope, because the ground was laid as level treads and a car had to sit on the
  // tread where there was one. The tiles are planes now, so the surface and the line a car
  // rides over it are the same thing again.
  return terrainAt(x, z);
}

/** How far under the road surface the ground is held, wherever a road is laid over it. */
const ROAD_BED = 0.1;

/**
 * How far an embankment reaches out from a road it has to meet, and the slope it comes down
 * at. The slope is the city's own budget — half a metre over a tile — because that is what a
 * runner can walk up; anything steeper is a wall they have to jump, which is what the ground
 * beside a raised carriageway used to be.
 */
const APRON_TILES = 8;
const APRON_GRADE = TERRACE / TILE;

/** How far inboard from the water's edge the stone quay reaches. */
const QUAY_SLAB = 16;
/** Stations to a bay of quay. The same grid the water is laid on, so the two edges agree. */
export const BAY = 8;
/** Every so many bays a flight of steps runs down the quay wall into the water, and a launch may tie up at its foot. */
export const WATER_STEPS = 23;
/** Every so many bays an iron ladder runs up the quay wall out of the water. */
export const LADDERS = 5;
/** How far out from the quay wall a launch at the steps lies, to its middle: alongside the last tread clear of the water. */
const LAUNCH_OFF = 8.6;

/**
 * One bay of quay: its middle on the river's centreline, which way the river runs there, and
 * how long it is — taken between the bay's own two ends, as the water and the stone are.
 */
export function quayBay(line: number, k: number): { p: Vec2; dir: Vec2; chord: number } {
  const a = riverFrame(line, k * BAY).p, c = riverFrame(line, (k + 1) * BAY).p;
  const dx = c[0] - a[0], dz = c[1] - a[1];
  const chord = Math.hypot(dx, dz) || BAY;
  return { p: [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2], dir: [dx / chord, dz / chord], chord };
}

/** The launch tied up at the foot of the water steps in bay `k` on one side of a river, if one is. */
export function launchAt(line: number, k: number, side: 1 | -1): { x: number; z: number; yaw: number } | null {
  if (k % WATER_STEPS !== 0 || hashInt(line, k, side + 1, 341) % 3 === 0) return null;
  const { p, dir } = quayBay(line, k);
  const o = RIVER_HALF - LAUNCH_OFF;
  return { x: p[0] - dir[1] * o * side, z: p[1] + dir[0] * o * side, yaw: Math.atan2(dir[0], dir[1]) };
}
/** The diagonal of a ground tile: how far a corner's height can carry across the grid. */
const TILE_DIAG = TILE * 1.45;

/**
 * The ceiling the river puts on the ground at a point.
 *
 * The bank is a curve and the ground is a five-metre grid, so the two can never meet along
 * the water's edge. A tile that straddles it is one plane from the quay top down to the bed:
 * it juts out over the river at the corner still on land, and falls away from under the
 * coping at the corner that is not — the teeth, and the holes between them. No cut placed
 * *at* the edge mends that, because the edge is exactly where the grid cannot follow.
 *
 * So the ground is not asked to make the edge at all. It is cut to the bed a tile's diagonal
 * *behind* the water, which is far enough that nothing left standing can reach out over the
 * river; and for a slab's width behind that it is held a few centimetres under the quay,
 * which is where the stone laid along the river's own spline covers it. Ground comes back to
 * its own height only past the far edge of that stone, where the two are flush.
 */
function channelCap(x: number, z: number): number {
  const r = riverNear(x, z, RIVER_HALF + QUAY_SLAB + TILE_DIAG);
  if (!r) return Infinity;
  const w = waterLevel(r.line);
  if (r.dist < RIVER_HALF + TILE_DIAG) return w - 1.5;
  // A tile with one corner inside this has every corner inside it, so no tile the slab
  // overlaps is ever left at full height to fight with the stone over it.
  if (r.dist < RIVER_HALF + QUAY_SLAB + TILE_DIAG) return w + QUAY_RISE - 0.06;
  return Infinity;
}

/**
 * The ground of one region: a field of tiles, each the plane through the four corners it
 * shares with its neighbours.
 *
 * The heights live on the corners, not on the tiles, and that is the whole of it. Asked of a
 * tile, "how low must this be to stay under the road?" has one answer for the whole five
 * metres, and both answers are wrong: take the lowest thing any corner touches and a tile
 * that merely clips a junction is dragged down bodily, leaving a trench along the kerb; take
 * only what covers the middle and the half of the tile lying inside the road stands up
 * through it, which is a block of hillside sitting in the carriageway. Asked of a corner it
 * has one answer that is right, and the tile between four of them tilts to suit — down into
 * the road on the side that is under it, level with the hill on the side that is not. Two
 * tiles sharing an edge share both its corners, so they meet along it.
 */
function terrain(
  b: Builder, solid: Builder, x0: number, z0: number, covered: (x: number, z: number) => Cover | null,
  blocks: Cover[], lanes: Piece[],
): void {
  const t: Tint = [0.96, 0.96, 0.97];
  const BED: Tint = [0.30, 0.31, 0.27];
  // the road's own grid, so the ground is laid on corners fixed to the world, and a corner on
  // a seam is the same corner to the regions either side of it
  const G = RGRID, N = Math.round(REGION / G);
  const P = APRON_TILES;
  const W = N + 2 * P; // tiles across, with padding so the aprons of both sides of a seam agree
  const CW = W + 1; // corners
  const node = (i: number, j: number) => i * CW + j;
  const C = new Float64Array(CW * CW);
  // How high the ground may stand at each corner for the road surface over it, if any: a
  // little under it, so that where the two are laid over the same ground the road is on top.
  const under = new Float64Array(CW * CW).fill(Infinity);
  // the pavement's height at each corner inside a block, which nothing afterwards may move
  const paved = new Float64Array(CW * CW).fill(NaN);

  for (let i = 0; i <= W; i++) {
    for (let j = 0; j <= W; j++) {
      const x = x0 + (i - P) * G, z = z0 + (j - P) * G;
      let h = terrainAt(x, z), seed = -Infinity;
      const over = roadTopAt(x, z);
      if (over !== null) under[node(i, j)] = over - ROAD_BED;
      // Inside a block the ground is its pavement, and the pavement is the road's own surface
      // carried on past the kerb (see `paveAt`): level with the street at every point of it,
      // and so with every corner of the ground round it. It used to be held at the block's
      // level, the ground under its middle, which on a hillside is metres under the street on
      // the uphill side — every tile across the outline a plane from the street down to it, a
      // row of wedges, and with those cut away a trench along the kerb.
      if (covered(x, z)) {
        paved[node(i, j)] = C[node(i, j)] = paveAt(x, z);
        continue;
      }
      // under the carriageway over it, and coming down to meet one it stands beside
      h = Math.min(h, roadCut(lanes, x, z), under[node(i, j)]);
      // Inside the channel the ground is riverbed, and the bed is under the water, not level
      // with it: left at the height the land happens to be, it stands up through the surface
      // wherever it is a few centimetres high. How far back that cut runs, and what happens
      // between it and the quay, is `channelCap`.
      h = Math.min(h, channelCap(x, z));
      if (over !== null) seed = Math.max(seed, over);
      // A road standing over the ground has to be reachable from it, but no higher than the
      // apron can carry within the padding this grid was given, or two regions sharing a
      // corner would not agree on it.
      C[node(i, j)] = seed === -Infinity ? h : Math.min(Math.max(h, seed), h + (P - 1) * G * APRON_GRADE);
    }
  }

  // The embankment: ground climbs to whatever stands over it at a slope a runner can take,
  // spreading until it runs back into the hillside. Four sweeps carry it as far as it goes.
  const rise = G * APRON_GRADE;
  for (const k of [0, 1, 2, 3]) {
    const iFwd = k === 0 || k === 2, jFwd = k === 0 || k === 1;
    for (let a = 0; a <= W; a++) {
      const i = iFwd ? a : W - a;
      for (let c = 0; c <= W; c++) {
        const j = jFwd ? c : W - c;
        const o = node(i, j);
        if (!Number.isNaN(paved[o])) continue;
        let want = C[o];
        if (i > 0) want = Math.max(want, C[node(i - 1, j)] - rise);
        if (i < W) want = Math.max(want, C[node(i + 1, j)] - rise);
        if (j > 0) want = Math.max(want, C[node(i, j - 1)] - rise);
        if (j < W) want = Math.max(want, C[node(i, j + 1)] - rise);
        // never above what covers this corner — the cap came first and still holds
        C[o] = Math.min(want, capOf(x0 + (i - P) * G, z0 + (j - P) * G, lanes), under[o]);
      }
    }
  }

  // The bed of a river is one depth under the water, whatever the sweeps made of it. They carry
  // the banks down into the channel at the slope a runner can walk, and how far that reaches
  // depends on how much bank the region can see past its own edge — so the two regions either
  // side of a seam laid the bed at different depths, and the river floor stepped along the seam.
  for (let i = 0; i <= W; i++)
    for (let j = 0; j <= W; j++) {
      const x = x0 + (i - P) * G, z = z0 + (j - P) * G;
      const r = riverNear(x, z, RIVER_HALF + TILE_DIAG);
      if (r && r.dist < RIVER_HALF + TILE_DIAG) C[node(i, j)] = waterLevel(r.line) - 1.5;
    }

  // The ground is laid as triangles on those corners: each tile the same two triangles the
  // road grid uses, and every corner one height that all the tiles round it share. It used to be
  // one box to a tile, its top the plane fitted through the tile's four corners — which four
  // corners on a hillside are not — so no two tiles met along their common edge, and the whole
  // of the open ground was a field of slabs with a step at every joint.
  //
  // Which tiles are laid: all but those over a subway entrance, where the ground is the one
  // thing in the way of getting down to it. Inside a block the same triangles are its pavement,
  // cut at the foot of its podium as the road is cut at its kerbs — still in the triangle's own
  // plane, so the pavement, the ground and the street are one sheet. The podium stands in the
  // hole that leaves.
  const laidTile = (i: number, j: number) => {
    const cx = x0 + (i - P + 0.5) * G, cz = z0 + (j - P + 0.5) * G;
    return !shaftCut(cx, cz);
  };
  const sides = blocks.map((c) => polySides(c.p));
  const podiumSides = blocks.map((c) => (c.podium ? polySides(c.podium) : null));
  const WHITE: Tint = [1, 1, 1];
  const boxes = blocks.map((c) => {
    const xs = c.p.map((p) => p[0]), zs = c.p.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)];
  });
  const at = (i: number, j: number) => C[node(Math.max(0, Math.min(W, i)), Math.max(0, Math.min(W, j)))];
  const corner = (i: number, j: number): number[] => {
    const gx = (at(i + 1, j) - at(i - 1, j)) / (2 * G), gz = (at(i, j + 1) - at(i, j - 1)) / (2 * G);
    const l = Math.hypot(gx, 1, gz);
    const x = x0 + (i - P) * G, z = z0 + (j - P) * G;
    return [x, at(i, j), z, -gx / l, 1 / l, -gz / l, x, z];
  };
  /** The side of a laid tile facing one that is not: straight down, as the slab's side was. */
  const side = (p: number[], q: number[], ox: number, oz: number, tint: Tint) => {
    const DEPTH = 16;
    const v = (V: number[], dy: number) => [V[0], V[1] - dy, V[2], ox, 0, oz, V[0] * oz - V[2] * ox, V[1] - dy];
    // wound so that the face looks outward, the way the tile's edge does
    const flip = (q[0] - p[0]) * oz - (q[2] - p[2]) * ox > 0;
    const [P0, Q0] = flip ? [q, p] : [p, q];
    b.tri([v(P0, 0), v(Q0, 0), v(Q0, DEPTH)], Mat.Asphalt, tint);
    b.tri([v(P0, 0), v(Q0, DEPTH), v(P0, DEPTH)], Mat.Asphalt, tint);
  };

  // Collision, never drawn: a box to a tile, up to the highest of its corners, or four where it
  // is steep enough that one would stand proud of the slope; level tiles gathered into runs.
  let run: { i: number; j0: number; j1: number; lo: number; hi: number } | null = null;
  const endRun = () => {
    if (!run) return;
    const x = x0 + (run.i - P) * G;
    solid.box(x, run.lo - 16, z0 + (run.j0 - P) * G, x + G, run.hi, z0 + (run.j1 + 1 - P) * G, Mat.Asphalt, t, 0,
      { hidden: true, detail: false });
    run = null;
  };

  for (let i = P; i < P + N; i++) {
    for (let j = P; j < P + N; j++) {
      if (!laidTile(i, j)) {
        endRun();
        continue;
      }
      const c00 = at(i, j), c10 = at(i + 1, j), c01 = at(i, j + 1), c11 = at(i + 1, j + 1);
      const x = x0 + (i - P) * G, z = z0 + (j - P) * G;
      const cx = x + G / 2, cz = z + G / 2;
      const r = riverNear(cx, cz, RIVER_HALF + TILE_DIAG + 4);
      const w = r ? waterLevel(r.line) : Infinity;
      // Only ground that is actually under a river is riverbed. Comparing against a water
      // level of Infinity where there is no river said yes to every tile in the city, so
      // every stretch of open ground was laid in silt: a dark floor a little below the
      // roadway all round it, which is a hole in the road with mud at the bottom.
      const drowned = w !== Infinity && (c00 + c10 + c01 + c11) / 4 < w - 0.3;
      const tint = drowned ? BED : t;
      const A = corner(i, j), B = corner(i + 1, j), D = corner(i, j + 1), E = corner(i + 1, j + 1);
      // height and normal on either triangle, the same split as the road's (see `roadSurface`)
      const atP = (k: number, p: Vec2): number[] => {
        const fx = (p[0] - x) / G, fz = (p[1] - z) / G;
        const [ha, hb, na, nb] = k === 0 ? [c10, c11, B, E] : [c01, c11, D, E];
        const yy = k === 0 ? c00 + fx * (ha - c00) + fz * (hb - ha) : c00 + fz * (ha - c00) + fx * (hb - ha);
        const [wa, wb] = k === 0 ? [fx - fz, fz] : [fz - fx, fx];
        const w0 = 1 - wa - wb;
        return [yy, ...[3, 4, 5].map((e) => A[e] * w0 + na[e] * wa + nb[e] * wb)];
      };
      // the blocks this tile reaches into
      const near: number[] = [];
      for (let k = 0; k < blocks.length; k++) {
        const bb = boxes[k];
        if (bb[0] < x + G && bb[2] > x && bb[1] < z + G && bb[3] > z) near.push(k);
      }
      // split from the low corner to the high one, as `fieldAt` splits the road
      const tris: Frag[] = [[[x, z], [x + G, z], [x + G, z + G]], [[x, z], [x + G, z + G], [x, z + G]]];
      const wound = (f: Frag) => (area2(f) < 0 ? f.slice().reverse() : f);
      // a block wholly beyond one of its own sides from the triangle takes nothing from it
      const misses = (s: ((p: Vec2) => number)[], tri: Frag) => s.some((side) => tri.every((p) => side(p) >= 0));
      // each triangle in two: the open ground outside every block, and the pavement inside one
      // up to the foot of its podium
      const cut = tris.map((tri) => {
        let parts = [tri];
        for (const k of near) if (!misses(sides[k], tri)) parts = parts.flatMap((q) => subtractSides(q, sides[k]));
        return parts.map(wound);
      });
      const pave = tris.map((tri) => {
        const out: Frag[] = [];
        for (const k of near) {
          if (misses(sides[k], tri)) continue;
          let part = tri;
          for (const side of sides[k]) {
            part = clipHalf(part, side);
            if (part.length < 3) break;
          }
          if (part.length < 3 || Math.abs(area2(part)) <= SLIVER) continue;
          const pod = podiumSides[k];
          let parts = [part];
          if (pod && !misses(pod, part)) parts = subtractSides(part, pod);
          out.push(...parts.map(wound));
        }
        return out;
      });
      for (let k = 0; k < 2; k++)
        for (const [frags, mat, tn] of [[cut[k], Mat.Asphalt, tint], [pave[k], Mat.Paving, WHITE]] as const)
          for (const f of frags) {
            const v = f.map((p) => {
              const [yy, nx, ny, nz] = atP(k, p);
              return [p[0], yy, p[1], nx, ny, nz, p[0], p[1]];
            });
            // wound to face the sky
            for (let m = 1; m + 1 < v.length; m++) b.tri([v[0], v[m + 1], v[m]], mat, tn);
          }
      if (!laidTile(i - 1, j)) side(A, D, -1, 0, tint);
      if (!laidTile(i + 1, j)) side(B, E, 1, 0, tint);
      if (!laidTile(i, j - 1)) side(A, B, 0, -1, tint);
      if (!laidTile(i, j + 1)) side(D, E, 0, 1, tint);

      // A tile cut at a podium is sliced a metre at a time for collision, as a cut cell of road
      // is, so that none of it reaches in through the podium's wall.
      if (!cut.every((fs, k) => fs.length === 1 && fs[0] === tris[k])) {
        endRun();
        for (let k = 0; k < 2; k++)
          for (const f of [...cut[k], ...pave[k]])
            for (let xa = x; xa < x + G - 1e-6; xa++) {
              let part = clipHalf(f, (p) => xa - p[0]);
              part = clipHalf(part, (p) => p[0] - (xa + 1));
              if (part.length < 3 || Math.abs(area2(part)) <= SLIVER) continue;
              const zs = part.map((p) => p[1]), ys = part.map((p) => atP(k, p)[0]);
              solid.box(xa, Math.min(...ys) - 16, Math.min(...zs), xa + 1, Math.max(...ys), Math.max(...zs),
                Mat.Asphalt, t, 0, { hidden: true, detail: false });
            }
        continue;
      }

      const lo = Math.min(c00, c10, c01, c11), hi = Math.max(c00, c10, c01, c11);
      if (hi - lo <= 0.3) {
        if (run && run.i === i && run.j1 === j - 1 && Math.abs(run.hi - hi) < 0.03) {
          run.j1 = j;
          run.lo = Math.min(run.lo, lo);
          run.hi = Math.max(run.hi, hi);
        } else {
          endRun();
          run = { i, j0: j, j1: j, lo, hi };
        }
        continue;
      }
      endRun();
      // the tile's own two triangles at a point of it, as fractions across
      const y = (u: number, v: number) => u >= v ? c00 + u * (c10 - c00) + v * (c11 - c10) : c00 + v * (c01 - c00) + u * (c11 - c01);
      for (const su of [0, 0.5])
        for (const sv of [0, 0.5]) {
          const ys = [y(su, sv), y(su + 0.5, sv), y(su, sv + 0.5), y(su + 0.5, sv + 0.5)];
          solid.box(x + su * G, Math.min(...ys) - 16, z + sv * G, x + (su + 0.5) * G, Math.max(...ys), z + (sv + 0.5) * G,
            Mat.Asphalt, t, 0, { hidden: true, detail: false });
        }
    }
    endRun();
  }
}

/**
 * How far a cutting reaches out from a road the ground stands above.
 *
 * The same eight tiles the embankment spreads over, for the same reason: the two are one rule
 * seen from either side, and what the ground may do beside a road is come to meet it.
 */
const CUT_TILES = APRON_TILES;

/**
 * The highest the ground may stand for the roads near a point: level with the lowest
 * carriageway over it, and rising away from one it is beside at the slope an embankment comes
 * down at.
 *
 * Only holding the corners a road actually covered was not enough, because the grid of corners
 * is five metres square and a kerb is a line drawn across it at any angle. The tile *across* a
 * kerb had one corner pinned under the asphalt and the other still up at the hill's own height,
 * and the plane between them stands through the carriageway: a good two metres of hillside
 * inside the road on the steepest ground the city can grow. To a car that is a wall across the
 * street; from the pavement it is a cliff at the kerb.
 *
 * So a road cut into a flank gets a cutting, at the slope the runner can walk and the car can
 * drive. It costs nothing past the ground's own steepest grade — which is this same slope, so a
 * hillside that merely rises away from a road it is level with is not touched at all.
 */
function roadCut(pieces: Piece[], x: number, z: number): number {
  let cap = Infinity;
  const far = CUT_TILES * TILE;
  for (const p of pieces) {
    const dx = x - p.cx, dz = z - p.cz;
    // distance out to the carriageway's own rectangle, which is zero anywhere over it
    const along = Math.max(0, Math.abs(dx * p.ux + dz * p.uz) - p.hl);
    const across = Math.max(0, Math.abs(dz * p.ux - dx * p.uz) - p.hw);
    if (along > far || across > far) continue;
    const out = Math.hypot(along, across);
    if (out > far) continue;
    // the surface at the nearest point of the carriageway; a stretch is a plane across its
    // width, so `pieceYOn` already answers for a point beside it
    cap = Math.min(cap, pieceYOn(p, x, z) - 0.05 + out * APRON_GRADE);
  }
  return cap;
}

/**
 * The lowest thing laid over a point that the ground there has to stay under.
 *
 * Not a block: the ground is cut off at a block's outline (see `terrain`), so nothing of it is
 * ever laid inside one to stand through the pavement, whatever height its corners there are.
 */
function capOf(x: number, z: number, lanes: Piece[]): number {
  let cap = roadCut(lanes, x, z);
  // The channel is a cap like any other. Cutting the bed when the corner heights are first
  // taken and leaving it out of this let the embankment sweeps raise it straight back up
  // again, since they are allowed to climb to whatever the cap says — and the bed came back
  // to the waterline, taking the staircase with it.
  cap = Math.min(cap, channelCap(x, z));
  return cap;
}

/**
 * A block as the ground sees it: its outline, and the footprint of its podium — the hole the
 * ground is cut to, null for a sliver that is all pavement.
 */
interface Cover {
  p: Vec2[];
  podium: Vec2[] | null;
}

/** How far the pavement is held under the road field, so the two never share a plane. */
const PAVE_DROP = 0.03;

/**
 * The pavement at a point: the road's own surface carried on past the kerb (see `fieldAt`),
 * so that the walk is level with the carriageway beside it, however the street climbs.
 */
function paveAt(x: number, z: number): number {
  return fieldAt(x, z) - PAVE_DROP;
}

/** The pavement's surface at a point, for anything walking on it (see `paveAt`). */
export const pavementAt = paveAt;

/**
 * A block's outline at the kerb, if it is a block with a pavement round a podium: the ring
 * between this and the outline pulled in by `WALK` is where people walk. Null for the slivers
 * left between streets, which are nothing but paving.
 */
export function pavementOf(site: Site): Vec2[] | null {
  const poly = cellOf(site);
  return poly && poly.length >= 3 && podiumOf(poly) ? poly : null;
}

/**
 * The podium's footprint, as its walls stand: the outline pulled in by the walk and blunted at
 * the corners as `extrude` blunts it. Null where the block is too small to carry one, which
 * `buildBlock` leaves as pavement.
 */
function podiumOf(poly: Vec2[]): Vec2[] | null {
  if (spanOf(poly) < 16) return null;
  const face = shrink(poly, WALK);
  if (face.length < 3 || spanOf(face) < 12) return null;
  return blunt(face);
}

const baseCache = rememberBySeed<string, number>();

/**
 * The level a block is built at: the street round it, which is the pavement at its outline,
 * taken on average along it. It used to be the ground under the block's middle, which on a
 * hillside is metres under the street on the uphill side — a block sunk in a pit, with the
 * pavement at the bottom of it.
 */
function blockBase(poly: Vec2[]): number {
  const key = poly.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(";");
  checkSeed();
  const hit = baseCache.get(key);
  if (hit !== undefined) return hit;
  let sum = 0, len = 0;
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k], c = poly[(k + 1) % poly.length];
    const l = Math.hypot(c[0] - a[0], c[1] - a[1]);
    const n = Math.max(1, Math.ceil(l / 4));
    for (let m = 0; m < n; m++) {
      const t = (m + 0.5) / n;
      sum += paveAt(a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t) * (l / n);
    }
    len += l;
  }
  const base = len > 0 ? sum / len : groundAt(poly[0][0], poly[0][1]);
  if (baseCache.size > 8192) baseCache.clear();
  baseCache.set(key, base);
  return base;
}

/** A region of the city, built on the road network instead of the grid. */
export function buildPlanRegion(rx: number, rz: number, faceCull = true): RegionMesh {
  const x0 = rx * REGION, z0 = rz * REGION;
  const parts: Part[] = [];
  // the polygons of every block that reaches this region, for masking the ground under them
  const shapes = blocksIn(x0 - 200, z0 - 200, x0 + REGION + 200, z0 + REGION + 200)
    .map((s) => cellOf(s))
    .filter((p): p is Vec2[] => !!p && p.length >= 3);
  const covers: Cover[] = shapes.map((p) => ({ p, podium: podiumOf(p) }));
  const covered = (x: number, z: number): Cover | null => {
    for (const c of covers) if (inPoly(c.p, x, z)) return c;
    return null;
  };
  const ground = new Builder(new Rng(hashInt(rx, rz, 5)));
  // As far out as the embankments reach and the cuttings are read, or a road just past the seam
  // raises no ground here — and, worse, two regions sharing a corner would not see the same
  // roads from it and so would not agree on its height, which is a seam in the ground.
  const reach = (APRON_TILES + CUT_TILES) * TILE;
  const lanes = streetPieces(x0 - reach, z0 - reach, x0 + REGION + reach, z0 + REGION + reach);
  // collision for the ground and the road, kept apart from what is drawn so that its hidden
  // boxes never cull a face
  const solid = new Builder(new Rng(hashInt(rx, rz, 6)));
  terrain(ground, solid, x0, z0, covered, covers, lanes);
  roadSurface(ground, solid, x0, z0);
  streets(ground, x0, z0);
  bridges(ground, solid, x0, z0);
  rails(ground, x0, z0);
  const railStops = railStationsNear(x0 + REGION / 2, z0 + REGION / 2, REGION)
    .filter((st) => st.x >= x0 && st.x < x0 + REGION && st.z >= z0 && st.z < z0 + REGION);
  for (const st of railStops) railStation(ground, st);
  marketsIn(ground, x0, z0);
  const stations = subway(ground, x0, z0);
  waterfront(ground, x0, z0);
  river(ground, x0, z0);
  vessels(ground, x0, z0);
  parts.push({ ci: rx * 100000, cj: rz * 100000, b: ground });
  parts.push({ ci: rx * 100000 + 1, cj: rz * 100000, b: solid });
  for (const site of blocksIn(x0, z0, x0 + REGION, z0 + REGION)) {
    // each block belongs to the region its seed is in, so no block is built twice
    if (site.p[0] < x0 || site.p[0] >= x0 + REGION || site.p[1] < z0 || site.p[1] >= z0 + REGION) continue;
    const b = new Builder(new Rng(hashInt(Math.round(site.p[0]), Math.round(site.p[1]), 2)));
    buildBlock(site, b);
    if (b.count === 0) continue;
    parts.push({ ci: Math.round(site.p[0]), cj: Math.round(site.p[1]), b });
  }
  const mesh = assembleRegion(rx, rz, parts, faceCull, false);
  mesh.colliders = byGridCell(mesh.colliders, rx, rz);
  // carried back with the mesh so that nothing on the main thread ever has to work out
  // where a station is for itself
  mesh.stations = stations;
  mesh.railStations = railStops;
  return mesh;
}

/**
 * Collision regrouped by grid cell, which is how the world looks it up.
 *
 * The world finds what a runner can collide with by the grid cell they stand in and its eight
 * neighbours. The parts of this city are blocks, not cells, and were handed over keyed by
 * block — so every lookup came back empty, read the length of nothing and killed the game at
 * startup, which on screen is simply a runner who will not move. A box goes into every cell it
 * overlaps, so a long one is found from anywhere along it.
 */
function byGridCell(
  colliders: { ci: number; cj: number; boxes: Float32Array }[], rx: number, rz: number,
): { ci: number; cj: number; boxes: Float32Array }[] {
  const buckets = new Map<string, number[]>();
  for (let ci = rx * REGION_CELLS; ci < (rx + 1) * REGION_CELLS; ci++)
    for (let cj = rz * REGION_CELLS; cj < (rz + 1) * REGION_CELLS; cj++) buckets.set(`${ci},${cj}`, []);
  for (const c of colliders) {
    const b = c.boxes;
    for (let i = 0; i < b.length; i += 6) {
      for (let a = Math.floor(b[i] / CELL); a <= Math.floor(b[i + 3] / CELL); a++)
        for (let d = Math.floor(b[i + 2] / CELL); d <= Math.floor(b[i + 5] / CELL); d++) {
          // a block straddling the seam puts boxes in the neighbour's cells as well: keep them,
          // the world merges every region's share of a cell
          let bucket = buckets.get(`${a},${d}`);
          if (!bucket) buckets.set(`${a},${d}`, (bucket = []));
          for (let k = 0; k < 6; k++) bucket.push(b[i + k]);
        }
    }
  }
  return [...buckets].map(([key, v]) => {
    const [ci, cj] = key.split(",").map(Number);
    return { ci, cj, boxes: Float32Array.from(v) };
  });
}

export { ROAD, hasRail, hasSubway, SUB_SPACING };

/**
 * Where the runner starts on the network city: standing in the middle of an arterial.
 *
 * Picking a spot and checking it against one nearby block was not enough — `blocksIn` hands
 * back whichever site comes first, not the one whose block the point is actually in, so being
 * outside *that* block meant nothing and the runner started inside a building, wedged, unable
 * to move a step. An arterial's centreline is the one place in the city guaranteed to be clear
 * of every block, because the blocks are cut back off it by construction.
 */
export interface Spawn {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/**
 * The search for that spot, one arterial at a time.
 *
 * It is the first thing to ask the plan anything, and on a cold cache that means settling
 * the rivers, the hills and every block around the origin before it can say where a bank
 * is — seconds of work, all of it on whichever thread called. So it comes as a generator
 * that yields how far along it is after each arterial: a caller with a page to keep alive
 * can let it breathe and count in between, and `planSpawn` below just runs it to the end.
 */
export function* spawnSearch(): Generator<number, Spawn> {
  // Best of all, on the bank facing the nearest bridge: the river, the bridge, the quays and
  // the boats are the first thing seen rather than something a kilometre away to go and find.
  let best: Spawn | null = null, bd = Infinity;
  const near = arteryLines(0, ARTERY * 2.5);
  const steps = 2 * near.length;
  let step = 0;
  for (const axis of [1, 0] as const)
    for (const line of near) {
      for (let k = -3; k <= 2; k++)
        for (const c of crossings(axis, line, k))
          // back along the road until the spot is really in the street: near the water the
          // blocks are pushed about, and the spline and the street part company
          for (let back = 70; back <= 250; back += 20) {
            const s = c.s0 - RAMP - back;
            const { p, dir } = arteryFrame(axis, line, s);
            const d = Math.hypot(p[0], p[1]);
            if (d >= bd) break;
            if (riverNear(p[0], p[1], RIVER_HALF + QUAY + 10)) continue;
            const x = p[0] - dir[1] * 7, z = p[1] + dir[0] * 7;
            if (!inStreet(x, z) || !inStreet(x + dir[0] * 30, z + dir[1] * 30)) continue;
            bd = d;
            best = { x, y: roadY(axis, line, s, x, z) + 0.4, z, yaw: Math.atan2(dir[0], dir[1]) };
            break;
          }
      yield ++step / steps;
    }
  if (best) return best;
  for (const axis of [1, 0] as const)
    for (const line of arteryLines(0, ARTERY)) {
      for (let s = -ARTERY; s <= ARTERY; s += 40) {
        const { p, dir } = arteryFrame(axis, line, s);
        if (Math.hypot(p[0], p[1]) > ARTERY * 1.2) continue;
        // not on a bridge, and not in the river
        if (riverNear(p[0], p[1], RIVER_HALF + 60)) continue;
        // In a lane, not dead centre: an elevated railway stands its piers down the middle of
        // the road it follows, and the centreline is exactly where they are.
        const x = p[0] - dir[1] * 7, z = p[1] + dir[0] * 7;
        return { x, y: roadY(axis, line, s, x, z) + 0.4, z, yaw: Math.atan2(dir[0], dir[1]) };
      }
    }
  return { x: 0, y: groundAt(0, 0) + 0.4, z: 0, yaw: 0 };
}

/** The spawn, worked out in one go. */
export function planSpawn(): Spawn {
  const search = spawnSearch();
  for (;;) {
    const r = search.next();
    if (r.done) return r.value;
  }
}

/** True where a point is in the open and not inside any block, with room round it. */
function inStreet(x: number, z: number): boolean {
  for (const s of blocksIn(x - 8, z - 8, x + 8, z + 8)) {
    const poly = cellOf(s);
    if (!poly) continue;
    const grown = shrink(poly, -3);
    if (grown.length >= 3 && inPoly(grown, x, z)) return false;
  }
  return true;
}

function inPoly(poly: Vec2[], x: number, z: number): boolean {
  let neg = 0, pos = 0;
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k], b = poly[(k + 1) % poly.length];
    const c = (b[0] - a[0]) * (z - a[1]) - (b[1] - a[1]) * (x - a[0]);
    if (c < 0) neg++;
    else pos++;
  }
  return neg === 0 || pos === 0;
}

/**
 * Bridges: wherever an arterial crosses a river, a deck on piers.
 *
 * The road's line is already a spline and the river's is another, so the crossing is found by
 * walking the road and watching the distance to the water. The deck is laid as turned boxes
 * along the road, which is the same way every wall in this city is built.
 */
/** One river crossing of one road: where it starts and ends, and how high the deck rides. */
interface Crossing {
  s0: number;
  s1: number;
  /**
   * Stations the two approach ramps start from: the nearest place either side where there is
   * actually a carriageway to leave.
   *
   * Not a fixed distance back from the bank. A street exists here only between two blocks,
   * and the last blocks stop well short of the water, so the arterial simply ends — and a
   * ramp that began a fixed twenty-four metres out started in mid-air over the gap, with the
   * road it was meant to join ending forty metres behind it. That gap is the one a car drove
   * through on its way onto the bridge.
   */
  a0: number;
  a1: number;
  /**
   * Where the level deck ends and each ramp begins. The banks themselves (`s0`, `s1`) unless a
   * street runs across the approach: then the deck carries on at full height until it is past
   * that street, and comes down only beyond it. See `UNDER`.
   */
  e0: number;
  e1: number;
  deck: number;
  water: number;
}

const crossCache = rememberBySeed<string, Crossing[]>();
/** Shortest an approach ramp may be, whatever the climb. */
const RAMP = 24;
/** Steepest an approach ramp may be; past this it is a wall, not a road. */
const RAMP_GRADE = 0.08;
/**
 * How far a deck carried over a street stands above that street's surface: a lorry's
 * headroom under the soffit, and the depth of the deck itself.
 *
 * A road along a river runs parallel to the bank, which puts it straight across the approach
 * to every bridge. The ramps used to come down at grade wherever they happened to be and
 * cross whatever was under them — so at the street along the bank the ramp was still a metre
 * and a half up, and the street ran into the side of it: a concrete wall across the road
 * with the bridge sitting on top. A bridge goes over the road along the bank, not through it.
 */
const UNDER = 5 + 2.2;
/** How far past the far kerb of a street it crosses the level deck runs before the ramp starts. */
const UNDER_RUN = 8;

/**
 * Where a road crosses water, worked out once per road per span and kept.
 *
 * The bridge builder and the traffic both need this and must agree exactly: the geometry puts
 * a deck at one height and the cars have to ride it, or they drive down the bank and into the
 * river underneath their own bridge.
 */
export function crossings(axis: 0 | 1, line: number, k: number): Crossing[] {
  const key = `${axis},${line},${k}`;
  checkSeed();
  const hit = crossCache.get(key);
  if (hit) return hit;
  const out: Crossing[] = [];
  /** The river under a station, or null where the road is over dry ground. */
  const wet = (s: number) => {
    const { p } = arteryFrame(axis, line, s);
    const r = riverNear(p[0], p[1], RIVER_HALF + 70);
    return r && r.dist < RIVER_HALF + 46 ? r : null;
  };
  // How far past its window this will chase a crossing's banks. A span longer than this is
  // not a bridge, and the walk has to stop somewhere.
  const REACH = ARTERY * 2;
  const seen = new Set<number>();
  /**
   * One crossing, walked out to its own two banks.
   *
   * This is the whole reason the ends are found again here rather than taken from the scan.
   * The window is three spans wide and a crossing that runs past either edge of it came back
   * cut to that edge — or, if it was still open when the scan ran out, did not come back at
   * all. Since the window moves with the station being asked about, the same bridge had a
   * different length, a different deck height, and at every span boundary a bucket that knew
   * about it next to one that did not. The deck is built per region and the traffic reads it
   * per station, so what that produced was a bridge in two heights with a cliff between them
   * every nine hundred metres. Walking to the banks makes a crossing the same crossing
   * whichever window happens to find it.
   */
  const reach = (from: number, to: number) => {
    let a = from;
    for (let n = 0; n * 6 < REACH && wet(a - 6); n++) a -= 6;
    let b = to;
    for (let n = 0; n * 6 < REACH && wet(b); n++) b += 6;
    if (b - a < 24 || seen.has(a)) return;
    seen.add(a);
    const r = wet(a);
    if (!r) return;
    // The deck clears the higher of the two banks. Taken there and not at the ramp feet, so
    // that it does not depend on the feet the ramps are then chosen to reach.
    let deck = Math.max(surface(a - 6), surface(b)) + 1.2;
    // A deck that cannot clear the water is no bridge, and `span` declines to build one. It
    // must not be in this list either, or the traffic rides a crossing that was never built.
    if (deck < waterLevel(r.line) + 5) return;
    // And it clears the quays. Over the bank by only a metre, the deck sat across the walk
    // along the water as a wall, and the quay that runs the length of the river stopped at
    // every bridge. It goes under, with the same headroom as a street.
    deck = Math.max(deck, waterLevel(r.line) + QUAY_RISE + UNDER);
    // Then over any street the ramps would otherwise meet part way up. Raising the deck
    // lengthens the ramps, and a longer ramp can reach the next street out, so this goes round
    // until the ramps come down clear of everything — or reach a street at its own level, which
    // is a junction and fine.
    let e0 = a, e1 = b, a0 = foot(e0, -1, deck), a1 = foot(e1, 1, deck);
    for (let pass = 0; pass < 4; pass++) {
      // the level deck clears any other bridge under it, unless the two are level with each other
      for (let s = e0; s <= e1; s += 3) {
        const other = bridgeUnder(s);
        if (other !== null && Math.abs(other - deck) > 0.02 && deck - other < UNDER) deck = other + UNDER;
      }
      const c: Crossing = { s0: a, s1: b, a0, a1, e0, e1, deck, water: 0 };
      const lo = blocked(c, e0, a0, -1), hi = blocked(c, e1, a1, 1);
      if (!lo && !hi) break;
      if (lo) {
        e0 = Math.min(e0, lo.s - UNDER_RUN);
        deck = Math.max(deck, lo.top + UNDER);
      }
      if (hi) {
        e1 = Math.max(e1, hi.s + UNDER_RUN);
        deck = Math.max(deck, hi.top + UNDER);
      }
      a0 = foot(e0, -1, deck);
      a1 = foot(e1, 1, deck);
    }
    out.push({ s0: a, s1: b, a0, a1, e0, e1, water: waterLevel(r.line), deck });
  };
  /**
   * The street furthest out along one ramp that the ramp passes over without meeting it — at
   * its station, with the highest surface among those found — or null where the ramp is clear.
   *
   * Only a street that runs right across, seen on both sides of the deck. A side street that
   * merely ends at the main road is a junction, and lifting a bridge over every one of those
   * would never bring a ramp down at all.
   */
  const blocked = (c: Crossing, from: number, to: number, dir: -1 | 1) => {
    let at: number | null = null, high = -Infinity;
    for (let s = from; dir < 0 ? s > to : s < to; s += dir * 3) {
      // Another main road's bridge: at exactly this one's level the two cross on the flat, so
      // the level deck carries on past it; at any other height this one goes over it. A ramp
      // running across a level deck met it a step at a time, a third of a metre at the worst.
      const other = bridgeUnder(s);
      if (other !== null && Math.abs(spanY(axis, line, c, s) - other) > 0.02) {
        at = s;
        high = Math.max(high, Math.abs(other - c.deck) <= 0.02 ? c.deck - UNDER : other);
      }
      const top = crossTop(axis, line, s);
      if (top === null) continue;
      const y = spanY(axis, line, c, s);
      // at its own level the ramp meets the street and the two simply cross; high enough, it
      // is already over it
      if (y - top < 0.5 || y - top >= UNDER - 0.05) continue;
      at = s;
      high = Math.max(high, top);
    }
    return at === null ? null : { s: at, top: high };
  };
  /**
   * The highest bridge deck of another main road under this one at a station, seen across the
   * whole width, or null where there is none.
   *
   * Only the roads running the other way are asked, and only by the roads running east and
   * west. Two bridges deciding their heights by each other would each have to be worked out
   * first; this way the north–south bridges are built as they would be anyway and the
   * east–west ones fit themselves round them, so every region gets the same answer whichever
   * it asks about first.
   */
  const bridgeUnder = (s: number): number | null => {
    if (axis !== 0) return null;
    const { p, dir } = arteryFrame(axis, line, s);
    let top: number | null = null;
    for (const off of [-ARTERY_HALF, 0, ARTERY_HALF]) {
      const x = p[0] - dir[1] * off, z = p[1] + dir[0] * off;
      for (const st of arteryStations(x, z, ARTERY_HALF + 2)) {
        if (st.axis !== 1) continue;
        for (const c of crossings(1, st.line, Math.floor(st.s / ARTERY)))
          if (st.s > c.a0 && st.s < c.a1) {
            const y = spanY(1, st.line, c, st.s);
            top = top === null ? y : Math.max(top, y);
          }
      }
    }
    return top;
  };
  /**
   * Height of whatever a vehicle runs on at a station: the road surface where there is a road
   * to come down to — the very height a ramp's foot is laid at (see `spanY`), so the gradient
   * judged here is the one built — else the ground.
   */
  const surface = (s: number) => {
    const { p } = arteryFrame(axis, line, s);
    return onCarriageway(p[0], p[1]) ? fieldAt(p[0], p[1]) : terrainAt(p[0], p[1]);
  };
  /**
   * Where an approach ramp starts: far enough out that the climb to the deck is a gradient a
   * car can take, and on a station that has a carriageway to start from.
   *
   * Both conditions matter. Stopping at the first carriageway found a road running down the
   * bank towards the water six metres from the abutment and built a ramp that climbed five
   * metres over those six — a wall the traffic went up like a lift. Stopping at a fixed
   * distance instead started the ramp in the gap where the road is not.
   */
  const foot = (from: number, dir: -1 | 1, deck: number) => {
    let last = from + dir * RAMP;
    for (let n = 1; n * 6 <= RAMP * 8; n++) {
      const s = from + dir * n * 6;
      const { p } = arteryFrame(axis, line, s);
      if (!onCarriageway(p[0], p[1])) continue;
      last = s;
      const run = n * 6;
      if (run >= RAMP && Math.abs(deck - surface(s)) <= RAMP_GRADE * run) return s;
    }
    return last;
  };
  const lo = (k - 1) * ARTERY, hi = (k + 2) * ARTERY;
  let run: number | null = null;
  for (let s = lo; s <= hi; s += 6) {
    if (wet(s)) {
      if (run === null) run = s;
    } else if (run !== null) {
      reach(run, s);
      run = null;
    }
  }
  if (run !== null) reach(run, hi + 6); // still over water where the window ran out
  if (crossCache.size > 2048) crossCache.clear();
  crossCache.set(key, out);
  return out;
}

/**
 * Height of the surface a vehicle actually runs on along a road: the bridge deck where there
 * is one, the ground everywhere else, easing between the two over the approach so a car is
 * never asked to step.
 *
 * Taken on the road's own centreline, from the station alone, and deliberately not from where
 * the car happens to be sitting. A carriageway is one flat slab the whole way across, cut to
 * the ground along its middle; the hillside a lane's width to the side of that is not the
 * surface the car is on. Asking there cost nothing while the ground was flat and put a car in
 * the kerbside lane the better part of a metre into the road once it was not.
 */
export function roadY(axis: 0 | 1, line: number, s: number, x: number, z: number): number {
  // On a bridge and on either of its ramps the surface is the deck, and the deck is built
  // from `spanY` — the same function of the station, so the car is on the structure and not
  // near it. Everywhere else it is the road under the car itself, which is not always the one
  // it is nominally driving on: at a junction on a slope the crossing street's slab laps over
  // this one, and a car holding to its own road's height drives through it. Off the
  // carriageway altogether there is nothing to ride but the ground.
  for (const c of crossings(axis, line, Math.floor(s / ARTERY))) {
    if (s <= c.a0 || s >= c.a1) continue;
    return deckY(axis, line, c, s, x, z);
  }
  return roadRideAt(x, z) ?? terrainAt(x, z);
}

/**
 * The stations of every main road whose centreline passes within `reach` of a point.
 *
 * The traffic is handed its road and its station and never has to ask this. Anything driving
 * itself has only where it is, and the roads are splines — so the station is found by walking
 * onto the foot of the perpendicular, which on a road curved this gently lands in a step or two.
 */
function arteryStations(x: number, z: number, reach: number): { axis: 0 | 1; line: number; s: number; p: Vec2 }[] {
  const out: { axis: 0 | 1; line: number; s: number; p: Vec2 }[] = [];
  for (const axis of [0, 1] as const) {
    for (const line of arteryLines(axis === 0 ? z : x, reach + 300)) {
      let s = axis === 0 ? x : z;
      for (let k = 0; k < 8; k++) {
        const f = arteryFrame(axis, line, s);
        const step = (x - f.p[0]) * f.dir[0] + (z - f.p[1]) * f.dir[1];
        s += step;
        if (Math.abs(step) < 0.02) break;
      }
      const { p } = arteryFrame(axis, line, s);
      if (Math.hypot(p[0] - x, p[1] - z) <= reach) out.push({ axis, line, s, p });
    }
  }
  return out;
}

/**
 * The surface a vehicle rides at a point, or null where the city lays no carriageway over it.
 *
 * Everything the city calls a road: the road surface, which is every stretch of street and the
 * fill laid along a main road wherever the blocks either side ran out (see `roadTopAt`), and
 * the bridges and the ramps that climb to them, whose deck is the road wherever it runs.
 *
 * Missing either is why a car on a main road with no blocks along it was told it was off
 * the road entirely: it went back to reading its height off collision, and met the first bay of
 * its own bridge ramp — two metres of cast concrete, thirty-eight across — as a block standing in
 * the carriageway. The traffic drove through it, because the traffic reads `roadY` and knew all
 * along that it was the road.
 *
 * `below` is the highest surface worth having: the road under the vehicle, never the flyover
 * above it.
 */
export function rideAt(x: number, z: number, below: number): number | null {
  let best: number | null = null;
  const take = (y: number | null) => {
    if (y !== null && y <= below && (best === null || y > best)) best = y;
  };
  take(roadRideAt(x, z));
  for (const { axis, line, s } of arteryStations(x, z, ARTERY_HALF + ARTERY_MARGIN))
    for (const c of crossings(axis, line, Math.floor(s / ARTERY)))
      if (s > c.a0 && s < c.a1) take(deckY(axis, line, c, s, x, z));
  return best;
}

/**
 * Whether a deck passes over (x, z) anywhere between heights `lo` and `hi`: a main road's
 * bridge or its ramp, or the railway's viaduct. For anything standing in the street that has
 * to keep out from under them — a street lamp is taller than either leaves room for.
 */
export function overhead(x: number, z: number, lo: number, hi: number): boolean {
  // a deck's surface, with the depth of its structure under it
  const hits = (top: number, depth: number) => top > lo && top - depth < hi;
  for (const { axis, line, s } of arteryStations(x, z, ARTERY_HALF + ARTERY_MARGIN)) {
    for (const c of crossings(axis, line, Math.floor(s / ARTERY)))
      if (s > c.a0 && s < c.a1 && hits(deckY(axis, line, c, s, x, z), 2.5)) return true;
  }
  for (const { axis, line, s, p } of arteryStations(x, z, 5.6)) {
    if (hasRail(axis, line) && Math.hypot(p[0] - x, p[1] - z) < 5.6 && hits(railY(axis, line, s), 1.9)) return true;
  }
  return false;
}

/**
 * Height of a bridge's surface at a station: the deck over the crossing itself, and the climb
 * up to it from the road on the bank over either ramp.
 *
 * Taken on the centreline, because this is what the deck is built from and a bay of deck has
 * one height across its width. The traffic reads the same function, so the two cannot part.
 */
function spanY(axis: 0 | 1, line: number, c: Crossing, s: number): number {
  if (s >= c.e0 && s <= c.e1) return c.deck;
  const foot = s < c.e0 ? c.a0 : c.a1;
  const p = arteryFrame(axis, line, foot).p;
  // the road surface, laid or not, so the ramp starts at exactly the height it is drawn at
  const bank = fieldAt(p[0], p[1]);
  const t = s < c.e0 ? (s - c.a0) / (c.e0 - c.a0) : (c.a1 - s) / (c.a1 - c.e1);
  const e = Math.max(0, Math.min(1, t));
  // Eased in at the foot and out at the deck. A straight climb meets both at a kink, and a car
  // going over the top of one at speed left the road for a third of a second and landed on it.
  return bank + (c.deck - bank) * e * e * (3 - 2 * e);
}

/**
 * The deck's surface at a point on it, at station `s`: `spanY` across the whole width, except
 * on a ramp, which comes down onto the road and so carries on down whatever the road does across
 * its width. At the foot it *is* the road surface, so the two meet without a step; up at the
 * level deck it is level across.
 */
function deckY(axis: 0 | 1, line: number, c: Crossing, s: number, x: number, z: number): number {
  const y = spanY(axis, line, c, s);
  if (s >= c.e0 && s <= c.e1) return y;
  const foot = arteryFrame(axis, line, s < c.e0 ? c.a0 : c.a1).p;
  const t = s < c.e0 ? (s - c.a0) / (c.e0 - c.a0) : (c.a1 - s) / (c.a1 - c.e1);
  const e = Math.max(0, Math.min(1, t));
  return y + (1 - e) * (fieldAt(x, z) - fieldAt(foot[0], foot[1]));
}

function bridges(b: Builder, solid: Builder, x0: number, z0: number): void {
  const t: Tint = [0.9, 0.9, 0.91];
  const pad = 260;
  for (const axis of [0, 1] as const) {
    const across = axis === 0 ? z0 + REGION / 2 : x0 + REGION / 2;
    for (const line of arteryLines(across, REGION / 2 + pad)) {
      const from = (axis === 0 ? x0 : z0) - pad, to = (axis === 0 ? x0 + REGION : z0 + REGION) + pad;
      // Each crossing once, however many buckets know about it. A crossing now reads the
      // same from every span of road it reaches — which is what stopped a bridge being two
      // different heights — and the cost of that is that walking the buckets hands back the
      // same one several times over. Building it each time laid the deck, the parapets and
      // the piers on top of themselves, face for face, with nothing to choose between them:
      // the blinking along a bridge.
      const seen = new Set<number>();
      for (let k = Math.floor(from / ARTERY); k <= Math.floor(to / ARTERY); k++)
        for (const c of crossings(axis, line, k)) {
          if (seen.has(c.s0)) continue;
          seen.add(c.s0);
          span(b, solid, axis, line, c, t, x0, z0);
        }
    }
  }
}

/** One bay of a deck laid along an arterial: where it sits, which way it runs, how long it is. */
interface Bay {
  p: Vec2;
  dir: Vec2;
  turn: number;
  /** Straight-line distance between the bay's two stations. */
  chord: number;
  /** Length of the box laid along it, which overruns both ends by the mitre. */
  len: number;
  /** How far this bay is set down from its neighbours; see `SHINGLE`. */
  drop: number;
  /** A climb across the chord, as the shear the box needs to carry that gradient. */
  riseOf: (climb: number) => number;
}

/**
 * How far a bay of deck runs past its own two ends.
 *
 * The next bay is turned against this one by up to two degrees, which nineteen metres out at
 * the edge of a bridge deck leaves a third of a metre of open mitre. Overlapping the two
 * closes it, and costs nothing: the boxes are opaque and the seam is inside the concrete.
 */
const MITRE = 0.02;

/**
 * How far every other bay is set down, so that the mitre is an overlap and not a tie.
 *
 * The overlap puts two boxes over the same strip of road at every joint, and along the level
 * part of a crossing both of them are flat at the deck's own height: two surfaces in exactly
 * the same plane, each with its own texture origin, and nothing in the depth buffer to choose
 * between them. Which one a pixel shows is then decided by the last bit of the interpolated
 * depth, so it changes with the smallest movement of the head — the strips that cross the
 * road at every bay and come and go as you look around, reading as smears of shadow because
 * the two boxes carry the paving at different offsets. Setting alternate bays down a few
 * millimetres makes one of the pair definitively the upper one: the joint is still closed,
 * the step is far below anything the eye or a car can find, and the surface stops flickering.
 */
const SHINGLE = 0.004;

/**
 * A bay of deck between two stations of an arterial.
 *
 * A station is a straight fraction of the lattice spacing and not arc length, so the spline
 * covers anywhere from five to twelve metres over a bay of nine — and a box cut to the
 * nominal length leaves a gap at every joint where the road stretches. Regularly spaced
 * holes, and nothing ever complained about them: the traffic reads its height off `roadY`
 * and never asks whether there is anything underneath to hold it up. Measuring each bay
 * between its own ends is what closes them.
 */
function bayOf(axis: 0 | 1, line: number, s0: number, s1: number, halfW: number): Bay {
  const a = arteryFrame(axis, line, s0).p, c = arteryFrame(axis, line, s1).p;
  const dx = c[0] - a[0], dz = c[1] - a[1];
  const chord = Math.hypot(dx, dz) || 1;
  // Which of the pair this one is, counted off the line's own stations so that every region
  // building the same bay sets it down by the same amount and the two halves of a bay either
  // side of a seam still meet.
  const k = Math.round(s0 / (s1 - s0));
  return {
    p: [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2],
    dir: [dx / chord, dz / chord],
    turn: Math.atan2(dz, dx),
    chord,
    len: chord + 2 * (halfW * MITRE + 0.15),
    drop: (((k % 2) + 2) % 2) * SHINGLE,
    // The box runs a little past both of its own ends, so a climb given for the chord has to
    // be stretched over the box to keep the same gradient — or every bay would be a shade
    // flatter than the one it has to meet, and the joints would step again.
    riseOf: (climb: number) => (climb * (chord + 2 * (halfW * MITRE + 0.15))) / chord,
  };
}

/**
 * Whether a carriageway other than this road runs over a point: a street, or a second main road.
 *
 * What a bridge may not do is wall another road off. Over the water this is false everywhere and
 * the deck gets its parapets as before; it is only the approach ramps, which come down to the
 * bank at grade and can cross anything on the way, that ever answer true.
 */
function crossedHere(axis: 0 | 1, line: number, x: number, z: number): boolean {
  if (onStretch(x, z)) return true;
  for (const st of arteryStations(x, z, ARTERY_HALF + ARTERY_MARGIN))
    if (st.axis !== axis || st.line !== line) return true;
  return false;
}

/**
 * The surface of whatever other road crosses this one at a point: a street, another main
 * road's bridge, or failing both the ground.
 *
 * The bridge matters. Two main roads can cross over the water, and where both their decks are
 * at the same height each one's parapets ran straight across the other's carriageway — the
 * other road being no street, the deck was compared with the riverbed twenty metres down.
 */
function crossedTop(axis: 0 | 1, line: number, x: number, z: number): number {
  let top = streetTopAt(x, z) ?? -Infinity;
  for (const st of arteryStations(x, z, ARTERY_HALF + ARTERY_MARGIN)) {
    if (st.axis === axis && st.line === line) continue;
    for (const c of crossings(st.axis, st.line, Math.floor(st.s / ARTERY)))
      if (st.s > c.a0 && st.s < c.a1) top = Math.max(top, spanY(st.axis, st.line, c, st.s));
  }
  return top === -Infinity ? terrainAt(x, z) : top;
}

/** Whether a pier standing at a point would be in another road's carriageway. */
function inOtherRoad(axis: 0 | 1, line: number, p: Vec2): boolean {
  for (const dx of [-3.4, 3.4]) for (const dz of [-3.4, 3.4])
    if (crossedHere(axis, line, p[0] + dx, p[1] + dz)) return true;
  return false;
}

/**
 * The surface of a road running right across this one at a station — seen just outside the
 * carriageway on both sides — or null where nothing does.
 */
function crossTop(axis: 0 | 1, line: number, s: number): number | null {
  const { p, dir } = arteryFrame(axis, line, s);
  let top = -Infinity;
  for (const side of [1, -1]) {
    const off = side * (ARTERY_HALF + 1.6);
    const x = p[0] - dir[1] * off, z = p[1] + dir[0] * off;
    if (!crossedHere(axis, line, x, z)) return null;
    top = Math.max(top, streetTopAt(x, z) ?? terrainAt(x, z));
  }
  return top;
}

/** One bridge: deck, parapets and piers, from station `s0` to `s1` along the road. */
/** Stations between the cross-sections of a deck sheet. */
const DECK_STEP = 3;

/**
 * A bridge's deck as one sheet of triangles, from the foot of one ramp to the foot of the
 * other: cross-sections every DECK_STEP metres along the road, each the deck surface at five
 * points across it (see `deckY`), joined into triangles that share every corner with the ones
 * either side. Carried down at both edges into the fascia, and closed underneath by the soffit.
 *
 * The deck used to be a row of boxes a bay long, each a plane of its own, set a few millimetres
 * apart so their overlaps would not flicker: the road over a river was a row of slabs, with a
 * step at every joint and one more where the last of them met the road at the foot.
 *
 * Each region lays the lengths whose middle is in it. The cross-sections fall on the same
 * stations whichever region asks, so the lengths either side of a seam share their corners.
 */
function deckSheet(
  b: Builder, axis: 0 | 1, line: number, c: Crossing, half: number, t: Tint, x0: number, z0: number,
): void {
  const DEPTH = 2.2;
  const across = [-half, -half / 2, 0, half / 2, half];
  const n = Math.max(1, Math.ceil((c.a1 - c.a0) / DECK_STEP));
  const section = (k: number) => {
    const s = c.a0 + ((c.a1 - c.a0) * k) / n;
    const { p, dir } = arteryFrame(axis, line, s);
    return across.map((o) => {
      const x = p[0] - dir[1] * o, z = p[1] + dir[0] * o;
      return [x, deckY(axis, line, c, s, x, z), z];
    });
  };
  // one triangle, wound to face along `want`, with its own normal
  const face = (A: number[], B: number[], C: number[], want: number[], mat: Mat, style: number) => {
    const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2];
    const vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-9) return;
    nx /= l; ny /= l; nz /= l;
    let Q = B, R = C;
    if (nx * want[0] + ny * want[1] + nz * want[2] < 0) {
      Q = C; R = B;
      nx = -nx; ny = -ny; nz = -nz;
    }
    const corner = (V: number[]) => [V[0], V[1], V[2], nx, ny, nz, V[0] + V[2], V[1]];
    b.tri([corner(A), corner(Q), corner(R)], mat, t, style);
  };
  const quad = (A: number[], B: number[], C: number[], D: number[], want: number[], mat: Mat, style = 0) => {
    face(A, B, C, want, mat, style);
    face(A, C, D, want, mat, style);
  };
  const down = (V: number[]) => [V[0], V[1] - DEPTH, V[2]];
  const last = across.length - 1, mid = last / 2;
  let prev = section(0);
  for (let k = 1; k <= n; k++) {
    const next = section(k);
    const mx = (prev[mid][0] + next[mid][0]) / 2, mz = (prev[mid][2] + next[mid][2]) / 2;
    if (mx >= x0 && mx < x0 + REGION && mz >= z0 && mz < z0 + REGION) {
      for (let i = 0; i < last; i++) quad(prev[i], prev[i + 1], next[i + 1], next[i], [0, 1, 0], Mat.Asphalt);
      for (const i of [0, last]) {
        // outward: from the middle of the section towards this edge
        const out = [prev[i][0] - prev[mid][0], 0, prev[i][2] - prev[mid][2]];
        quad(prev[i], next[i], down(next[i]), down(prev[i]), out, Mat.Board, Finish.Cast);
      }
      quad(down(prev[0]), down(prev[last]), down(next[last]), down(next[0]), [0, -1, 0], Mat.Board, Finish.Cast);
    }
    prev = next;
  }
}

function span(
  b: Builder, solid: Builder, axis: 0 | 1, line: number, c: Crossing, t: Tint, x0: number, z0: number,
): void {
  const { s0, s1, deck } = c;
  const HALF = ARTERY_HALF + 2;
  const STEP = 9;
  deckSheet(b, axis, line, c, HALF, t, x0, z0);
  for (let s = c.a0; s < c.a1; s += STEP) {
    const { p, dir, turn, len, riseOf } = bayOf(axis, line, s, s + STEP, HALF);
    // Only the part of the bridge this region owns, on a half-open square with no slack in
    // it. The test used to allow eight metres either side, which is not a boundary but an
    // overlap: every bay within eight metres of a seam was built by the region on each side
    // of it, twice, in the same place — two identical faces with nothing to choose between
    // them, which is the blinking along a deck near a seam.
    if (p[0] < x0 || p[0] >= x0 + REGION || p[1] < z0 || p[1] >= z0 + REGION) continue;
    // The deck takes the line the traffic rides, which over the level crossing is the deck's
    // own height and over either ramp is the climb up to it from the bank. Built flat at the
    // deck's height the whole way, as it was, the ramps stood at full height over ground the
    // road was still down on — so a car crossing them drove up through the underside of the
    // bridge and out of its surface, which is the deck being in two places at once.
    // Heights at either end of the bay, `off` to the side: the deck surface itself (see
    // `deckY`), which on a ramp is not level across.
    const ends = (off: number) => {
      const at = (q: number) => {
        const f = arteryFrame(axis, line, q);
        return deckY(axis, line, c, q, f.p[0] - f.dir[1] * off, f.p[1] + f.dir[0] * off);
      };
      return [at(s), at(s + STEP)];
    };
    const put = (bb: Builder, halfW: number, y0: number, y1: number, off: number, rise: number, mat: Mat, style = 0, opts = {}) => {
      const cx = p[0] - dir[1] * off, cz = p[1] + dir[0] * off;
      bb.box(cx - len / 2, y0, cz - halfW, cx + len / 2, y1, cz + halfW, mat, t, style, { turn, rise, ...opts });
    };
    // The deck is drawn as one sheet (see `deckSheet`); what stands for it in collision is a
    // box a bay long, never drawn, up to the highest the sheet reaches across it.
    const [ya, yb] = ends(0);
    let top = 0;
    for (const o of [-HALF, HALF]) {
      const [ea, eb] = ends(o);
      top = Math.max(top, ea - ya, eb - yb);
    }
    const mid = (ya + yb) / 2;
    put(solid, HALF, mid - 2.2, mid + top, 0, riseOf(yb - ya), Mat.Board, Finish.Cast, { detail: false, hidden: true });
    // Parapets, except where another road crosses the deck. A bridge's approach ramp comes down
    // to the bank at grade, and on the way it can run straight across a second main road — and
    // then its parapet is a metre of panel standing right across that road's carriageway. The
    // traffic drove through it, because the traffic does not collide with the city; anybody
    // driving it themselves met a concrete block across the road with no way round. The deck is
    // left where it is and the two roads simply cross on it. Only at grade, though: where the
    // deck has been carried up over the street (see `UNDER`) the street is underneath, and the
    // parapet stays.
    for (const side of [1, -1] as const) {
      const off = side * (HALF - 0.4);
      const cx = p[0] - dir[1] * off, cz = p[1] + dir[0] * off;
      const [ea, eb] = ends(off);
      if (crossedHere(axis, line, cx, cz) && (ea + eb) / 2 - crossedTop(axis, line, cx, cz) < UNDER - 1) continue;
      put(b, 0.4, (ea + eb) / 2, (ea + eb) / 2 + 1.15, off, riseOf(eb - ea), Mat.Panel);
    }
  }
  const pier = (s: number, top: number) => {
    const { p } = arteryFrame(axis, line, s);
    if (p[0] < x0 || p[0] >= x0 + REGION || p[1] < z0 || p[1] >= z0 + REGION) return;
    const foot = groundAt(p[0], p[1]);
    b.box(p[0] - 3.4, foot - 3, p[1] - 3.4, p[0] + 3.4, top, p[1] + 3.4, Mat.Board, t, Finish.Ribbed, { detail: false });
  };
  // piers, standing in the water — not on the quay, which is the walk that passes under
  const piers = Math.max(1, Math.round((s1 - s0) / 46));
  for (let k = 1; k < piers; k++) {
    const s = s0 + ((s1 - s0) * k) / piers;
    const { p } = arteryFrame(axis, line, s);
    const r = riverNear(p[0], p[1], RIVER_HALF + 10);
    // never in another road: where two main roads cross over the water, the other one's deck
    if (r && r.dist < RIVER_HALF - 5 && !inOtherRoad(axis, line, p)) pier(s, deck - 2.2);
  }
  // and on land, under the deck where it is carried high over the bank — but never in a road,
  // which is the whole reason it is up there
  for (const [from, to] of [[c.a0, s0], [s1, c.a1]]) {
    for (let s = from + 15; s < to - 10; s += 30) {
      const { p } = arteryFrame(axis, line, s);
      const top = spanY(axis, line, c, s) - 2.2;
      if (top - groundAt(p[0], p[1]) < 3) continue;
      let clear = true;
      for (const dx of [-5, 0, 5]) for (const dz of [-5, 0, 5]) if (roadTopAt(p[0] + dx, p[1] + dz) !== null) clear = false;
      if (clear) pier(s, top);
    }
  }
}

/** Arterials that carry an elevated railway above them. */
/**
 * A railway's deck is built in level bays, and this is the grid they are laid out on. Every
 * region builds the bays of the same grid, or two of them would lay overlapping decks across
 * the seam between them.
 */
const RAIL_BAY = 10;
/** Clearance of the railway over the ground it is built off. */
const RAIL_RISE = 27;
/**
 * How far along the line the ground is averaged to get the railway's height.
 *
 * This is the whole difference between a viaduct and a row of platforms. Read the ground
 * under each bay on its own and the deck does whatever the ground does: over the river it
 * follows the bed down, so a run of bays sat twenty metres below their neighbours with open
 * air between them, and the train — reading the same ground, but smoothly — hopped from one
 * to the next. Averaged over most of a kilometre instead, the deck ignores the gorge it
 * crosses and the piers under it grow to suit, which is what a viaduct actually does.
 */
const RAIL_SMOOTH = 700;

const railCache = rememberBySeed<string, number>();

/**
 * The level of one bay of an elevated railway's deck.
 *
 * Two passes: the long average of the ground along the line, then a short average of that
 * over the neighbouring bays, which takes the corners off where the window's own ends move
 * on and off a slope. What comes out climbs at most half a metre from one bay to the next,
 * so the deck — two metres deep — always overlaps its neighbour and the viaduct stays in one
 * piece however steep the hill under it.
 */
function railDeck(axis: 0 | 1, line: number, k: number): number {
  const key = `${axis},${line},${k}`;
  checkSeed();
  const hit = railCache.get(key);
  if (hit !== undefined) return hit;
  let sum = 0, n = 0;
  for (let d = -RAIL_SMOOTH; d <= RAIL_SMOOTH; d += 35) {
    const w = 1 - Math.abs(d) / (RAIL_SMOOTH + 35);
    const p = arteryFrame(axis, line, (k + 0.5) * RAIL_BAY + d).p;
    sum += rideY(p[0], p[1]) * w;
    n += w;
  }
  // Never lower than the clearance over any road under the bays it is smoothed with (see
  // `railLevel`), so that the smoothing can only lift the deck off it, never bring it back down.
  let clear = -Infinity;
  for (let j = k - RAIL_EASE - 2; j <= k + RAIL_EASE + 2; j++) clear = Math.max(clear, railClear(axis, line, j));
  const y = Math.max(sum / n + RAIL_RISE, clear);
  if (railCache.size > 4096) railCache.clear();
  railCache.set(key, y);
  return y;
}

const railClearCache = rememberBySeed<string, number>();

/**
 * The lowest the deck of bay `k` may be: the highest road surface anywhere under it — a street,
 * a main road, or another road's bridge — plus a lorry's headroom and the depth of a deck.
 *
 * The railway takes its height from the ground averaged along its line, and that is all it
 * used to look at. Down a river valley the average is the riverbed, so the viaduct came across
 * the valley at the height of the bridges over it and ran straight through the deck of one,
 * at windscreen height, wall to wall across the carriageway. A train goes over a bridge.
 */
function railClear(axis: 0 | 1, line: number, k: number): number {
  const key = `${axis},${line},${k}`;
  checkSeed();
  const hit = railClearCache.get(key);
  if (hit !== undefined) return hit;
  let top = -Infinity;
  for (const u of [0, 0.5, 1]) {
    const f = arteryFrame(axis, line, (k + u) * RAIL_BAY);
    for (const off of [-RAIL_REACH, 0, RAIL_REACH]) {
      const y = rideAt(f.p[0] - f.dir[1] * off, f.p[1] + f.dir[0] * off, 1e6);
      if (y !== null) top = Math.max(top, y);
    }
  }
  const clear = top + UNDER;
  if (railClearCache.size > 8192) railClearCache.clear();
  railClearCache.set(key, clear);
  return clear;
}

/** Half the width of the railway's deck, with a margin: how far to either side it looks down. */
const RAIL_REACH = 6.5;
/** Bays either side a bay's level is smoothed over; see `railLevel`. */
const RAIL_EASE = 6;

/** Which bay of the deck a station falls in. */
function railBayAt(s: number): number {
  return Math.floor(s / RAIL_BAY);
}

/** The level of bay `k` with the corners taken off, which is what actually gets built. */
function railLevel(axis: 0 | 1, line: number, k: number): number {
  const SPAN = RAIL_EASE;
  let sum = 0, n = 0;
  for (let d = -SPAN; d <= SPAN; d++) {
    const w = 1 - Math.abs(d) / (SPAN + 1);
    sum += railDeck(axis, line, k + d) * w;
    n += w;
  }
  return sum / n;
}

/**
 * Height of the deck at a joint between two bays — the level the two of them meet at.
 *
 * Both bay levels are already long averages of the ground, so the mean of the two is smooth
 * as well, and every bay taking its two ends from here means consecutive bays share a height
 * at the station they share. That is what makes the viaduct one surface.
 */
function railNode(axis: 0 | 1, line: number, k: number): number {
  return (railLevel(axis, line, k - 1) + railLevel(axis, line, k)) / 2;
}

/**
 * Top of an elevated railway's deck at a station along its line.
 *
 * A bay is a plane between its two joints, not a level platform, so this is the line up the
 * middle of it. Levelling each bay and letting the train read the bay it stood on is what had
 * it hopping from one platform to the next: half a metre at every joint, ten metres apart,
 * with the deck doing the same. Sloping the bays means the train and the deck are the same
 * line and neither of them steps.
 */
export function railY(axis: 0 | 1, line: number, s: number): number {
  const k = railBayAt(s);
  const t = s / RAIL_BAY - k;
  return railNode(axis, line, k) * (1 - t) + railNode(axis, line, k + 1) * t;
}


/**
 * An elevated railway, carried on piers above an arterial.
 *
 * Running it over a road rather than on its own line is what keeps it out of the buildings:
 * the roadway is the one strip of the city guaranteed to be clear all the way up. It crosses
 * everything else — side streets, other arterials, the river — on the way, which is where the
 * overpasses come from without having to look for them.
 */
function rails(b: Builder, x0: number, z0: number): void {
  const t: Tint = [0.72, 0.71, 0.69];
  const steel: Tint = [0.32, 0.33, 0.34];
  const pad = 200;
  for (const axis of [0, 1] as const) {
    const across = axis === 0 ? z0 + REGION / 2 : x0 + REGION / 2;
    for (const line of arteryLines(across, REGION / 2 + pad)) {
      if (!hasRail(axis, line)) continue;
      const from = (axis === 0 ? x0 : z0) - pad, to = (axis === 0 ? x0 + REGION : z0 + REGION) + pad;
      const HALF = 5.2, DEEP = 1.9;
      for (let k = railBayAt(from); k <= railBayAt(to); k++) {
        const { p, dir, turn, len, drop, riseOf } = bayOf(axis, line, k * RAIL_BAY, (k + 1) * RAIL_BAY, HALF);
        if (p[0] < x0 || p[0] >= x0 + REGION || p[1] < z0 || p[1] >= z0 + REGION) continue;
        // A bay is the plane between its two joints. Levelling it and dropping its underside to
        // meet whichever neighbour sat lowest closed the gaps, but left the line a row of
        // platforms at their own heights with a step at every joint — which is what the train
        // was hopping up. Sharing the joint height and sloping between them is one structure:
        // deck, upstands, rails and soffit all carry the same gradient.
        const ya = railNode(axis, line, k), yb = railNode(axis, line, k + 1);
        const y = (ya + yb) / 2, rise = riseOf(yb - ya);
        const put = (halfW: number, y0: number, y1: number, off: number, mat: Mat, tn: Tint, style = 0) => {
          const cx = p[0] - dir[1] * off, cz = p[1] + dir[0] * off;
          b.box(cx - len / 2, y0 - drop, cz - halfW, cx + len / 2, y1 - drop, cz + halfW, mat, tn, style,
            { turn, rise, detail: false });
        };
        put(HALF, y - DEEP, y, 0, Mat.Board, t, Finish.Cast); // deck
        // upstands, except along a station, where the platforms stand out past the deck instead
        if (!inRailStation(axis, line, (k + 0.5) * RAIL_BAY)) {
          put(0.3, y, y + 0.9, 4.9, Mat.Panel, t);
          put(0.3, y, y + 0.9, -4.9, Mat.Panel, t);
        }
        for (const off of [-2.6, -1.1, 1.1, 2.6]) put(0.09, y, y + 0.16, off, Mat.Metal, steel); // rails
        // A portal every third bay: a column either side of the road, clear of the kerb, and a
        // crossbeam under the deck between them. This used to be a single pier on the arterial's
        // own centreline — a three-metre block of concrete standing in the middle of a
        // thirty-five-metre carriageway. The traffic keeps to its lanes and never met one;
        // anybody driving the road themselves met one every thirty metres at speed, which is
        // most of what made a road with a railway over it undriveable.
        if (((k % 3) + 3) % 3 === 0) {
          const off = ARTERY_HALF + 2.2; // beyond the widest carriageway that can run under it
          const beam = y - DEEP - 1.1;
          const feet = ([1, -1] as const).map(
            (side) => [p[0] - dir[1] * off * side, p[1] + dir[0] * off * side] as const,
          );
          // Not where another road crosses. Clear of this arterial is not clear of everything: a
          // side street's slab runs past its own end to fill the junction, and where two main
          // roads cross, a foot set beyond the kerb of one stands in the middle of the other — and
          // a column in a road is the pier in the middle of the arterial again, moved twenty
          // metres sideways. Asked of the roads' own lines, because a main road with no blocks
          // along it is laid as fill and has no stretches for `roadTopAt` to find. The bays either
          // side carry the deck over the gap.
          if (feet.every(([cx, cz]) => !crossedHere(axis, line, cx, cz))) {
            for (const [cx, cz] of feet) {
              b.box(cx - 1.5, groundAt(cx, cz) - 3, cz - 1.5, cx + 1.5, beam, cz + 1.5,
                Mat.Board, t, Finish.Ribbed, { detail: false });
            }
            // square across the road, so it reads as one frame with the two columns
            b.box(p[0] - off - 1.5, beam, p[1] - 1.2, p[0] + off + 1.5, y - DEEP, p[1] + 1.2,
              Mat.Board, t, Finish.Ribbed, { turn: turn + Math.PI / 2, detail: false });
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The subway
//
// A cut-and-cover box under an arterial, set deep enough that nothing the surface builds —
// the roadway slab, the ground tiles, an embankment — reaches down to it. That depth is the
// reason the rest of the city needs to know nothing about it: the one place the two meet is
// the hole in the pavement the entrance comes up through.
//
// The line runs on the same armature as the elevated railway and never on an arterial that
// already carries one: one road, one railway, above it or below it.

/** Centre of each running track, off the tunnel centreline. */
export const TRACK_OFF = 8.5;
/** Interior of the running tunnel: half-width, and track bed to soffit. */
const SUB_HALF = 11.4;
const SUB_RISE = 6.0;
const SUB_WALL = 0.9;
/** Island platform: half-width, and how far it stands above the track bed. */
const PLAT_HALF = 6.5;
export const PLAT_RISE = 1.1;
/** The mezzanine over the tracks: its floor above the track bed, and its headroom. */
const MEZZ = SUB_RISE + 0.8;
const MEZZ_RISE = 3.6;
/** Track bed below the lowest ground anywhere near the line. */
const SUB_DEPTH = 27;
/** Length of tunnel built in one go, and the span its level is interpolated over. */
const SUB_BAY = 30;
/**
 * The entrance: one straight flight from the street down to the mezzanine, running along the
 * kerb, with a chamber at its foot that the passage leaves from the side of.
 *
 * Narrow across, because the only ground beside an arterial that is neither carriageway nor
 * building is the block's own pavement, and that is seven metres wide. Long the other way,
 * along the kerb, because twenty metres of descent at a walkable pitch is thirty-odd metres of
 * stair. It used to fold that into a room-sized shaft as a dozen short flights doubling back
 * on each other, which from the top read as a lift shaft somebody had filled with steps.
 */
const SHAFT_X = 2.0;
/** Half-length of the chamber at the foot, which the passage leaves through its side. */
const FOOT = 4.6;
/** The landing at the top, which the street steps down onto. */
const LAND = 1.7;
/** Length of the hole in the pavement over the top of the flight, landing and all. */
const MOUTH = 11.2;
/** One step of the flight: how far it drops, and how far it goes. */
const STEP_RISE = 0.47;
const STEP_GOING = 0.75;
/**
 * Headroom over the nosings where the flight is roofed. Three metres and a bit is enough to
 * walk under and read as a crawl down into a tomb from the top of the stair; a station
 * entrance is a public hall, and this is the height of one.
 */
const HEAD = 4.4;
/** How far the surround stands out round the cut, to face the ragged edge the tiles leave. */
const SURROUND = TILE + 1.2;

/** Length of the flight that takes `drop` metres. */
function flightRun(drop: number): number {
  return Math.max(1, Math.round(drop / STEP_RISE)) * STEP_GOING;
}


/**
 * Track bed level at a node of the line.
 *
 * Taken from the lowest ground across the corridor rather than from the road on the
 * centreline: a road on an embankment stands metres above the dip beside it, and it is the
 * dip whose ground tiles reach furthest down. A bridge is ignored — a tunnel does not follow
 * a road up over a river — but an embankment is not, or the line would surface inside it.
 */
const subNodes = rememberBySeed<string, number>();

/** The level the ground alone asks for at a point on the line. */
function rawLevel(axis: 0 | 1, line: number, s: number): number {
  const { p, dir } = arteryFrame(axis, line, s);
  let low = Infinity;
  for (const off of [0, -40, -20, 20, 40]) {
    const x = p[0] - dir[1] * off, z = p[1] + dir[0] * off;
    const g = terrainAt(x, z);
    const road = off === 0 ? roadTopAt(x, z) : null;
    low = Math.min(low, road === null ? g : Math.max(g, Math.min(road, g + 10)));
  }
  return low - SUB_DEPTH;
}

/** How many bays either side of a station are laid dead level, as a platform has to be. */
const FLAT_BAYS = 2;
/** Nodes per station, so that every station falls exactly on one. */
const NODES_PER_STATION = SUB_SPACING / SUB_BAY;

function subNode(axis: 0 | 1, line: number, k: number): number {
  const key = `${axis},${line},${k}`;
  checkSeed();
  const hit = subNodes.get(key);
  if (hit !== undefined) return hit;
  // A station is level — a platform on a gradient is not a platform — so every node inside
  // one takes the station's own level, and the bays on either side ramp up to whatever the
  // ground is doing next. Which is why a station sits exactly on a node: the flat stretch
  // and the boxes laid over it have to agree on where they begin and end.
  const j = Math.round(k / NODES_PER_STATION);
  let y = rawLevel(axis, line, k * SUB_BAY);
  for (const n of [j - 1, j, j + 1]) {
    const st = stationAt(axis, line, n);
    if (st && Math.abs(k - st.node) <= FLAT_BAYS) y = st.y;
  }
  if (subNodes.size > 4096) subNodes.clear();
  subNodes.set(key, y);
  return y;
}

/**
 * Track bed level anywhere along a line.
 *
 * A smooth curve through the nodes rather than straight lines between them. Straight, the
 * gradient changed at every node, and a train running over thirty-metre chords of a hill
 * pitched at each one like a car going over a kerb. The slope at a node is the harmonic mean
 * of the two either side — and nothing where they disagree in sign or one of them is level —
 * so the curve never overshoots a node, and a station's flat stretch stays dead flat.
 */
export function subwayY(axis: 0 | 1, line: number, s: number): number {
  const k = Math.floor(s / SUB_BAY);
  const t = s / SUB_BAY - k;
  const y0 = subNode(axis, line, k - 1), y1 = subNode(axis, line, k);
  const y2 = subNode(axis, line, k + 1), y3 = subNode(axis, line, k + 2);
  const slope = (a: number, b: number) => (a * b <= 0 ? 0 : (2 * a * b) / (a + b));
  const m1 = slope(y1 - y0, y2 - y1), m2 = slope(y2 - y1, y3 - y2);
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * y1 + (t3 - 2 * t2 + t) * m1 + (3 * t2 - 2 * t3) * y2 + (t3 - t2) * m2;
}

export interface Station {
  axis: 0 | 1;
  line: number;
  /** Which station along the line. */
  k: number;
  /** Where it ended up on the spline, and the node that is — always a whole one. */
  s: number;
  node: number;
  /** Centre of the platform. */
  x: number;
  z: number;
  /** Track bed level; the platform stands `PLAT_RISE` above it. */
  y: number;
  /** Yaw of the line here, in the direction of rising `s`. */
  yaw: number;
  /** Centre of the chamber at the foot of the entrance stair, and the ground it opens onto. */
  shaftX: number;
  shaftZ: number;
  top: number;
  /**
   * Which way along the line the stair climbs from the foot to the street (+1 is rising `s`),
   * and how far from the foot's centre the opening ends.
   */
  lean: 1 | -1;
  reach: number;
  /**
   * The street over the roofed run, in equal lengths from the far end of the surround to the
   * edge of the hole: the level each is laid at.
   */
  deck: number[];
  /** Middle of the opening in the pavement, which is what the map marks. */
  mouthX: number;
  mouthZ: number;
  /** Which side of the line the entrance stands on, and how far out. */
  side: 1 | -1;
  off: number;
  name: string;
}

const STATION_HEAD = [
  "Ash", "Carrow", "Kiln", "Marl", "Brand", "Colt", "Fen", "Garrow", "Hale", "Ingle",
  "Lime", "Mere", "Nether", "Ock", "Pike", "Quarry", "Rood", "Slate", "Tarn", "Vale",
  "Warp", "Yarrow", "Bourne", "Clay", "Dray", "Elder", "Flint", "Gaunt",
];
const STATION_TAIL = [
  "Street", "Cross", "Gate", "Wharf", "Yard", "Row", "Green", "Hill", "Quay", "Bridge",
  "Works", "Sidings", "Fields", "Reach", "Bank", "End",
];

/**
 * Where an entrance can stand.
 *
 * Not much choice: the carriageway runs out to `ARTERY_HALF` and the blocks are clipped back
 * to exactly that, so the one strip of ground left is the pavement between a block's kerb
 * and its building line. The opening is cut to fit it, and the search works outwards from
 * the kerb on either side until it finds a stretch clear of the building, clear of any road
 * slab, clear of the river and flat enough to walk off.
 */
function shaftSpot(axis: 0 | 1, line: number, s: number): { x: number; z: number; side: 1 | -1; off: number; top: number; lean: 1 | -1; reach: number; deck: number[] } | null {
  const { p, dir } = arteryFrame(axis, line, s);
  // Every block that could cover any of this search's candidates, gathered once. They all lie
  // within a few tens of metres of the same point on the line, so they are all answered by the
  // same handful of blocks — and gathering those is a walk over every seed within two slots,
  // which used to happen afresh for each of the hundred-odd points asked about. The opening
  // runs fifty metres along the kerb, so the net reaches that far either way.
  const REACH = 96;
  const near = blocksIn(p[0] - REACH, p[1] - REACH, p[0] + REACH, p[1] + REACH);
  // One look for the water, for the same reason: if the nearest river is further off than the
  // clearance plus the reach of the search, then no candidate in it is near one either.
  const WET = RIVER_HALF + QUAY + 14;
  const wet = !!riverNear(p[0], p[1], WET + REACH);
  // This used to ask `roadTopAt` first, which was both the dearest question here and a
  // redundant one: `openGround` ends by asking `underRoad`, which is the same question put to
  // a wider net of streets and with a margin on top, so anything the one turned down the other
  // turns down too. Cutting a street into stretches walks the terrain under it, and the search
  // was paying for that over every point it looked at — two thirds of what a station cost.
  const clear = (px: number, pz: number) =>
    (!wet || !riverNear(px, pz, WET)) && openGround(px, pz, near);
  const mezz = rawLevel(axis, line, s) + MEZZ;
  // Clear of the arterial itself: its carriageway is laid out to ARTERY_HALF and filled as a
  // six-metre slab, and that fill is not a street piece, so nothing above would report it.
  for (const off of [24, 27, 30, 34, 38, 42, 46]) {
    for (const side of [1, -1] as const) {
      const x = p[0] - dir[1] * off * side, z = p[1] + dir[0] * off * side;
      // the spline test first: it asks nothing of the Voronoi, and it turns down the most
      if (crossedByArtery(axis, line, x, z) || !clear(x, z)) continue;
      for (const lean of [1, -1] as const) {
        /** A point `u` along the stair from the foot towards the street and `w` across it. */
        const at = (u: number, w: number): Vec2 => [
          x - dir[1] * w * side + dir[0] * u * lean, z + dir[0] * w * side + dir[1] * u * lean,
        ];
        // How long the flight is depends on how far down it goes, which depends on the ground
        // at the top of it, which depends on how long it is: guessed from the ground at the foot,
        // then once more from the ground where that guess put the top.
        let reach = FOOT + flightRun(groundAt(x, z) + 0.5 - mezz) + LAND;
        reach = FOOT + flightRun(groundAt(...at(reach - MOUTH / 2, 0)) + 0.5 - mezz) + LAND;
        const edge = reach - MOUTH - 0.6;
        // The hole, its parapets and the landing: one level, laid at the highest ground it
        // meets, so the step off it has to stay inside what a runner can walk — and that makes
        // every one of those steps a step down.
        let ok = true, lo = Infinity, hi = -Infinity;
        for (let i = 0; i <= 3 && ok; i++) {
          const u = edge - 0.4 + (i / 3) * (reach - edge + 0.8);
          for (const a of [-1, 1]) {
            const [px, pz] = at(u, a * (SHAFT_X + 0.4));
            if (!clear(px, pz)) { ok = false; break; }
            const h = groundAt(px, pz);
            lo = Math.min(lo, h);
            hi = Math.max(hi, h);
          }
        }
        if (!ok || hi - lo > 0.5) continue;
        const top = hi;
        // the flight was sized from a guess at this; it must not have come out steeper
        if (top - mezz > ((reach - LAND - FOOT) / STEP_GOING) * STEP_RISE + 0.01) continue;
        // The roofed run behind it, from the far end of the surround to the edge of the hole.
        // All of it is open ground — every metre is cut out of the ground down to the stair —
        // but not one level: the lid over it is laid in lengths, each at the ground it meets.
        const u0 = -FOOT - SURROUND, n = Math.ceil((edge - u0) / 5), du = (edge - u0) / n;
        const ends: number[] = [];
        for (let i = 0; i <= n && ok; i++) {
          let h = -Infinity;
          for (const a of [-1, 1]) {
            const [px, pz] = at(u0 + i * du, a * (SHAFT_X + 0.4));
            if (!clear(px, pz)) { ok = false; break; }
            h = Math.max(h, groundAt(px, pz));
          }
          ends.push(h);
        }
        if (!ok) continue;
        const deck = ends.slice(1).map((h, j) => Math.max(h, ends[j]));
        const pitch = (top - mezz) / (reach - LAND - FOOT);
        for (let j = 0; j < n && ok; j++) {
          // a walkable step onto the next length, and onto the forecourt from the last
          if (Math.abs(deck[j] - (j + 1 < n ? deck[j + 1] : top)) > 0.5) ok = false;
          // and the lid has to stay clear of the ceiling over the flight under it
          const u = Math.min(u0 + (j + 1) * du, edge);
          if (deck[j] - 0.6 < mezz + Math.max(0, u - FOOT) * pitch + HEAD + 0.6) ok = false;
        }
        if (ok) return { x, z, side, off, top, lean, reach, deck };
      }
    }
  }
  return null;
}

const stations = rememberBySeed<string, Station | null>();
const sites = rememberBySeed<string, Station | null>();

/**
 * Closest two stations on a line may stand. Each one slides up to five bays to find an
 * entrance, so two neighbours sliding towards each other used to end up a stone's throw
 * apart — two halls with a few metres of tube between them.
 */
const STATION_GAP = 220;

/**
 * Station `k` along a line, or null where no entrance to it would fit anywhere.
 *
 * One cache, one object. The level of the line has to know which stretches are stations
 * before it can lay them flat, and for a while that was a second cache holding a second
 * view of the same search — which is two things that can fall out of step, and did.
 * Nothing here asks what level the line is at, so this and `subNode` are not circular.
 *
 * Where two neighbours came out too close, the odd one gives way. Its own neighbours are both
 * even, so the question never chains: no station's fate hangs on one further off than the next.
 */
export function stationAt(axis: 0 | 1, line: number, k: number): Station | null {
  if (!hasSubway(axis, line)) return null;
  const key = `${axis},${line},${k}`;
  checkSeed();
  const hit = stations.get(key);
  if (hit !== undefined) return hit;
  let out = stationSite(axis, line, k);
  if (out && k & 1) {
    const s = out.s;
    for (const n of [k - 1, k + 1]) {
      const other = stationSite(axis, line, n);
      if (other && Math.abs(other.s - s) < STATION_GAP) out = null;
    }
  }
  if (stations.size > 2048) stations.clear();
  stations.set(key, out);
  return out;
}

/** Where station `k` would stand if it had the line to itself. */
function stationSite(axis: 0 | 1, line: number, k: number): Station | null {
  const key = `${axis},${line},${k}`;
  const hit = sites.get(key);
  if (hit !== undefined) return hit;
  let out: Station | null = null;
  // A station can slide along the line to find an entrance, by whole bays so that it still
  // begins and ends on a node. Nearest to where it belongs first.
  //
  // It slides a long way — a third of the way to the next stop either side. Blocks are clipped
  // back to the carriageway and an entrance has to stand clear of both, so the only ground it
  // can come up on is where a side street or a gap between blocks meets the arterial, and
  // those are tens of metres apart. Searching two bays either way found one slot in three and
  // left whole lines with no way into them at all, which on the map reads as a subway nobody
  // can get on.
  const slide = [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5].map((n) => n * SUB_BAY);
  for (const shift of slide) {
    const s = k * SUB_SPACING + shift;
    const spot = shaftSpot(axis, line, s);
    if (!spot) continue;
    const { p, dir } = arteryFrame(axis, line, s);
    const h = hashInt(axis, line, k, 362);
    out = {
      axis, line, k, s, node: Math.round(s / SUB_BAY), x: p[0], z: p[1],
      y: rawLevel(axis, line, s),
      yaw: Math.atan2(dir[0], dir[1]),
      shaftX: spot.x, shaftZ: spot.z, top: spot.top,
      lean: spot.lean, reach: spot.reach, deck: spot.deck,
      mouthX: spot.x + dir[0] * spot.lean * (spot.reach - 4),
      mouthZ: spot.z + dir[1] * spot.lean * (spot.reach - 4),
      side: spot.side, off: spot.off,
      name: `${STATION_HEAD[h % STATION_HEAD.length]} ${STATION_TAIL[(h >>> 8) % STATION_TAIL.length]}`,
    };
    break;
  }
  if (sites.size > 2048) sites.clear();
  sites.set(key, out);
  return out;
}

/**
 * How far an arterial can be from the line it is named after.
 *
 * Its junctions wander up to a third of the lattice spacing, and the spline through them a
 * little more, so a road called line 0 can run a couple of hundred metres away from x = 0.
 * Asking `arteryLines` for a tight radius therefore misses roads that are right on top of
 * you — which, when the caller was the one deciding whether to leave the ground out for an
 * entrance, left stations sealed under the pavement.
 */
const WANDER = ARTERY * 0.4;

/** Every station whose platform lies within `r` of a point. */
export function stationsNear(x: number, z: number, r: number): Station[] {
  const out: Station[] = [];
  for (const axis of [0, 1] as const) {
    const across = axis === 0 ? z : x, along = axis === 0 ? x : z;
    for (const line of arteryLines(across, r + WANDER)) {
      if (!hasSubway(axis, line)) continue;
      for (let k = Math.floor((along - r - WANDER) / SUB_SPACING); k <= Math.ceil((along + r + WANDER) / SUB_SPACING); k++) {
        const st = stationAt(axis, line, k);
        if (st && Math.hypot(st.x - x, st.z - z) <= r) out.push(st);
      }
    }
  }
  return out;
}

/**
 * True where the ground has to be left out for an entrance.
 *
 * Each region lays its tiles from its own corner and the grids do not line up, so the hole a
 * region cuts is its own tiles' idea of the opening. Asking about the tile centre with the
 * opening grown by half a tile takes out every tile that overlaps it, and the surround built
 * round the shaft is thick enough to face whatever ragged edge that leaves.
 */
export function shaftCut(x: number, z: number): boolean {
  for (const st of stationsNear(x, z, 110)) if (inEntrance(st, x, z, TILE / 2)) return true;
  return false;
}

/** True where a point is within `pad` of a station's opening in the street. */
export function inEntrance(st: Station, x: number, z: number, pad: number): boolean {
  const c = Math.cos(st.yaw), sn = Math.sin(st.yaw);
  const dx = x - st.shaftX, dz = z - st.shaftZ;
  const u = (dx * sn + dz * c) * st.lean;
  return u > -FOOT - pad && u < st.reach + pad && Math.abs(dx * c - dz * sn) < SHAFT_X + pad;
}

/**
 * The way down into a station, for anyone walking it: x, y, z from the pavement off the end of
 * the opening, down the flight to the chamber at its foot, along the passage to the concourse
 * and down the stair in the well, to the platform just past its foot. With it, a point on the
 * platform `m` metres along the line from the middle of the station and `off` across it,
 * how far the platform runs either way, and where the stair from the concourse comes down.
 */
export function stationWay(st: Station): {
  way: Vec3[]; platform: (m: number, off: number) => Vec3; hall: number; well: [number, number]; half: number;
} {
  const mezz = st.y + MEZZ, plat = st.y + PLAT_RISE, end = st.reach;
  // the same frames `station` builds in: the entrance's, with +x towards the line and the stair
  // climbing along `lean`, and the line's own, with +z along it
  const frame = (x: number, z: number, yaw: number) => {
    const a = yawStep(-yaw) * YAW_STEP, cs = Math.cos(a), sn = Math.sin(a);
    return (lx: number, lz: number, y: number): Vec3 => [x + lx * cs - lz * sn, y, z + lx * sn + lz * cs];
  };
  const E = frame(st.shaftX, st.shaftZ, st.yaw), L = frame(st.x, st.z, st.yaw);
  const at = (lx: number, u: number, y: number) => E(lx, st.lean * u, y);
  const scale = arteryScale(st.axis, st.line, st.s);
  const platform = (m: number, off: number): Vec3 => {
    const { p, dir } = arteryFrame(st.axis, st.line, st.s + m / scale);
    return [p[0] - dir[1] * off, plat, p[1] + dir[0] * off];
  };
  const street = at(0, end + SURROUND + 1.5, st.top);
  street[1] = paveAt(street[0], street[2]);
  return {
    way: [
      street, at(0, end + 0.6, st.top), at(0, end - LAND, st.top), at(0, FOOT, mezz), at(0, 0, mezz),
      L(0, 0, mezz), L(0, -4, mezz), L(0, -WELL - 4, plat), L(0, -WELL - 6.5, plat),
    ],
    platform,
    hall: FLAT_BAYS * SUB_BAY * scale - 0.3,
    well: [-WELL - 4, -4],
    half: PASS_HALF,
  };
}

/** The well the stair comes down through, over the middle of the platform. */
const WELL = 12;
/** Half-width of the passage from the entrance to the well. */
const PASS_HALF = 3.4;

/**
 * The station whose mezzanine has taken over the roof of this bay, if any.
 *
 * A bay is roofed when both of its nodes are inside a station's flat stretch — which is the
 * same test the level uses, so the flat concrete and the boxes laid on it begin and end
 * together instead of a bay apart.
 */
function roofedBy(axis: 0 | 1, line: number, k: number): Station | null {
  const j = Math.round(k / NODES_PER_STATION);
  for (const n of [j - 1, j, j + 1]) {
    const st = stationAt(axis, line, n);
    if (st && k >= st.node - FLAT_BAYS && k <= st.node + FLAT_BAYS - 1) return st;
  }
  return null;
}

const CONCRETE: Tint = [0.79, 0.78, 0.75];
const TILED: Tint = [0.93, 0.93, 0.9];
const STEEL: Tint = [0.32, 0.33, 0.34];

/**
 * The subway: running tunnel, and at each station a platform, the mezzanine over the tracks
 * and the shaft up to the street.
 */
function subway(b: Builder, x0: number, z0: number): Station[] {
  const own: Station[] = [];
  // How far past the region to look for bays and stations that land in it. A station on the
  // spline is not a coordinate along the axis — where the road wanders the two drift a couple
  // of hundred metres apart — and the hundred and forty this used to be left stretches of
  // tunnel that no region thought were its own: a tube that stopped short of the station, and
  // daylight beyond.
  const pad = 140 + WANDER;
  for (const axis of [0, 1] as const) {
    const across = axis === 0 ? z0 + REGION / 2 : x0 + REGION / 2;
    for (const line of arteryLines(across, REGION / 2 + pad)) {
      if (!hasSubway(axis, line)) continue;
      const from = (axis === 0 ? x0 : z0) - pad, to = (axis === 0 ? x0 + REGION : z0 + REGION) + pad;
      const mine = (p: Vec2) => p[0] >= x0 && p[0] < x0 + REGION && p[1] >= z0 && p[1] < z0 + REGION;
      for (let k = Math.floor(from / SUB_BAY); k <= Math.floor(to / SUB_BAY); k++) {
        const bay = bayOf(axis, line, k * SUB_BAY, (k + 1) * SUB_BAY, SUB_HALF + SUB_WALL);
        if (!mine(bay.p)) continue;
        tunnelBay(b, axis, line, k, bay);
      }
      for (let k = Math.floor(from / SUB_SPACING) - 1; k <= Math.floor(to / SUB_SPACING) + 1; k++) {
        const st = stationAt(axis, line, k);
        if (st && mine([st.x, st.z])) {
          station(b, st);
          own.push(st);
        }
      }
    }
  }
  return own;
}

/**
 * The running tunnels between stations: one bored tube to each track, which is what a train
 * leaves a station hall through — two round holes in its end wall.
 *
 * Radius, and the height of the axis over the track bed: a carriage is 3.1 m wide and stands
 * 4.5 m off the bed, and this clears it all round by a few tens of centimetres. The lowest part
 * of the circle is under the bed and is never laid.
 */
const TUBE_R = 2.9;
const TUBE_Y = 2.4;
const TUBE_SIDES = 16;
/** Lengths each bay of tube is laid in, so the tube follows the line round a bend. */
const TUBE_STEPS = 6;

/**
 * One triangle of a curved surface, wound to face the way its corners' normals point — so a
 * caller can lay a ring of them without caring which way round it is going.
 */
function smoothTri(b: Builder, A: number[], B: number[], C: number[], mat: Mat, tint: Tint, style = 0): void {
  const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2];
  const vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  if (Math.hypot(nx, ny, nz) < 1e-6) return;
  const want = nx * (A[3] + B[3] + C[3]) + ny * (A[4] + B[4] + C[4]) + nz * (A[5] + B[5] + C[5]);
  b.tri(want >= 0 ? [A, B, C] : [A, C, B], mat, tint, style);
}

/** A point of a cross-section: `w` across the line, `h` over the track bed, and its normal (nw, nh). */
type SectionPoint = [number, number, number, number];

/**
 * Sweeps a cross-section along one bay of the line, as one continuous surface: every point
 * rides the line's own curve and level, and each bay asks for the same section at its two ends
 * as its neighbours do, so there is no joint anywhere — no slab, no step, no gap.
 */
function sweep(b: Builder, axis: 0 | 1, line: number, s0: number, pts: SectionPoint[], mat: Mat, tint: Tint, style = 0): void {
  const across = (s: number) => {
    const { p, dir } = arteryFrame(axis, line, s);
    const y = subwayY(axis, line, s);
    const nx = -dir[1], nz = dir[0];
    let v = 0;
    return pts.map(([w, h, nw, nh], i) => {
      if (i > 0) v += Math.hypot(w - pts[i - 1][0], h - pts[i - 1][1]);
      return [p[0] + nx * w, y + h, p[1] + nz * w, nx * nw, nh, nz * nw, s, v];
    });
  };
  let a = across(s0);
  for (let i = 1; i <= TUBE_STEPS; i++) {
    const c = across(s0 + (i / TUBE_STEPS) * SUB_BAY);
    for (let j = 0; j + 1 < pts.length; j++) {
      smoothTri(b, a[j], a[j + 1], c[j + 1], mat, tint, style);
      smoothTri(b, a[j], c[j + 1], c[j], mat, tint, style);
    }
    a = c;
  }
}

/** The round of a tube centred `off` across the line, from `lo` to `hi` radians, at radius `r`. */
function arc(off: number, r: number, lo: number, hi: number, n: number): SectionPoint[] {
  const out: SectionPoint[] = [];
  for (let i = 0; i <= n; i++) {
    const a = lo + (i / n) * (hi - lo);
    out.push([off + r * Math.cos(a), TUBE_Y + r * Math.sin(a), -Math.cos(a), -Math.sin(a)]);
  }
  return out;
}

/** A run of tunnel: in a station hall the open box, between them the two tubes. */
function tunnelBay(b: Builder, axis: 0 | 1, line: number, k: number, bay: Bay): void {
  const { p, dir, turn, len, drop, riseOf } = bay;
  const ya = subNode(axis, line, k), yb = subNode(axis, line, k + 1);
  const y = (ya + yb) / 2, rise = riseOf(yb - ya);
  const put = (halfW: number, y0: number, y1: number, off: number, mat: Mat, tint: Tint, style = 0, collide = true) => {
    const cx = p[0] - dir[1] * off, cz = p[1] + dir[0] * off;
    b.box(cx - len / 2, y0 - drop, cz - halfW, cx + len / 2, y1 - drop, cz + halfW, mat, tint, style,
      { turn, rise, detail: false, collide });
  };
  // Over a station the mezzanine floor is the roof, and it is laid with the station; so is the
  // wall across each end of the hall, with the mouths of the tubes in it. A hall is dead level,
  // so boxes lie true in it.
  if (roofedBy(axis, line, k)) {
    const outer = SUB_HALF + SUB_WALL;
    put(outer, y - 1.2, y, 0, Mat.Board, CONCRETE, Finish.Cast); // invert
    put(SUB_WALL / 2, y, y + SUB_RISE, SUB_HALF + SUB_WALL / 2, Mat.Board, TILED, Finish.Cast);
    put(SUB_WALL / 2, y, y + SUB_RISE, -SUB_HALF - SUB_WALL / 2, Mat.Board, TILED, Finish.Cast);
    for (const off of [-TRACK_OFF - 0.72, -TRACK_OFF + 0.72, TRACK_OFF - 0.72, TRACK_OFF + 0.72]) {
      put(0.09, y, y + 0.16, off, Mat.Metal, STEEL);
    }
    return;
  }
  // Out in the tubes the line climbs and falls, and everything a train runs over is swept along
  // it as one surface, the way the roads are: laid as boxes, each bay was a straight slab on the
  // chord of the curve, and a train riding the curve sank into one and rose out of the next.
  // Nothing collides with any of it; nobody gets in here but the trains.
  const s0 = k * SUB_BAY;
  const lo = Math.asin(-(TUBE_Y + 0.05) / TUBE_R); // a few centimetres under the bed
  const crown = Math.PI / 2, lit = 0.2 / TUBE_R;
  for (const off of [-TRACK_OFF, TRACK_OFF]) {
    sweep(b, axis, line, s0, arc(off, TUBE_R, lo, Math.PI - lo, TUBE_SIDES), Mat.Board, CONCRETE, Finish.Cast);
    // the line of light along the crown, a few centimetres proud of it
    sweep(b, axis, line, s0, arc(off, TUBE_R - 0.04, crown - lit, crown + lit, 1), Mat.Strip, TILED);
    // A hair over the bed, because the hall's invert runs on a little past the end wall and
    // its top is the same plane.
    const W = Math.sqrt(TUBE_R * TUBE_R - (TUBE_Y + 0.05) ** 2);
    sweep(b, axis, line, s0, [[off - W, 0.01, 0, 1], [off + W, 0.01, 0, 1]], Mat.Board, CONCRETE, Finish.Cast);
    for (const c of [off - 0.72, off + 0.72]) {
      const l = c - 0.09, r = c + 0.09, top = 0.16;
      sweep(b, axis, line, s0, [[l, 0, -1, 0], [l, top, -1, 0]], Mat.Metal, STEEL);
      sweep(b, axis, line, s0, [[l, top, 0, 1], [r, top, 0, 1]], Mat.Metal, STEEL);
      sweep(b, axis, line, s0, [[r, top, 1, 0], [r, 0, 1, 0]], Mat.Metal, STEEL);
    }
  }
}

/**
 * The wall across one end of a station hall, at `s`, facing back into it along `face`
 * (+1 towards rising `s`): flat tiling from wall to wall and track bed to roof, with the
 * mouth of each tube cut out of it. Behind it, never drawn, a slab across the whole width
 * for the runner to walk into — the holes are for the trains.
 */
function hallEnd(b: Builder, axis: 0 | 1, line: number, s: number, y: number, face: 1 | -1): void {
  const { p, dir } = arteryFrame(axis, line, s);
  const nx = -dir[1], nz = dir[0];
  const fx = dir[0] * face, fz = dir[1] * face;
  /** A point on the wall `w` across the line and `h` over the track bed. */
  const at = (w: number, h: number) => [p[0] + nx * w, y + h, p[1] + nz * w, fx, 0, fz, w, h];
  for (const side of [1, -1]) {
    // Each half of the wall round its own hole, in local u measured out from the centreline.
    // Laid as rays from the middle of the hole: each one runs from the rim (or the bed, below
    // it) out to the edge of the wall, and two neighbours bound a strip. The corners are rays
    // of their own, or the strips would cut across them.
    const cu = TRACK_OFF, ch = TUBE_Y;
    const angles: number[] = [];
    for (let i = 0; i < TUBE_SIDES * 2; i++) angles.push((i / (TUBE_SIDES * 2)) * Math.PI * 2);
    for (const [u, h] of [[0, 0], [SUB_HALF, 0], [SUB_HALF, SUB_RISE], [0, SUB_RISE]]) {
      angles.push((Math.atan2(h - ch, u - cu) + Math.PI * 2) % (Math.PI * 2));
    }
    angles.sort((m, n) => m - n);
    const ray = (a: number) => {
      const dx = Math.cos(a), dy = Math.sin(a);
      const tu = dx > 1e-9 ? (SUB_HALF - cu) / dx : dx < -1e-9 ? -cu / dx : Infinity;
      const th = dy > 1e-9 ? (SUB_RISE - ch) / dy : dy < -1e-9 ? -ch / dy : Infinity;
      const t = Math.min(tu, th), r = Math.min(t, TUBE_R);
      return [at(side * (cu + dx * r), ch + dy * r), at(side * (cu + dx * t), ch + dy * t)];
    };
    for (let i = 0; i < angles.length; i++) {
      const [ia, oa] = ray(angles[i]), [ib, ob] = ray(angles[(i + 1) % angles.length]);
      smoothTri(b, ia, oa, ob, Mat.Board, TILED, Finish.Cast);
      smoothTri(b, ia, ob, ib, Mat.Board, TILED, Finish.Cast);
    }
  }
  const T = 0.5, cx = p[0] - fx * T / 2, cz = p[1] - fz * T / 2;
  b.box(cx - T / 2, y, cz - SUB_HALF, cx + T / 2, y + SUB_RISE, cz + SUB_HALF, Mat.Board, TILED, 0,
    { turn: Math.atan2(dir[1], dir[0]), detail: false, hidden: true });
}

/** Everything that makes a station: the platform, the roof over it, the passage and the shaft. */
function station(b: Builder, st: Station): void {
  const { axis, line } = st;
  const y = st.y, plat = y + PLAT_RISE, mezz = y + MEZZ;
  const outer = SUB_HALF + SUB_WALL;
  /** How many lengths of each run of boxes have been laid, to alternate them by. */
  const laid = new Map<string, number>();
  /** A box laid along the line, `off` to one side of it, from station a0 to a1. */
  const along = (a0: number, a1: number, halfW: number, y0: number, y1: number, off: number,
    mat: Mat, tint: Tint, style = 0, collide = true) => {
    const bay = bayOf(axis, line, a0, a1, halfW);
    const cx = bay.p[0] - bay.dir[1] * off, cz = bay.p[1] + bay.dir[0] * off;
    // Lengths laid end to end round a bend overlap in a wedge on the outside of it, and there
    // the floor of one and the floor of the next are the same plane, which flickers between
    // the two. Every other length is drawn in by a few millimetres so one of them always wins.
    const run = `${halfW},${off},${y0},${y1},${mat}`;
    const n = laid.get(run) ?? 0;
    laid.set(run, n + 1);
    const nudge = n & 1 ? 0.005 : 0;
    b.box(cx - bay.len / 2, y0 - bay.drop + nudge, cz - halfW, cx + bay.len / 2, y1 - bay.drop - nudge, cz + halfW,
      mat, tint, style, { turn: bay.turn, detail: false, collide });
  };

  // The roof the running bays left out, in lengths short enough to follow the spline, with
  // the well over the platform left open. The station's own level is taken as flat: over
  // eighty metres the line moves by a few centimetres, and a mezzanine is one floor.
  //
  // Everything here is set out in metres back along the line and turned into stations at the
  // end, because a station is not a metre: the spline is parameterised by how far along the
  // lattice it has come, so where the road wanders these are a third apart. The stair down the
  // well is laid in metres in the line's own frame, and an opening measured in stations left
  // its top buried under the roof and its foot in the open.
  const K = st.node;
  const scale = arteryScale(axis, line, st.s);
  const back = (m: number) => st.s - m / scale;
  const wellA = back(WELL + 4), wellB = back(4);
  const end = (K + FLAT_BAYS) * SUB_BAY;
  // The lengths break exactly at the two ends of the well. Rounded out to whole lengths, the
  // opening ran on metres past the head of the stair: a hole in the floor beside it, straight
  // down onto the platform.
  for (let a = (K - FLAT_BAYS) * SUB_BAY; a < end - 1e-3;) {
    let to = Math.min(a + 5, end);
    if (a < wellA && to > wellA) to = wellA;
    else if (a < wellB && to > wellB) to = wellB;
    if (a >= wellA - 1e-6 && to <= wellB + 1e-6) {
      // over the well: two strips of roof with the stair down between them
      for (const side of [1, -1]) {
        along(a, to, (outer - PASS_HALF) / 2, y + SUB_RISE, mezz, side * (outer + PASS_HALF) / 2, Mat.Board, CONCRETE, Finish.Cast);
      }
    } else {
      along(a, to, outer, y + SUB_RISE, mezz, 0, Mat.Board, CONCRETE, Finish.Cast);
    }
    a = to;
  }
  // A balustrade down both sides of the well and across its foot; the head of the stair is
  // the one side left open.
  for (let a = wellA - 0.24 / scale; a < wellB - 1e-3; a += 5) {
    const to = Math.min(a + 5, wellB);
    for (const side of [1, -1]) {
      along(a, to, 0.12, mezz, mezz + 1.05, side * (PASS_HALF + 0.12), Mat.Panel, TILED);
    }
  }
  along(wellA - 0.24 / scale, wellA, PASS_HALF, mezz, mezz + 1.05, 0, Mat.Panel, TILED);

  // The concourse: the length of the mezzanine a passenger is ever on, shut off from the rest
  // of it.
  //
  // The floor here is the tunnel roof, which is laid the whole flat length of the station and
  // has nothing over it. There is no ground to be inside of — the terrain is a skin and a
  // block fills sixteen metres under its own footprint, and a station stands eleven metres
  // below that — so without this the way down from the street ended on an open slab a hundred
  // metres long, hanging in the light with the city overhead and the fog underneath it.
  const ceil = mezz + MEZZ_RISE, ceilTop = ceil + 0.7;
  const roomA = back(WELL + 8), roomB = back(-8);
  // the passage crosses the box here, bringing its own roof over half of it and a way in
  // through the wall on its own side
  const passA = back(PASS_HALF + 0.7), passB = back(-PASS_HALF - 0.7);
  const doorA = back(PASS_HALF), doorB = back(-PASS_HALF);
  const near = Math.sign(st.off * st.side);
  /** A run of box laid along the line in lengths short enough to follow it. */
  const run = (a0: number, a1: number, halfW: number, y0: number, y1: number, off: number, tint: Tint,
    mat = Mat.Board, collide = true) => {
    for (let a = a0; a < a1 - 0.01; a += 5) {
      along(a, Math.min(a + 5, a1), halfW, y0, y1, off, mat, tint, mat === Mat.Board ? Finish.Cast : 0, collide);
    }
  };
  // Ceiling, in the lengths the passage roof does not already cover. Laid over the top of it
  // instead, the two would be the same slab twice and neither would settle.
  run(roomA, passA, outer, ceil, ceilTop, 0, CONCRETE);
  run(passB, roomB, outer, ceil, ceilTop, 0, CONCRETE);
  // a hair thinner than the lengths either side, which it meets at a slant on a bend
  run(passA, passB, outer / 2, ceil + 0.003, ceilTop - 0.003, (-near * outer) / 2, CONCRETE);
  // Walls up off the tunnel's own, which stop at this floor. The near one stands aside for the
  // way in; the passage roof is the lintel over it.
  run(roomA, roomB, SUB_WALL / 2, mezz, ceil, -near * (SUB_HALF + SUB_WALL / 2), TILED);
  run(roomA, doorA, SUB_WALL / 2, mezz, ceil, near * (SUB_HALF + SUB_WALL / 2), TILED);
  run(doorB, roomB, SUB_WALL / 2, mezz, ceil, near * (SUB_HALF + SUB_WALL / 2), TILED);
  // and the two ends of it
  along(roomA - 0.7 / scale, roomA, outer, mezz, ceil, 0, Mat.Board, TILED, Finish.Cast);
  along(roomB, roomB + 0.7 / scale, outer, mezz, ceil, 0, Mat.Board, TILED, Finish.Cast);
  // Two lines of light down it, off to either side so that one of them hangs over the stair.
  // Without them the concourse is the one room down here with nothing lighting it at all: the
  // tunnels have their strips and the passage has one, and a station is not a coal cellar.
  for (const side of [1, -1]) {
    run(roomA + 1, roomB - 1, 0.22, ceil - 0.24, ceil - 0.04, side * 5, TILED, Mat.Strip, false);
  }

  // Platform: an island between the two tracks, with a tactile edge down each side and a
  // line of light over it. It runs the whole hall, wall to wall, with the mouths of the tubes
  // either side of it at each end — it used to stop short in the middle of the box, and the
  // tunnel beyond was the same box carrying on into the dark with nothing to say you were not
  // meant to walk down it.
  // Its ends are drawn in by what a length runs past its own ends, so the platform stops at the
  // wall rather than poking through into the mouth of a tube.
  const start = (K - FLAT_BAYS) * SUB_BAY, inset = 0.3 / scale;
  for (let a = start + inset; a < end - inset - 1e-3; a += 6) {
    const to = Math.min(a + 6, end - inset);
    along(a, to, PLAT_HALF, y, plat, 0, Mat.Board, TILED, Finish.Cast);
    for (const side of [1, -1]) {
      along(a, to, 0.45, plat, plat + 0.02, side * (PLAT_HALF - 0.45), Mat.Paint, [0.78, 0.62, 0.12], 0, false);
      along(a, to, 0.22, y + SUB_RISE - 0.28, y + SUB_RISE - 0.06, side * 4.6, Mat.Strip, TILED, 0, false);
    }
  }
  hallEnd(b, axis, line, start, y, 1);
  hallEnd(b, axis, line, end, y, -1);
  // the name, on the wall behind each track
  for (const side of [1, -1]) {
    along(st.s - 5, st.s + 5, 0.1, plat + 1.5, plat + 2.6, side * (SUB_HALF - 0.05), Mat.Strip, [0.5, 0.62, 0.8], 0, false);
  }

  // Everything above and beside the tracks stands in the entrance's own frame: local +z runs
  // along the line and local +x from the shaft towards it, so the passage is a run in x.
  const reach = st.off * st.side;
  b.turned(st.shaftX, st.shaftZ, -st.yaw, () => {
    const top = st.top;
    const lean = st.lean, end = st.reach;
    /** A box in the entrance's frame, `u` measured along the stair from the foot towards the street. */
    const put = (x0: number, x1: number, u0: number, u1: number, y0: number, y1: number,
      mat: Mat, tint: Tint, style = 0, opts: { collide?: boolean; riseU?: number } = {}) => {
      const za = lean * u0, zb = lean * u1;
      b.box(st.shaftX + x0, y0, st.shaftZ + Math.min(za, zb), st.shaftX + x1, y1, st.shaftZ + Math.max(za, zb),
        mat, tint, style, { detail: false, collide: opts.collide, riseZ: (opts.riseU ?? 0) * lean });
    };
    // The surround, which faces whatever ragged edge the cut tiles left and is solid from the
    // mezzanine to the street, the whole length of the stair. On the side towards the line the
    // passage has to get out of the chamber at the foot, so that side is built round a doorway
    // its full width and headroom.
    //
    // Over the roofed run the street is laid in lengths, each at the ground it meets, so the
    // surround is too; round the hole it is the one level the forecourt is.
    const wallX = SHAFT_X + SURROUND;
    const open = end - MOUTH, edge = open - 0.6;
    const u0 = -FOOT - SURROUND, du = (edge - u0) / st.deck.length;
    const wall = (x0: number, x1: number, u0: number, u1: number, y1: number, y0 = mezz - 1.2) =>
      put(x0, x1, u0, u1, y0, y1, Mat.Board, CONCRETE, Finish.Ribbed);
    const sides = (ua: number, ub: number, y1: number) => {
      for (const s of [1, -1] as const) {
        const [x0, x1] = s > 0 ? [SHAFT_X, wallX] : [-wallX, -SHAFT_X];
        // the doorway the passage leaves by, with a lintel over it
        const da = Math.max(ua, -PASS_HALF), db = Math.min(ub, PASS_HALF);
        if (s !== Math.sign(reach) || da >= db) {
          wall(x0, x1, ua, ub, y1);
          continue;
        }
        if (da > ua) wall(x0, x1, ua, da, y1);
        if (db < ub) wall(x0, x1, db, ub, y1);
        wall(x0, x1, da, db, y1, mezz + MEZZ_RISE);
      }
    };
    st.deck.forEach((y1, j) => {
      const ua = u0 + j * du, ub = ua + du;
      sides(ua, ub, y1);
      // the end wall behind the foot, and the lid over the run
      if (ua < -FOOT) wall(-SHAFT_X, SHAFT_X, ua, Math.min(ub, -FOOT), y1);
      if (ub > -FOOT) put(-SHAFT_X, SHAFT_X, Math.max(ua, -FOOT), ub, y1 - 0.6, y1, Mat.Board, CONCRETE, Finish.Cast);
    });
    sides(edge, end + SURROUND, top);
    wall(-SHAFT_X, SHAFT_X, end, end + SURROUND, top);

    // The stair: a landing the street steps down onto, then one straight flight all the way
    // down to the chamber at the foot.
    const run = end - LAND - FOOT, pitch = (top - mezz) / run;
    put(-SHAFT_X, SHAFT_X, end - LAND, end, top - 0.5, top, Mat.Board, TILED, Finish.Cast);
    flight(b, st.shaftX, st.shaftZ, lean * (end - LAND), lean * FOOT, top, mezz, SHAFT_X, TILED);
    // The floor of the chamber, which is the mezzanine, and its ceiling.
    put(-SHAFT_X, SHAFT_X, -FOOT, FOOT, mezz - 1.0, mezz, Mat.Board, CONCRETE, Finish.Cast);
    put(-SHAFT_X, SHAFT_X, -FOOT, FOOT, mezz + HEAD, mezz + HEAD + 0.5, Mat.Board, CONCRETE, Finish.Cast);
    put(-0.22, 0.22, -FOOT + 0.4, FOOT, mezz + HEAD - 0.2, mezz + HEAD - 0.02, Mat.Strip, TILED, 0, { collide: false });

    // Only the top of the flight is open to the sky, through a hole the size of a room. Below
    // that it runs on under the pavement: a ceiling raking down over it at a constant headroom,
    // a lid at street level over the void above that, and a beam across where the two meet,
    // so that looking down from the street the flight disappears into a tunnel.
    const head = (u: number) => mezz + (u - FOOT) * pitch + HEAD;
    if (edge > FOOT) {
      const mid = (FOOT + edge) / 2, riseU = (edge - FOOT) * pitch;
      put(-SHAFT_X, SHAFT_X, FOOT, edge, head(mid), head(mid) + 0.5, Mat.Board, CONCRETE, Finish.Cast, { riseU, collide: false });
      put(-0.22, 0.22, FOOT, edge, head(mid) - 0.2, head(mid) - 0.02, Mat.Strip, TILED, 0, { collide: false, riseU });
    }
    put(-SHAFT_X, SHAFT_X, edge, open, head(open), top, Mat.Board, CONCRETE, Finish.Cast);

    // a parapet round the opening, which is also what hides the edge of the cut
    put(-SHAFT_X - 0.7, -SHAFT_X, edge, end + 0.7, top, top + 0.5, Mat.Panel, TILED);
    put(SHAFT_X, SHAFT_X + 0.7, edge, end + 0.7, top, top + 0.5, Mat.Panel, TILED);
    put(-SHAFT_X, SHAFT_X, edge, open, top, top + 0.5, Mat.Panel, TILED); // the street end is the way in
    // A lit sign on a mast at the open end, because from the street a subway entrance is
    // otherwise a low kerb round a hole and there is nothing to say what it is. Tall enough
    // to read down the pavement, and lit whatever the hour, like the lights below it.
    for (const side of [1, -1]) {
      const c = side * (SHAFT_X + 0.35);
      put(c - 0.12, c + 0.12, end + 0.1, end + 0.34, top, top + 2.2, Mat.Metal, STEEL);
    }
    put(-SHAFT_X - 0.5, SHAFT_X + 0.5, end + 0.08, end + 0.36, top + 2.2, top + 3.1, Mat.Strip, [0.55, 0.78, 0.72]);

    // The passage from the foot of the shaft across to the well over the platform. Its floor
    // stops at the tunnel wall, because from there on the tunnel roof is the floor — and sits
    // a centimetre under it, so that where the two meet at a slant they are not one plane.
    const at = Math.sign(reach) * SHAFT_X, face = reach - Math.sign(reach) * outer;
    const [fx0, fx1] = at < face ? [at, face] : [face, at];
    b.box(st.shaftX + fx0, mezz - 1.0, st.shaftZ - PASS_HALF - 0.7, st.shaftX + fx1,
      mezz - 0.01, st.shaftZ + PASS_HALF + 0.7, Mat.Board, CONCRETE, Finish.Cast, { detail: false });
    // Its walls and roof start outside the surround, which is already wall and lintel through
    // its own thickness: laid from the chamber as they used to be, they stood inside it face to
    // face with it and the two flickered.
    const out = Math.sign(reach) * wallX;
    const [wx0, wx1] = out < face ? [out, face] : [face, out];
    const [px0, px1] = out < reach ? [out, reach] : [reach, out];
    // The walls stop where the floor does, at the doorway in the concourse wall. Carried on
    // to the centreline as they used to be, the passage ran halfway across the concourse as a
    // blind corridor and the way down stood just behind the end of it, out of sight from the
    // door and out of reach until you had walked past it and turned round.
    for (const side of [1, -1]) {
      const za = Math.min(side * PASS_HALF, side * (PASS_HALF + 0.7));
      b.box(st.shaftX + wx0, mezz, st.shaftZ + za, st.shaftX + wx1, mezz + MEZZ_RISE,
        st.shaftZ + za + 0.7, Mat.Board, TILED, Finish.Cast, { detail: false });
    }
    b.box(st.shaftX + px0, mezz + MEZZ_RISE, st.shaftZ - PASS_HALF - 0.7, st.shaftX + px1,
      mezz + MEZZ_RISE + 0.7, st.shaftZ + PASS_HALF + 0.7, Mat.Board, CONCRETE, Finish.Cast, { detail: false });
    // its light stops at the concourse wall, short of the concourse's own lights it would cross
    b.box(st.shaftX + wx0 + 0.4, mezz + MEZZ_RISE - 0.24, st.shaftZ - 0.22, st.shaftX + wx1 - 0.4,
      mezz + MEZZ_RISE - 0.04, st.shaftZ + 0.22, Mat.Strip, TILED, 0, { collide: false, detail: false });

    // Lamps, for the night. The strips are lit whatever the hour, but a strip only glows: it
    // lights nothing round it, and after dark the way down was a black hole with a pale line
    // drawn down the middle. The renderer lights the lamps nearest the eye like the ones over
    // the streets, so these are what light the flight, the chamber and the passage as you go.
    const a = yawStep(-st.yaw) * YAW_STEP, cs = Math.cos(a), sn = Math.sin(a);
    const lamp = (lx: number, y: number, lz: number) =>
      b.lamps.push(st.shaftX + lx * cs - lz * sn, y, st.shaftZ + lx * sn + lz * cs);
    for (let u = FOOT + 3; u < open; u += 5) lamp(0, head(u) - 0.4, lean * u);
    lamp(0, mezz + HEAD - 0.4, 0);
    for (let x = wallX + 3; x < Math.abs(reach) - 2; x += 6) lamp(Math.sign(reach) * x, mezz + MEZZ_RISE - 0.4, 0);
  });
  // the stair down through the well onto the platform, in the line's own frame
  b.turned(st.x, st.z, -st.yaw, () => {
    flight(b, st.x, st.z, -4, -WELL - 4, mezz, plat, PASS_HALF, TILED, true);
  });
}

/**
 * A straight flight running along local z, from `za` at `yTop` down to `zb` at `yBot`.
 *
 * One raking slab with its nosings standing on it, which is what the stairs elsewhere in the
 * city are: laid as treads alone there is nothing between them or under them, and a flight
 * underground — where the only light is the strip over it — reads as a ladder of loose planks
 * with the dark showing through.
 *
 * `landed` says the floor runs on under the foot of the flight. The last step stands at exactly
 * the floor's level, so laid over it the two are one plane with two boxes in it — a phantom
 * step that flickers in and out — and there it is left to the floor.
 */
function flight(
  b: Builder, cx: number, cz: number, za: number, zb: number, yTop: number, yBot: number,
  halfW: number, tint: Tint, landed = false,
): void {
  const drop = yTop - yBot, span = Math.abs(zb - za);
  if (drop < 0.2 || span < 0.5) return;
  const steps = Math.max(1, Math.round(drop / 0.48));
  const rise = drop / steps, run = span / steps, dir = Math.sign(zb - za);
  const z0 = Math.min(za, zb), z1 = Math.max(za, zb);
  // The slab: its mean top halfway down, sheared so each end meets its own landing. The
  // shear is measured from the box's own +z end, which is the *top* of the flight when the
  // steps run towards -z — get that backwards and the soffit rakes against the treads, so
  // the flight hangs in the air at the bottom and buries itself at the top.
  // Its top runs through the inner corners, where each riser meets the tread below, a whole
  // rise under the nosings. Laid through the nosings it stood a rise proud of the back of
  // every tread and swallowed them, leaving a sawtooth of slab that faced down the flight.
  const mid = yTop - drop / 2 - rise;
  b.box(cx - halfW, mid - 0.5, cz + z0, cx + halfW, mid, cz + z1,
    Mat.Board, tint, Finish.Cast, { riseZ: dir > 0 ? -drop : drop, detail: false });
  for (let i = 1; i <= (landed ? steps - 1 : steps); i++) {
    const top = yTop - i * rise;
    const a = za + dir * (i - 1) * run, c = za + dir * i * run;
    // deep enough to reach down to the slab under its nosing
    b.box(cx - halfW, top - rise - 0.1, cz + Math.min(a, c), cx + halfW, top, cz + Math.max(a, c), Mat.Board, tint, Finish.Cast);
  }
}

/**
 * The way up: a stair that climbs the block's own perimeter from the pavement to its deck.
 *
 * A deck is forty to sixty metres up, which at a walkable pitch is eighty metres of stair —
 * longer than any one side of a block. So it turns each corner and keeps going, winding round
 * the building in the strip between the kerb and the building line, and arrives on the deck
 * wherever it runs out of height.
 *
 * A flight is one raking slab with its steps standing on it, not a row of treads. Laid as
 * treads alone — a box each, a metre deep, with nothing between them and nothing under them —
 * it was a ladder of loose planks cantilevered off nothing, the sky showing through between
 * every pair and the soffit a sawtooth. The slab is what makes it a stair: one plane
 * underneath, one line of nosings on top, and the parapet raking alongside it in one piece
 * rather than in stepped lengths.
 *
 * It turns on a landing, square to the corner it turns on, and the flights stop short of it.
 * Running the treads on into the corner instead left the last tread of one flight and the
 * first of the next — each turned to its own side, half a metre apart in height — crossing
 * through each other and hanging out over the kerb.
 */
function perimeterStair(
  b: Builder | null, poly: Vec2[], top: number, tint: Tint,
): { treads: Vec2[]; arrived: boolean; arrival?: Vec2; way: Vec3[] } {
  const RISE = 0.4, RUN = 1.15, WIDE = 3.4, SLAB = 0.42;
  const treads: Vec2[] = [];
  /** The line up the middle of it, for anyone walking it: see `stairOf`. */
  const way: Vec3[] = [];
  const gave = (arrived: boolean, arrival?: Vec2) => ({ treads, arrived, arrival, way });
  // As close in to the building as it can run without going under the deck: the deck oversails
  // the facade by nearly a metre, and a stair tucked under that edge drives its top flights
  // straight through the deck slab. Out in the middle of the pavement, which is where it used
  // to run, it reads as a ribbon of concrete standing on its own with nothing to do with the
  // tower behind it.
  const path = simplify(shrink(poly, WALK - 0.9 - 0.2 - WIDE / 2), WIDE);
  if (path.length < 3) return gave(false);
  const n = path.length;
  const centre = centroid(path);
  const start = hashInt(Math.round(path[0][0]), Math.round(path[0][1]), 330) % n;

  /** Leg k of the walk: where it runs, and which way is the street. */
  const legOf = (k: number) => {
    const a = path[(start + k) % n], c = path[(start + k + 1) % n];
    const vx = c[0] - a[0], vz = c[1] - a[1];
    const len = Math.hypot(vx, vz) || 1;
    const ux = vx / len, uz = vz / len;
    // the parapet stands on the open side, which is the side away from the building
    let nx = -uz, nz = ux;
    if (nx * (a[0] - centre[0]) + nz * (a[1] - centre[1]) < 0) {
      nx = -nx;
      nz = -nz;
    }
    return { a, c, len, ux, uz, nx, nz, turn: Math.atan2(vz, vx) };
  };

  // from the pavement where it starts, which follows the street and not the podium
  let y = paveAt(path[start][0], path[start][1]);
  let last: { m: Vec2; leg: ReturnType<typeof legOf> } | null = null;
  {
    const { a, ux, uz } = legOf(0);
    way.push([a[0] - ux * 1.5, paveAt(a[0] - ux * 1.5, a[1] - uz * 1.5), a[1] - uz * 1.5], [a[0], y, a[1]]);
  }
  for (let k = 0; k < n * 3 && y < top; k++) {
    const leg = legOf(k);
    // steps stop half a stair's width short of the corner, which is exactly the near edge of
    // the landing that stands there
    const stop = leg.len - WIDE / 2;
    const fit = Math.max(0, Math.round(stop / RUN));
    const steps = Math.min(fit, Math.ceil((top - y) / RISE - 1e-9));
    if (steps > 0) {
      const foot = y; // the level the flight leaves from
      const stepY = (i: number) => Math.min(top, foot + (i + 1) * RISE);
      // The flight is cut into whole steps that fill the leg exactly, so its last nosing lands
      // on the landing's edge rather than a fraction of a step short of it. That remainder was
      // the hole at every turn: a gap the width of the stair with nothing under it but street.
      const run = steps === fit ? stop / steps : RUN;
      const span = steps * run;
      const mx = leg.a[0] + leg.ux * (span / 2), mz = leg.a[1] + leg.uz * (span / 2);
      // the plane through the nosings, dropped a little so the steps stand proud of it
      const crown = (stepY(0) + stepY(steps - 1)) / 2 - 0.06;
      const rise = stepY(steps - 1) - stepY(0) + RISE;
      b?.box(mx - span / 2, crown - SLAB, mz - WIDE / 2, mx + span / 2, crown, mz + WIDE / 2,
        Mat.Board, tint, Finish.Cast, { turn: leg.turn, rise, detail: false });
      // the parapet, raking alongside in one piece
      const edge = WIDE / 2 - 0.11;
      const px = mx + leg.nx * edge, pz = mz + leg.nz * edge;
      b?.box(px - span / 2, crown, pz - 0.11, px + span / 2, crown + 1.05, pz + 0.11,
        Mat.Panel, tint, 0, { turn: leg.turn, rise, collide: false });
      for (let i = 0; i < steps; i++) {
        const sy = stepY(i), s = i * run + run / 2;
        const tx = leg.a[0] + leg.ux * s, tz = leg.a[1] + leg.uz * s;
        treads.push([tx, tz]);
        way.push([tx, sy, tz]);
        last = { m: [tx, tz], leg };
        b?.box(tx - run / 2, sy - 0.55, tz - WIDE / 2, tx + run / 2, sy, tz + WIDE / 2,
          Mat.Board, tint, Finish.Boards, { turn: leg.turn, detail: false });
      }
      y = stepY(steps - 1);
    }
    if (y >= top) break;
    // The landing it turns on: a square of the stair's own width centred on the corner and
    // square to the flight arriving, so that flight runs into it flush. Square to the bisector
    // instead, as a landing ought to be, its edge crosses the arriving flight at an angle and
    // opens a wedge at one side of it — which is the second hole. The flight leaving starts at
    // the corner itself and climbs off the landing, so there is no joint on that side at all.
    const v = leg.c;
    b?.box(v[0] - WIDE / 2, y - SLAB, v[1] - WIDE / 2, v[0] + WIDE / 2, y, v[1] + WIDE / 2,
      Mat.Board, tint, Finish.Cast, { turn: leg.turn, detail: false });
    // the parapet carried round the landing as far as the corner, so the hand never leaves it
    const lx = v[0] - leg.ux * (WIDE / 4) + leg.nx * (WIDE / 2 - 0.11);
    const lz = v[1] - leg.uz * (WIDE / 4) + leg.nz * (WIDE / 2 - 0.11);
    b?.box(lx - WIDE / 4, y, lz - 0.11, lx + WIDE / 4, y + 1.05, lz + 0.11,
      Mat.Panel, tint, 0, { turn: leg.turn, collide: false });
    treads.push([v[0], v[1]]);
    way.push([v[0], y, v[1]]);
  }

  // Where it arrives, a landing reaching in from the stair to the edge of the deck. Laid at
  // the last tread and square to the flight that got there, not at a fixed corner of the
  // outline square to the world, which is where it used to go whichever way the stair ran.
  if (y < top - 0.6 || !last) return gave(false);
  const { m, leg } = last;
  // pushed in far enough to get right over the deck edge and a little way on to it, and set
  // three centimetres under the deck so the two do not argue over the strip they share
  const cx = m[0] - leg.nx * 1.2, cz = m[1] - leg.nz * 1.2;
  b?.box(cx - WIDE / 2, top - 1.4, cz - (WIDE / 2 + 0.6), cx + WIDE / 2, top - 0.03, cz + (WIDE / 2 + 0.6),
    Mat.Deck, tint, 0, { turn: leg.turn, detail: false });
  way.push([cx, top, cz], [cx - leg.nx * 2.3, top, cz - leg.nz * 2.3]);
  return gave(true, [cx, cz]);
}

/**
 * The outline with its shortest edges taken out, so no corner is so close to the next that
 * the landings on them would sit on top of each other.
 */
function simplify(poly: Vec2[], minLen: number): Vec2[] {
  if (poly.length < 3) return poly;
  const out: Vec2[] = [poly[0]];
  for (let k = 1; k < poly.length; k++) {
    const p = out[out.length - 1], q = poly[k];
    if (Math.hypot(q[0] - p[0], q[1] - p[1]) >= minLen) out.push(q);
  }
  // the closing edge counts too, and three corners is the least a walk round can have
  while (out.length > 3 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < minLen)
    out.pop();
  return out.length >= 3 ? out : poly;
}

/**
 * Lifts from the pavement to the deck, on the longest sides the stair leaves free.
 *
 * One stair a block, winding a hundred metres round it, was the only way up, and it starts
 * wherever it happens to — so from the street the deck was somewhere you could see and not
 * reach. A lift is found by looking for it: a lit mast on the kerb. It stops level with the
 * top of the deck's parapet, so the rider steps off over it rather than climbing it.
 */
function blockLifts(
  b: Builder, poly: Vec2[], E: number, tint: Tint, avoid: Vec2[], must = false,
): void {
  const c = centroid(poly);
  const sides = poly.map((a, k) => [a, poly[(k + 1) % poly.length]] as const)
    .map(([a, q]) => ({ a, q, len: Math.hypot(q[0] - a[0], q[1] - a[1]) }))
    .filter((e) => e.len >= 16)
    .sort((x, y) => y.len - x.len);
  const h = LIFT_SIZE / 2, top = E + 1.05;
  let placed = 0;
  // `must` relaxes both the spacing from the stair and how snugly the platform has to sit in
  // the pavement: a lift a little tight against the kerb beats a deck nothing can get to
  for (const pass of must ? [false, true] : [false]) {
  for (const { a, q, len } of sides) {
    if (placed >= (pass ? 1 : 3)) break;
    const ux = (q[0] - a[0]) / len, uz = (q[1] - a[1]) / len;
    let nx = -uz, nz = ux;
    // a third of the way along: the middle of the side is where a deck bridge lands
    const mx = a[0] + (q[0] - a[0]) * 0.3, mz = a[1] + (q[1] - a[1]) * 0.3;
    if (nx * (c[0] - mx) + nz * (c[1] - mz) < 0) {
      nx = -nx;
      nz = -nz;
    }
    // In the pavement, clear of the kerb and of the deck overhead. The platform is square to
    // the world, not to the side, so how far it reaches toward the building depends on the
    // side's angle; the deck's collision reaches up to a slab width past its outline.
    const reach = h * (Math.abs(nx) + Math.abs(nz));
    const d = Math.max(1.0 + reach, Math.min(WALK - 1.8 - reach, 3.2));
    if (!pass && (d - reach < 0.95 || d + reach > WALK - 1.8)) continue;
    const x = mx + nx * d, z = mz + nz * d;
    if (!pass && avoid.some(([px, pz]) => Math.hypot(px - x, pz - z) < 5)) continue;
    // standing on the pavement, which on a slope is not the podium's level: the highest of it
    // under the platform, so no corner of the pavement stands up through the floor
    let foot = -Infinity;
    for (const dx of [-h, h]) for (const dz of [-h, h]) foot = Math.max(foot, paveAt(x + dx, z + dz));
    b.lift(x - h, z - h, x + h, z + h, foot, top);
    // the mast stands on the kerb beside the platform, not in front of it
    const side = h * (Math.abs(ux) + Math.abs(uz)) + 0.5;
    const kx = mx + nx * 0.4 + ux * side, kz = mz + nz * 0.4 + uz * side;
    const kerb = paveAt(kx, kz);
    b.box(kx - 0.18, kerb - 0.3, kz - 0.18, kx + 0.18, top + 3.4, kz + 0.18, Mat.Metal, tint, 0, { detail: false });
    b.box(kx - 0.24, top + 3.4, kz - 0.24, kx + 0.24, top + 3.8, kz + 0.24, Mat.Beacon, tint, 0, { collide: false });
    b.box(kx - 0.2, kerb + 2.4, kz - 0.2, kx + 0.2, kerb + 3.0, kz + 0.2, Mat.Glow, tint, 0, { collide: false });
    avoid.push([x, z]);
    placed++;
  }
  if (placed > 0) break;
  }
}

/**
 * The waterfront: the embankment's coping and its steps, and the vessels tied up against it.
 *
 * Everything is placed from the river's own spline, so it follows the water round its bends
 * rather than being scattered near it.
 */
/**
 * The river surface, laid along the river's own line rather than over whichever ground tiles
 * happen to be under water.
 *
 * A level plane cut to the five-metre grid has a shoreline of right angles — a staircase,
 * and the flatter the bank the worse it is, because there is no slope for the water to
 * disappear under and the tile edge *is* the edge of the water. The channel is a spline and
 * the quay walls are already built along it at RIVER_HALF either side, so the water is laid
 * the same way: bays turned to follow it, overlapping at their joints so the turn between
 * two of them leaves no gap.
 */
function river(b: Builder, x0: number, z0: number): void {
  const STEP = 8;
  const pad = 200;
  for (const line of riverLines(x0 + REGION / 2, REGION / 2 + pad)) {
    const w = waterLevel(line);
    for (let s = z0 - pad; s < z0 + REGION + pad; s += STEP) {
      const a = riverFrame(line, s).p, c = riverFrame(line, s + STEP).p;
      const px = (a[0] + c[0]) / 2, pz = (a[1] + c[1]) / 2;
      if (px < x0 || px >= x0 + REGION || pz < z0 || pz >= z0 + REGION) continue;
      const dx = c[0] - a[0], dz = c[1] - a[1];
      const len = (Math.hypot(dx, dz) || STEP) + RIVER_HALF * 0.08;
      // and every other bay a shade under the one before it, so the two metres of water they
      // both cover is not two surfaces at one height (see `SHINGLE`)
      const drop = (((Math.round(s / STEP) % 2) + 2) % 2) * SHINGLE;
      // The seed carries how far down the river this bay begins. A bay is turned to the
      // channel, so its own u axis runs downstream and its v across, and the two together
      // give the shader a coordinate that is continuous from bay to bay however the river
      // bends — which is what lets the water run down it rather than drift north-east.
      b.box(px - len / 2, w - 0.5 - drop, pz - RIVER_HALF, px + len / 2, w - drop, pz + RIVER_HALF,
        Mat.Water, [1, 1, 1], 0,
        { seed: ((s % 4096) + 4096) % 4096, detail: false, collide: false, turn: Math.atan2(dz, dx) });
    }
  }
}

function waterfront(b: Builder, x0: number, z0: number): void {
  const stone: Tint = [0.74, 0.74, 0.73];
  const pad = 200;
  for (const line of riverLines(x0 + REGION / 2, REGION / 2 + pad)) {
    const from = z0 - pad, to = z0 + REGION + pad;
    for (let s = from; s < to; s += BAY) {
      // The bay taken between its own two ends, as the water is, rather than off the nominal
      // spacing of the stations. A station is a fraction of the river's lattice and not arc
      // length, so eight of them is anywhere from five to thirteen metres of bank — and boxes
      // cut to the nominal eight left the quay open at every joint where the spline stretches:
      // a missing tooth of parapet with the water showing through behind it.
      const k = Math.round(s / BAY);
      const { p: [px, pz], dir, chord } = quayBay(line, k);
      const turn = Math.atan2(dir[1], dir[0]);
      // Bays overrun both ends by the mitre: two of them turned against each other leave the
      // joint open on the inside of the bend otherwise, and the wider the thing laid the wider
      // that opening. The boxes are opaque, so the seam is buried inside the stone.
      const halfL = chord / 2 + 1.6;
      // and, as on a deck, every other bay is set down out of the plane of its neighbours, or
      // the three metres of quay the two of them both cover is two surfaces at one height
      // (see `SHINGLE`)
      const drop = (((k % 2) + 2) % 2) * SHINGLE;
      const steps = k % WATER_STEPS === 0;
      for (const side of [1, -1] as const) {
        const ex = px - dir[1] * RIVER_HALF * side, ez = pz + dir[0] * RIVER_HALF * side;
        if (ex < x0 - 4 || ex >= x0 + REGION + 4 || ez < z0 - 4 || ez >= z0 + REGION + 4) continue;
        const w = waterLevel(line), top = w + QUAY_RISE;
        const put = (halfW: number, y0: number, y1: number, off: number, mat: Mat, tn: Tint, style = 0, opts = {}) => {
          const cx = ex - dir[1] * off * side, cz = ez + dir[0] * off * side;
          b.box(cx - halfL, y0 - drop, cz - halfW, cx + halfL, y1 - drop, cz + halfW, mat, tn, style, { turn, detail: false, ...opts });
        };
        // The quay: the wall out of the water and the strip of deck behind it. The ground
        // under all of it is cut away (see `channelCap`), because a five-metre grid cannot
        // make a curved shoreline — so this stone *is* the edge of the city against the
        // water, and the ground only picks up again, flush, behind its inner edge.
        put(QUAY_SLAB / 2, w - 4, top, QUAY_SLAB / 2, Mat.Deck, stone);
        // A solid parapet along the top of the wall. Nothing thin: a slender rail here runs
        // the whole length of the bank and, seen down the quay, reads as a wire over the
        // water rather than as anything anyone would build. It stops at the head of the water
        // steps, so that they are walked down to rather than climbed over to.
        if (!steps) {
          put(1.1, top, top + 0.42, 1.0, Mat.Board, stone, Finish.Cast);
          put(0.42, top + 0.42, top + 1.15, 1.7, Mat.Board, stone, Finish.Cast);
        }
        // A bollard now and then, with an iron ladder down the wall in front of it for anyone
        // in the water to get out by: two stiles standing off the face and over the coping as
        // handles, and the rungs between them. Not solid — a swimmer climbs it (see swim.ts),
        // and nobody on the quay should trip over its handles.
        if (k % LADDERS === 0 && !steps) {
          put(0.3, top + 0.42, top + 1.1, 1.0, Mat.Board, stone, Finish.Ribbed);
          const iron: Tint = [0.16, 0.15, 0.14];
          const bar = (along: number, half: number, y0: number, y1: number, o0: number, o1: number) => {
            const o = (o0 + o1) / 2;
            const cx = ex - dir[1] * o * side + dir[0] * along, cz = ez + dir[0] * o * side + dir[1] * along;
            b.box(cx - half, y0, cz - Math.abs(o1 - o0) / 2, cx + half, y1, cz + Math.abs(o1 - o0) / 2, Mat.Metal, iron, 0,
              { turn, detail: false, collide: false });
          };
          for (const along of [-0.26, 0.26]) {
            bar(along, 0.03, w - 1.5, top + 0.9, -0.22, -0.14);
            bar(along, 0.03, top + 0.84, top + 0.9, -0.22, 0.35);
          }
          for (let y = w - 1.2; y < top; y += 0.32) bar(0, 0.26, y, y + 0.035, -0.2, -0.16);
        }
        if (steps) {
          for (let n = 1; n <= 12; n++) {
            // Half a shingle low, so that the tread which lands at the waterline — and with
            // this rise one of them always does — is not in the plane of the river itself.
            const y = top - n * (top - w + 1) / 12 - SHINGLE / 2;
            put(1.6, y - 0.6, y, -0.6 - n * 0.42, Mat.Board, stone, Finish.Boards);
          }
          // A launch tied up at the foot, for anyone who walks down to take it. Registered
          // rather than built, and by the region its own middle is in, so that two regions
          // building the same steps do not both moor one there.
          const moor = launchAt(line, k, side);
          if (moor && moor.x >= x0 && moor.x < x0 + REGION && moor.z >= z0 && moor.z < z0 + REGION) {
            b.boats.push({ x: moor.x, y: w + 1.2, z: moor.z, yaw: moor.yaw });
          }
        }
      }
    }
  }
}

/**
 * Vessels on the river: barges tied up along the quays and larger ships out in the channel.
 *
 * Their decks are solid, so one moored against the steps is something you can walk aboard.
 */
function vessels(b: Builder, x0: number, z0: number): void {
  const hull: Tint = [0.36, 0.38, 0.40];
  const deckT: Tint = [0.62, 0.60, 0.56];
  const house: Tint = [0.80, 0.80, 0.78];
  const pad = 160;
  for (const line of riverLines(x0 + REGION / 2, REGION / 2 + pad)) {
    const w = waterLevel(line);
    for (let k = Math.floor((z0 - pad) / 90); k <= Math.floor((z0 + REGION + pad) / 90); k++) {
      const h = hashInt(line, k, 340);
      if (h % 100 >= 44) continue;
      const s = k * 90 + (h % 37);
      const big = h % 100 < 13;
      const { p, dir } = riverFrame(line, s);
      // A third of the small ones are not here: the launches anyone can take lie at the water
      // steps instead (see `waterfront`). And nothing ties up across the steps themselves,
      // where it would stand between a launch and the treads it is boarded from.
      if (!big && h % 3 === 0) continue;
      const span = BAY * WATER_STEPS, past = (((s - BAY / 2) % span) + span) % span;
      if (!big && (past < 34 || past > span - 34)) continue;
      // moored against a quay, or standing off in the fairway
      const side = h % 2 === 0 ? 1 : -1;
      const off = big ? (h % 3) * 9 : RIVER_HALF - 7 - (h % 5);
      const cx = p[0] - dir[1] * off * side, cz = p[1] + dir[0] * off * side;
      if (cx < x0 - 40 || cx >= x0 + REGION + 40 || cz < z0 - 40 || cz >= z0 + REGION + 40) continue;
      const turn = Math.atan2(dir[1], dir[0]);
      const L = big ? 33 : 13, W = big ? 7.5 : 3.6;
      const put = (a0: number, a1: number, y0: number, y1: number, c0: number, c1: number, mat: Mat, tn: Tint, style = 0) =>
        b.box(cx + a0, y0, cz + c0, cx + a1, y1, cz + c1, mat, tn, style, { turn, detail: false });
      put(-L, L, w - 2.6, w + 1.1, -W, W, Mat.Board, hull, Finish.Cast); // hull
      put(-L + 1.4, L - 1.4, w + 1.1, w + 1.5, -W + 0.9, W - 0.9, Mat.Deck, deckT); // deck
      put(-L, -L + 1.2, w + 1.1, w + 2.1, -W, W, Mat.Panel, hull); // bulwarks fore and aft
      put(L - 1.2, L, w + 1.1, w + 2.1, -W, W, Mat.Panel, hull);
      // wheelhouse aft, and a funnel on the big ones
      put(L - 9, L - 3.4, w + 1.5, w + 5.2, -W + 1.1, W - 1.1, Mat.Windows, house, Win.Ribbon);
      put(L - 8.4, L - 4, w + 5.2, w + 5.7, -W + 0.7, W - 0.7, Mat.Board, house, Finish.Boards);
      if (big) {
        put(L - 16, L - 12, w + 5.2, w + 11, -2.2, 2.2, Mat.Board, [0.5, 0.2, 0.16], Finish.Cast);
        put(-L + 4, -L + 4.5, w + 1.5, w + 13, -0.3, 0.3, Mat.Metal, [0.3, 0.31, 0.32]);
      }
    }
  }
}

/** The deck height of whatever block stands at this seed. */
export function deckOf(site: Site): number {
  const poly = cellOf(site);
  return (poly && poly.length >= 3 ? blockBase(poly) : groundAt(site.p[0], site.p[1]))
    + DECKS[hashInt(Math.round(site.p[0]), Math.round(site.p[1]), 301) % DECKS.length];
}

/**
 * The way up a block's stair, for anyone walking it: x, y, z from the pavement a step short of
 * its foot, up the middle of every flight and across every landing, and on over the arrival
 * onto the deck. Null where the block has no stair, or one that never gets there.
 */
export function stairOf(site: Site): Vec3[] | null {
  const poly = pavementOf(site);
  if (!poly) return null;
  const stair = perimeterStair(null, poly, deckOf(site), [1, 1, 1]);
  return stair.arrived ? stair.way : null;
}

/**
 * Bridges from this block's deck to its neighbours', so the decks are a network rather than a
 * set of islands you can climb one at a time.
 *
 * Only one of the two blocks builds each bridge — whichever seed sorts first — or both would,
 * in the same place. A pair whose decks are too far apart in height is left unbridged; the
 * rest take a short flight of steps at the higher end.
 */
function deckBridges(b: Builder, site: Site, E: number, tint: Tint): void {
  for (const { other, mid, normal } of neighbours(site)) {
    // one side builds it: the one whose seed comes first
    const mine = `${site.p[0].toFixed(1)},${site.p[1].toFixed(1)}`;
    const theirs = `${other.p[0].toFixed(1)},${other.p[1].toFixed(1)}`;
    if (mine > theirs) continue;
    const far = deckOf(other);
    if (Math.abs(far - E) > 11) continue; // too much of a climb to bridge
    const low = Math.min(E, far), high = Math.max(E, far);
    const gap = Math.hypot(mid[0] - site.p[0], mid[1] - site.p[1]);
    if (gap > 220) continue;
    // Not across the water. A river is a Voronoi edge like any other, so the block on the far
    // bank counts as a neighbour and this cheerfully threw a walkway over the river at deck
    // height — which from the water reads as a wire strung across it.
    if (riverNear(mid[0], mid[1], RIVER_HALF + 40)) continue;
    const half = ROAD * 2.2; // reach well past the kerbs on both sides
    const W = 3.6, turn = Math.atan2(normal[1], normal[0]);
    const STEP = 3.0;
    for (let s = -half; s < half; s += STEP) {
      const cx = mid[0] + normal[0] * (s + STEP / 2), cz = mid[1] + normal[1] * (s + STEP / 2);
      b.box(cx - STEP / 2, low - 1.0, cz - W / 2, cx + STEP / 2, low, cz + W / 2,
        Mat.Board, tint, Finish.Cast, { turn, detail: false });
      for (const side of [-1, 1]) {
        b.box(cx - STEP / 2, low, cz + side * (W / 2 - 0.16), cx + STEP / 2, low + 1.05, cz + side * (W / 2),
          Mat.Panel, tint, 0, { turn, collide: false });
      }
    }
    // steps up to whichever deck is the higher of the two
    if (high - low > 0.3) {
      const dir = E > far ? -1 : 1; // toward the high side
      const n = Math.ceil((high - low) / 0.42);
      for (let i = 1; i <= n; i++) {
        const s = dir * (half + i * 0.75);
        const cx = mid[0] + normal[0] * s, cz = mid[1] + normal[1] * s;
        b.box(cx - 0.4, low + (high - low) * (i / n) - 1.2, cz - W / 2,
          cx + 0.4, low + (high - low) * (i / n), cz + W / 2, Mat.Board, tint, Finish.Boards,
          { turn, detail: false });
      }
    }
  }
}

/** Debug: every stretch laid over a point, with what it belongs to. */
export function piecesAtDebug(x: number, z: number): { y: number; half: number; a: Vec2; b: Vec2; hl: number; hw: number; s0: number; s1: number; len: number }[] {
  const out: { y: number; half: number; a: Vec2; b: Vec2; hl: number; hw: number; s0: number; s1: number; len: number }[] = [];
  for (const p of piecesNear(x, z)) {
    const dx = x - p.cx, dz = z - p.cz;
    if (Math.abs(dx * p.ux + dz * p.uz) > p.hl || Math.abs(dz * p.ux - dx * p.uz) > p.hw) continue;
    out.push({ y: p.y, half: p.street.half, a: p.street.a, b: p.street.b, hl: p.hl, hw: p.hw, s0: p.s0, s1: p.s1, len: p.len });
  }
  return out;
}

/** Test hook: every stretch of street laid over a point, and where each one came from. */
export function __piecesAt(x: number, z: number): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const p of piecesNear(x, z)) {
    const dx = x - p.cx, dz = z - p.cz;
    if (Math.abs(dx * p.ux + dz * p.uz) > p.hl || Math.abs(dz * p.ux - dx * p.uz) > p.hw) continue;
    out.push({
      y: +pieceYOn(p, x, z).toFixed(2),
      half: +p.street.half.toFixed(1),
      arterial: p.street.half >= ARTERY_HALF - 0.5,
      grade: +p.grade.toFixed(3),
      s: `${p.s0.toFixed(0)}..${p.s1.toFixed(0)} of ${p.len.toFixed(0)}`,
      from: `${p.street.a[0].toFixed(0)},${p.street.a[1].toFixed(0)}`,
      to: `${p.street.b[0].toFixed(0)},${p.street.b[1].toFixed(0)}`,
    });
  }
  return out;
}

/**
 * True on open ground: no block, and no road slab.
 *
 * Both of those are solid a long way down — a block fills its outline from sixteen metres
 * below its pavement up, and a carriageway is a slab six metres thick — so an entrance can
 * only come up where neither is, which on this network is the ground between them.
 */
// A block's outline grown by the clearance an entrance keeps off it, kept by seed. The search
// for somewhere an entrance can stand asks about a couple of hundred points and the same
// dozen blocks answer for all of them; growing each one afresh every time was most of what
// that search cost.
const grownCells = rememberBySeed<string, Vec2[]>();

function grownCell(s: Site): Vec2[] {
  checkSeed();
  const hit = grownCells.get(s.key);
  if (hit) return hit;
  const poly = cellOf(s);
  const out = poly && poly.length >= 3 ? shrink(poly, -1.2) : [];
  if (grownCells.size > 8192) grownCells.clear();
  grownCells.set(s.key, out);
  return out;
}

function openGround(x: number, z: number, near?: Site[]): boolean {
  for (const s of near ?? blocksIn(x - 10, z - 10, x + 10, z + 10)) {
    const grown = grownCell(s);
    if (grown.length >= 3 && inPoly(grown, x, z)) return false;
  }
  // Clear of every arterial, not just the one the station is on. An arterial's carriageway
  // is filled as a six-metre slab that is not a street piece and that no road lookup
  // reports, so the only way to know is to measure to the spline — and the one that catches
  // an entrance out is the arterial crossing the line, which nothing else would think to ask
  // about.
  for (const axis of [0, 1] as const)
    for (const line of arteryLines(axis === 0 ? z : x, WANDER + 60)) {
      // The spline is parameterised so that its station is close to the along coordinate, so
      // a handful of samples either side of that is enough to find how near the road passes.
      for (const d of [-14, -7, 0, 7, 14]) {
        const at = arteryFrame(axis, line, (axis === 0 ? x : z) + d).p;
        if (Math.hypot(at[0] - x, at[1] - z) < ARTERY_HALF + 4) return false;
      }
    }
  return !underRoad(x, z);
}

/**
 * True where another arterial passes close enough to cover the entrance.
 *
 * An arterial's carriageway is filled as a six-metre slab which is not a street piece, so no
 * road lookup in the plan reports it — the only way to know is to measure to the spline. The
 * line the station is on is left out, because the offset the entrance was placed at already
 * says how far from that one it stands; what catches an entrance out is the arterial
 * crossing it, which nothing else would think to ask about.
 *
 * Asked once per candidate rather than at every corner of the opening, with the opening's
 * own half-diagonal folded into the clearance, because a spline lookup is not cheap and this
 * search runs over a hundred candidates for every station in the city.
 */
function crossedByArtery(own: 0 | 1, ownLine: number, x: number, z: number): boolean {
  const reach = ARTERY_HALF + 4 + Math.hypot(SHAFT_X, FOOT);
  for (const axis of [0, 1] as const)
    for (const line of arteryLines(axis === 0 ? z : x, WANDER + reach)) {
      if (axis === own && line === ownLine) continue;
      // the spline's station runs with the along coordinate, so a few samples either side of
      // it bracket the nearest approach
      for (const d of [-13, 0, 13]) {
        const at = arteryFrame(axis, line, (axis === 0 ? x : z) + d).p;
        if (Math.hypot(at[0] - x, at[1] - z) < reach) return true;
      }
    }
  return false;
}

/**
 * True where any stretch of street is laid over a point.
 *
 * `roadTopAt` would be the obvious thing to ask, and it is what the ground itself asks — but
 * it reads the pieces remembered for the cell the point is in, and a piece belongs to the
 * cell its own midpoint falls in. A street eighty metres long therefore covers ground its
 * cell has never heard of. Everything else that asks is deciding how high to lay a tile, and
 * gets it slightly wrong in a way nobody sees; here the answer decides whether an entrance
 * comes up under six metres of tarmac, so this one walks the neighbouring cells too.
 */
const wideStreets = rememberBySeed<string, Street[]>();

/**
 * The ground a street's carriageway is laid over: its footprint, and nothing else about it.
 *
 * The same rectangle `cutPieces` fills, before it is cut into stretches — which is the only
 * part of a street this question needs. Cutting one walks the terrain under it and the terrain
 * reads the rivers, and asking for the stretches here made the search for somewhere an
 * entrance could stand into a terrain survey of every road for a kilometre around it.
 */
function underStreet(st: Street, x: number, z: number, margin: number): boolean {
  const [ax, az] = st.a, [bx, bz] = st.b;
  const L = Math.hypot(bx - ax, bz - az) || 1;
  const ux = (bx - ax) / L, uz = (bz - az) / L;
  // carried past each end to fill the junction, exactly as the stretches themselves are
  const ext = st.half >= ARTERY_HALF - 0.5 ? 0 : Math.min(st.half * 1.8, 30);
  const dx = x - (ax + bx) / 2, dz = z - (az + bz) / 2;
  return Math.abs(dx * ux + dz * uz) <= L / 2 + ext + margin
    && Math.abs(dz * ux - dx * uz) <= st.half + 0.4 + margin;
}

function underRoad(x: number, z: number): boolean {
  const ci = Math.floor(x / PIECE_CELL), cj = Math.floor(z / PIECE_CELL);
  const key = `${ci},${cj}`;
  checkSeed();
  let near = wideStreets.get(key);
  if (!near) {
    const r = 140;
    near = streetsIn(ci * PIECE_CELL - r, cj * PIECE_CELL - r, (ci + 1) * PIECE_CELL + r, (cj + 1) * PIECE_CELL + r);
    if (wideStreets.size > 512) wideStreets.clear();
    wideStreets.set(key, near);
  }
  for (const st of near) if (underStreet(st, x, z, 1)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Stations on the elevated railway
//
// A platform either side of the deck, outside the two tracks, the length of a train and under
// a canopy; and from the middle of each, a footbridge out over the carriageway to a stair tower
// standing in the forecourt the block on that side keeps in front of it (see `railStop`).

/** Platform top above the rails: level with a carriage floor, as on the subway. */
export const RAIL_PLAT = 1.06;
/** Where each track runs, off the middle of the deck; see `railways` in traffic.ts. */
export const RAIL_TRACK = 1.85;
/** A platform runs from just clear of the train to its outer edge, either side. */
export const PLAT_IN = 3.45, PLAT_OUT = 7.6;
/** Half the length of a platform: a train of five twenty-metre cars and a little over. */
const PLAT_LONG = 54;
/** The stair tower: how far out from the line its near face stands, and how wide it is. */
const TOWER_IN = ARTERY_HALF + 6.5;
const TOWER_WIDE = 4.6;
/** Steps to a flight, their going, and the landings at either end. */
const TOWER_STEPS = 7, TOWER_GOING = 0.8, TOWER_LAND = 2.4;
const TOWER_LONG = TOWER_LAND * 2 + TOWER_STEPS * TOWER_GOING;

export interface RailStation {
  axis: 0 | 1;
  line: number;
  k: number;
  /** Where it is on the line, and the point on the line there. */
  s: number;
  x: number;
  z: number;
  /** Top of the rails at its middle; the platforms stand `RAIL_PLAT` above that. */
  y: number;
  yaw: number;
  name: string;
  /** The way up each side, from the forecourt to the platform: see `railWay`. */
  towers: RailTower[];
}

/** A stair tower, in the station's own frame: `u` along the line, `v` out from it on its side. */
export interface RailTower {
  side: 1 | -1;
  /** Where along the line its first landing begins. */
  u0: number;
  /** The ground at its foot, the platform level at its top, and how many flights between. */
  foot: number;
  top: number;
  flights: number;
}

const railStations = rememberBySeed<string, RailStation | null>();

/** Station `k` of an elevated railway, or null where it has none. */
export function railStationAt(axis: 0 | 1, line: number, k: number): RailStation | null {
  const stop = railStop(axis, line, k);
  if (!stop) return null;
  const key = `${axis},${line},${k}`;
  checkSeed();
  const hit = railStations.get(key);
  if (hit !== undefined) return hit;
  const { s } = stop;
  const { p, dir } = arteryFrame(axis, line, s);
  const y = railY(axis, line, s);
  const top = y + RAIL_PLAT;
  const h = hashInt(axis, line, k, 365);
  const towers: RailTower[] = ([1, -1] as const).map((side) => {
    // The tower stands so that the landing the last flight arrives at is opposite the middle
    // of the platform, where the footbridge leaves from. Flights go out along the line and back,
    // so that is the far end after an odd number of them and the near end after an even one —
    // which depends on the ground at its foot, which depends on where it stands. Asked twice.
    let u0 = -TOWER_LONG + TOWER_LAND / 2, foot = 0, flights = 1;
    for (let pass = 0; pass < 2; pass++) {
      foot = -Infinity;
      for (const a of [0, TOWER_LONG]) for (const v of [TOWER_IN, TOWER_IN + TOWER_WIDE]) {
        const u = u0 + a;
        foot = Math.max(foot, groundAt(p[0] + dir[0] * u - dir[1] * v * side, p[1] + dir[1] * u + dir[0] * v * side));
      }
      flights = Math.max(1, Math.ceil((top - foot) / (TOWER_STEPS * 0.45)));
      u0 = -(flights % 2 === 1 ? TOWER_LONG - TOWER_LAND / 2 : TOWER_LAND / 2);
    }
    return { side, u0, foot, top, flights };
  });
  const st: RailStation = {
    axis, line, k, s, x: p[0], z: p[1], y, yaw: Math.atan2(dir[0], dir[1]),
    name: `${STATION_HEAD[h % STATION_HEAD.length]} ${STATION_TAIL[(h >>> 8) % STATION_TAIL.length]}`,
    towers,
  };
  if (railStations.size > 2048) railStations.clear();
  railStations.set(key, st);
  return st;
}

/** Every station on an elevated railway within `r` of a point. */
export function railStationsNear(x: number, z: number, r: number): RailStation[] {
  const out: RailStation[] = [];
  for (const axis of [0, 1] as const) {
    const across = axis === 0 ? z : x, along = axis === 0 ? x : z;
    for (const line of arteryLines(across, r + WANDER)) {
      if (!hasRail(axis, line)) continue;
      for (let k = Math.floor((along - r - WANDER) / RAIL_SPACING) - 1; k <= Math.ceil((along + r + WANDER) / RAIL_SPACING) + 1; k++) {
        const st = railStationAt(axis, line, k);
        if (st && Math.hypot(st.x - x, st.z - z) <= r) out.push(st);
      }
    }
  }
  return out;
}

/** Whether a stretch of an elevated railway runs along a platform, where the deck leaves its upstands off. */
function inRailStation(axis: 0 | 1, line: number, s: number): boolean {
  const k = Math.round(s / RAIL_SPACING);
  for (const j of [k - 1, k, k + 1]) {
    const st = railStationAt(axis, line, j);
    if (st && Math.abs(s - st.s) * arteryScale(axis, line, st.s) < PLAT_LONG + 6) return true;
  }
  return false;
}

/** The point of the tower on `side` that is `a` along it from its first landing and `v` out from the line, at height `y`. */
function towerPoint(st: RailStation, t: RailTower, a: number, v: number, y: number): Vec3 {
  const { p, dir } = arteryFrame(st.axis, st.line, st.s);
  const u = t.u0 + a;
  return [p[0] + dir[0] * u - dir[1] * v * t.side, y, p[1] + dir[1] * u + dir[0] * v * t.side];
}

/**
 * The way up one side of a station, for anyone walking it: x y z from the forecourt in front of
 * the tower's foot, up every flight and across every landing, over the footbridge and out onto
 * the middle of the platform. With it, a point on that platform `m` metres along from the
 * middle and `v` out from the line.
 */
export function railWay(st: RailStation, side: 1 | -1): { way: Vec3[]; platform: (m: number, v: number) => Vec3 } {
  const t = st.towers.find((w) => w.side === side)!;
  const rise = (t.top - t.foot) / (t.flights * TOWER_STEPS);
  const lane = (f: number) => TOWER_IN + (f % 2 === 0 ? TOWER_WIDE * 0.75 : TOWER_WIDE * 0.25);
  const start = towerPoint(st, t, -2.5, lane(0), 0);
  start[1] = groundAt(start[0], start[2]);
  const way: Vec3[] = [start, towerPoint(st, t, TOWER_LAND / 2, lane(0), t.foot)];
  for (let f = 0; f < t.flights; f++) {
    const out = f % 2 === 0;
    const fa = TOWER_LAND, fb = TOWER_LAND + TOWER_STEPS * TOWER_GOING;
    const y0 = t.foot + f * TOWER_STEPS * rise, y1 = y0 + TOWER_STEPS * rise;
    way.push(towerPoint(st, t, out ? fa : fb, lane(f), y0), towerPoint(st, t, out ? fb : fa, lane(f), y1));
    // onto the landing, and across it to the next flight's lane
    const mid = out ? TOWER_LONG - TOWER_LAND / 2 : TOWER_LAND / 2;
    way.push(towerPoint(st, t, mid, lane(f), y1));
    if (f + 1 < t.flights) way.push(towerPoint(st, t, mid, lane(f + 1), y1));
  }
  // over the footbridge to the platform
  way.push(towerPoint(st, t, -t.u0, TOWER_IN - 0.5, t.top), towerPoint(st, t, -t.u0, PLAT_OUT + 0.5, t.top));
  const scale = arteryScale(st.axis, st.line, st.s);
  const platform = (m: number, v: number): Vec3 => {
    const s = st.s + m / scale;
    const f = arteryFrame(st.axis, st.line, s);
    return [f.p[0] - f.dir[1] * v * side, railY(st.axis, st.line, s) + RAIL_PLAT, f.p[1] + f.dir[0] * v * side];
  };
  way.push(platform(0, (PLAT_IN + PLAT_OUT) / 2 + 0.6));
  return { way, platform };
}

const RAIL_STONE: Tint = [0.72, 0.71, 0.69];
const CANOPY: Tint = [0.3, 0.31, 0.33];

/** One station of an elevated railway: platforms, canopies, footbridges and stair towers. */
function railStation(b: Builder, st: RailStation): void {
  const scale = arteryScale(st.axis, st.line, st.s);
  /** A box `u0`..`u1` metres along the line from the middle and `v0`..`v1` out on `side`, sloping with the deck. */
  const along = (u0: number, u1: number, v0: number, v1: number, y0: number, y1: number, side: number,
    mat: Mat, tint: Tint, style = 0, collide = true) => {
    const s0 = st.s + u0 / scale, s1 = st.s + u1 / scale;
    const a = arteryFrame(st.axis, st.line, s0), c = arteryFrame(st.axis, st.line, s1);
    const dx = c.p[0] - a.p[0], dz = c.p[1] - a.p[1], chord = Math.hypot(dx, dz) || 1;
    const nx = (-dz / chord) * side, nz = (dx / chord) * side, vc = (v0 + v1) / 2;
    const cx = (a.p[0] + c.p[0]) / 2 + nx * vc, cz = (a.p[1] + c.p[1]) / 2 + nz * vc;
    const ya = railY(st.axis, st.line, s0), yc = railY(st.axis, st.line, s1), ym = (ya + yc) / 2;
    const len = chord + 0.12, half = (v1 - v0) / 2;
    b.box(cx - len / 2, ym + y0, cz - half, cx + len / 2, ym + y1, cz + half, mat, tint, style,
      { turn: Math.atan2(dz, dx), rise: ((yc - ya) * len) / chord, detail: false, collide });
  };
  const SEG = 4;
  const gap = TOWER_LAND / 2 + 0.1;
  const MID = (PLAT_IN + PLAT_OUT) / 2;
  for (const side of [1, -1] as const) {
    for (let u = -PLAT_LONG; u < PLAT_LONG - 0.01; u += SEG) {
      const u1 = Math.min(u + SEG, PLAT_LONG);
      // the platform, standing on the deck and out past its edge, with a yellow line along it
      along(u, u1, PLAT_IN, PLAT_OUT, -1.2, RAIL_PLAT, side, Mat.Board, RAIL_STONE, Finish.Cast);
      along(u, u1, PLAT_IN, PLAT_IN + 0.5, RAIL_PLAT, RAIL_PLAT + 0.02, side, Mat.Paint, [0.78, 0.62, 0.12], 0, false);
      // the parapet along the outer edge, open where the footbridge leaves
      const wall = (a: number, c: number) => along(a, c, PLAT_OUT - 0.25, PLAT_OUT, RAIL_PLAT, RAIL_PLAT + 1.1, side, Mat.Panel, RAIL_STONE);
      if (u1 <= -gap || u >= gap) wall(u, u1);
      else {
        if (u < -gap) wall(u, -gap);
        if (u1 > gap) wall(gap, u1);
      }
      // the canopy over it, on posts along the back, with a strip light under it
      along(u, u1, PLAT_IN - 0.4, PLAT_OUT + 0.3, RAIL_PLAT + 3.5, RAIL_PLAT + 3.75, side, Mat.Metal, CANOPY);
      along(u, u1, MID - 0.15, MID + 0.15, RAIL_PLAT + 3.38, RAIL_PLAT + 3.5, side, Mat.Strip, [0.9, 0.9, 0.86], 0, false);
      if (Math.round(u / SEG) % 2 === 0 && (u + 2.2 < -gap || u + 1.8 > gap)) {
        along(u + 1.8, u + 2.2, PLAT_OUT - 0.65, PLAT_OUT - 0.25, RAIL_PLAT, RAIL_PLAT + 3.5, side, Mat.Metal, CANOPY);
      }
    }
    // the name, hung under the canopy either side of the middle
    for (const u of [-14, 14]) along(u - 2.5, u + 2.5, PLAT_OUT - 0.5, PLAT_OUT - 0.4, RAIL_PLAT + 2.2, RAIL_PLAT + 2.9, side, Mat.Strip, [0.55, 0.78, 0.72], 0, false);
    // pools of lamp light down the platform at night
    for (let u = -PLAT_LONG + 8; u <= PLAT_LONG - 8; u += 16) {
      const s = st.s + u / scale, f = arteryFrame(st.axis, st.line, s);
      b.lamps.push(f.p[0] - f.dir[1] * MID * side, railY(st.axis, st.line, s) + RAIL_PLAT + 3.3, f.p[1] + f.dir[0] * MID * side);
    }
  }
  for (const t of st.towers) railTower(b, st, t);
}

/**
 * A stair tower and its footbridge. Flights of seven run out along the line and back in two
 * lanes, turning on a landing at either end, inside four columns that carry a roof over the top;
 * the footbridge leaves the top landing across the carriageway to the platform.
 */
function railTower(b: Builder, st: RailStation, t: RailTower): void {
  const { dir } = arteryFrame(st.axis, st.line, st.s);
  const turn = Math.atan2(dir[1], dir[0]);
  /** A box in the tower's frame: `a` along the line from its first landing, `v` out from the line. */
  const put = (a0: number, a1: number, v0: number, v1: number, y0: number, y1: number, mat: Mat, tint: Tint,
    style = 0, opts: { rise?: number; collide?: boolean } = {}) => {
    const [cx, , cz] = towerPoint(st, t, (a0 + a1) / 2, (v0 + v1) / 2, 0);
    const hl = (a1 - a0) / 2, hw = (v1 - v0) / 2;
    b.box(cx - hl, y0, cz - hw, cx + hl, y1, cz + hw, mat, tint, style, { turn, detail: false, ...opts });
  };
  const rise = (t.top - t.foot) / (t.flights * TOWER_STEPS);
  const h = TOWER_STEPS * rise;
  // the outer lane goes out along the line, the inner one comes back
  const lanes: [number, number][] = [
    [TOWER_IN + TOWER_WIDE / 2 + 0.1, TOWER_IN + TOWER_WIDE - 0.2], [TOWER_IN + 0.2, TOWER_IN + TOWER_WIDE / 2 - 0.1],
  ];
  const fa = TOWER_LAND, fb = TOWER_LAND + TOWER_STEPS * TOWER_GOING;
  // A rising `rise` climbs towards local +x, which is the way the line runs, so a flight going
  // back climbs the other way. The side the tower is on mirrors nothing along the line.
  for (let f = 0; f < t.flights; f++) {
    const out = f % 2 === 0;
    const [v0, v1] = lanes[f % 2];
    const y0 = t.foot + f * h;
    for (let i = 0; i < TOWER_STEPS; i++) {
      const top = y0 + (i + 1) * rise;
      const a = out ? fa + i * TOWER_GOING : fb - (i + 1) * TOWER_GOING;
      put(a, a + TOWER_GOING, v0, v1, top - rise - 0.12, top, Mat.Board, RAIL_STONE, Finish.Boards);
    }
    // the raking slab under the steps, and a parapet along the outside of the outer lane
    const mid = y0 + h / 2 - rise;
    put(fa, fb, v0, v1, mid - 0.4, mid, Mat.Board, RAIL_STONE, Finish.Cast, { rise: out ? h : -h });
    if (out) put(fa, fb, v1 + 0.02, v1 + 0.2, mid + rise, mid + rise + 1.05, Mat.Panel, RAIL_STONE, 0, { rise: h, collide: false });
    // the landing it arrives at, across both lanes
    const [la, lb] = out ? [fb, TOWER_LONG] : [0, fa];
    put(la, lb, TOWER_IN, TOWER_IN + TOWER_WIDE, y0 + h - 0.35, y0 + h, Mat.Board, RAIL_STONE, Finish.Cast);
  }
  // a wall between the lanes, so the flights read as a stair rather than a heap of steps
  put(fa, fb, TOWER_IN + TOWER_WIDE / 2 - 0.1, TOWER_IN + TOWER_WIDE / 2 + 0.1, t.foot, t.top + 1.05, Mat.Panel, RAIL_STONE);
  // four columns and the roof over the top landing
  for (const a of [0.2, TOWER_LONG - 0.2]) for (const v of [TOWER_IN + 0.2, TOWER_IN + TOWER_WIDE - 0.2]) {
    put(a - 0.2, a + 0.2, v - 0.2, v + 0.2, t.foot - 1, t.top + 3.4, Mat.Board, RAIL_STONE, Finish.Ribbed);
  }
  put(-0.3, TOWER_LONG + 0.3, TOWER_IN - 0.3, TOWER_IN + TOWER_WIDE + 0.3, t.top + 3.4, t.top + 3.75, Mat.Metal, CANOPY);
  for (let y = t.foot + h; y < t.top + 1; y += 2 * h) {
    const [x, , z] = towerPoint(st, t, TOWER_LONG / 2, TOWER_IN + TOWER_WIDE / 2, 0);
    b.lamps.push(x, y + 2.6, z);
  }
  // The footbridge, level from the top landing out over the road to the platform's edge.
  const ba = -t.u0 - TOWER_LAND / 2, bb = -t.u0 + TOWER_LAND / 2;
  put(ba, bb, PLAT_OUT - 0.1, TOWER_IN + 0.05, t.top - 0.45, t.top, Mat.Board, RAIL_STONE, Finish.Cast);
  for (const a of [ba, bb - 0.2]) put(a, a + 0.2, PLAT_OUT, TOWER_IN, t.top, t.top + 1.1, Mat.Panel, RAIL_STONE);
}

// ---------------------------------------------------------------------------
// Night markets
//
// The forecourts the blocks keep in front of the stations would otherwise be gaps: open ground
// between the kerb and a block standing back from it for no reason anyone can see. A row of
// stalls along each one makes it a square — a counter under a canvas roof with a string of
// bulbs along its front, lit when the street lamps are — and the people standing about them
// (see pedestrians.ts) make it a market.

/** One stall: where it stands, which way its counter faces, and its canvas. */
export interface Stall {
  x: number;
  z: number;
  /** The ground it stands on. */
  y: number;
  /** Along its front, and out of its front towards the street: unit vectors. */
  t: Vec2;
  n: Vec2;
  tint: Tint;
  /** Which stall it is, for whoever keeps it and whoever is at it. */
  id: number;
}

const STALL_HALF = 1.7, STALL_DEEP = 1.3;
/** Where the row of stalls stands, out from the middle of the street. */
const STALL_V = ARTERY_HALF + 11;
const CANVAS: Tint[] = [
  [0.62, 0.16, 0.12], [0.78, 0.55, 0.14], [0.16, 0.36, 0.42], [0.3, 0.42, 0.22], [0.52, 0.5, 0.46], [0.4, 0.2, 0.36],
];

const markets = rememberBySeed<string, Stall[]>();

/** The stalls in the forecourt `court` keeps, `key` naming it. */
function marketOf(key: string, court: Forecourt): Stall[] {
  checkSeed();
  const hit = markets.get(key);
  if (hit) return hit;
  const { p, n, owner } = court;
  const t: Vec2 = [-n[1], n[0]];
  const at = (u: number, v: number): Vec2 => [p[0] + t[0] * u + n[0] * v, p[1] + t[1] * u + n[1] * v];
  const out: Stall[] = [];
  const near = blocksIn(p[0] - 90, p[1] - 90, p[0] + 90, p[1] + 90);
  const subs = stationsNear(p[0], p[1], 140);
  const rails = railStationsNear(p[0], p[1], 160);
  const h0 = hashInt(Math.round(p[0]), Math.round(p[1]), 366);
  for (let u = -36; u <= 36; u += 2 * STALL_HALF + 1.4) {
    const h = hashInt(h0, Math.round(u * 10), 367);
    // gaps in the row, so it is a market and not a terrace
    if (h % 100 < 22) continue;
    // in front of this block, and nowhere else
    if ([u - STALL_HALF, u + STALL_HALF].some((a) => blockAt(...at(a, ARTERY_HALF + 6))?.key !== owner.key)) continue;
    const corners = [at(u - STALL_HALF, STALL_V - STALL_DEEP), at(u + STALL_HALF, STALL_V - STALL_DEEP),
      at(u - STALL_HALF, STALL_V + STALL_DEEP), at(u + STALL_HALF, STALL_V + STALL_DEEP)];
    // and in front of the stall, where people stand at it
    const front = [at(u - STALL_HALF, STALL_V - STALL_DEEP - 2.5), at(u + STALL_HALF, STALL_V - STALL_DEEP - 2.5)];
    if (![...corners, ...front].every(([x, z]) => openGround(x, z, near))) continue;
    // clear of the way down into the subway, and of the stairs up to the railway
    if (subs.some((st) => [...corners, ...front].some(([x, z]) => inEntrance(st, x, z, 2.5)))) continue;
    const [cx, cz] = at(u, STALL_V);
    if (rails.some((st) => st.towers.some((tw) => {
      const c = towerPoint(st, tw, TOWER_LONG / 2, TOWER_IN + TOWER_WIDE / 2, 0);
      return Math.hypot(c[0] - cx, c[2] - cz) < 10;
    }))) continue;
    // on ground flat enough to stand a counter on
    let lo = Infinity, hi = -Infinity;
    for (const [x, z] of corners) {
      const g = groundAt(x, z);
      lo = Math.min(lo, g);
      hi = Math.max(hi, g);
    }
    if (hi - lo > 0.7) continue;
    // facing the street, which is back towards the line
    out.push({ x: cx, z: cz, y: hi, t, n: [-n[0], -n[1]], tint: CANVAS[(h >>> 8) % CANVAS.length], id: h });
  }
  if (markets.size > 2048) markets.clear();
  markets.set(key, out);
  return out;
}

/** Every market with a stall within `r` of a point: the stalls of each, in a row. */
export function marketsNear(x: number, z: number, r: number): Stall[][] {
  const out: Stall[][] = [];
  for (const axis of [0, 1] as const) {
    const across = axis === 0 ? z : x, along = axis === 0 ? x : z;
    for (const line of arteryLines(across, r + WANDER)) {
      const sub = hasSubway(axis, line);
      if (!sub && !hasRail(axis, line)) continue;
      const spacing = sub ? SUB_SPACING : RAIL_SPACING;
      for (let k = Math.floor((along - r - WANDER) / spacing) - 1; k <= Math.ceil((along + r + WANDER) / spacing) + 1; k++) {
        const courts = sub ? [forecourtOf(axis, line, k)] : railStop(axis, line, k)?.sides ?? [];
        courts.forEach((court, i) => {
          if (!court || Math.hypot(court.p[0] - x, court.p[1] - z) > r + 60) return;
          const stalls = marketOf(`${axis},${line},${k},${i}`, court);
          if (stalls.length) out.push(stalls);
        });
      }
    }
  }
  return out;
}

/** A stall: a counter and a back table under a canvas roof on four posts, with bulbs along the front. */
function stall(b: Builder, s: Stall): void {
  const turn = Math.atan2(s.t[1], s.t[0]);
  /** A box `a` along the stall's front and `c` out of it towards the street, from its middle. */
  const put = (a0: number, a1: number, c0: number, c1: number, y0: number, y1: number, mat: Mat, tint: Tint, collide = true) => {
    const ac = (a0 + a1) / 2, cc = (c0 + c1) / 2;
    const x = s.x + s.t[0] * ac + s.n[0] * cc, z = s.z + s.t[1] * ac + s.n[1] * cc;
    const hl = (a1 - a0) / 2, hw = (c1 - c0) / 2;
    b.box(x - hl, s.y + y0, z - hw, x + hl, s.y + y1, z + hw, mat, tint, 0, { turn, detail: false, collide });
  };
  const wood: Tint = [0.5, 0.4, 0.3], steel: Tint = [0.3, 0.31, 0.32];
  const H = STALL_HALF, D = STALL_DEEP;
  put(-H + 0.1, H - 0.1, D - 0.7, D - 0.1, -0.3, 1.05, Mat.Panel, wood);
  put(-H + 0.1, H - 0.1, -D + 0.1, -D + 0.6, -0.3, 1.35, Mat.Panel, wood);
  for (const a of [-H + 0.08, H - 0.08]) for (const c of [-D + 0.08, D - 0.08]) put(a - 0.06, a + 0.06, c - 0.06, c + 0.06, -0.3, 2.5, Mat.Metal, steel);
  // the canvas, overhanging the counter, and a valance hanging off its front
  put(-H - 0.15, H + 0.15, -D - 0.1, D + 0.45, 2.5, 2.6, Mat.Paint, s.tint);
  put(-H - 0.15, H + 0.15, D + 0.38, D + 0.45, 2.15, 2.5, Mat.Paint, s.tint, false);
  // a string of bulbs along the front, under the valance
  for (let i = 0; i < 5; i++) {
    const a = -H + 0.25 + (i * (2 * H - 0.5)) / 4;
    put(a - 0.07, a + 0.07, D + 0.3, D + 0.44, 2.02, 2.14, Mat.Lamp, [1, 1, 1], false);
  }
  b.lamps.push(s.x + s.n[0] * D, s.y + 2.2, s.z + s.n[1] * D);
}

/** The markets whose stalls stand in this region. */
function marketsIn(b: Builder, x0: number, z0: number): void {
  for (const stalls of marketsNear(x0 + REGION / 2, z0 + REGION / 2, REGION)) {
    for (const s of stalls) if (s.x >= x0 && s.x < x0 + REGION && s.z >= z0 && s.z < z0 + REGION) stall(b, s);
  }
}
