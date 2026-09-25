// The city built on the road network: every block is a polygon rather than a cell of a grid,
// so the pieces that used to be four axis-aligned boxes are now walls of turned boxes wrapped
// round an outline, with the inside filled by strips that nobody ever sees.

import { hashInt, Rng } from "../math";
import {
  assembleRegion, Builder, CELL, LIFT_SIZE, REGION, REGION_CELLS, type Part, type RegionMesh,
} from "./generate";
import { Finish, Mat, Win, type Tint } from "./materials";
import { PAINT_COLORS } from "../vehicles/models";
import {
  ARTERY, ARTERY_HALF, arteryFrame, arteryLines, blocksIn, cellOf, checkSeed, grain, RIVER_HALF,
  neighbours, QUAY, QUAY_RISE, rememberBySeed, riverFrame, riverLines, riverNear, ROAD, streetsOf, TERRACE, terrainAt, TILE,
  waterLevel,
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
const WALK = 7;

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
    for (const [s0, s1] of runs) {
      if (s1 - s0 < 0.3) continue;
      const mx = a[0] + (vx / l) * ((s0 + s1) / 2) - nx * depth / 2;
      const mz = a[1] + (vz / l) * ((s0 + s1) / 2) - nz * depth / 2;
      b.box(mx - (s1 - s0) / 2, y0, mz - depth / 2, mx + (s1 - s0) / 2, top, mz + depth / 2,
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

  // The block is a terrace cut into the hill: flat at its own level, with the difference to
  // the ground round it made up by the wall its pavement stands on. Every block gets this,
  // slivers included — the ground is not laid under blocks, so one left bare is a hole.
  const base = blockBase(poly);
  let lowest = base;
  for (const [px, pz] of poly) lowest = Math.min(lowest, groundAt(px, pz));
  extrude(b, poly, lowest - 16, base, Mat.Board, tint, Finish.Cast, { wall: 4, strip: 14, detail: false });
  slab(b, poly, base, base + 0.18, Mat.Paving, [1, 1, 1]);
  if (spanOf(poly) < 16) return; // a sliver left between streets; leave it as pavement
  const face = shrink(poly, WALK);
  if (face.length < 3 || spanOf(face) < 12) return;

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
  const stair = perimeterStair(b, poly, base + 0.18, E, tint);
  parapet(b, deck, E, 1.05, tint, stair.arrival ? [stair.arrival] : []);
  // a block whose perimeter is too short to climb has to have the lift, or its deck — and the
  // flyer standing on it — is somewhere nothing can reach
  blockLifts(b, poly, base, E, tint, stair.treads, !stair.arrived);
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
      const c = centroid(cap);
      if (top - E > 220) {
        // a mast and a light on the ones that stand above everything
        const mast = r.uniform(20, 70);
        b.box(c[0] - 0.45, top + 3, c[1] - 0.45, c[0] + 0.45, top + 3 + mast, c[1] + 0.45, Mat.Metal, tint, 0, { detail: false });
        b.box(c[0] - 0.7, top + 3 + mast, c[1] - 0.7, c[0] + 0.7, top + 4.4 + mast, c[1] + 0.7, Mat.Beacon, tint, 0, { collide: false });
      } else if (r.chance(0.4)) {
        b.box(c[0] - 0.6, top + 3, c[1] - 0.6, c[0] + 0.6, top + 3.9, c[1] + 0.6, Mat.Beacon, tint, 0, { collide: false });
      }
    }
  });
}

// The terrace and the tile live with the terrain field: between them they set the steepest
// ground it is allowed to ask for, and neither can be changed here alone.

/** One flat stretch of street: a turned rectangle at one height. */
interface Piece {
  cx: number;
  cz: number;
  ux: number;
  uz: number;
  hl: number; // half length, along u
  hw: number; // half width, across
  /** Height on the centreline at the stretch's middle. */
  y: number;
  street: Street;
  /** Stations along the street this stretch runs between, and the street's length. */
  s0: number;
  s1: number;
  len: number;
  /**
   * How much the surface climbs per metre along `u`.
   *
   * A stretch is a plane, not a terrace. Everything else in this city is an axis-aligned box
   * and a turn about the vertical, and a hillside built out of those can only be steps — but
   * a road built out of them is a flight of stairs, which is not what a road is. So a stretch
   * is laid as one tilted slab (see `rise` in mesh.ts) and the cut into stretches is a cut
   * into straight gradients, not into half-metre treads.
   */
  grade: number;
}

/** Surface height of a stretch at a station along its street. */
function pieceYAt(p: Piece, s: number): number {
  const mid = (p.s0 + p.s1) / 2;
  return p.y + p.grade * (Math.max(p.s0, Math.min(p.s1, s)) - mid);
}

/** Surface height of a stretch under a point, which is taken to lie on it. */
function pieceYOn(p: Piece, x: number, z: number): number {
  const u = (x - p.cx) * p.ux + (z - p.cz) * p.uz;
  return p.y + p.grade * Math.max(-p.hl, Math.min(p.hl, u));
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
 * ground is what they all agree on.
 */
function cornerHeight(x: number, z: number): number {
  return arterialAt(x, z, 18) ?? groundAt(x, z);
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
  const yAt = (s: number) => {
    const c = Math.max(0, Math.min(L, s));
    const x = ax + ux * c, z = az + uz * c;
    // An arterial simply follows the ground, and now follows it as a gradient rather than as
    // the terrace it stands nearest. Consecutive stretches of one are separate streets that
    // meet end to end, and both read this at the same point, so they still agree exactly.
    if (!corners) return terrainAt(x, z);
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
    // than its height, keeps every street that shares the corner agreeing to within the
    // terrace the corner was rounded to, and lets all of them follow the hill down.
    const ground = terrainAt(ax + ux * c, az + uz * c);
    const dA = yA - terrainAt(ax, az), dB = yB - terrainAt(bx, bz);
    const own = wA + wB >= 1
      ? ground + (dA * wA + dB * wB) / (wA + wB)
      : ground + dA * wA + dB * wB;
    // Where this street lies in a main road it is that road's surface, not its own — a side
    // street leaving an arterial at a shallow angle stays in the carriageway for thirty or
    // forty metres. Eased out over the same distance a junction is, so that leaving the road
    // is a ramp off it rather than the step off its edge that it was.
    const over = arterialBlend(x, z, st.half + 2, FADE);
    return over ? own + (over.y - own) * over.w : own;
  };
  // Nothing is laid over the water, and nothing is laid inside a main road either: where a
  // side street runs into an arterial, the arterial's own carriageway is the junction, and a
  // second slab over the top of it at a slightly different level is a step across the road and
  // the lip a car catches on. The side street stops at the kerb, which is what a side street
  // does, and its approach is already at the main road's level to meet it.
  const wet = (s: number) => {
    const x = ax + ux * s, z = az + uz * s;
    if (corners && arterialAt(x, z, 0) !== null) return true;
    const r = riverNear(x, z, RIVER_HALF + QUAY + st.half);
    return !!r && r.dist < RIVER_HALF + QUAY + 2;
  };
  const out: Piece[] = [];
  const push = (s0: number, s1: number, ya: number, yb: number) => {
    const m = (s0 + s1) / 2;
    out.push({
      cx: ax + ux * m, cz: az + uz * m, ux, uz, hl: (s1 - s0) / 2, hw,
      y: (ya + yb) / 2, grade: (yb - ya) / (s1 - s0), street: st, s0, s1, len: L,
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
  const ys: number[] = [], dry: boolean[] = [];
  for (let k = 0; k <= n; k++) {
    const s = s0 + ((s1 - s0) * k) / n;
    ys.push(yAt(s));
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
      // the straight line from i to j, tested against every sample it passes over
      let off = 0;
      for (let k = i + 1; k < j; k++)
        off = Math.max(off, Math.abs(ys[k] - (ys[i] + ((ys[j] - ys[i]) * (k - i)) / (j - i))));
      if (off > SAG) break;
    }
    j--; // the last one that fitted
    if (j <= i) j = i + 1;
    push(at(i), at(j), ys[i], ys[j]);
    i = j;
  }
  return out;
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

/**
 * The top of the highest stretch of street laid over a point, or null where no road covers it.
 *
 * Which is not the same question as the one `pieceAt` asks. A carriageway is a flat slab the
 * whole way across, cut to the ground along its own middle, so where two streets cross on a
 * slope one of them laps over the other a metre higher — and what anything standing there sits
 * on is whichever of them ended up on top, not the one whose road it nominally is.
 */
export function roadTopAt(x: number, z: number): number | null {
  return topPieceAt(x, z)?.[1] ?? null;
}

/** The lowest stretch laid over a point. Against `roadTopAt` it says what a junction disagrees by. */
export function roadLowAt(x: number, z: number): number | null {
  let low: number | null = null;
  for (const p of piecesNear(x, z)) {
    const dx = x - p.cx, dz = z - p.cz;
    if (Math.abs(dx * p.ux + dz * p.uz) > p.hl || Math.abs(dz * p.ux - dx * p.uz) > p.hw) continue;
    const y = pieceYOn(p, x, z);
    if (low === null || y < low) low = y;
  }
  return low;
}

/**
 * The highest stretch of street laid over a point, with its surface there, or null where no
 * road covers it. A stretch is a plane, so which of two is on top is asked at the point, not
 * of the stretches as wholes.
 */
function topPieceAt(x: number, z: number): [Piece, number] | null {
  let top: [Piece, number] | null = null;
  for (const p of piecesNear(x, z)) {
    const dx = x - p.cx, dz = z - p.cz;
    if (Math.abs(dx * p.ux + dz * p.uz) > p.hl || Math.abs(dz * p.ux - dx * p.uz) > p.hw) continue;
    const y = pieceYOn(p, x, z);
    if (top === null || y > top[1]) top = [p, y];
  }
  return top;
}

/**
 * The line a vehicle rides along a road, which is now simply the road.
 *
 * This used to reconstruct the slope the terraces had been cut from, because the asphalt
 * itself was a flight of half-metre treads and a car reading its height off them dropped a
 * terrace three times a second down a flank. A stretch is a plane now, so the surface and the
 * line a car rides along it are the same thing, and the car sits on the road rather than
 * hovering a quarter-metre over the middle of each tread.
 */
export function roadRideAt(x: number, z: number): number | null {
  return topPieceAt(x, z)?.[1] ?? null;
}

/** The street surface under a point, if there is one: the lowest stretch covering it. */
function pieceAt(pieces: Piece[], x: number, z: number): number | null {
  let y: number | null = null;
  for (const p of pieces) {
    const dx = x - p.cx, dz = z - p.cz;
    if (Math.abs(dx * p.ux + dz * p.uz) > p.hl || Math.abs(dz * p.ux - dx * p.uz) > p.hw) continue;
    const at = pieceYOn(p, x, z);
    if (y === null || at < y) y = at;
  }
  return y;
}

/**
 * The streets whose middle is in this region, laid as turned slabs.
 *
 * Every stretch of a street this region owns is laid, however far the far end of it reaches
 * out of the region. Taking them from the list the ground is cut against instead looked like
 * the same thing and was not: that list is pruned to a tile beyond the region, which on level
 * ground is no loss, because a street there is one long stretch that reaches the region from
 * wherever it lies. On a slope the same street is cut into a stretch every few metres, and the
 * ones past the pruning were dropped — while the ground under them was still skipped as being
 * under a street. What that left was a hole in the road with nothing beneath it at all.
 */
function streets(b: Builder, x0: number, z0: number): void {
  const t: Tint = [1, 1, 1];
  for (const st of streetsIn(x0, z0, x0 + REGION, z0 + REGION))
    for (const p of piecesOf(st)) {
      // one tilted slab: flat underneath, and its top the plane of the gradient it carries
      b.box(p.cx - p.hl, p.y - 6, p.cz - p.hw, p.cx + p.hl, p.y, p.cz + p.hw, Mat.Asphalt, t, 0,
          { seed: 0, detail: false, turn: Math.atan2(p.uz, p.ux), rise: p.grade * 2 * p.hl });
      parkAlong(b, p);
      markings(b, p);
      lamps(b, p);
    }
}

/** Stations of a stretch of street that are clear of the junctions at either end. */
function clearOf(p: Piece): [number, number] {
  const clear = p.street.half * 1.6 + 2;
  return [Math.max(p.s0, clear), Math.min(p.s1, p.len - clear)];
}

/** A thin painted stripe along the street, from station s0 to s1, `off` to one side. */
function stripe(b: Builder, p: Piece, s0: number, s1: number, off: number, w: number): void {
  if (s1 - s0 < 0.2) return;
  const [ax, az] = p.street.a, m = (s0 + s1) / 2;
  const x = ax + p.ux * m - p.uz * off, z = az + p.uz * m + p.ux * off;
  // paint lies on the road, so it takes the road's gradient with it
  const y = pieceYAt(p, m);
  b.box(x - (s1 - s0) / 2, y, z - w / 2, x + (s1 - s0) / 2, y + 0.02, z + w / 2, Mat.Paint, PAINT_LINE, 0,
    { collide: false, detail: true, turn: Math.atan2(p.uz, p.ux), rise: p.grade * (s1 - s0) });
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
  const [from, to] = clearOf(p);
  const st = p.street, [ax, az] = st.a;
  const SPACING = 32, H = 8.5;
  for (let s = Math.ceil(from / SPACING) * SPACING; s < to; s += SPACING) {
    const side = Math.round(s / SPACING) % 2 === 0 ? 1 : -1;
    const off = side * (st.half + 0.8);
    const x = ax + p.ux * s - p.uz * off, z = az + p.uz * s + p.ux * off;
    const kerb = pieceYAt(p, s);
    const y0 = kerb - 3, top = kerb + H;
    b.box(x - 0.13, y0, z - 0.13, x + 0.13, top, z + 0.13, Mat.Metal, [1, 1, 1], 0, { detail: false });
    // the arm and head, out over the road
    const reach = -side * 1.8;
    const hx = x - p.uz * reach, hz = z + p.ux * reach;
    b.box(hx - 1.1, top - 0.12, hz - 0.1, hx + 1.1, top, hz + 0.1, Mat.Metal, [1, 1, 1], 0,
      { collide: false, detail: true, turn: Math.atan2(p.ux, -p.uz) });
    const lx = x - p.uz * reach * 1.6, lz = z + p.ux * reach * 1.6;
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
      // on whatever is laid over the spot rather than on this stretch's own level: near a
      // junction on a slope the crossing street's slab lies over this one and a car left at
      // its own kerb height is buried to the windows in the other road
      const own = pieceYAt(p, s);
      const y = Math.max(own, roadTopAt(x, z) ?? own);
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
const BAY = 8;
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
  b: Builder, x0: number, z0: number, covered: (x: number, z: number) => Cover | null, lanes: Piece[],
): void {
  const t: Tint = [0.96, 0.96, 0.97];
  const BED: Tint = [0.30, 0.31, 0.27];
  const N = Math.round(REGION / TILE);
  const P = APRON_TILES;
  const W = N + 2 * P; // tiles across, with padding so the aprons of both sides of a seam agree
  const CW = W + 1; // corners
  const node = (i: number, j: number) => i * CW + j;
  const C = new Float64Array(CW * CW);

  for (let i = 0; i <= W; i++) {
    for (let j = 0; j <= W; j++) {
      const x = x0 + (i - P) * TILE, z = z0 + (j - P) * TILE;
      let h = terrainAt(x, z), seed = -Infinity;
      const under = pieceAt(lanes, x, z);
      const over = pieceTopAt(lanes, x, z);
      const on = covered(x, z);
      if (under !== null) h = Math.min(h, under - 0.05);
      if (on) h = Math.min(h, on.base - 0.05);
      // Inside the channel the ground is riverbed, and the bed is under the water, not level
      // with it: left at the height the land happens to be, it stands up through the surface
      // wherever it is a few centimetres high. How far back that cut runs, and what happens
      // between it and the quay, is `channelCap`.
      h = Math.min(h, channelCap(x, z));
      if (over !== null) seed = Math.max(seed, over);
      if (on) seed = Math.max(seed, on.base);
      // A road standing over the ground has to be reachable from it, but no higher than the
      // apron can carry within the padding this grid was given, or two regions sharing a
      // corner would not agree on it.
      C[node(i, j)] = seed === -Infinity ? h : Math.min(Math.max(h, seed), h + (P - 1) * TILE * APRON_GRADE);
    }
  }

  // The embankment: ground climbs to whatever stands over it at a slope a runner can take,
  // spreading until it runs back into the hillside. Four sweeps carry it as far as it goes.
  const rise = TILE * APRON_GRADE;
  for (const k of [0, 1, 2, 3]) {
    const iFwd = k === 0 || k === 2, jFwd = k === 0 || k === 1;
    for (let a = 0; a <= W; a++) {
      const i = iFwd ? a : W - a;
      for (let c = 0; c <= W; c++) {
        const j = jFwd ? c : W - c;
        const o = node(i, j);
        let want = C[o];
        if (i > 0) want = Math.max(want, C[node(i - 1, j)] - rise);
        if (i < W) want = Math.max(want, C[node(i + 1, j)] - rise);
        if (j > 0) want = Math.max(want, C[node(i, j - 1)] - rise);
        if (j < W) want = Math.max(want, C[node(i, j + 1)] - rise);
        // never above what covers this corner — the cap came first and still holds
        C[o] = Math.min(want, capOf(x0 + (i - P) * TILE, z0 + (j - P) * TILE, lanes, covered));
      }
    }
  }

  for (let i = P; i < P + N; i++) {
    const x = x0 + (i - P) * TILE;
    let run: { z: number; h: number; drowned: boolean } | null = null;

    const endRun = (z: number) => {
      if (run) b.box(x, run.h - 16, run.z, x + TILE, run.h, z, Mat.Asphalt, run.drowned ? BED : t, 0, { seed: 0, detail: false });
      run = null;
    };

    for (let j = P; j < P + N; j++) {
      const z = z0 + (j - P) * TILE;
      const cx = x + TILE / 2, cz = z + TILE / 2;
      // Only a tile well inside a block is left out, where the block's own plinth is a solid
      // extrusion that fills it. Anything else is laid and held down by its corners.
      if (covered(cx, cz)?.deep) {
        endRun(z);
        continue;
      }
      const c00 = C[node(i, j)], c10 = C[node(i + 1, j)];
      const c01 = C[node(i, j + 1)], c11 = C[node(i + 1, j + 1)];
      const gx = ((c10 + c11) - (c00 + c01)) / 2;
      const gz = ((c01 + c11) - (c00 + c10)) / 2;
      const h = (c00 + c10 + c01 + c11) / 4;
      const r = riverNear(cx, cz, RIVER_HALF + TILE_DIAG + 4);
      const w = r ? waterLevel(r.line) : Infinity;
      // Only ground that is actually under a river is riverbed. Comparing against a water
      // level of Infinity where there is no river said yes to every tile in the city, so
      // every stretch of open ground was laid in silt: a dark floor a little below the
      // roadway all round it, which is a hole in the road with mud at the bottom.
      const drowned = w !== Infinity && h < w - 0.3;
      // Only level tiles join into a run; a sloping one is its own box, since a run of them
      // would be one plane pretending to be several.
      if (gx || gz) {
        endRun(z);
        b.box(x, h - 16, z, x + TILE, h, z + TILE, Mat.Asphalt, drowned ? BED : t, 0,
          { seed: 0, detail: false, rise: gx, riseZ: gz });
      } else if (!run || run.h !== h || run.drowned !== drowned) {
        endRun(z);
        run = { z, h, drowned };
      }
    }
    endRun(z0 + REGION);
  }
}

/** The lowest thing laid over a point that the ground there has to stay under. */
function capOf(
  x: number, z: number, lanes: Piece[], covered: (x: number, z: number) => Cover | null,
): number {
  let cap = Infinity;
  const under = pieceAt(lanes, x, z);
  if (under !== null) cap = Math.min(cap, under - 0.05);
  const on = covered(x, z);
  if (on) cap = Math.min(cap, on.base - 0.05);
  // The channel is a cap like any other. Cutting the bed when the corner heights are first
  // taken and leaving it out of this let the embankment sweeps raise it straight back up
  // again, since they are allowed to climb to whatever the cap says — and the bed came back
  // to the waterline, taking the staircase with it.
  cap = Math.min(cap, channelCap(x, z));
  return cap;
}

/** The highest stretch of street laid over a point, from a list already gathered. */
function pieceTopAt(pieces: Piece[], x: number, z: number): number | null {
  let y: number | null = null;
  for (const p of pieces) {
    const dx = x - p.cx, dz = z - p.cz;
    if (Math.abs(dx * p.ux + dz * p.uz) > p.hl || Math.abs(dz * p.ux - dx * p.uz) > p.hw) continue;
    const at = pieceYOn(p, x, z);
    if (y === null || at > y) y = at;
  }
  return y;
}

/** Whether a point is in a block, how far in, and the level of that block's pavement. */
interface Cover {
  deep: boolean;
  base: number;
}

/** The level a block is built at: the ground under its middle. */
function blockBase(poly: Vec2[]): number {
  const c = centroid(poly);
  return groundAt(c[0], c[1]);
}

/** A region of the city, built on the road network instead of the grid. */
export function buildPlanRegion(rx: number, rz: number, faceCull = true): RegionMesh {
  const x0 = rx * REGION, z0 = rz * REGION;
  const parts: Part[] = [];
  // the polygons of every block that reaches this region, for masking the ground under them
  const shapes = blocksIn(x0 - 200, z0 - 200, x0 + REGION + 200, z0 + REGION + 200)
    .map((s) => cellOf(s))
    .filter((p): p is Vec2[] => !!p && p.length >= 3);
  const covers = shapes.map((p) => ({ p, inner: shrink(p, 3.5), base: blockBase(p) }));
  const covered = (x: number, z: number): Cover | null => {
    for (const c of covers)
      if (inPoly(c.p, x, z)) return { deep: c.inner.length >= 3 && inPoly(c.inner, x, z), base: c.base };
    return null;
  };
  const ground = new Builder(new Rng(hashInt(rx, rz, 5)));
  // as far out as the embankments reach, or a road just past the seam raises no ground here
  const reach = APRON_TILES * TILE;
  const lanes = streetPieces(x0 - reach, z0 - reach, x0 + REGION + reach, z0 + REGION + reach);
  terrain(ground, x0, z0, covered, lanes);
  streets(ground, x0, z0);
  arterialFill(ground, x0, z0);
  bridges(ground, x0, z0);
  rails(ground, x0, z0);
  waterfront(ground, x0, z0);
  river(ground, x0, z0);
  vessels(ground, x0, z0);
  parts.push({ ci: rx * 100000, cj: rz * 100000, b: ground });
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

export { ROAD };

/**
 * Where the runner starts on the network city: standing in the middle of an arterial.
 *
 * Picking a spot and checking it against one nearby block was not enough — `blocksIn` hands
 * back whichever site comes first, not the one whose block the point is actually in, so being
 * outside *that* block meant nothing and the runner started inside a building, wedged, unable
 * to move a step. An arterial's centreline is the one place in the city guaranteed to be clear
 * of every block, because the blocks are cut back off it by construction.
 */
export function planSpawn(): { x: number; y: number; z: number; yaw: number } {
  // Best of all, on the bank facing the nearest bridge: the river, the bridge, the quays and
  // the boats are the first thing seen rather than something a kilometre away to go and find.
  let best: { x: number; y: number; z: number; yaw: number } | null = null, bd = Infinity;
  for (const axis of [1, 0] as const)
    for (const line of arteryLines(0, ARTERY * 2.5))
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
  deck: number;
  water: number;
}

const crossCache = rememberBySeed<string, Crossing[]>();
/** Shortest an approach ramp may be, whatever the climb. */
const RAMP = 24;
/** Steepest an approach ramp may be; past this it is a wall, not a road. */
const RAMP_GRADE = 0.08;

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
    const deck = Math.max(surface(a - 6), surface(b)) + 1.2;
    // A deck that cannot clear the water is no bridge, and `span` declines to build one. It
    // must not be in this list either, or the traffic rides a crossing that was never built.
    if (deck < waterLevel(r.line) + 5) return;
    out.push({ s0: a, s1: b, a0: foot(a, -1, deck), a1: foot(b, 1, deck), water: waterLevel(r.line), deck });
  };
  /** Height of whatever a vehicle runs on at a station: the carriageway, else the ground. */
  const surface = (s: number) => {
    const { p } = arteryFrame(axis, line, s);
    return roadRideAt(p[0], p[1]) ?? terrainAt(p[0], p[1]);
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
      if (roadRideAt(p[0], p[1]) === null) continue;
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
    return spanY(axis, line, c, s);
  }
  return roadRideAt(x, z) ?? terrainAt(x, z);
}

/**
 * Height of a bridge's surface at a station: the deck over the crossing itself, and the climb
 * up to it from the road on the bank over either ramp.
 *
 * Taken on the centreline, because this is what the deck is built from and a bay of deck has
 * one height across its width. The traffic reads the same function, so the two cannot part.
 */
function spanY(axis: 0 | 1, line: number, c: Crossing, s: number): number {
  const foot = s < c.s0 ? c.a0 : c.a1;
  const p = arteryFrame(axis, line, foot).p;
  const bank = roadRideAt(p[0], p[1]) ?? terrainAt(p[0], p[1]);
  const t = s < c.s0 ? (s - c.a0) / (c.s0 - c.a0) : s > c.s1 ? (c.a1 - s) / (c.a1 - c.s1) : 1;
  const e = Math.max(0, Math.min(1, t));
  return bank * (1 - e) + c.deck * e;
}

function bridges(b: Builder, x0: number, z0: number): void {
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
          span(b, axis, line, c, t, x0, z0);
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
  return {
    p: [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2],
    dir: [dx / chord, dz / chord],
    turn: Math.atan2(dz, dx),
    chord,
    len: chord + 2 * (halfW * MITRE + 0.15),
    // The box runs a little past both of its own ends, so a climb given for the chord has to
    // be stretched over the box to keep the same gradient — or every bay would be a shade
    // flatter than the one it has to meet, and the joints would step again.
    riseOf: (climb: number) => (climb * (chord + 2 * (halfW * MITRE + 0.15))) / chord,
  };
}

/** One bridge: deck, parapets and piers, from station `s0` to `s1` along the road. */
function span(
  b: Builder, axis: 0 | 1, line: number, c: Crossing, t: Tint, x0: number, z0: number,
): void {
  const { s0, s1, deck } = c;
  const HALF = ARTERY_HALF + 2;
  const STEP = 9;
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
    const ya = spanY(axis, line, c, s), yb = spanY(axis, line, c, s + STEP);
    const mid = (ya + yb) / 2, rise = riseOf(yb - ya);
    const put = (halfW: number, y0: number, y1: number, off: number, mat: Mat, style = 0, opts = {}) => {
      const cx = p[0] - dir[1] * off, cz = p[1] + dir[0] * off;
      b.box(cx - len / 2, y0, cz - halfW, cx + len / 2, y1, cz + halfW, mat, t, style, { turn, rise, ...opts });
    };
    put(HALF, mid - 2.2, mid, 0, Mat.Board, Finish.Cast, { detail: false });
    put(0.4, mid, mid + 1.15, HALF - 0.4, Mat.Panel);
    put(0.4, mid, mid + 1.15, -(HALF - 0.4), Mat.Panel);
  }
  // piers, standing on the bed clear of the water
  const piers = Math.max(1, Math.round((s1 - s0) / 46));
  for (let k = 1; k < piers; k++) {
    const s = s0 + ((s1 - s0) * k) / piers;
    const { p } = arteryFrame(axis, line, s);
    if (p[0] < x0 || p[0] >= x0 + REGION || p[1] < z0 || p[1] >= z0 + REGION) continue;
    const foot = groundAt(p[0], p[1]);
    b.box(p[0] - 3.4, foot - 3, p[1] - 3.4, p[0] + 3.4, deck - 2.2, p[1] + 3.4, Mat.Board, t, Finish.Ribbed, { detail: false });
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
  const y = sum / n + RAIL_RISE;
  if (railCache.size > 4096) railCache.clear();
  railCache.set(key, y);
  return y;
}

/** Which bay of the deck a station falls in. */
function railBayAt(s: number): number {
  return Math.floor(s / RAIL_BAY);
}

/** The level of bay `k` with the corners taken off, which is what actually gets built. */
function railLevel(axis: 0 | 1, line: number, k: number): number {
  const SPAN = 6;
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

export function hasRail(axis: 0 | 1, line: number): boolean {
  return hashInt(axis, line, 320) % 100 < 26;
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
        const { p, dir, turn, len, riseOf } = bayOf(axis, line, k * RAIL_BAY, (k + 1) * RAIL_BAY, HALF);
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
          b.box(cx - len / 2, y0, cz - halfW, cx + len / 2, y1, cz + halfW, mat, tn, style,
            { turn, rise, detail: false });
        };
        put(HALF, y - DEEP, y, 0, Mat.Board, t, Finish.Cast); // deck
        put(0.3, y, y + 0.9, 4.9, Mat.Panel, t); // upstands
        put(0.3, y, y + 0.9, -4.9, Mat.Panel, t);
        for (const off of [-2.6, -1.1, 1.1, 2.6]) put(0.09, y, y + 0.16, off, Mat.Metal, steel); // rails
        // a pier every third bay, down to whatever the ground is doing underneath
        if (((k % 3) + 3) % 3 === 0) {
          const foot = groundAt(p[0], p[1]);
          b.box(p[0] - 1.5, foot - 3, p[1] - 1.5, p[0] + 1.5, y - DEEP, p[1] + 1.5, Mat.Board, t, Finish.Ribbed, { detail: false });
        }
      }
    }
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
  b: Builder, poly: Vec2[], base: number, top: number, tint: Tint,
): { treads: Vec2[]; arrived: boolean; arrival?: Vec2 } {
  const RISE = 0.4, RUN = 1.15, WIDE = 3.4, SLAB = 0.42;
  const treads: Vec2[] = [];
  const gave = (arrived: boolean, arrival?: Vec2) => ({ treads, arrived, arrival });
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

  let y = base;
  let last: { m: Vec2; leg: ReturnType<typeof legOf> } | null = null;
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
      b.box(mx - span / 2, crown - SLAB, mz - WIDE / 2, mx + span / 2, crown, mz + WIDE / 2,
        Mat.Board, tint, Finish.Cast, { turn: leg.turn, rise, detail: false });
      // the parapet, raking alongside in one piece
      const edge = WIDE / 2 - 0.11;
      const px = mx + leg.nx * edge, pz = mz + leg.nz * edge;
      b.box(px - span / 2, crown, pz - 0.11, px + span / 2, crown + 1.05, pz + 0.11,
        Mat.Panel, tint, 0, { turn: leg.turn, rise, collide: false });
      for (let i = 0; i < steps; i++) {
        const sy = stepY(i), s = i * run + run / 2;
        const tx = leg.a[0] + leg.ux * s, tz = leg.a[1] + leg.uz * s;
        treads.push([tx, tz]);
        last = { m: [tx, tz], leg };
        b.box(tx - run / 2, sy - 0.55, tz - WIDE / 2, tx + run / 2, sy, tz + WIDE / 2,
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
    b.box(v[0] - WIDE / 2, y - SLAB, v[1] - WIDE / 2, v[0] + WIDE / 2, y, v[1] + WIDE / 2,
      Mat.Board, tint, Finish.Cast, { turn: leg.turn, detail: false });
    // the parapet carried round the landing as far as the corner, so the hand never leaves it
    const lx = v[0] - leg.ux * (WIDE / 4) + leg.nx * (WIDE / 2 - 0.11);
    const lz = v[1] - leg.uz * (WIDE / 4) + leg.nz * (WIDE / 2 - 0.11);
    b.box(lx - WIDE / 4, y, lz - 0.11, lx + WIDE / 4, y + 1.05, lz + 0.11,
      Mat.Panel, tint, 0, { turn: leg.turn, collide: false });
    treads.push([v[0], v[1]]);
  }

  // Where it arrives, a landing reaching in from the stair to the edge of the deck. Laid at
  // the last tread and square to the flight that got there, not at a fixed corner of the
  // outline square to the world, which is where it used to go whichever way the stair ran.
  if (y < top - 0.6 || !last) return gave(false);
  const { m, leg } = last;
  // pushed in far enough to get right over the deck edge and a little way on to it, and set
  // three centimetres under the deck so the two do not argue over the strip they share
  const cx = m[0] - leg.nx * 1.2, cz = m[1] - leg.nz * 1.2;
  b.box(cx - WIDE / 2, top - 1.4, cz - (WIDE / 2 + 0.6), cx + WIDE / 2, top - 0.03, cz + (WIDE / 2 + 0.6),
    Mat.Deck, tint, 0, { turn: leg.turn, detail: false });
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
  b: Builder, poly: Vec2[], base: number, E: number, tint: Tint, avoid: Vec2[], must = false,
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
    b.lift(x - h, z - h, x + h, z + h, base + 0.18, top);
    // the mast stands on the kerb beside the platform, not in front of it
    const side = h * (Math.abs(ux) + Math.abs(uz)) + 0.5;
    const kx = mx + nx * 0.4 + ux * side, kz = mz + nz * 0.4 + uz * side;
    b.box(kx - 0.18, base + 0.18, kz - 0.18, kx + 0.18, top + 3.4, kz + 0.18, Mat.Metal, tint, 0, { detail: false });
    b.box(kx - 0.24, top + 3.4, kz - 0.24, kx + 0.24, top + 3.8, kz + 0.24, Mat.Beacon, tint, 0, { collide: false });
    b.box(kx - 0.2, base + 2.6, kz - 0.2, kx + 0.2, base + 3.2, kz + 0.2, Mat.Glow, tint, 0, { collide: false });
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
      // The seed carries how far down the river this bay begins. A bay is turned to the
      // channel, so its own u axis runs downstream and its v across, and the two together
      // give the shader a coordinate that is continuous from bay to bay however the river
      // bends — which is what lets the water run down it rather than drift north-east.
      b.box(px - len / 2, w - 0.5, pz - RIVER_HALF, px + len / 2, w, pz + RIVER_HALF,
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
      const a = riverFrame(line, s).p, c = riverFrame(line, s + BAY).p;
      const px = (a[0] + c[0]) / 2, pz = (a[1] + c[1]) / 2;
      const dx = c[0] - a[0], dz = c[1] - a[1];
      const chord = Math.hypot(dx, dz) || BAY;
      const dir: Vec2 = [dx / chord, dz / chord];
      const turn = Math.atan2(dz, dx);
      // Bays overrun both ends by the mitre: two of them turned against each other leave the
      // joint open on the inside of the bend otherwise, and the wider the thing laid the wider
      // that opening. The boxes are opaque, so the seam is buried inside the stone.
      const halfL = chord / 2 + 1.6;
      for (const side of [1, -1] as const) {
        const ex = px - dir[1] * RIVER_HALF * side, ez = pz + dir[0] * RIVER_HALF * side;
        if (ex < x0 - 4 || ex >= x0 + REGION + 4 || ez < z0 - 4 || ez >= z0 + REGION + 4) continue;
        const w = waterLevel(line), top = w + QUAY_RISE;
        const put = (halfW: number, y0: number, y1: number, off: number, mat: Mat, tn: Tint, style = 0, opts = {}) => {
          const cx = ex - dir[1] * off * side, cz = ez + dir[0] * off * side;
          b.box(cx - halfL, y0, cz - halfW, cx + halfL, y1, cz + halfW, mat, tn, style, { turn, detail: false, ...opts });
        };
        // The quay: the wall out of the water and the strip of deck behind it. The ground
        // under all of it is cut away (see `channelCap`), because a five-metre grid cannot
        // make a curved shoreline — so this stone *is* the edge of the city against the
        // water, and the ground only picks up again, flush, behind its inner edge.
        put(QUAY_SLAB / 2, w - 4, top, QUAY_SLAB / 2, Mat.Deck, stone);
        // A solid parapet along the top of the wall. Nothing thin: a slender rail here runs
        // the whole length of the bank and, seen down the quay, reads as a wire over the
        // water rather than as anything anyone would build.
        put(1.1, top, top + 0.42, 1.0, Mat.Board, stone, Finish.Cast);
        const k = Math.round(s / BAY);
        put(0.42, top + 0.42, top + 1.15, 1.7, Mat.Board, stone, Finish.Cast);
        // a bollard now and then, and steps down to the water every so often
        if (k % 5 === 0) put(0.3, top + 0.42, top + 1.1, 1.0, Mat.Board, stone, Finish.Ribbed);
        if (k % 23 === 0) {
          for (let n = 1; n <= 12; n++) {
            const y = top - n * (top - w + 1) / 12;
            put(1.6, y - 0.6, y, -0.6 - n * 0.42, Mat.Board, stone, Finish.Boards);
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
      // the small craft are launches anyone can take, so they are registered rather than built
      if (!big && h % 3 === 0) {
        const side2 = h % 2 === 0 ? 1 : -1;
        const o = RIVER_HALF - 9;
        const bx = p[0] - dir[1] * o * side2, bz = p[1] + dir[0] * o * side2;
        if (bx >= x0 - 40 && bx < x0 + REGION + 40 && bz >= z0 - 40 && bz < z0 + REGION + 40) {
          b.boats.push({ x: bx, y: w + 1.2, z: bz, yaw: Math.atan2(dir[0], dir[1]) });
        }
        continue;
      }
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
  return groundAt(site.p[0], site.p[1])
    + DECKS[hashInt(Math.round(site.p[0]), Math.round(site.p[1]), 301) % DECKS.length];
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

/**
 * Carriageway laid straight along an arterial wherever no street was built over it.
 *
 * A street exists here only between two blocks, because that is where the network puts one —
 * so where the blocks either side run out, and they do along every waterfront and wherever
 * the plan thins, the main road simply stops. A fifth of the arterial length on some seeds
 * has no road surface at all. Nothing complained, because the traffic falls back to the
 * ground when it finds no carriageway: what that looks like is cars driving off the asphalt
 * onto the bare hillside and jumping the joints between its tiles.
 *
 * Laid at the ground's own height, which is the same number the traffic falls back to, so
 * the surface a car rides and the surface under it are the same to the centimetre. Water is
 * left alone — the bridge builder owns every station a crossing reaches, ramps included.
 */
function arterialFill(b: Builder, x0: number, z0: number): void {
  const t: Tint = [1, 1, 1];
  const HALF = ARTERY_HALF + 0.4;
  const STEP = 9;
  const pad = 40;
  for (const axis of [0, 1] as const) {
    const across = axis === 0 ? z0 + REGION / 2 : x0 + REGION / 2;
    for (const line of arteryLines(across, REGION / 2 + pad)) {
      const from = (axis === 0 ? x0 : z0) - pad, to = (axis === 0 ? x0 + REGION : z0 + REGION) + pad;
      for (let s = Math.floor(from / STEP) * STEP; s < to; s += STEP) {
        const { p, dir, turn, len, riseOf } = bayOf(axis, line, s, s + STEP, HALF);
        if (p[0] < x0 || p[0] >= x0 + REGION || p[1] < z0 || p[1] >= z0 + REGION) continue;
        // a bay the blocks already built over, or one a bridge is carrying, is not ours
        if (roadTopAt(p[0], p[1]) !== null) continue;
        if (crossings(axis, line, Math.floor(s / ARTERY)).some((c) => s + STEP > c.a0 && s < c.a1)) continue;
        const r = riverNear(p[0], p[1], RIVER_HALF + 46);
        if (r && r.dist < RIVER_HALF + 46) continue;
        const a = arteryFrame(axis, line, s).p, c = arteryFrame(axis, line, s + STEP).p;
        const ya = terrainAt(a[0], a[1]), yb = terrainAt(c[0], c[1]);
        const y = (ya + yb) / 2;
        b.box(p[0] - len / 2, y - 6, p[1] - HALF, p[0] + len / 2, y, p[1] + HALF, Mat.Asphalt, t, 0,
          { seed: 0, detail: false, turn, rise: riseOf(yb - ya) });
        void dir;
      }
    }
  }
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
