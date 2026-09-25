// Deterministic, infinite brutalist city made only of boxes.
//
// The world is a grid of CELL x CELL cells. Streets run along cell borders and sit
// in deep canyons: every block is a raised podium (the main running level) connected
// to its neighbours by bridges. Towers rise from the podiums; mid-rise towers have
// external stairs to their roofs and link to each other and to sky lobbies of
// skyscrapers. Long stairs and lifts lead up from the street.

import { hashInt, Rng } from "../math";
import { Finish, Mat, Win, type Tint } from "./materials";
import { PAINT_COLORS } from "../vehicles/models";
import { emitBox, FLOATS_PER_VERTEX, positionsOf, YAW_STEP, YAW_STEPS, yawStep } from "./mesh";

export { VERTEX_LAYOUT, FLOATS_PER_VERTEX } from "./mesh";

export const CELL = 88;
export const STREET = 18;
export const REGION_CELLS = 3;
export const REGION = CELL * REGION_CELLS;
export const LAMP_HEIGHT = 7.2;
export const PODIUM_LEVELS = [18, 24, 30];
export const INSET = 6.5; // block edge -> podium face, for a block that takes the standard setback
export const INNER = 15; // block edge -> tower zone
const KERB = 0.4;

export { Mat, Win } from "./materials";



const TINTS: Tint[] = [
  [1.0, 1.0, 1.0],
  [0.92, 0.93, 0.95],
  [1.03, 1.0, 0.95],
  [0.85, 0.85, 0.86],
  [1.02, 0.97, 0.93],
  [0.78, 0.79, 0.8],
  [1.06, 1.05, 1.02],
];
const WHITE: Tint = [1, 1, 1];

export function podiumHeight(ci: number, cj: number): number {
  return PODIUM_LEVELS[hashInt(ci, cj, 11) % PODIUM_LEVELS.length];
}

/**
 * Setbacks a block may take on the two faces of one axis. No pair adds up to more than two
 * standard insets, because the 40 m tower zone plus the depth a corner pylon needs behind
 * each face already fills a standard podium exactly — a deeper pair on one side has to be
 * paid for on the other. Uneven pairs are the point: they slide the podium off the middle
 * of its block, so the two walls of a street stop being parallel.
 */
const SETBACKS: [number, number][] = [
  [INSET, INSET],
  [INSET, INSET],
  [INSET, INSET],
  [3.5, 9.5],
  [9.5, 3.5],
  [3, 10],
  [10, 3],
  [5, 8],
  [8, 5],
  [4.5, 4.5],
];

/**
 * How far block (ci, cj)'s podium stands back from the block edge on `side` (0 east, 1 north,
 * 2 west, 3 south). Each axis draws its own pair, so a street is bounded by two lines of
 * podium faces that step in and out along its length instead of running dead straight —
 * which is most of what made the place read as a grid of identical blocks.
 */
export function podiumInset(ci: number, cj: number, side: number): number {
  // The east and west faces vary down a column, the north and south faces across a row, and
  // never the other way about: a skyway leaves one podium's corner for the corner of the one
  // opposite, so the two have to present their cross faces on the same line or it meets thin
  // air. Within that, the pair is uneven as often as not, which slides the podium off the
  // middle of its block and sets each street its own width.
  const pair = SETBACKS[hashInt(side % 2 === 0 ? ci : cj, 40 + (side % 2)) % SETBACKS.length];
  return side < 2 ? pair[1] : pair[0]; // 0 east and 1 north are the far faces
}

/**
 * How far block (ci, cj)'s podium corners are cut back, on a flat chamfer or an arc (0 for a
 * square corner). Whether a given corner actually takes the cut also depends on what stands
 * on it, so this is the worst case — which is what anyone routing round the deck wants.
 */
export function podiumCut(ci: number, cj: number): number {
  const roll = hashInt(ci, cj, 41) % 100;
  return roll < 38 ? 0 : 3.5 + (roll % 4);
}

/** Block-local coordinate of the podium face on `side`, as the deck's outer edge. */
export function deckEdge(ci: number, cj: number, side: number): number {
  const inset = podiumInset(ci, cj, side);
  return side < 2 ? CELL - STREET / 2 - inset : STREET / 2 + inset;
}

/** Lamp head (x, z) positions in cell-local coordinates (shared with the shader). */
export function lampHeadsLocal(): [number, number][] {
  const s = STREET / 2;
  const over = s + 0.6 - 1.6;
  const far = CELL - over;
  const a = CELL * 0.3, b = CELL * 0.7;
  return [[over, a], [over, b], [far, a], [far, b], [a, over], [b, over], [a, far], [b, far]];
}

export const FLOATS_PER_BOX = 17; // x0 y0 z0 x1 y1 z1 r g b mat style seed collide detail turn rise riseZ

/** A car parked at the kerb (dynamic: it can be driven away). */
export interface ParkedCar {
  x: number;
  y: number;
  z: number;
  yaw: number;
  van: boolean;
  color: Tint;
}

/** A lift platform: its footprint and the height of its top at the bottom and top stops. */
export interface Lift {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  y0: number;
  y1: number;
  phase: number; // 0..1, where in its timetable the lift is at time 0
}

/** A landing pad with a parked flyer (feet level y, facing yaw). */
export interface Pad {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export class Builder {
  data: number[] = [];
  count = 0;
  pads: Pad[] = [];
  /** Street lamp heads (x, y, z), for lighting the network city, which has no lamp grid. */
  lamps: number[] = [];
  cars: ParkedCar[] = [];
  /** Small craft tied up along a quay, which can be boarded. */
  boats: Pad[] = [];
  lifts: Lift[] = [];
  /** Concrete finish given to Mat.Board boxes that don't ask for one. */
  finish: Finish = Finish.Boards;
  constructor(private rng: Rng) {}

  /** Active turned frame; see `turned`. */
  private frame: { x: number; z: number; turn: number; cs: number; sn: number } | null = null;

  /**
   * Runs `body` with everything it places turned by `angle` about (x, z). Geometry inside is
   * still written on the axes, so any building here can be stood at an angle to the street
   * without being rewritten. Frames don't nest.
   */
  turned(x: number, z: number, angle: number, body: () => void): void {
    const turn = yawStep(angle);
    if (!turn) return body();
    const a = turn * YAW_STEP;
    this.frame = { x, z, turn, cs: Math.cos(a), sn: Math.sin(a) };
    body();
    this.frame = null;
  }

  /** A point carried into the active frame. */
  private point(x: number, z: number): [number, number] {
    const f = this.frame;
    if (!f) return [x, z];
    const dx = x - f.x, dz = z - f.z;
    return [f.x + dx * f.cs - dz * f.sn, f.z + dx * f.sn + dz * f.cs];
  }

  /** Painted landing pad (5 x 5 m) centred at (x, z) on a surface at height y. */
  pad(x: number, y: number, z: number, yaw: number): void {
    this.box(x - 2.6, y, z - 2.6, x + 2.6, y + 0.04, z + 2.6, Mat.Pad, WHITE, 0, { detail: false });
    const [px, pz] = this.point(x, z);
    this.pads.push({ x: px, y: y + 0.04, z: pz, yaw: yaw - (this.frame ? this.frame.turn * YAW_STEP : 0) });
  }

  lift(x0: number, z0: number, x1: number, z1: number, y0: number, y1: number): void {
    this.lifts.push({ x0, z0, x1, z1, y0, y1, phase: this.rng.next() });
  }

  box(
    x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
    mat: Mat, tint: Tint = WHITE, style = 0,
    opts: { collide?: boolean; detail?: boolean; seed?: number; turn?: number; hidden?: boolean; rise?: number; riseZ?: number } = {},
  ): void {
    if (x1 - x0 < 1e-3 || y1 - y0 < 1e-3 || z1 - z0 < 1e-3) return;
    const volume = (x1 - x0) * (y1 - y0) * (z1 - z0);
    const detail = opts.detail ?? volume < 20;
    if (mat === Mat.Board && style === 0) style = this.finish;
    let turn = opts.turn ? yawStep(opts.turn) : 0;
    const f = this.frame;
    if (f) {
      // the frame carries the centre round and adds to the turn; the extents are unchanged,
      // which is the whole point: a turned building is the same building
      const hx = (x1 - x0) / 2, hz = (z1 - z0) / 2;
      const [cx, cz] = this.point(x0 + hx, z0 + hz);
      x0 = cx - hx; x1 = cx + hx;
      z0 = cz - hz; z1 = cz + hz;
      turn = (turn + f.turn) % YAW_STEPS;
    }
    this.data.push(
      x0, y0, z0, x1, y1, z1, tint[0], tint[1], tint[2], mat, style,
      opts.seed ?? this.rng.next(), opts.collide === false ? 0 : opts.hidden ? HIDDEN : 1, detail ? 1 : 0, turn,
      opts.rise ?? 0, opts.riseZ ?? 0,
    );
    this.count++;
  }
}

/**
 * World-space bounds of box `o`. A turned box still covers its own extents in y, but in x
 * and z it sweeps out to the bounds of its four rotated corners — which is what collision,
 * face culling and frustum culling all have to use, since none of them know about the turn.
 */
function boxBounds(d: ArrayLike<number>, o: number): [number, number, number, number] {
  const turn = d[o + 14];
  if (!turn) return [d[o], d[o + 2], d[o + 3], d[o + 5]];
  const hx = (d[o + 3] - d[o]) / 2, hz = (d[o + 5] - d[o + 2]) / 2;
  const a = turn * YAW_STEP;
  const cs = Math.abs(Math.cos(a)), sn = Math.abs(Math.sin(a));
  const ex = hx * cs + hz * sn, ez = hx * sn + hz * cs;
  const cx = d[o] + hx, cz = d[o + 2] + hz;
  return [cx - ex, cz - ez, cx + ex, cz + ez];
}

// ---------------------------------------------------------------------------
// Walkable connectors

/**
 * Bridge along `axis` from a0 to a1 (a0 < a1), centred on `c` across, with deck
 * top ya at a0 and yb at a1. Height differences become a stepped bridge.
 */
function stairBridge(
  b: Builder, r: Rng, axis: "x" | "z", a0: number, a1: number, c: number, w: number,
  ya: number, yb: number, tint: Tint, covered: boolean,
): void {
  const put = (s0: number, s1: number, y0: number, y1: number, t0: number, t1: number, mat: Mat, style = 0,
    opts: { collide?: boolean; detail?: boolean } = {}) => {
    if (axis === "x") b.box(s0, y0, t0, s1, y1, t1, mat, tint, style, opts);
    else b.box(t0, y0, s0, t1, y1, s1, mat, tint, style, opts);
  };
  const c0 = c - w / 2, c1 = c + w / 2;
  const thick = 0.9;
  const dh = yb - ya;
  let land = 3;
  if (Math.abs(dh) < 0.01) {
    put(a0, a1, ya - thick, ya, c0, c1, Mat.Board);
    if (covered && a1 - a0 > 6) {
      put(a0, a1, ya, ya + 3.6, c0 - 0.35, c0, Mat.Windows, Win.Ribbon);
      put(a0, a1, ya, ya + 3.6, c1, c1 + 0.35, Mat.Windows, Win.Ribbon);
      put(a0, a1, ya + 3.6, ya + 4.2, c0 - 0.6, c1 + 0.6, Mat.Board);
    } else {
      put(a0, a1, ya, ya + 1.05, c0, c0 + 0.25, Mat.Panel);
      put(a0, a1, ya, ya + 1.05, c1 - 0.25, c1, Mat.Panel);
    }
    put(a0 + 1, a1 - 1, ya - thick - 0.06, ya - thick, c - 0.12, c + 0.12, Mat.Glow, 0, { collide: false, detail: true });
    return;
  }
  const n = Math.ceil(Math.abs(dh) / 0.45) - 1;
  // A tread narrower than a runner is wide is one they wedge on, so where a short bridge and
  // a big drop leave no room the landings give way first: they only square up the deck ends,
  // while the flight is what has to be walkable.
  while (land > 1 && (a1 - a0 - 2 * land) / n < 0.8) land -= 0.1;
  const span = a1 - a0 - 2 * land;
  const run = span / n;
  put(a0, a0 + land, ya - thick, ya, c0, c1, Mat.Board);
  put(a1 - land, a1, yb - thick, yb, c0, c1, Mat.Board);
  put(a0, a0 + land, ya, ya + 1.05, c0, c0 + 0.25, Mat.Panel);
  put(a0, a0 + land, ya, ya + 1.05, c1 - 0.25, c1, Mat.Panel);
  put(a1 - land, a1, yb, yb + 1.05, c0, c0 + 0.25, Mat.Panel);
  put(a1 - land, a1, yb, yb + 1.05, c1 - 0.25, c1, Mat.Panel);
  for (let i = 1; i <= n; i++) {
    const top = ya + (dh * i) / (n + 1);
    const s0 = a0 + land + (i - 1) * run;
    put(s0, s0 + run, top - thick, top, c0, c1, Mat.Board, 0, { detail: false });
    put(s0, s0 + run, top, top + 1.05, c0, c0 + 0.25, Mat.Panel);
    put(s0, s0 + run, top, top + 1.05, c1 - 0.25, c1, Mat.Panel);
  }
  void r;
}

/**
 * Street stair wrapped around a podium corner: one long flight up the sidewalk beside one face
 * to a landing on a concrete pier in the corner, then a second long flight along the other face
 * to the deck. (cx, cz) is the podium corner; sx / sz point from it into the podium. Local a / b
 * measure outward from the podium faces along x / z, so negative values run along a face.
 */
export function cornerStair(b: Builder, cx: number, cz: number, sx: number, sz: number, E: number, tint: Tint): void {
  const put = cornerPut(b, cx, cz, sx, sz, tint);
  const { rise, run, steps, length } = streetFlight(E);
  const lane: [number, number] = [0.6, 3.6]; // off the podium face by a gap too narrow to fall into
  const par: [number, number] = [3.6, 3.85];
  const glow = { collide: false, detail: true };
  const half = E / 2;
  const tread = (i: number, y: number) => {
    const top = y + rise * i;
    return { top, bottom: top < 2.5 ? 0 : top - 0.45 };
  };
  // flight 1 beside the face that runs along z, climbing outward toward the corner
  // treads one by one; parapet and stringer in lengths of three treads
  const start1 = lane[0] - length;
  for (let i = 1; i <= steps; i++) {
    const { top, bottom } = tread(i, 0);
    const s0 = start1 + (i - 1) * run;
    put(lane[0], lane[1], s0, s0 + run, bottom, top, Mat.Board);
  }
  for (let i = 1; i <= steps; i += 3) {
    const j = Math.min(i + 2, steps), first = tread(i, 0);
    const s0 = start1 + (i - 1) * run, s1 = start1 + j * run;
    put(par[0], par[1], s0, s1, first.bottom, tread(j, 0).top + 1.05, Mat.Board);
    if (first.bottom > 0) put(lane[1] - 0.6, lane[1], s0, s1, first.top - 1.5, first.bottom, Mat.Board);
  }
  // the corner landing on its pier
  put(lane[0], lane[1], lane[0], lane[1], half - 0.6, half, Mat.Deck);
  put(par[0], par[1], lane[0], par[1], half, half + 1.05, Mat.Board);
  put(lane[0], par[0], par[0], par[1], half, half + 1.05, Mat.Board);
  put(1.1, 3.1, 1.1, 3.1, 0.18, half - 0.6, Mat.Board, 0, { detail: false });
  put(lane[0] + 0.3, lane[1] - 0.3, 3.2, 3.3, half - 0.65, half - 0.6, Mat.Glow, 0, glow);
  // flight 2 beside the face that runs along x, climbing inward
  for (let i = 1; i <= steps; i++) {
    const { top, bottom } = tread(i, half);
    const s1 = lane[0] - (i - 1) * run;
    put(s1 - run, s1, lane[0], lane[1], bottom, top, Mat.Board);
  }
  for (let i = 1; i <= steps; i += 3) {
    const j = Math.min(i + 2, steps), first = tread(i, half);
    const s0 = lane[0] - j * run, s1 = lane[0] - (i - 1) * run;
    put(s0, s1, par[0], par[1], first.bottom, tread(j, half).top + 1.05, Mat.Board);
    put(s0, s1, lane[1] - 0.6, lane[1], first.top - 1.5, first.bottom, Mat.Board);
  }
  // top landing along the deck edge, closed at its far end
  const t0 = lane[0] - length;
  put(t0 - 2.4, t0, lane[0], lane[1], E - 0.6, E, Mat.Deck);
  put(t0 - 2.4, t0, par[0], par[1], E, E + 1.05, Mat.Board);
  put(t0 - 2.65, t0 - 2.4, lane[0], par[1], E - 0.6, E + 1.05, Mat.Board);
  put(t0 - 2.0, t0 - 0.4, 3.2, 3.3, E - 0.65, E - 0.6, Mat.Glow, 0, glow);
  // columns under the long flights
  for (const f of [0.35, 0.7]) {
    const s = lane[0] - length * f;
    // slimmer than the stringers and stopping below them, so no faces coincide
    put(lane[1] - 0.5, lane[1] - 0.1, s - 0.2, s + 0.2, 0.18, half * (1 - f) - 2.1, Mat.Board, 0, { detail: false });
    put(s - 0.2, s + 0.2, lane[1] - 0.5, lane[1] - 0.1, 0.18, half * (1 + f) - 2.1, Mat.Board, 0, { detail: false });
  }
}

type CornerPut = (a0: number, a1: number, b0: number, b1: number, y0: number, y1: number, mat: Mat, style?: number,
  opts?: { collide?: boolean; detail?: boolean }) => void;

/** Box placement around podium corner (cx, cz): a / b are distances outward from the faces. */
function cornerPut(b: Builder, cx: number, cz: number, sx: number, sz: number, tint: Tint): CornerPut {
  return (a0, a1, b0, b1, y0, y1, mat, style = 0, opts = {}) => {
    const x0 = cx - sx * a0, x1 = cx - sx * a1, z0 = cz - sz * b0, z1 = cz - sz * b1;
    b.box(Math.min(x0, x1), y0, Math.min(z0, z1), Math.max(x0, x1), y1, Math.max(z0, z1), mat, tint, style, opts);
  };
}

/** Treads of one flight of a street stair (each flight climbs half the podium). */
export function streetFlight(E: number): { rise: number; run: number; steps: number; length: number } {
  const steps = Math.round(E / 2 / 0.5), run = 0.55;
  return { rise: E / 2 / steps, run, steps, length: steps * run };
}

/** Platform size of every lift (they are all drawn with one model). */
export const LIFT_SIZE = 3.2;

/**
 * Open lift from the sidewalk corner at podium corner (cx, cz) up to a landing beside the
 * deck (same local a / b as cornerStair). Walls on the two street sides; open towards the
 * landing and the podium.
 */
export function streetLift(b: Builder, cx: number, cz: number, sx: number, sz: number, E: number, tint: Tint): void {
  const put = cornerPut(b, cx, cz, sx, sz, tint);
  const X = (a: number) => cx - sx * a, Z = (v: number) => cz - sz * v;
  const p0 = 1.0, p1 = p0 + LIFT_SIZE, q0 = 0.8, q1 = q0 + LIFT_SIZE;
  const cap = E + 3.6;
  const glow = { collide: false, detail: true };
  b.lift(Math.min(X(p0), X(p1)), Math.min(Z(q0), Z(q1)), Math.max(X(p0), X(p1)), Math.max(Z(q0), Z(q1)), 0.2, E);
  put(p1 + 0.25, p1 + 0.65, 0.5, q1 + 0.25, 0.18, cap, Mat.Windows, Win.Slit);
  put(0.6, p1 + 0.65, q1 + 0.25, q1 + 0.65, 0.18, cap, Mat.Board, 0, { detail: false });
  put(0.4, p1 + 0.85, 0.3, q1 + 0.85, cap, cap + 0.8, Mat.Board);
  put(p0 + 0.4, p1 - 0.4, q0 + 1.5, q0 + 1.7, cap - 0.05, cap, Mat.Glow, 0, glow);
  // the landing reaches over the other sidewalk to the deck edge
  put(-2.5, p0, 0.5, q1, E - 0.6, E, Mat.Deck);
  put(-2.5, 0.6, q1 - 0.2, q1, E, E + 1.05, Mat.Panel);
  put(-2.75, -2.5, 0.5, q1, E - 0.6, E + 1.05, Mat.Board);
  put(-2.0, 0.4, 2.2, 2.3, E - 0.65, E - 0.6, Mat.Glow, 0, glow);
}

/** Steps wrapping counter-clockwise around a tower footprint, from base up to top, with corner landings. */
export function facadeStair(b: Builder, x0: number, z0: number, x1: number, z1: number, base: number, top: number, tint: Tint): void {
  const w = 1.8, rise = 0.45, slab = 0.35;
  let h = base;
  const bottom = () => (h - base < 2.2 ? base : h - slab);
  // each side: steps along the face, then a flat landing on the next corner
  const sides: { along: "x" | "z"; from: number; to: number; lane: [number, number]; rail: number; corner: [number, number, number, number] }[] = [
    { along: "x", from: x0, to: x1, lane: [z0 - w, z0], rail: z0 - w, corner: [x1, z0 - w, x1 + w, z0] },
    { along: "z", from: z0, to: z1, lane: [x1, x1 + w], rail: x1 + w - 0.2, corner: [x1, z1, x1 + w, z1 + w] },
    { along: "x", from: x1, to: x0, lane: [z1, z1 + w], rail: z1 + w - 0.2, corner: [x0 - w, z1, x0, z1 + w] },
    { along: "z", from: z1, to: z0, lane: [x0 - w, x0], rail: x0 - w, corner: [x0 - w, z0 - w, x0, z0] },
  ];
  for (const s of sides) {
    const len = Math.abs(s.to - s.from);
    const n = Math.max(1, Math.floor(len / 0.62));
    const run = len / n;
    const dir = Math.sign(s.to - s.from);
    for (let i = 0; i < n && h < top - 1e-3; i++) {
      h = Math.min(h + rise, top);
      const p = s.from + dir * i * run;
      const pa = Math.min(p, p + dir * run), pb = Math.max(p, p + dir * run);
      if (s.along === "x") {
        b.box(pa, bottom(), s.lane[0], pb, h, s.lane[1], Mat.Board, tint);
        b.box(pa, h, s.rail, pb, h + 1.0, s.rail + 0.2, Mat.Panel, tint);
      } else {
        b.box(s.lane[0], bottom(), pa, s.lane[1], h, pb, Mat.Board, tint);
        b.box(s.rail, h, pa, s.rail + 0.2, h + 1.0, pb, Mat.Panel, tint);
      }
    }
    if (h >= top - 1e-3) return;
    const [cx0, cz0, cx1, cz1] = s.corner;
    b.box(cx0, bottom(), cz0, cx1, h, cz1, Mat.Board, tint);
  }
}

function kerb(b: Builder, x0: number, z0: number, x1: number, z1: number, y: number, tint: Tint, glow = false,
  cut = 0, segs = 1, mask = 0b1111): void {
  const t = 0.35;
  const c = !mask || 2 * cut > Math.min(x1 - x0, z1 - z0) ? 0 : cut;
  const at = (k: number) => (mask & (1 << k) ? c : 0);
  b.box(x0 + at(CORNER_SW), y, z0, x1 - at(CORNER_SE), y + KERB, z0 + t, Mat.Board, tint);
  b.box(x0 + at(CORNER_NW), y, z1 - t, x1 - at(CORNER_NE), y + KERB, z1, Mat.Board, tint);
  b.box(x0, y, z0 + at(CORNER_SW), x0 + t, y + KERB, z1 - at(CORNER_NW), Mat.Board, tint);
  b.box(x1 - t, y, z0 + at(CORNER_SE), x1, y + KERB, z1 - at(CORNER_NE), Mat.Board, tint);
  // the parapet carries on round a cut-back corner, one box to a chord
  cornerChords(x0, z0, x1, z1, c, segs, (mx, mz, nx, nz, chord, angle) => {
    const qx = mx - nx * (t / 2), qz = mz - nz * (t / 2);
    b.box(qx - chord / 2, y, qz - t / 2, qx + chord / 2, y + KERB, qz + t / 2, Mat.Board, tint, 0, { turn: angle });
  }, mask);
  if (glow) {
    const g = { collide: false, detail: true };
    b.box(x0 + at(CORNER_SW) + 0.1, y + KERB, z0 + 0.12, x1 - at(CORNER_SE) - 0.1, y + KERB + 0.03, z0 + 0.2, Mat.Glow, tint, 0, g);
    b.box(x0 + at(CORNER_NW) + 0.1, y + KERB, z1 - 0.2, x1 - at(CORNER_NE) - 0.1, y + KERB + 0.03, z1 - 0.12, Mat.Glow, tint, 0, g);
  }
}

function beacon(b: Builder, cx: number, y: number, cz: number): void {
  b.box(cx - 0.35, y, cz - 0.35, cx + 0.35, y + 0.7, cz + 0.35, Mat.Beacon, WHITE, 0, { collide: false });
}

function fins(b: Builder, r: Rng, x0: number, z0: number, x1: number, z1: number, y0: number, y1: number, depth: number, tint: Tint): void {
  const spacing = r.pick([2.4, 3.2, 4.0]);
  for (const [a0, a1, along] of [[x0, x1, "x"], [z0, z1, "z"]] as const) {
    const n = Math.floor((a1 - a0) / spacing);
    for (let i = 1; i < n; i++) {
      const p = a0 + (i * (a1 - a0)) / n;
      if (along === "x") {
        b.box(p - 0.2, y0, z0 - depth, p + 0.2, y1, z0, Mat.Board, tint, 0, { detail: false });
        b.box(p - 0.2, y0, z1, p + 0.2, y1, z1 + depth, Mat.Board, tint, 0, { detail: false });
      } else {
        b.box(x0 - depth, y0, p - 0.2, x0, y1, p + 0.2, Mat.Board, tint, 0, { detail: false });
        b.box(x1, y0, p - 0.2, x1 + depth, y1, p + 0.2, Mat.Board, tint, 0, { detail: false });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Skyways: an upper walking level at 36 or 42 m, just below the lowest flyer corridor (45 m).
// Open stair or lift pylons on the podium corners climb to it, and bridges cross the streets between
// them: railed decks, bare beams with nothing to hold on to, and (over the east-west streets)
// covered tubes.

export const SKY_LEVELS = [36, 42];
const PYLON_D = 5.8;
const SKY_MID = PYLON_D / 2; // skyway centre line, measured from the podium edge side of a pylon
const LIFT_PYLON_L = 5.2;

/** Treads of one flight of a pylon stair (two flights, each climbing half the height). */
function pylonFlight(rise: number): { steps: number; run: number; step: number; length: number } {
  const steps = Math.round(rise / 2 / 0.5), run = 0.55;
  return { steps, run, step: rise / 2 / steps, length: steps * run };
}

/** Footprint of a corner pylon: length along its axis, depth across it. */
export function pylonSize(lift: boolean, rise: number): [number, number] {
  return lift ? [LIFT_PYLON_L, PYLON_D] : [5.6 + pylonFlight(rise).length, PYLON_D];
}

type SkyKind = "rail" | "beam" | "covered";

/**
 * Skyways around the street crossing at (I * CELL, J * CELL). `xs` / `xn` cross the north-south
 * street just south / north of it; `zw` / `ze` cross the east-west street just west / east of it.
 * Each block corner belongs to one crossing and serves at most one arm.
 */
export interface Crossing {
  level: number;
  xs?: SkyKind;
  xn?: SkyKind;
  zw?: SkyKind;
  ze?: SkyKind;
}

export function crossing(I: number, J: number): Crossing | null {
  const r = new Rng(hashInt(I, J, 41));
  if (!r.chance(0.5)) return null;
  const c: Crossing = { level: r.pick(SKY_LEVELS) };
  const xKind = (): SkyKind => (r.chance(0.6) ? "rail" : "beam");
  const zKind = (): SkyKind => r.pick<SkyKind>(["rail", "rail", "beam", "covered", "covered"]);
  // the runner starts on the south-west corner of block (0, 0): keep pylons off that corner
  const start = I === 0 && J === 0;
  const roll = r.next();
  if (roll < 0.25 || start) {
    c.xs = xKind();
    c.xn = xKind();
    if (start) delete c.xn;
    else if (r.chance(0.3)) delete c.xs;
  } else if (roll < 0.5) {
    c.zw = zKind();
    c.ze = zKind();
  } else {
    const arm = r.pick(["xs", "xn", "zw", "ze"] as const);
    c[arm] = arm[0] === "x" ? xKind() : zKind();
  }
  return c;
}

/** Pylon on a podium corner: `east` / `north` say which corner of block (ci, cj). */
export function cornerPylon(ci: number, cj: number, east: boolean, north: boolean): { axis: "x" | "z"; level: number; lift: boolean } | null {
  const c = crossing(ci + (east ? 1 : 0), cj + (north ? 1 : 0));
  if (!c) return null;
  // the corner sits south-west (sw), south-east (se), ... of its crossing
  const xArm = north ? c.xs : c.xn;
  const zArm = east ? c.zw : c.ze;
  const lift = hashInt(ci, cj, 43 + (east ? 1 : 0) + (north ? 2 : 0)) % 100 < 45;
  if (xArm) return { axis: "x", level: c.level, lift };
  if (zArm) return { axis: "z", level: c.level, lift };
  return null;
}

type PylonPut = (ua: number, ub: number, va: number, vb: number, y0: number, y1: number, mat: Mat, style?: number,
  opts?: { collide?: boolean; detail?: boolean }) => void;

/** Box placement in pylon space: u along the axis from the street end, v from the podium edge inward. */
function pylonPut(b: Builder, axis: "x" | "z", u0: number, us: number, v0: number, vs: number, tint: Tint): PylonPut {
  return (ua, ub, va, vb, y0, y1, mat, style = 0, opts = {}) => {
    const a0 = u0 + us * ua, a1 = u0 + us * ub, c0 = v0 + vs * va, c1 = v0 + vs * vb;
    const [ax0, ax1] = a0 < a1 ? [a0, a1] : [a1, a0];
    const [cx0, cx1] = c0 < c1 ? [c0, c1] : [c1, c0];
    if (axis === "x") b.box(ax0, y0, cx0, ax1, y1, cx1, mat, tint, style, opts);
    else b.box(cx0, y0, ax0, cx1, y1, ax1, mat, tint, style, opts);
  };
}

/** Roof slab over a pylon, with a beacon or a concrete blade. */
function pylonCrown(b: Builder, r: Rng, put: PylonPut, axis: "x" | "z", u0: number, us: number, v0: number, vs: number,
  L: number, D: number, crown: number): void {
  put(-0.5, L + 0.3, -0.4, D + 0.4, crown, crown + 1.1, Mat.Board);
  put(0.6, L - 0.6, 1.2, D - 1.2, crown - 0.05, crown, Mat.Glow, 0, { collide: false, detail: true });
  const at = (u: number, v: number): [number, number] => (axis === "x" ? [u0 + us * u, v0 + vs * v] : [v0 + vs * v, u0 + us * u]);
  if (r.chance(0.5)) {
    const blade = r.uniform(4, 14), end = Math.min(L - 0.4, 9);
    put(1.4, end, 0, 0.5, crown + 1.1, crown + 1.1 + blade, Mat.Board, 0, { detail: false });
    const [bx, bz] = at(end - 0.6, 0.25);
    beacon(b, bx, crown + 1.1 + blade, bz);
  } else {
    const [bx, bz] = at(1, 1);
    beacon(b, bx, crown + 1.1, bz);
  }
}

/** Height above the deck where pylon structure may start without blocking the way past it. */
const PASS_UNDER = 2.6;

/**
 * Open stair from `base` up to `top`: a long flight in the inner lane away from the street, a
 * landing, and a long flight back in the outer lane to the top landing at the street end, where
 * the skyway leaves. A spine wall runs between the flights. At deck level the edge side and the
 * street end stay open (the upper flight is carried overhead), so runners can pass by the edge.
 */
function stairPylon(
  b: Builder, r: Rng, axis: "x" | "z", u0: number, us: number, v0: number, vs: number,
  base: number, top: number, tint: Tint, skyHalf: number,
): void {
  const put = pylonPut(b, axis, u0, us, v0, vs, tint);
  const { steps, run, step, length } = pylonFlight(top - base);
  const [L, D] = pylonSize(false, top - base);
  const wall = 0.4;
  const laneA: [number, number] = [wall, 2.7], laneB: [number, number] = [3.1, D - wall];
  const f0 = 2.6, f1 = f0 + length, far = L - wall;
  const glow = { collide: false, detail: true };
  const half = (top - base) / 2;
  for (let k = 0; k < 2; k++) {
    const y = base + half * k;
    // rails run beside the treads (not on them), clear of the piers, so no two faces share a plane
    const rail: [number, number] = k === 0 ? [D - wall - 0.2, D - wall] : [wall, wall + 0.2];
    const lane: [number, number] = k === 0 ? [laneB[0], rail[0]] : [rail[1], laneA[1]];
    for (let i = 1; i <= steps; i++) {
      const st = y + step * i;
      const s0 = k === 0 ? f0 + (i - 1) * run : f1 - i * run;
      put(s0, s0 + run, lane[0], lane[1], Math.max(base, st - 0.45), st, Mat.Board);
    }
    // the rail in lengths of three treads
    for (let i = 1; i <= steps; i += 3) {
      const j = Math.min(i + 2, steps);
      const [s0, s1] = k === 0 ? [f0 + (i - 1) * run, f0 + j * run] : [f1 - j * run, f1 - (i - 1) * run];
      put(s0, s1, rail[0], rail[1], y + step * i, y + step * j + 1.0, Mat.Panel);
    }
    const land = y + half;
    const [la, lb] = k === 0 ? [f1, far] : [0, f0];
    put(la, lb, wall, D - wall, land - 0.5, land, Mat.Deck);
    put(la, lb, wall, wall + 0.2, land, land + 1.0, Mat.Panel);
    put(la, lb, D - wall - 0.2, D - wall, land, land + 1.0, Mat.Panel);
    put(la + 0.4, lb - 0.4, 2.8, 3.0, land - 0.55, land - 0.5, Mat.Glow, 0, glow);
  }
  // the street end of the top landing: a rail, except where the skyway leaves
  put(0.02, 0.2, wall + 0.2, SKY_MID - skyHalf, top, top + 1.0, Mat.Panel);
  put(0.02, 0.2, SKY_MID + skyHalf, D - wall - 0.2, top, top + 1.0, Mat.Panel);
  const crown = top + 3.4;
  // spine between the flights, far end wall, piers and a beam at the landing level
  put(f0, f1, laneA[1], laneB[0], base, top + 1.1, Mat.Board);
  const lintel = base + PASS_UNDER;
  put(far, L, laneA[1], D, base, crown, Mat.Board);
  put(far, L, 0, laneA[1], lintel, crown, Mat.Board);
  const piers = Math.max(1, Math.round(far / 5));
  for (let p = 0; p < piers; p++) {
    const pu = (far * p) / piers;
    put(pu, pu + wall, 0, wall, lintel, crown, Mat.Board, 0, { detail: false });
    put(pu, pu + wall, D - wall, D, p === 0 ? lintel : base, crown, Mat.Board, 0, { detail: false });
  }
  // a beam at the landing level, where it clears the heads of people walking in
  const mid = base + half;
  if (mid - 1.2 > base + 2.4) {
    put(-0.1, far, -0.15, 0.2, mid - 1.2, mid - 0.6, Mat.Board);
    put(-0.1, far, D - 0.2, D + 0.15, mid - 1.2, mid - 0.6, Mat.Board);
  }
  pylonCrown(b, r, put, axis, u0, us, v0, vs, L, D, crown);
}

/**
 * Lift pylon: an open shaft from the deck to the skyway. At the top the platform stops level
 * with a short landing at the street end, where the skyway leaves.
 */
function liftPylon(
  b: Builder, r: Rng, axis: "x" | "z", u0: number, us: number, v0: number, vs: number,
  base: number, top: number, tint: Tint, skyHalf: number,
): void {
  const put = pylonPut(b, axis, u0, us, v0, vs, tint);
  const [L, D] = pylonSize(true, top - base);
  const p0 = 1.3, p1 = p0 + LIFT_SIZE, q0 = SKY_MID - LIFT_SIZE / 2, q1 = SKY_MID + LIFT_SIZE / 2;
  const at = (u: number, v: number): [number, number] => (axis === "x" ? [u0 + us * u, v0 + vs * v] : [v0 + vs * v, u0 + us * u]);
  const [ax, az] = at(p0, q0), [bx, bz] = at(p1, q1);
  b.lift(Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz), base + 0.02, top);
  const crown = top + 3.4;
  const glow = { collide: false, detail: true };
  // back wall with lit slits, a blank wall on the podium edge side, corner posts, open to the
  // deck; along the edge and at the street end everything starts overhead so runners pass by
  const lintel = base + PASS_UNDER;
  put(p1 + 0.3, L, q0, D, base, crown, Mat.Windows, Win.Slit);
  put(p1 + 0.3, L, 0.4, q0, lintel, crown, Mat.Windows, Win.Slit);
  put(0, p1 + 0.3, 0.4, 0.9, lintel, crown, Mat.Board, 0, { detail: false });
  put(0, 0.4, D - 0.4, D, lintel, crown, Mat.Board, 0, { detail: false });
  put(p1 - 0.1, p1 + 0.3, D - 0.4, D, base, crown, Mat.Board, 0, { detail: false });
  // guide rails in the back corners of the shaft
  put(p1 + 0.1, p1 + 0.3, q0 - 0.25, q0 - 0.1, lintel, crown, Mat.Metal, 0, { detail: false });
  put(p1 + 0.1, p1 + 0.3, q1 + 0.1, q1 + 0.25, base, crown, Mat.Metal, 0, { detail: false });
  // the landing, its rails and the skyway opening
  put(0, p0, 0.9, D - 0.4, top - 0.5, top, Mat.Deck);
  put(0.02, 0.2, 0.9, SKY_MID - skyHalf, top, top + 1.0, Mat.Panel);
  put(0.02, 0.2, SKY_MID + skyHalf, D - 0.4, top, top + 1.0, Mat.Panel);
  put(0.3, p0 - 0.3, 3.2, 3.3, top - 0.55, top - 0.5, Mat.Glow, 0, glow);
  pylonCrown(b, r, put, axis, u0, us, v0, vs, L, D, crown);
}

function skyHalfWidth(kind: SkyKind): number {
  return kind === "beam" ? 0.7 : kind === "covered" ? 1.8 : 1.6;
}

/** Skyway along `axis` from a0 to a1 at deck height y, centred on c across. */
function skyway(b: Builder, axis: "x" | "z", a0: number, a1: number, c: number, y: number, kind: SkyKind, tint: Tint): void {
  const put = (s0: number, s1: number, y0: number, y1: number, t0: number, t1: number, mat: Mat, style = 0,
    opts: { collide?: boolean; detail?: boolean } = {}) => {
    if (axis === "x") b.box(s0, y0, t0, s1, y1, t1, mat, tint, style, opts);
    else b.box(t0, y0, s0, t1, y1, s1, mat, tint, style, opts);
  };
  const hw = skyHalfWidth(kind);
  const glow = { collide: false, detail: true };
  if (kind === "beam") {
    // a bare concrete beam: a narrow deck on a deep blade, nothing to hold on to
    put(a0, a1, y - 0.6, y, c - hw, c + hw, Mat.Board, 0, { detail: false });
    put(a0 + 0.3, a1 - 0.3, y - 3.4, y - 0.6, c - 0.3, c + 0.3, Mat.Board, 0, { detail: false });
    put(a0 + 0.5, a1 - 0.5, y - 3.45, y - 3.4, c - 0.08, c + 0.08, Mat.Glow, 0, glow);
    return;
  }
  put(a0, a1, y - 0.9, y, c - hw, c + hw, Mat.Board, 0, { detail: false });
  // downstand beams under both edges
  put(a0 + 0.4, a1 - 0.4, y - 2.6, y - 0.9, c - hw, c - hw + 0.5, Mat.Board, 0, { detail: false });
  put(a0 + 0.4, a1 - 0.4, y - 2.6, y - 0.9, c + hw - 0.5, c + hw, Mat.Board, 0, { detail: false });
  put(a0 + 1, a1 - 1, y - 0.95, y - 0.9, c - 0.12, c + 0.12, Mat.Glow, 0, glow);
  if (kind === "covered") {
    put(a0, a1, y, y + 3.5, c - hw, c - hw + 0.35, Mat.Windows, Win.Ribbon);
    put(a0, a1, y, y + 3.5, c + hw - 0.35, c + hw, Mat.Windows, Win.Ribbon);
    put(a0 - 0.3, a1 + 0.3, y + 3.5, y + 4.2, c - hw - 0.3, c + hw + 0.3, Mat.Board);
    put(a0 + 1, a1 - 1, y + 3.45, y + 3.5, c - 0.1, c + 0.1, Mat.Glow, 0, glow);
  } else {
    put(a0, a1, y, y + 1.05, c - hw, c - hw + 0.25, Mat.Panel);
    put(a0, a1, y, y + 1.05, c + hw - 0.25, c + hw, Mat.Panel);
  }
}

/** Pylons on the corners of block (ci, cj), and the skyways leaving it east and north. */
function skyways(b: Builder, r: Rng, ci: number, cj: number, px0: number, pz0: number, px1: number, pz1: number,
  E: number, tint: Tint): Footprint[] {
  const taken: Footprint[] = [];
  const saved = b.finish;
  b.finish = r.pick([Finish.Boards, Finish.Ribbed, Finish.Cast]);
  for (const east of [false, true])
    for (const north of [false, true]) {
      const p = cornerPylon(ci, cj, east, north);
      if (!p) continue;
      const cx = east ? px1 : px0, cz = north ? pz1 : pz0;
      const sx = east ? -1 : 1, sz = north ? -1 : 1;
      const c = crossing(ci + (east ? 1 : 0), cj + (north ? 1 : 0))!;
      const kind = p.axis === "x" ? (north ? c.xs : c.xn)! : (east ? c.zw : c.ze)!;
      const [u0, us, v0, vs] = p.axis === "x" ? [cx + sx * 0.3, sx, cz + sz * 0.3, sz] : [cz + sz * 0.3, sz, cx + sx * 0.3, sx];
      (p.lift ? liftPylon : stairPylon)(b, r, p.axis, u0, us, v0, vs, E, p.level, tint, skyHalfWidth(kind));
      const [L, D] = pylonSize(p.lift, p.level - E);
      const ua = u0 + us * -0.6, ub = u0 + us * (L + 0.4);
      const va = v0 + vs * -0.5, vb = v0 + vs * (D + 0.5);
      const [a0, a1] = [Math.min(ua, ub), Math.max(ua, ub)], [c0, c1] = [Math.min(va, vb), Math.max(va, vb)];
      taken.push(p.axis === "x" ? { x0: a0, z0: c0, x1: a1, z1: c1 } : { x0: c0, z0: a0, x1: c1, z1: a1 });
      // this block builds the skyways that leave its east and north corners
      const centre = v0 + vs * SKY_MID;
      // pylon origin to pylon origin, across whatever the two podiums leave between them
      const alongX = p.axis === "x";
      const span = STREET + 0.6 + podiumInset(ci, cj, alongX ? 0 : 1)
        + (alongX ? podiumInset(ci + 1, cj, 2) : podiumInset(ci, cj + 1, 3));
      if (p.axis === "x" && east) skyway(b, "x", u0, u0 + span, centre, p.level, kind, tint);
      if (p.axis === "z" && north) skyway(b, "z", u0, u0 + span, centre, p.level, kind, tint);
    }
  b.finish = saved;
  return taken;
}

/**
 * Where two podiums have no bridge, sometimes the stubs of one are left: two cantilevers
 * with a gap to jump. Nothing but a runner uses them.
 */
function brokenBridge(b: Builder, r: Rng, axis: "x" | "z", a0: number, a1: number, c: number, ya: number, yb: number, tint: Tint): void {
  const put = (s0: number, s1: number, y0: number, y1: number, t0: number, t1: number, mat: Mat,
    opts: { collide?: boolean; detail?: boolean } = {}) => {
    if (axis === "x") b.box(s0, y0, t0, s1, y1, t1, mat, tint, 0, opts);
    else b.box(t0, y0, s0, t1, y1, s1, mat, tint, 0, opts);
  };
  const gap = r.uniform(2.6, 4.2);
  const mid = (a0 + a1) / 2 + r.uniform(-3, 3);
  const w = 3.2;
  const bits = { collide: false, detail: true };
  for (const [s0, s1, y, end] of [[a0, mid - gap / 2, ya, mid - gap / 2], [mid + gap / 2, a1, yb, mid + gap / 2]]) {
    const dir = end === s1 ? 1 : -1;
    put(s0, s1, y - 0.9, y, c - w / 2, c + w / 2, Mat.Board);
    put(s0 + 0.4, s1 - 0.4, y - 2.2, y - 0.9, c - 0.8, c + 0.8, Mat.Board);
    // parapet on one side only, stopping short of the broken end
    const side = r.chance(0.5) ? -1 : 1;
    const p0 = dir > 0 ? s0 : s0 + 2.5, p1 = dir > 0 ? s1 - 2.5 : s1;
    put(p0, p1, y, y + 1.05, side < 0 ? c - w / 2 : c + w / 2 - 0.25, side < 0 ? c - w / 2 + 0.25 : c + w / 2, Mat.Panel);
    // the broken edge: a ragged lip and bent reinforcing bars
    const lip = r.uniform(0.4, 1.0);
    put(dir > 0 ? end : end - lip, dir > 0 ? end + lip : end, y - 0.85, y - 0.4, c - w / 2 + 0.4, c + w / 2 - 0.9, Mat.Board, bits);
    for (let k = 0; k < 5; k++) {
      const t = c - w / 2 + 0.3 + k * 0.62, len = r.uniform(0.3, 1.3), drop = r.uniform(0, 0.6);
      put(dir > 0 ? end - 0.1 : end - len, dir > 0 ? end + len : end + 0.1, y - 0.7 - drop, y - 0.62 - drop, t - 0.03, t + 0.03, Mat.Metal, bits);
    }
  }
}

// ---------------------------------------------------------------------------
// Towers

interface Footprint { x0: number; z0: number; x1: number; z1: number }

/** Mid-rise with a walkable roof reached by an external stair. Optional tunnel. */
/**
 * Bridges between towers cross the facade stairs just below the roofs; lifting their decks a
 * little keeps the top steps from sharing a face with them (which flickers).
 */
const LINK_LIFT = 0.02;

function midTower(b: Builder, r: Rng, f: Footprint, base: number, top: number, tint: Tint, tunnel: boolean): void {
  const style = r.pick([Win.Punched, Win.Grid, Win.Slit, Win.Ribbon]);
  const { x0, z0, x1, z1 } = f;
  if (tunnel && z1 - z0 > 12 && top - base > 9) {
    const cz = (z0 + z1) / 2, tw = 3;
    b.box(x0, base, z0, x1, base + 5, cz - tw, Mat.Board, tint);
    b.box(x0, base, cz + tw, x1, base + 5, z1, Mat.Board, tint);
    b.box(x0, base + 5, z0, x1, top - 1, z1, Mat.Windows, tint, style);
    b.box(x0 + 0.4, base + 4.6, cz - tw, x1 - 0.4, base + 5, cz + tw, Mat.Glow, tint, 0, { collide: false, detail: true });
  } else {
    b.box(x0, base, z0, x1, top - 1, z1, Mat.Windows, tint, style);
  }
  b.box(x0 - 0.3, top - 1, z0 - 0.3, x1 + 0.3, top, z1 + 0.3, Mat.Deck, tint);
  kerb(b, x0 - 0.3, z0 - 0.3, x1 + 0.3, z1 + 0.3, top, tint, true);
  facadeStair(b, x0 - 0.3, z0 - 0.3, x1 + 0.3, z1 + 0.3, base, top, tint);
  // roof furniture
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const roll = r.next();
  if (roll > 0.55 && x1 - x0 > 11 && z1 - z0 > 11) {
    b.pad(cx, top, cz, r.int(0, 3) * Math.PI / 2);
  } else if (roll < 0.25) {
    b.box(cx - 1.5, top, cz - 1.5, cx + 1.5, top + 1.2, cz + 1.5, Mat.Metal, tint);
    b.box(cx - 1.0, top + 1.2, cz - 1.0, cx + 1.0, top + 2.4, cz + 1.0, Mat.Metal, tint);
  } else if (roll < 0.42) {
    // water tank on legs
    for (const [lx, lz] of [[-1.2, -1.2], [1.2, -1.2], [-1.2, 1.2], [1.2, 1.2]])
      b.box(cx + lx - 0.15, top, cz + lz - 0.15, cx + lx + 0.15, top + 2.2, cz + lz + 0.15, Mat.Metal, tint);
    b.box(cx - 1.6, top + 2.2, cz - 1.6, cx + 1.6, top + 4.6, cz + 1.6, Mat.Panel, tint);
  } else if (roll < 0.55) {
    b.box(cx - 0.3, top, cz - 0.3, cx + 0.3, top + r.uniform(8, 18), cz + 0.3, Mat.Metal, tint);
  }
}

/**
 * A drum: a regular ring of wall panels around (cx, cz) whose outer faces meet corner to
 * corner on a circle of radius `r`, filled by a square core so it is solid all the way
 * through. Sixteen sides read as round from the street; six or eight read as a faceted
 * silo, which is no less brutal.
 *
 * Panels are turned to stand tangent, so this is the one shape in the city that has no
 * face square to the grid.
 */
function drum(
  b: Builder, cx: number, cz: number, r: number, y0: number, y1: number, sides: number,
  mat: Mat, tint: Tint, style = 0, opts: { collide?: boolean; detail?: boolean; core?: boolean } = {},
): void {
  const apothem = r * Math.cos(Math.PI / sides); // where the flat of each panel sits
  const side = 2 * r * Math.sin(Math.PI / sides);
  const q = apothem * Math.SQRT1_2; // half-side of the largest square that stays inside
  const t = apothem - q; // panels reach inward as far as that square, leaving no gap
  const pass = { collide: opts.collide, detail: opts.detail };
  for (let k = 0; k < sides; k++) {
    const th = (Math.PI * 2 * k) / sides;
    const ox = Math.sin(th), oz = Math.cos(th);
    const px = cx + (apothem - t / 2) * ox, pz = cz + (apothem - t / 2) * oz;
    b.box(px - side / 2, y0, pz - t / 2, px + side / 2, y1, pz + t / 2, mat, tint, style, { ...pass, turn: -th });
  }
  if (opts.core !== false) b.box(cx - q, y0, cz - q, cx + q, y1, cz + q, Mat.Board, tint, 0, pass);
}

/**
 * A rectangular mass with its four corners cut back on an arc of radius `c`: a cross of two
 * axis-aligned boxes, plus `segs` turned boxes filling each corner out to the arc. One
 * segment is a flat chamfer, three or four read as round.
 *
 * Each corner box sits with its outer face on a chord of the arc and reaches inward past the
 * arc's centre, so whatever it covers beyond the corner square is solid podium anyway.
 */
function roundedMass(
  b: Builder, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
  c: number, segs: number, mat: Mat, tint: Tint, style = 0,
  opts: { collide?: boolean; detail?: boolean; mask?: number; seed?: number } = {},
): void {
  const mask = opts.mask ?? 0b1111;
  if (c <= 0.05 || !mask || 2 * c > Math.min(x1 - x0, z1 - z0)) {
    b.box(x0, y0, z0, x1, y1, z1, mat, tint, style, opts);
    return;
  }
  const at = (k: number) => (mask & (1 << k) ? c : 0);
  b.box(x0, y0, z0 + c, x1, y1, z1 - c, mat, tint, style, opts);
  b.box(x0 + at(CORNER_SW), y0, z0, x1 - at(CORNER_SE), y1, z0 + c, mat, tint, style, opts);
  b.box(x0 + at(CORNER_NW), y0, z1 - c, x1 - at(CORNER_NE), y1, z1, mat, tint, style, opts);
  cornerChords(x0, z0, x1, z1, c, segs, (mx, mz, nx, nz, chord, angle) => {
    const qx = mx - nx * (c / 2), qz = mz - nz * (c / 2);
    b.box(qx - chord / 2, y0, qz - c / 2, qx + chord / 2, y1, qz + c / 2, mat, tint, style, { ...opts, turn: angle });
  }, mask);
}

// Corner order shared by roundedMass, cornerChords and the cut mask.
const CORNER_SW = 0, CORNER_SE = 1, CORNER_NE = 2, CORNER_NW = 3;

/**
 * Walks the chords of the four corner arcs of a rectangle cut back by `c`, giving each one's
 * midpoint, outward normal, length and turn — enough to lay a box along it.
 */
function cornerChords(
  x0: number, z0: number, x1: number, z1: number, c: number, segs: number,
  fn: (mx: number, mz: number, nx: number, nz: number, chord: number, angle: number) => void,
  mask = 0b1111,
): void {
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]]; // SW, SE, NE, NW
  for (let k = 0; k < 4; k++) {
    if (!(mask & (1 << k))) continue;
    const [sx, sz] = corners[k];
    const ax = sx < 0 ? x0 + c : x1 - c, az = sz < 0 ? z0 + c : z1 - c;
    const from = sx < 0 ? Math.PI : 0; // the quadrant this corner faces, swept toward sz
    for (let k = 0; k < segs; k++) {
      const ta = from + ((sx * sz) * (Math.PI / 2) * k) / segs;
      const tb = from + ((sx * sz) * (Math.PI / 2) * (k + 1)) / segs;
      const pax = ax + c * Math.cos(ta), paz = az + c * Math.sin(ta);
      const pbx = ax + c * Math.cos(tb), pbz = az + c * Math.sin(tb);
      const mx = (pax + pbx) / 2, mz = (paz + pbz) / 2;
      const nl = Math.hypot(mx - ax, mz - az) || 1;
      fn(mx, mz, (mx - ax) / nl, (mz - az) / nl, Math.hypot(pbx - pax, pbz - paz),
        Math.atan2(pbz - paz, pbx - pax));
    }
  }
}

/** Plan of a tower shaft: a plain box, a cross with cut-back corners, or twin slabs joined by a core. */
type Plan = "box" | "cross" | "split";

/** One stretch of tower shaft from ya to yb in the given plan. */
function shaft(b: Builder, f: Footprint, ya: number, yb: number, plan: Plan, cut: number, tint: Tint, style: number): void {
  const { x0, z0, x1, z1 } = f;
  const w = x1 - x0, d = z1 - z0;
  if (plan === "cross" && Math.min(w, d) > 2 * cut + 6) {
    b.box(x0 + cut, ya, z0, x1 - cut, yb, z1, Mat.Windows, tint, style);
    b.box(x0, ya, z0 + cut, x0 + cut, yb, z1 - cut, Mat.Windows, tint, style);
    b.box(x1 - cut, ya, z0 + cut, x1, yb, z1 - cut, Mat.Windows, tint, style);
  } else if (plan === "split" && Math.min(w, d) > 14) {
    // a deep slot through the middle of the long faces; the core between the slabs is blank concrete
    const g = Math.min(cut, 2.5);
    if (w >= d) {
      const cz = (z0 + z1) / 2, c0 = x0 + w * 0.35, c1 = x1 - w * 0.35;
      b.box(x0, ya, z0, x1, yb, cz - g, Mat.Windows, tint, style);
      b.box(x0, ya, cz + g, x1, yb, z1, Mat.Windows, tint, style);
      b.box(c0, ya, cz - g, c1, yb, cz + g, Mat.Board, tint);
    } else {
      const cx = (x0 + x1) / 2, c0 = z0 + d * 0.35, c1 = z1 - d * 0.35;
      b.box(x0, ya, z0, cx - g, yb, z1, Mat.Windows, tint, style);
      b.box(cx + g, ya, z0, x1, yb, z1, Mat.Windows, tint, style);
      b.box(cx - g, ya, c0, cx + g, yb, c1, Mat.Board, tint);
    }
  } else {
    b.box(x0, ya, z0, x1, yb, z1, Mat.Windows, tint, style);
  }
}

/** Plant-floor bands wrapped around a shaft every `every` metres. */
function bands(b: Builder, f: Footprint, ya: number, yb: number, every: number, tint: Tint): void {
  for (let y = ya + every; y < yb - 6; y += every)
    b.box(f.x0 - 0.35, y - 1.4, f.z0 - 0.35, f.x1 + 0.35, y, f.z1 + 0.35, Mat.Panel, tint);
}

/**
 * Skyscraper with setbacks, an optional open sky lobby, fins and a crown. Its height is
 * limited by the footprint so narrow towers stay mid-height and only broad ones go very tall.
 * Returns the roof height below the crown.
 */
function tallTower(
  b: Builder, r: Rng, f: Footprint, base: number, top: number, tint: Tint, lobby: number | null,
  opts: { setbacks?: boolean; serviceShaft?: boolean } = {},
): number {
  const saved = b.finish;
  if (r.chance(0.45)) b.finish = r.pick([Finish.Boards, Finish.Ribbed, Finish.Cast]);
  const minSide = Math.min(f.x1 - f.x0, f.z1 - f.z0);
  const out = lobby === null && opts.setbacks !== false && minSide > 17 && top - base > 50 && r.chance(0.22)
    ? corbelTower(b, r, f, base, Math.min(top, base + minSide * r.uniform(4, 6)), tint)
    : towerBody(b, r, f, base, top, tint, lobby, opts);
  b.finish = saved;
  return out;
}

/**
 * Inverted ziggurat: a narrow plinth, then stages that each cantilever further out on a deep
 * concrete tray, ending at the full footprint. Returns the roof height.
 */
function corbelTower(b: Builder, r: Rng, f: Footprint, base: number, top: number, tint: Tint): number {
  const G = r.uniform(2.5, 4.5);
  const n = r.int(3, 4);
  const style = r.pick([Win.Crate, Win.Crate, Win.Grid, Win.Slit]);
  const inset = (s: number): Footprint => {
    const g = G * (1 - s / n);
    return { x0: f.x0 + g, z0: f.z0 + g, x1: f.x1 - g, z1: f.z1 - g };
  };
  const plinth = r.uniform(7, 12);
  const core = inset(0);
  const ci = 1.5;
  b.box(core.x0 + ci, base, core.z0 + ci, core.x1 - ci, base + plinth, core.z1 - ci, Mat.Board, tint, Finish.Ribbed);
  b.box(core.x0 + ci - 0.05, base + plinth - 0.05, core.z0 + ci - 0.05, core.x1 - ci + 0.05, base + plinth, core.z1 - ci + 0.05, Mat.Glow, tint, 0, { collide: false });
  const stageH = (top - base - plinth) / n;
  let y = base + plinth;
  for (let s = 1; s <= n; s++) {
    const g = inset(s);
    // tray: a deep slab that steps out beyond the stage below
    b.box(g.x0 - 0.3, y, g.z0 - 0.3, g.x1 + 0.3, y + 1.6, g.z1 + 0.3, Mat.Board, tint);
    b.box(g.x0, y + 1.6, g.z0, g.x1, y + stageH, g.z1, Mat.Windows, tint, style);
    y += stageH;
  }
  b.box(f.x0 - 0.6, y, f.z0 - 0.6, f.x1 + 0.6, y + 2.4, f.z1 + 0.6, Mat.Board, tint);
  const cx = (f.x0 + f.x1) / 2, cz = (f.z0 + f.z1) / 2;
  if (r.chance(0.5)) {
    b.pad(cx, y + 2.4, cz, r.int(0, 3) * Math.PI / 2);
    beacon(b, f.x0 - 0.3, y + 2.4, f.z0 - 0.3);
    beacon(b, f.x1 - 0.4, y + 2.4, f.z1 - 0.4);
  } else {
    const hw = (f.x1 - f.x0) * 0.3, hd = (f.z1 - f.z0) * 0.15, cap = r.uniform(3, 7);
    b.box(cx - hw, y + 2.4, cz - hd, cx + hw, y + 2.4 + cap, cz + hd, Mat.Board, tint);
    beacon(b, cx, y + 2.4 + cap, cz);
  }
  return y;
}

function towerBody(
  b: Builder, r: Rng, f: Footprint, base: number, top: number, tint: Tint, lobby: number | null,
  opts: { setbacks?: boolean; serviceShaft?: boolean },
): number {
  const style = r.pick([Win.Punched, Win.Ribbon, Win.Grid, Win.Slit, Win.Punched, Win.Crate]);
  let { x0, z0, x1, z1 } = f;
  const minSide = Math.min(x1 - x0, z1 - z0);
  top = Math.min(top, base + minSide * r.uniform(5, 8));
  top = Math.max(top, lobby !== null ? lobby + 26 : base + 24);
  const free = lobby === null;
  const plan: Plan = free ? r.pick<Plan>(["box", "box", "cross", "split"]) : "box";
  const cut = r.uniform(2.5, 4.5);
  const bandEvery = r.chance(0.4) ? r.pick([12, 15, 21]) : 0;
  const breaks: number[] = [];
  const nSet = top - base > 60 && opts.setbacks !== false ? r.int(0, 3) : 0;
  for (let i = 0; i < nSet; i++) breaks.push(r.uniform(base + 25, top - 20));
  breaks.sort((a, b2) => a - b2);
  // with a sky lobby, set back only above it so the lobby floor keeps the original footprint
  const levels = [base, ...breaks.filter((y) => lobby === null || y > lobby + 14), top];
  const lobbyH = 5;

  // on pilotis: a recessed core and corner columns carry the tower over the deck
  if (free && levels[1] - base > 30 && minSide > 13 && r.chance(0.3)) {
    const h = r.uniform(7, 12), ins = r.uniform(3, 4.5);
    b.box(x0 + ins, base, z0 + ins, x1 - ins, base + h, z1 - ins, Mat.Windows, tint, Win.Grid);
    for (const px of [x0, x1 - 1.6])
      for (const pz of [z0, z1 - 1.6])
        b.box(px, base, pz, px + 1.6, base + h, pz + 1.6, Mat.Board, tint, 0, { detail: false });
    b.box(x0 - 0.5, base + h, z0 - 0.5, x1 + 0.5, base + h + 1.6, z1 + 0.5, Mat.Board, tint);
    b.box(x0 + ins - 0.5, base + h - 0.05, z0 + 0.3, x1 - ins + 0.5, base + h, z0 + 0.5, Mat.Glow, tint, 0, { collide: false, detail: true });
    b.box(x0 + ins - 0.5, base + h - 0.05, z1 - 0.5, x1 - ins + 0.5, base + h, z1 - 0.3, Mat.Glow, tint, 0, { collide: false, detail: true });
    levels[0] = base + h + 1.6;
  } else if (free && r.chance(0.35)) {
    fins(b, r, x0, z0, x1, z1, base + 4, levels[1] - 2, 1.1, tint);
  }

  for (let s = 0; s < levels.length - 1; s++) {
    const ya = levels[s], yb = levels[s + 1];
    const cur = { x0, z0, x1, z1 };
    if (lobby !== null && lobby > ya && lobby + lobbyH < yb) {
      b.box(x0, ya, z0, x1, lobby - 0.8, z1, Mat.Windows, tint, style);
      b.box(x0 - 0.4, lobby - 0.8, z0 - 0.4, x1 + 0.4, lobby, z1 + 0.4, Mat.Deck, tint);
      // open floor held up only by corner columns, with a lit ceiling
      for (const px of [x0, x1 - 1.2])
        for (const pz of [z0, z1 - 1.2])
          b.box(px, lobby, pz, px + 1.2, lobby + lobbyH, pz + 1.2, Mat.Board, tint, 0, { detail: false });
      b.box(x0, lobby + lobbyH, z0, x1, lobby + lobbyH + 1.2, z1, Mat.Board, tint);
      b.box(x0 + 2, lobby + lobbyH - 0.05, z0 + 2, x1 - 2, lobby + lobbyH, z1 - 2, Mat.Glow, tint, 0, { collide: false });
      b.box(x0, lobby + lobbyH + 1.2, z0, x1, yb, z1, Mat.Windows, tint, style);
    } else {
      shaft(b, cur, ya, yb, plan, cut, tint, style);
    }
    if (bandEvery) bands(b, cur, ya, yb, bandEvery, tint);
    if (s < levels.length - 2) {
      // a hair above the shaft top, so the two top faces never share a plane
      b.box(x0 - 0.6, yb - 0.8, z0 - 0.6, x1 + 0.6, yb + 0.02, z1 + 0.6, Mat.Board, tint);
      // step back on one or two sides
      const inset = r.uniform(1.5, 4);
      const sides = r.int(1, 15);
      const nx0 = sides & 1 ? x0 + inset : x0, nx1 = sides & 2 ? x1 - inset : x1;
      const nz0 = sides & 4 ? z0 + inset : z0, nz1 = sides & 8 ? z1 - inset : z1;
      if (nx1 - nx0 > 8 && nz1 - nz0 > 8) [x0, x1, z0, z1] = [nx0, nx1, nz0, nz1];
    }
  }
  // service shaft on the tallest part, clear of the lobby floor
  if (r.chance(0.6) && lobby === null && opts.serviceShaft !== false) {
    const sw = r.uniform(3, 5), cz = (z0 + z1) / 2;
    b.box(x1, base, cz - sw / 2, x1 + sw, top + r.uniform(3, 10), cz + sw / 2, Mat.Board, tint);
  }
  const over = r.uniform(0.6, 2.5), ch = r.uniform(3, 8);
  b.box(x0 - over, top, z0 - over, x1 + over, top + ch, z1 + over, Mat.Board, tint);
  let peak = top + ch;
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  if (x1 - x0 > 10 && z1 - z0 > 10 && r.chance(0.35)) {
    b.pad(cx, peak, cz, r.int(0, 3) * Math.PI / 2);
    kerb(b, x0 - over, z0 - over, x1 + over, z1 + over, peak, tint, true);
    beacon(b, x0 - over + 0.6, peak + KERB, z0 - over + 0.6);
    beacon(b, x1 + over - 0.6, peak + KERB, z1 + over - 0.6);
    return top;
  }
  if (r.chance(0.5)) {
    const hw = (x1 - x0) * 0.22, hd = (z1 - z0) * 0.22, cap = r.uniform(4, 12);
    b.box(cx - hw, peak, cz - hd, cx + hw, peak + cap, cz + hd, Mat.Panel, tint);
    peak += cap;
  }
  if (r.chance(0.4)) {
    const mast = r.uniform(15, 45);
    b.box(cx - 0.4, peak, cz - 0.4, cx + 0.4, peak + mast, cz + 0.4, Mat.Metal, tint, 0, { detail: false });
    peak += mast;
  }
  beacon(b, cx, peak, cz);
  return top;
}

/** Smooth 0..1 value over a few blocks: dense high-rise districts and lower ones between them. */
export function districtDensity(ci: number, cj: number): number {
  const S = 5;
  const fx = ci / S, fz = cj / S;
  const ix = Math.floor(fx), iz = Math.floor(fz);
  const sm = (t: number) => t * t * (3 - 2 * t);
  const tx = sm(fx - ix), tz = sm(fz - iz);
  const v = (a: number, c: number) => (hashInt(a, c, 31) % 1024) / 1023;
  const top = v(ix, iz) + (v(ix + 1, iz) - v(ix, iz)) * tx;
  const bot = v(ix, iz + 1) + (v(ix + 1, iz + 1) - v(ix, iz + 1)) * tx;
  const n = top + (bot - top) * tz;
  return sm(Math.min(1, Math.max(0, (n - 0.2) / 0.6)));
}

function tallHeight(r: Rng, base: number, dens: number): number {
  const roll = r.next();
  const k = 0.55 + 1.05 * dens;
  if (roll < 0.35) return base + k * r.uniform(40, 80);
  if (roll < 0.8) return base + k * r.uniform(80, 160);
  return base + k * r.uniform(160, 280);
}

function midHeight(r: Rng, base: number, kMax = 5): number {
  return base + 6 * r.int(1, kMax);
}

/** Terraced ziggurat with a stair flight up to every level. */
function terraces(b: Builder, r: Rng, zone: Footprint, base: number, tint: Tint, dens: number): void {
  let { x0, z0, x1, z1 } = zone;
  let y = base;
  const levels = r.int(3, 6);
  const dx = r.chance(0.5) ? 1 : -1;
  for (let l = 0; l < levels; l++) {
    const h = 3;
    b.box(x0, y, z0, x1, y + h - 0.6, z1, Mat.Board, tint);
    b.box(x0 - 0.2, y + h - 0.6, z0 - 0.2, x1 + 0.2, y + h, z1 + 0.2, Mat.Deck, tint);
    // stair on the lower terrace, running along z against the face we step back from
    const sx = dx > 0 ? x0 - 2.2 : x1;
    const zStart = r.uniform(z0 + 1, z1 - 5);
    for (let i = 1; i <= 5; i++)
      b.box(sx, y, zStart + (i - 1) * 0.6, sx + 2.2, y + 0.5 * i, zStart + i * 0.6, Mat.Board, tint);
    b.box(dx > 0 ? sx : sx + 0.2, y, zStart + 3.0, dx > 0 ? sx + 2.0 : sx + 2.2, y + h, zStart + 4.2, Mat.Board, tint);
    y += h;
    const step = r.uniform(4, 7);
    if (dx > 0) x0 += step;
    else x1 -= step;
    if (r.chance(0.5)) z0 += r.uniform(0, 3);
    else z1 -= r.uniform(0, 3);
    if (x1 - x0 < 10 || z1 - z0 < 10) break;
  }
  kerb(b, x0 - 0.2, z0 - 0.2, x1 + 0.2, z1 + 0.2, y, tint, true);
  if (r.chance(0.5)) {
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, hw = Math.min(x1 - x0, z1 - z0) / 2 - 2;
    tallTower(b, r, { x0: cx - hw, z0: cz - hw, x1: cx + hw, z1: cz + hw }, y + KERB, tallHeight(r, y, dens), tint, null);
  } else {
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    b.box(cx - 1, y, cz - 4, cx + 1, y + r.uniform(8, 20), cz + 4, Mat.Board, tint);
  }
}

function parkourPillars(b: Builder, r: Rng, x: number, z: number, dirX: number, dirZ: number, base: number, tint: Tint): void {
  const n = r.int(3, 5);
  let h = base;
  for (let i = 0; i < n; i++) {
    h += r.uniform(0.9, 1.6);
    const px = x + dirX * i * 3.4, pz = z + dirZ * i * 3.4;
    b.box(px - 1, base, pz - 1, px + 1, h, pz + 1, Mat.Board, tint, 0, { detail: false });
  }
}

function pergola(b: Builder, r: Rng, f: Footprint, base: number, tint: Tint): void {
  const top = base + r.uniform(4.5, 6.5);
  const span = r.uniform(4, 6);
  for (let x = f.x0 + 1; x < f.x1 - 1; x += span) {
    for (const zc of [f.z0 + 1, f.z1 - 1]) b.box(x - 0.45, base, zc - 0.45, x + 0.45, top, zc + 0.45, Mat.Board, tint);
    b.box(x - 0.35, top, f.z0, x + 0.35, top + 1.1, f.z1, Mat.Board, tint);
  }
  b.box(f.x0, top + 1.1, f.z0 + 0.6, f.x1, top + 1.6, f.z0 + 1.4, Mat.Board, tint);
  b.box(f.x0, top + 1.1, f.z1 - 1.4, f.x1, top + 1.6, f.z1 - 0.6, Mat.Board, tint);
}

// ---------------------------------------------------------------------------
// Block layouts on top of the podium (zone is the 40 m inner square)

type Layout = (b: Builder, r: Rng, zone: Footprint, base: number, tint: Tint, dens: number) => void;

/** Sometimes a tower gets its own concrete mix instead of the block's. */
function towerTint(r: Rng, tint: Tint): Tint {
  return r.chance(0.35) ? r.pick(TINTS) : tint;
}

const single: Layout = (b, r, z, base, tint, dens) => {
  const w = r.uniform(20, 34), d = r.uniform(20, 34);
  let cx = (z.x0 + z.x1) / 2 + r.uniform(-1, 1) * (40 - w) / 2 * 0.7;
  let cz = (z.z0 + z.z1) / 2 + r.uniform(-1, 1) * (40 - d) / 2 * 0.7;
  const annex = r.chance(0.5) && w < 31 && d < 31;
  if (annex) {
    // annex (3 m) plus its facade stair (2.1 m) may stick out of the zone by 2 m at most
    const mx = (40 - w) / 2 - 3.1, mz = (40 - d) / 2 - 3.1;
    cx = (z.x0 + z.x1) / 2 + Math.max(-mx, Math.min(mx, cx - (z.x0 + z.x1) / 2));
    cz = (z.z0 + z.z1) / 2 + Math.max(-mz, Math.min(mz, cz - (z.z0 + z.z1) / 2));
  }
  const f = { x0: cx - w / 2, z0: cz - d / 2, x1: cx + w / 2, z1: cz + d / 2 };
  const t = towerTint(r, tint);
  if (annex) {
    // an accessible low annex wrapped around the base
    const top = midHeight(r, base, 2);
    midTower(b, r, { x0: f.x0 - 3, z0: f.z0 - 3, x1: f.x1 + 3, z1: f.z1 + 3 }, base, top, tint, false);
    tallTower(b, r, f, top + KERB, tallHeight(r, base, dens), t, null);
  } else {
    tallTower(b, r, f, base, tallHeight(r, base, dens), t, null);
  }
};

const pair: Layout = (b, r, z, base, tint, dens) => {
  const alongX = r.chance(0.5);
  const w1 = r.uniform(13, 16), w2 = r.uniform(14, 20);
  const d = r.uniform(14, 26);
  const c = alongX ? (z.z0 + z.z1) / 2 : (z.x0 + z.x1) / 2;
  const a0 = alongX ? z.x0 : z.z0, a1 = alongX ? z.x1 : z.z1;
  const make = (s0: number, s1: number): Footprint =>
    alongX ? { x0: s0, z0: c - d / 2, x1: s1, z1: c + d / 2 } : { x0: c - d / 2, z0: s0, x1: c + d / 2, z1: s1 };
  const A = make(a0, a0 + w1), B = make(a1 - w2, a1);
  const level = midHeight(r, base, 4);
  midTower(b, r, A, base, level, tint, r.chance(0.4));
  const roll = r.next();
  let bridge = true;
  if (roll < 0.6) tallTower(b, r, B, base, Math.max(level + 30, tallHeight(r, base, dens)), towerTint(r, tint), level);
  else if (roll < 0.85) midTower(b, r, B, base, level, tint, r.chance(0.4));
  else {
    midTower(b, r, B, base, midHeight(r, base), tint, false);
    bridge = false;
  }
  if (bridge) {
    const off = r.uniform(-d / 2 + 4, d / 2 - 4);
    stairBridge(b, r, alongX ? "x" : "z", a0 + w1 + 0.3, a1 - w2 - 0.4, c + off, 3.5, level + LINK_LIFT, level + LINK_LIFT, tint, r.chance(0.5));
  }
};

const quad: Layout = (b, r, z, base, tint, dens) => {
  const slot = 17, gap = 6;
  const level = midHeight(r, base, 4);
  const cx = z.x0 + slot + gap / 2, cz = z.z0 + slot + gap / 2;
  type Tower = { f: Footprint; connected: boolean };
  const towers: Tower[] = [];
  let mids = 0;
  for (let i = 0; i < 4; i++) {
    const sx = i % 2, sz = i >> 1;
    const w = r.uniform(11, slot), d = r.uniform(11, slot);
    const x0 = sx === 0 ? cx - gap / 2 - w : cx + gap / 2;
    const z0 = sz === 0 ? cz - gap / 2 - d : cz + gap / 2;
    const f = { x0, z0, x1: x0 + w, z1: z0 + d };
    const roll = r.next();
    const mustMid = i === 3 && mids === 0;
    if (mustMid || roll < 0.4) {
      midTower(b, r, f, base, level, tint, r.chance(0.3));
      mids++;
      towers.push({ f, connected: true });
    } else if (roll < 0.8) {
      tallTower(b, r, f, base, Math.max(level + 30, tallHeight(r, base, dens)), towerTint(r, tint), level);
      towers.push({ f, connected: true });
    } else {
      midTower(b, r, f, base, midHeight(r, base), tint, false);
      mids++;
      towers.push({ f, connected: false });
    }
  }
  const link = (a: Tower, c: Tower, alongX: boolean) => {
    if (!a.connected || !c.connected) return;
    if (alongX) {
      const lo = Math.max(a.f.z0, c.f.z0), hi = Math.min(a.f.z1, c.f.z1);
      const zc = sz(a.f) === 0 ? hi - 4 : lo + 4;
      stairBridge(b, r, "x", a.f.x1 + 0.3, c.f.x0 - 0.4, zc, 3.2, level + LINK_LIFT, level + LINK_LIFT, tint, r.chance(0.3));
    } else {
      const lo = Math.max(a.f.x0, c.f.x0), hi = Math.min(a.f.x1, c.f.x1);
      const xc = sx(a.f) === 0 ? hi - 4 : lo + 4;
      stairBridge(b, r, "z", a.f.z1 + 0.3, c.f.z0 - 0.4, xc, 3.2, level + LINK_LIFT, level + LINK_LIFT, tint, r.chance(0.3));
    }
  };
  const sx = (f: Footprint) => (f.x0 < cx ? 0 : 1);
  const sz = (f: Footprint) => (f.z0 < cz ? 0 : 1);
  link(towers[0], towers[1], true);
  link(towers[2], towers[3], true);
  link(towers[0], towers[2], false);
  link(towers[1], towers[3], false);
};

const garden: Layout = (b, r, z, base, tint, dens) => {
  const cx = (z.x0 + z.x1) / 2, cz = (z.z0 + z.z1) / 2;
  const w = r.uniform(13, 17);
  tallTower(b, r, { x0: z.x1 - w - 2, z0: z.z1 - w - 2, x1: z.x1 - 2, z1: z.z1 - 2 }, base, tallHeight(r, base, dens) + 40, towerTint(r, tint), null);
  pergola(b, r, { x0: z.x0 + 2, z0: z.z0 + 2, x1: cx + 4, z1: cz }, base, tint);
  for (let i = 0; i < r.int(1, 3); i++) {
    const mx = r.uniform(z.x0 + 2, cx - 4), mz = r.uniform(cz + 3, z.z1 - 10);
    b.box(mx, base, mz, mx + r.uniform(1.5, 3), base + r.uniform(8, 26), mz + r.uniform(5, 10), Mat.Board, tint);
  }
  parkourPillars(b, r, cx + 6, z.z0 + 4, 0, 1, base, tint);
};

const gate: Layout = (b, r, z, base, tint, dens) => {
  const f = { x0: z.x0 + 2, z0: z.z0 + r.uniform(4, 7), x1: z.x1 - 2, z1: z.z1 - r.uniform(4, 7) };
  const top = midHeight(r, base, 3);
  midTower(b, r, f, base, top, tint, true);
  const w = r.uniform(13, 18);
  const cx = (f.x0 + f.x1) / 2 + r.uniform(-5, 5), cz = (f.z0 + f.z1) / 2 + (r.chance(0.5) ? -1 : 1) * 4;
  const d = Math.min(w, f.z1 - f.z0 - 4);
  const tz0 = Math.max(f.z0 + 1, Math.min(cz - d / 2, f.z1 - 1 - d));
  tallTower(b, r, { x0: cx - w / 2, z0: tz0, x1: cx + w / 2, z1: tz0 + d }, top + KERB, tallHeight(r, top, dens), towerTint(r, tint), null);
};

/** Long slab block, sometimes with a detached service core joined to it by sky bridges. */
const slab: Layout = (b, r, z, base, tint, dens) => {
  const alongX = r.chance(0.5);
  const zx = (z.x0 + z.x1) / 2, zz = (z.z0 + z.z1) / 2;
  // a runs along the slab, c across it, both relative to the zone centre
  const fp = (a0: number, c0: number, a1: number, c1: number): Footprint =>
    alongX ? { x0: zx + a0, z0: zz + c0, x1: zx + a1, z1: zz + c1 } : { x0: zx + c0, z0: zz + a0, x1: zx + c1, z1: zz + a1 };
  const len = r.uniform(32, 40), dep = r.uniform(11, 15);
  const o = r.uniform(-19, 10.5 - dep);
  const t = towerTint(r, tint);
  const top = tallTower(b, r, fp(-len / 2, o, len / 2, o + dep), base, base + (0.6 + 0.6 * dens) * r.uniform(50, 110), t, null,
    { setbacks: false, serviceShaft: false });
  const c0 = o + dep + 3.5;
  if (r.chance(0.6)) {
    const cw = r.uniform(5, 7), ca = r.uniform(-len / 2 + 4, len / 2 - 4 - cw);
    const coreTop = top + r.uniform(6, 14);
    const core = fp(ca, c0, ca + cw, c0 + 5.5);
    b.box(core.x0, base, core.z0, core.x1, coreTop, core.z1, Mat.Windows, t, Win.Slit);
    b.box(core.x0 - 0.5, coreTop, core.z0 - 0.5, core.x1 + 0.5, coreTop + 1.5, core.z1 + 0.5, Mat.Board, t);
    beacon(b, (core.x0 + core.x1) / 2, coreTop + 1.5, (core.z0 + core.z1) / 2);
    // a covered link every third floor (starting clear of the deck)
    for (let y = base + 9; y < top - 4; y += 9.3) {
      const l = fp(ca + cw / 2 - 1.4, o + dep, ca + cw / 2 + 1.4, c0);
      b.box(l.x0, y, l.z0, l.x1, y + 3, l.z1, Mat.Windows, t, Win.Ribbon);
    }
  } else if (20 - c0 + 0.5 >= 9) {
    const al = r.uniform(12, 18), start = r.chance(0.5) ? -len / 2 : len / 2 - al;
    midTower(b, r, fp(start, c0 - 0.5, start + al, 20), base, midHeight(r, base, 3), tint, false);
  }
};

/** Bundled tubes: a grid of shafts of different heights that read as one tower. */
const cluster: Layout = (b, r, z, base, tint, dens) => {
  const W = r.uniform(26, 34), D = r.uniform(26, 34);
  const x0 = (z.x0 + z.x1) / 2 - W / 2 + r.uniform(-1, 1) * (40 - W) / 2;
  const z0 = (z.z0 + z.z1) / 2 - D / 2 + r.uniform(-1, 1) * (40 - D) / 2;
  const nx = r.int(2, 3), nz = r.int(2, 3);
  const t = towerTint(r, tint);
  const style = r.pick([Win.Punched, Win.Ribbon, Win.Grid, Win.Slit]);
  const H = Math.max(70, Math.min(tallHeight(r, base, Math.max(dens, 0.5)) - base, Math.min(W, D) * r.uniform(5.5, 8)));
  const tallest = r.int(0, nx * nz - 1);
  const every = r.chance(0.5) ? r.pick([15, 21]) : 0;
  // canopy over the deck around the foot of the bundle
  b.box(x0 - 1.8, base + 5.2, z0 - 1.8, x0 + W + 1.8, base + 6.4, z0 + D + 1.8, Mat.Board, t);
  for (let i = 0; i < nx; i++)
    for (let k = 0; k < nz; k++) {
      const f = { x0: x0 + (W * i) / nx, z0: z0 + (D * k) / nz, x1: x0 + (W * (i + 1)) / nx, z1: z0 + (D * (k + 1)) / nz };
      const idx = i * nz + k;
      const h = base + H * (idx === tallest ? 1 : r.pick([0.9, 0.75, 0.6, 0.45, 0.35]));
      b.box(f.x0, base, f.z0, f.x1, h, f.z1, Mat.Windows, t, style);
      if (every) bands(b, f, base + 6.4, h, every, t);
      b.box(f.x0 - 0.3, h, f.z0 - 0.3, f.x1 + 0.3, h + 1.6, f.z1 + 0.3, Mat.Board, t);
      const cx = (f.x0 + f.x1) / 2, cz = (f.z0 + f.z1) / 2;
      if (idx === tallest) {
        const mast = r.uniform(12, 40);
        b.box(cx - 0.4, h + 1.6, cz - 0.4, cx + 0.4, h + 1.6 + mast, cz + 0.4, Mat.Metal, t, 0, { detail: false });
        beacon(b, cx, h + 1.6 + mast, cz);
      } else if (r.chance(0.5)) {
        b.box(cx - 2, h + 1.6, cz - 1.5, cx + 2, h + 3.4, cz + 1.5, Mat.Metal, t);
      }
    }
};

/** Low courtyard block with passages through it, a walkable roof and sometimes a tower on one corner. */
const megablock: Layout = (b, r, z, base, tint, dens) => {
  const m = r.uniform(0.5, 2.5);
  const x0 = z.x0 + m, z0 = z.z0 + m, x1 = z.x1 - m, z1 = z.z1 - m;
  const t = r.uniform(9, 12);
  const top = base + 6 * r.int(3, 5);
  const style = r.pick([Win.Punched, Win.Ribbon, Win.Grid, Win.Punched]);
  const cx = (x0 + x1) / 2, pw = 3;
  // south and north wings, each with a passage at deck level
  for (const [za, zb] of [[z0, z0 + t], [z1 - t, z1]]) {
    b.box(x0, base, za, cx - pw, top - 1, zb, Mat.Windows, tint, style);
    b.box(cx + pw, base, za, x1, top - 1, zb, Mat.Windows, tint, style);
    b.box(cx - pw, base + 5, za, cx + pw, top - 1, zb, Mat.Windows, tint, style);
    b.box(cx - pw + 0.4, base + 4.95, za + 0.5, cx + pw - 0.4, base + 5, zb - 0.5, Mat.Glow, tint, 0, { collide: false, detail: true });
  }
  b.box(x0, base, z0 + t, x0 + t, top - 1, z1 - t, Mat.Windows, tint, style);
  b.box(x1 - t, base, z0 + t, x1, top - 1, z1 - t, Mat.Windows, tint, style);
  // roof deck
  b.box(x0 - 0.3, top - 1, z0 - 0.3, x1 + 0.3, top, z0 + t, Mat.Deck, tint);
  b.box(x0 - 0.3, top - 1, z1 - t, x1 + 0.3, top, z1 + 0.3, Mat.Deck, tint);
  b.box(x0 - 0.3, top - 1, z0 + t, x0 + t, top, z1 - t, Mat.Deck, tint);
  b.box(x1 - t, top - 1, z0 + t, x1 + 0.3, top, z1 - t, Mat.Deck, tint);
  kerb(b, x0 - 0.3, z0 - 0.3, x1 + 0.3, z1 + 0.3, top, tint, true);
  kerb(b, x0 + t - 0.35, z0 + t - 0.35, x1 - t + 0.35, z1 - t + 0.35, top, tint);
  facadeStair(b, x0 - 0.3, z0 - 0.3, x1 + 0.3, z1 + 0.3, base, top, tint);
  // the stair arrives on the south or east side, so the corner tower goes north-west
  const hx = (x0 + x1) / 2, hz = (z0 + z1) / 2;
  if (r.chance(0.55)) {
    const s = t - 1.2;
    tallTower(b, r, { x0: x0 + 1, z0: z1 - 1 - s, x1: x0 + 1 + s, z1: z1 - 1 }, top + KERB, tallHeight(r, top, dens), towerTint(r, tint), null);
  } else {
    b.box(x1 - t + 2, top, z0 + 2, x1 - 2, top + r.uniform(1.2, 2.4), z0 + t - 2, Mat.Metal, tint);
  }
  if (r.chance(0.5)) b.pad(hx, base, hz, r.int(0, 3) * Math.PI / 2);
  else pergola(b, r, { x0: x0 + t + 1.5, z0: z0 + t + 1.5, x1: x1 - t - 1.5, z1: z1 - t - 1.5 }, base, tint);
};

/**
 * Gate towers: two slender shafts with ribbed service cores, joined high up by a heavy bridge
 * block whose bare roof carries a landing pad; one shaft runs on above it to a drum crown.
 */
const twin: Layout = (b, r, z, base, tint, dens) => {
  const alongX = r.chance(0.5);
  const w = r.uniform(11, 14), d = r.uniform(15, 19);
  const zc = (alongX ? z.z0 + z.z1 : z.x0 + z.x1) / 2 + r.uniform(-1, 1) * (40 - d) / 2 * 0.6;
  const a0 = alongX ? z.x0 : z.z0, a1 = alongX ? z.x1 : z.z1;
  const fp = (s0: number, s1: number, c0: number, c1: number): Footprint =>
    alongX ? { x0: s0, z0: c0, x1: s1, z1: c1 } : { x0: c0, z0: s0, x1: c1, z1: s1 };
  const t = towerTint(r, tint);
  const saved = b.finish;
  b.finish = Finish.Ribbed;
  const H = base + Math.max(90, (0.8 + 0.6 * dens) * r.uniform(90, 150));
  const bridgeTop = H - r.uniform(4, 10), bridgeH = r.uniform(10, 16);
  const style = r.pick([Win.Crate, Win.Grid, Win.Slit]);
  const plain = r.chance(0.5) ? 0 : 1; // which tower runs on above the bridge
  for (const k of [0, 1]) {
    const s0 = k === 0 ? a0 : a1 - w, s1 = k === 0 ? a0 + w : a1;
    const shaftTop = k === plain ? bridgeTop + 2 : H + r.uniform(18, 34);
    // the shaft, with a ribbed core on its inner side between two strips of slit windows
    solid(b, fp(s0 + (k === 0 ? 0 : 3), s1 - (k === 0 ? 3 : 0), zc - d / 2, zc + d / 2), base, shaftTop, Mat.Windows, t, style);
    const core = fp(k === 0 ? s1 - 3 : s0, k === 0 ? s1 : s0 + 3, zc - d / 2 + 2, zc + d / 2 - 2);
    solid(b, core, base, shaftTop + 3, Mat.Board, t);
    const inner = fp(k === 0 ? s1 - 3 : s0, k === 0 ? s1 : s0 + 3, zc - d / 2, zc - d / 2 + 2);
    solid(b, inner, base + 6, shaftTop, Mat.Windows, t, Win.Slit);
    const inner2 = fp(k === 0 ? s1 - 3 : s0, k === 0 ? s1 : s0 + 3, zc + d / 2 - 2, zc + d / 2);
    solid(b, inner2, base + 6, shaftTop, Mat.Windows, t, Win.Slit);
    bands(b, fp(s0, s1, zc - d / 2, zc + d / 2), base, shaftTop, r.pick([18, 24]), t);
    if (k !== plain) {
      const cs = fp(s0 - 1.5, s1 + 1.5, zc - d / 2 - 1.5, zc + d / 2 + 1.5);
      solid(b, cs, shaftTop, shaftTop + 5, Mat.Windows, t, Win.Ribbon);
      solid(b, fp(s0 - 1.8, s1 + 1.8, zc - d / 2 - 1.8, zc + d / 2 + 1.8), shaftTop + 5, shaftTop + 6, Mat.Board, t);
      const mx = (s0 + s1) / 2;
      const mast = r.uniform(10, 30);
      const m = fp(mx - 0.4, mx + 0.4, zc - 0.4, zc + 0.4);
      solid(b, m, shaftTop + 6, shaftTop + 6 + mast, Mat.Metal, t, 0, { detail: false });
      beacon(b, (m.x0 + m.x1) / 2, shaftTop + 6 + mast, (m.z0 + m.z1) / 2);
    }
  }
  // the bridge block, a little deeper than the shafts
  const br = fp(a0 + w, a1 - w, zc - d / 2 - 1, zc + d / 2 + 1);
  solid(b, br, bridgeTop - bridgeH, bridgeTop - 1.4, Mat.Windows, t, Win.Crate);
  solid(b, fp(a0 + w - 0.5, a1 - w + 0.5, zc - d / 2 - 1.5, zc + d / 2 + 1.5), bridgeTop - 1.4, bridgeTop, Mat.Board, t);
  solid(b, fp(a0 + w, a1 - w, zc - d / 2 - 0.5, zc + d / 2 + 0.5), bridgeTop - bridgeH - 2.2, bridgeTop - bridgeH, Mat.Board, t);
  const pc = fp((a0 + a1) / 2, (a0 + a1) / 2, zc, zc);
  b.pad(pc.x0, bridgeTop, pc.z0, alongX ? Math.PI / 2 : 0);
  b.finish = saved;
  // a plaza pergola between the feet of the towers
  pergola(b, r, fp(a0 + w + 2, a1 - w - 2, zc - d / 2, zc + d / 2), base, tint);
};

/**
 * A round tower: a drum shaft standing on a walkable plinth, stepping back once or twice on
 * a ring cornice, with a lower drum beside it often enough that the block still reads as a
 * group. The one block layout with no face square to the street.
 */
const rotunda: Layout = (b, r, z, base, tint, dens) => {
  const sides = r.pick([12, 16, 16, 20]);
  const style = r.pick([Win.Ribbon, Win.Ribbon, Win.Punched, Win.Slit]);
  const zw = Math.min(z.x1 - z.x0, z.z1 - z.z0);
  const twin = r.chance(0.45) && zw > 34;
  const R = twin ? r.uniform(9, 11.5) : r.uniform(12, 16);
  const cx = (z.x0 + z.x1) / 2 + (twin ? -zw / 2 + R + 1 : r.uniform(-2, 2));
  const cz = (z.z0 + z.z1) / 2 + (twin ? r.uniform(-2, 2) : r.uniform(-2, 2));

  /** One drum tower from `base` up to `top`, stepping back on the way. */
  const stack = (dx: number, dz: number, rad: number, top: number, t: Tint): number => {
    const plinth = base + r.uniform(3, 5);
    drum(b, dx, dz, rad + r.uniform(1.6, 2.6), base, plinth, sides, Mat.Board, t);
    drum(b, dx, dz, rad + r.uniform(1.6, 2.6), plinth, plinth + KERB, sides, Mat.Panel, t, 0, { core: false, detail: true });
    let y = plinth, cur = rad;
    const stages = top - plinth > 70 ? r.int(2, 3) : 1;
    for (let s = 0; s < stages; s++) {
      const yb = s === stages - 1 ? top : y + (top - y) * r.uniform(0.4, 0.6);
      drum(b, dx, dz, cur, y, yb, sides, Mat.Windows, t, style);
      // a cornice ring where it steps in, which is also the only ledge on the way up
      drum(b, dx, dz, cur + 0.7, yb, yb + 1.3, sides, Mat.Panel, t, 0, { core: false });
      y = yb + 1.3;
      cur -= r.uniform(1.2, 2.2);
    }
    drum(b, dx, dz, cur + 1.1, y, y + r.uniform(2.4, 3.6), sides, Mat.Board, t);
    return y + 3.6;
  };

  const peak = stack(cx, cz, R, tallHeight(r, base, dens), towerTint(r, tint));
  if (R > 9) b.pad(cx, peak, cz, r.int(0, 3) * Math.PI / 2);
  beacon(b, cx, peak, cz);
  if (twin) {
    const ox = cx + R + r.uniform(8, 12) + 2;
    const or_ = Math.min(R, z.x1 - ox - 1);
    if (or_ > 6) {
      const top = stack(ox, cz, or_, base + 6 * r.int(4, 9), tint);
      // a skyway across to the tall one, tangent to both drums
      const y = top - r.uniform(6, 10);
      stairBridge(b, r, "x", cx + R - 1, ox - or_ + 1, cz, 3.5, y, y, tint, r.chance(0.4));
    }
  }
};

/** A box over footprint f from y0 to y1. */
function solid(b: Builder, f: Footprint, y0: number, y1: number, mat: Mat, tint: Tint, style = 0,
  opts: { collide?: boolean; detail?: boolean } = {}): void {
  b.box(f.x0, y0, f.z0, f.x1, y1, f.z1, mat, tint, style, opts);
}

const LAYOUTS: [Layout, (dens: number) => number][] = [
  [single, (d) => 3 * (0.4 + d)],
  [cluster, (d) => 2.5 * (0.1 + d)],
  [pair, () => 3],
  [quad, () => 3],
  [slab, () => 2],
  [terraces, (d) => 2 * (1.4 - d)],
  [megablock, (d) => 2 * (1.3 - d)],
  [twin, (d) => 0.6 + 1.2 * d],
  [garden, () => 1],
  [gate, () => 2],
  [rotunda, (d) => 1.6 + 1.4 * d],
];

function pickLayout(r: Rng, dens: number): Layout {
  const weights = LAYOUTS.map(([, w]) => w(dens));
  let x = r.uniform(0, weights.reduce((s, w) => s + w, 0));
  for (let i = 0; i < LAYOUTS.length; i++) {
    x -= weights[i];
    if (x <= 0) return LAYOUTS[i][0];
  }
  return LAYOUTS[0][0];
}

// ---------------------------------------------------------------------------
// Cell

/**
 * Central island down the avenue on this block's west edge. Everything it places stays
 * within 1.5 m of the line, which is the strip the traffic lanes leave clear, and it stops
 * well short of the junctions so cars can still turn across it and the crossings stay open.
 * Avenues carrying an expressway have no room: the piers already stand on the centre line.
 */
function median(b: Builder, r: Rng, ci: number, ox: number, oz: number, tint: Tint): void {
  if (hashInt(ci, 7) % 5 === 0) return;
  const HALF = 1.2, GAP = 14;
  const z0 = oz + GAP, z1 = oz + CELL - GAP;
  const kerb = 0.32;
  roundedMass(b, ox - HALF, 0, z0, ox + HALF, kerb, z1, HALF, 3, Mat.Deck, tint, 0, { seed: 0.42 });
  // a rail down the middle, broken where a planter takes its place
  const planters: [number, number][] = [];
  for (let z = z0 + 6; z < z1 - 8; z += r.uniform(14, 26)) planters.push([z, z + r.uniform(4, 7)]);
  const inPlanter = (z: number) => planters.some(([a, c]) => z > a - 1 && z < c + 1);
  for (let z = z0 + 1.2; z < z1 - 1; z += 2.4) {
    if (inPlanter(z)) continue;
    b.box(ox - 0.06, kerb, z - 0.06, ox + 0.06, kerb + 1.02, z + 0.06, Mat.Metal, tint);
    b.box(ox - 0.05, kerb + 0.92, z, ox + 0.05, kerb + 1.02, Math.min(z + 2.4, z1 - 1), Mat.Metal, tint, 0, { collide: false });
    b.box(ox - 0.04, kerb + 0.45, z, ox + 0.04, kerb + 0.53, Math.min(z + 2.4, z1 - 1), Mat.Metal, tint, 0, { collide: false });
  }
  for (const [a, c] of planters) {
    b.box(ox - HALF + 0.15, kerb, a, ox + HALF - 0.15, kerb + 0.62, c, Mat.Board, tint, Finish.Cast);
    b.box(ox - HALF + 0.35, kerb + 0.5, a + 0.2, ox + HALF - 0.35, kerb + 0.68, c - 0.2, Mat.Metal, [0.22, 0.26, 0.2], 0, { collide: false });
  }
}

/**
 * A signal mast on the block's south-west corner: an arm out over the avenue with a head for
 * the traffic coming up it, and a second head on the mast for the cross street. The two are
 * half a cycle apart, so one junction's aspects always contradict each other properly.
 */
function signals(b: Builder, ox: number, oz: number, tint: Tint): void {
  const x = ox + STREET / 2 + 1.0, z = oz + STREET / 2 + 1.0;
  const H = 6.2;
  b.box(x - 0.14, 0.18, z - 0.14, x + 0.14, H, z + 0.14, Mat.Metal, tint);
  b.box(ox + 2.6, H - 0.22, z - 0.09, x, H, z + 0.09, Mat.Metal, tint, 0, { collide: false });
  head(b, ox + 3.4, H - 0.3, z, 0, 0);
  head(b, x, H - 1.9, z - 0.35, 1, 0.5);
}

/** Three stacked aspects in a hood, facing -z (`axis` 0) or -x, on a cycle offset by `phase`. */
function head(b: Builder, x: number, top: number, z: number, axis: 0 | 1, phase: number): void {
  const w = 0.22, opts = { collide: false, detail: true, seed: phase };
  const [hx, hz] = axis === 0 ? [0.3, 0.16] : [0.16, 0.3];
  b.box(x - hx, top - 1.15, z - hz, x + hx, top, z + hz, Mat.Metal, [0.3, 0.32, 0.3], 0, { collide: false });
  for (let k = 0; k < 3; k++) {
    const y = top - 0.28 - k * 0.36;
    if (axis === 0) b.box(x - w, y - w, z - hz - 0.06, x + w, y + w, z - hz, Mat.Signal, WHITE, k, opts);
    else b.box(x - hx - 0.06, y - w, z - w, x - hx, y + w, z + w, Mat.Signal, WHITE, k, opts);
  }
}

/** Things that stand at the kerb: what a street has instead of a bare edge. */
function kerbside(b: Builder, r: Rng, ox: number, oz: number, tint: Tint, busy: [number, number][][]): void {
  const bx0 = ox + STREET / 2, bz0 = oz + STREET / 2;
  const grey: Tint = [0.86, 0.87, 0.88];
  for (let side = 0; side < 4; side++) {
    // a/b run along the face, d out from the kerb into the block
    const put = (a0: number, a1: number, d0: number, d1: number, y0: number, y1: number,
      mat: Mat, t: Tint, style = 0, opts: { collide?: boolean; detail?: boolean } = {}) => {
      const [p0, p1] = side < 2 ? [bx0 + CELL - STREET - d1, bx0 + CELL - STREET - d0] : [bx0 + d0, bx0 + d1];
      const [q0, q1] = side < 2 ? [bz0 + CELL - STREET - d1, bz0 + CELL - STREET - d0] : [bz0 + d0, bz0 + d1];
      if (side % 2 === 0) b.box(p0, y0, bz0 + a0, p1, y1, bz0 + a1, mat, t, style, opts);
      else b.box(bx0 + a0, y0, q0, bx0 + a1, y1, q1, mat, t, style, opts);
    };
    const free = (a: number, len: number) =>
      busy[side].every(([c0, c1]) => a > c1 || a + len < c0) &&
      // the lamp columns stand on this strip too
      [CELL * 0.3, CELL * 0.7].every((L) => a > L - STREET / 2 + 1.5 || a + len < L - STREET / 2 - 1.5);
    for (let a = 16; a < CELL - STREET - 12;) {
      const len = r.uniform(1.6, 3.2);
      if (!free(a, len)) {
        a += 2;
        continue;
      }
      const roll = r.next();
      if (roll < 0.3) {
        // a run of bollards
        for (let s = a + 0.4; s < a + len; s += 1.5) put(s - 0.14, s + 0.14, 0.55, 0.83, 0.18, 1.08, Mat.Board, grey, Finish.Cast);
      } else if (roll < 0.5) {
        // louvred vent plinth
        put(a, a + len, 0.5, 2.3, 0.18, 1.35, Mat.Board, tint, Finish.Ribbed);
        put(a + 0.15, a + len - 0.15, 0.4, 0.5, 0.5, 1.2, Mat.Metal, [0.2, 0.21, 0.22], 0, { collide: false });
      } else if (roll < 0.66) {
        // planter with a concrete tub
        put(a, a + len, 0.5, 2.1, 0.18, 0.82, Mat.Board, tint, Finish.Cast);
        put(a + 0.2, a + len - 0.2, 0.7, 1.9, 0.72, 0.95, Mat.Metal, [0.22, 0.26, 0.2], 0, { collide: false });
      } else if (roll < 0.8) {
        // utility cabinet
        put(a, a + Math.min(len, 1.3), 0.55, 1.35, 0.18, 1.7, Mat.Panel, grey);
      } else if (roll < 0.92) {
        // guard rail at the kerb
        for (let s = a; s < a + len; s += 1.8) {
          put(s - 0.05, s + 0.05, 0.5, 0.6, 0.18, 1.1, Mat.Metal, grey);
          put(s, Math.min(s + 1.8, a + len), 0.5, 0.58, 1.0, 1.1, Mat.Metal, grey, 0, { collide: false });
        }
      } else {
        // litter bin on a post
        put(a, a + 0.6, 0.6, 1.2, 0.18, 0.95, Mat.Metal, [0.24, 0.25, 0.26]);
        put(a + 0.05, a + 0.55, 0.65, 1.15, 0.95, 1.12, Mat.Metal, grey, 0, { collide: false });
      }
      a += len + r.uniform(3, 14);
    }
  }
}

function streetLevel(b: Builder, ox: number, oz: number): void {
  const s = STREET / 2;
  const bx0 = ox + s, bz0 = oz + s, bx1 = ox + CELL - s, bz1 = oz + CELL - s;
  b.box(bx0, 0, bz0, bx1, 0.18, bz1, Mat.Paving, WHITE, 0, { seed: 0 });
  lampHeadsLocal().forEach(([hx, hz], i) => {
    const wx = ox + hx, wz = oz + hz;
    const noCollide = { collide: false };
    if (i < 4) {
      const px = wx + (i < 2 ? 1.6 : -1.6);
      b.box(px - 0.12, 0.18, wz - 0.12, px + 0.12, LAMP_HEIGHT + 0.3, wz + 0.12, Mat.Metal);
      b.box(Math.min(px, wx) - 0.2, LAMP_HEIGHT + 0.1, wz - 0.06, Math.max(px, wx) + 0.2, LAMP_HEIGHT + 0.3, wz + 0.06, Mat.Metal, WHITE, 0, noCollide);
      b.box(wx - 0.5, LAMP_HEIGHT - 0.05, wz - 0.18, wx + 0.5, LAMP_HEIGHT + 0.1, wz + 0.18, Mat.Lamp, WHITE, 0, noCollide);
    } else {
      const pz = wz + (i < 6 ? 1.6 : -1.6);
      b.box(wx - 0.12, 0.18, pz - 0.12, wx + 0.12, LAMP_HEIGHT + 0.3, pz + 0.12, Mat.Metal);
      b.box(wx - 0.06, LAMP_HEIGHT + 0.1, Math.min(pz, wz) - 0.2, wx + 0.06, LAMP_HEIGHT + 0.3, Math.max(pz, wz) + 0.2, Mat.Metal, WHITE, 0, noCollide);
      b.box(wx - 0.18, LAMP_HEIGHT - 0.05, wz - 0.5, wx + 0.18, LAMP_HEIGHT + 0.1, wz + 0.5, Mat.Lamp, WHITE, 0, noCollide);
    }
  });
}

/** Cars parked along both curbs of the east-west street at z = oz. */
function parkedCars(b: Builder, r: Rng, ox: number, oz: number): void {
  for (const side of [-1, 1]) {
    const z = oz + side * 7.2;
    for (let x = ox + STREET / 2 + 5; x < ox + CELL - STREET / 2 - 5; x += 6.4) {
      if (!r.chance(0.38)) continue;
      const yaw = r.chance(0.5) ? Math.PI / 2 : -Math.PI / 2; // facing +x or -x
      b.cars.push({ x: x + r.uniform(-0.4, 0.4), y: 0, z, yaw, van: r.chance(0.15), color: r.pick(PAINT_COLORS) });
    }
  }
}

function expressways(b: Builder, ci: number, cj: number, ox: number, oz: number): void {
  const t: Tint = [0.96, 0.96, 0.97];
  if (hashInt(ci, 7) % 5 === 0) {
    const h = 6.5, x = ox;
    b.box(x - 6.5, h, oz, x + 6.5, h + 1.6, oz + CELL, Mat.Board, t, 0, { seed: 0.3 });
    b.box(x - 6.5, h + 1.6, oz, x - 6.0, h + 2.7, oz + CELL, Mat.Panel, t, 0, { seed: 0.3 });
    b.box(x + 6.0, h + 1.6, oz, x + 6.5, h + 2.7, oz + CELL, Mat.Panel, t, 0, { seed: 0.3 });
    for (const pz of [oz + 26, oz + 62]) {
      b.box(x - 0.9, 0, pz - 0.9, x + 0.9, h, pz + 0.9, Mat.Board, t, 0, { seed: 0.5 });
      b.box(x - 4.5, h - 1.4, pz - 1, x + 4.5, h, pz + 1, Mat.Board, t, 0, { seed: 0.5 });
    }
  }
  if (hashInt(cj, 8) % 5 === 0) {
    const h = 9.8, z = oz;
    b.box(ox, h, z - 6.5, ox + CELL, h + 1.6, z + 6.5, Mat.Board, t, 0, { seed: 0.6 });
    b.box(ox, h + 1.6, z - 6.5, ox + CELL, h + 2.7, z - 6.0, Mat.Panel, t, 0, { seed: 0.6 });
    b.box(ox, h + 1.6, z + 6.0, ox + CELL, h + 2.7, z + 6.5, Mat.Panel, t, 0, { seed: 0.6 });
    for (const px of [ox + 26, ox + 62]) {
      b.box(px - 0.9, 0, z - 0.9, px + 0.9, h, z + 0.9, Mat.Board, t, 0, { seed: 0.2 });
      b.box(px - 1, h - 1.4, z - 4.5, px + 1, h, z + 4.5, Mat.Board, t, 0, { seed: 0.2 });
    }
  }
}

/** Bridge centre offset along an edge, or null if the edge has no bridge. */
export function edgeBridge(ci: number, cj: number, dir: 0 | 1): number | null {
  const h = hashInt(ci, cj, 21 + dir);
  if (h % 100 >= 82) return null;
  return (Math.floor(h / 256) % 15) - 6;
}

/** Offset of the bridge leaving block (ci, cj) on `side` (0 east, 1 north, 2 west, 3 south), or null. */
export function bridgeOn(ci: number, cj: number, side: number): number | null {
  if (side === 0) return edgeBridge(ci, cj, 0);
  if (side === 1) return edgeBridge(ci, cj, 1);
  if (side === 2) return edgeBridge(ci - 1, cj, 0);
  return edgeBridge(ci, cj - 1, 1);
}

/** Podium corner k (0 south-west, 1 south-east, 2 north-west, 3 north-east) of block (ci, cj), with the directions into the podium. */
export function streetCorner(ci: number, cj: number, k: number): [number, number, number, number] {
  const east = k % 2 === 1, north = k >= 2;
  const x = ci * CELL + deckEdge(ci, cj, east ? 0 : 2);
  const z = cj * CELL + deckEdge(ci, cj, north ? 1 : 3);
  return [x, z, east ? -1 : 1, north ? -1 : 1];
}

export function buildCell(ci: number, cj: number, b: Builder): void {
  const r = new Rng(hashInt(ci, cj, 1));
  const ox = ci * CELL, oz = cj * CELL;
  const s = STREET / 2;
  const bx0 = ox + s, bz0 = oz + s;
  const px0 = ox + deckEdge(ci, cj, 2), pz0 = oz + deckEdge(ci, cj, 3);
  const px1 = ox + deckEdge(ci, cj, 0), pz1 = oz + deckEdge(ci, cj, 1);
  const E = podiumHeight(ci, cj);
  const tint = r.pick(TINTS);
  b.finish = r.pick([Finish.Boards, Finish.Boards, Finish.Ribbed, Finish.Cast]);

  streetLevel(b, ox, oz);
  expressways(b, ci, cj, ox, oz);
  parkedCars(b, r, ox, oz);
  const street = new Rng(hashInt(ci, cj, 50)); // its own stream: kerbside detail must not reshuffle the towers
  median(b, street, ci, ox, oz, tint);
  signals(b, ox, oz, tint);

  // --- podium: arcade on the street, office floors, walkable deck on top.
  // Many blocks cut their corners back, on a flat chamfer or on an arc, so the intersections
  // open out instead of being four right angles meeting.
  const cut = podiumCut(ci, cj);
  const segs = hashInt(ci, cj, 41) % 100 < 66 ? 1 : 3;
  // a corner can only be cut away if nothing stands on it: the street stair, the lift, or a
  // stair pylon all wrap a square corner and would be left hanging over the gap
  const stairAt = r.int(0, 3);
  const liftAt = r.chance(0.55) ? (stairAt + r.int(1, 3)) % 4 : -1;
  const CUT_OF_K = [CORNER_SW, CORNER_SE, CORNER_NW, CORNER_NE]; // streetCorner's k order
  let mask = 0b1111;
  mask &= ~(1 << CUT_OF_K[stairAt]);
  if (liftAt >= 0) mask &= ~(1 << CUT_OF_K[liftAt]);
  for (const [east, north, k] of [[0, 0, CORNER_SW], [1, 0, CORNER_SE], [1, 1, CORNER_NE], [0, 1, CORNER_NW]] as const)
    if (cornerPylon(ci, cj, !!east, !!north)) mask &= ~(1 << k);
  const arcade = 5.5;
  const cutOpts = { mask };
  roundedMass(b, px0 + 3, 0.18, pz0 + 3, px1 - 3, arcade, pz1 - 3, cut - 3, segs, Mat.Windows, tint, Win.Grid, cutOpts);
  // light strips under the overhang
  const g = { collide: false, detail: true };
  b.box(px0 + 1.4, arcade - 0.05, pz0 + 1.4, px1 - 1.4, arcade, pz0 + 1.6, Mat.Glow, tint, 0, g);
  b.box(px0 + 1.4, arcade - 0.05, pz1 - 1.6, px1 - 1.4, arcade, pz1 - 1.4, Mat.Glow, tint, 0, g);
  b.box(px0 + 1.4, arcade - 0.05, pz0 + 1.6, px0 + 1.6, arcade, pz1 - 1.6, Mat.Glow, tint, 0, g);
  b.box(px1 - 1.6, arcade - 0.05, pz0 + 1.6, px1 - 1.4, arcade, pz1 - 1.6, Mat.Glow, tint, 0, g);
  const colStep = 7.1;
  // columns stop short of a cut-back corner, where there is no longer a face for them to stand on
  for (let x = px0 + 0.6 + cut; x < px1 - cut; x += colStep) {
    b.box(x - 0.6, 0.18, pz0, x + 0.6, arcade, pz0 + 1.2, Mat.Board, tint);
    b.box(x - 0.6, 0.18, pz1 - 1.2, x + 0.6, arcade, pz1, Mat.Board, tint);
  }
  for (let z = pz0 + 0.6 + colStep + cut; z < pz1 - colStep - cut; z += colStep) {
    b.box(px0, 0.18, z - 0.6, px0 + 1.2, arcade, z + 0.6, Mat.Board, tint);
    b.box(px1 - 1.2, 0.18, z - 0.6, px1, arcade, z + 0.6, Mat.Board, tint);
  }
  roundedMass(b, px0, arcade, pz0, px1, E - 1.4, pz1, cut, segs, Mat.Windows, tint,
    r.pick([Win.Ribbon, Win.Grid, Win.Punched, Win.Crate]), cutOpts);
  roundedMass(b, px0 - 0.5, E - 1.4, pz0 - 0.5, px1 + 0.5, E, pz1 + 0.5, cut + 0.5, segs, Mat.Deck, tint, 0, cutOpts);
  kerb(b, px0 - 0.5, pz0 - 0.5, px1 + 0.5, pz1 + 0.5, E, tint, true, cut + 0.5, segs, mask);

  // --- from the street up to the deck: a stair round one corner, often a lift in another
  cornerStair(b, ...streetCorner(ci, cj, stairAt), E, tint);
  if (liftAt >= 0) streetLift(b, ...streetCorner(ci, cj, liftAt), E, tint);

  // --- kerbside furniture, wherever the stair and lift don't already wrap the corner
  const busy: [number, number][][] = [[], [], [], []];
  const face = CELL - STREET;
  for (const [k, reach] of [[stairAt, streetFlight(E).length + 5], [liftAt, LIFT_SIZE + 5]] as const) {
    if (k < 0) continue;
    const east = k % 2 === 1, north = k >= 2;
    for (const side of [east ? 0 : 2, north ? 1 : 3]) {
      const atEnd = side % 2 === 0 ? north : east;
      busy[side].push(atEnd ? [face - reach, face] : [0, reach]);
    }
  }
  kerbside(b, street, ox, oz, tint, busy);

  // --- bridges to the east and north neighbours. Both podiums set their own face back, so
  // a bridge is as long as the gap it actually has to cross.
  const far = (di: 0 | 1) => (di === 0 ? (ci + 1) * CELL + deckEdge(ci + 1, cj, 2) : (cj + 1) * CELL + deckEdge(ci, cj + 1, 3)) - 0.5;
  const east = edgeBridge(ci, cj, 0);
  if (east !== null) {
    const En = podiumHeight(ci + 1, cj);
    stairBridge(b, r, "x", px1 + 0.5, far(0), oz + CELL / 2 + east, 4.5, E, En, tint, r.chance(0.35));
  } else if (hashInt(ci, cj, 26) % 100 < 70) {
    const off = (hashInt(ci, cj, 27) % 15) - 6;
    brokenBridge(b, r, "x", px1 + 0.5, far(0), oz + CELL / 2 + off, E, podiumHeight(ci + 1, cj), tint);
  }
  const north = edgeBridge(ci, cj, 1);
  if (north !== null) {
    const En = podiumHeight(ci, cj + 1);
    stairBridge(b, r, "z", pz1 + 0.5, far(1), ox + CELL / 2 + north, 4.5, E, En, tint, r.chance(0.35));
  } else if (hashInt(ci, cj, 28) % 100 < 70) {
    const off = (hashInt(ci, cj, 29) % 15) - 6;
    brokenBridge(b, r, "z", pz1 + 0.5, far(1), ox + CELL / 2 + off, E, podiumHeight(ci, cj + 1), tint);
  }

  // --- stair pylons on the corners and the skyways between them
  const taken = skyways(b, r, ci, cj, px0, pz0, px1, pz1, E, tint);
  const free = (x0: number, z0: number, x1: number, z1: number) =>
    taken.every((t) => x1 < t.x0 - 0.8 || x0 > t.x1 + 0.8 || z1 < t.z0 - 0.8 || z0 > t.z1 + 0.8);

  // --- deck furniture in the ring between podium edge and towers
  const ringVents = r.int(1, 4);
  for (let i = 0; i < ringVents; i++) {
    const vx = r.chance(0.5) ? r.uniform(px0 + 1.5, px0 + 4) : r.uniform(px1 - 5, px1 - 2.5);
    // keep clear of the bridge landings around the middle of the east and west faces
    const cz = oz + CELL / 2;
    const vz = r.chance(0.5) ? r.uniform(pz0 + 2, cz - 13) : r.uniform(cz + 13, pz1 - 4);
    const vw = r.uniform(1.2, 2.5), vh = r.uniform(0.8, 1.6), vd = r.uniform(1.2, 2.5);
    // leave a walkway along the deck edge, as on the west side
    const x0 = Math.min(vx, px1 - 1.3 - vw);
    if (free(x0, vz, x0 + vw, vz + vd)) b.box(x0, E, vz, x0 + vw, E + vh, vz + vd, Mat.Metal, tint);
  }
  if (!(ci === 0 && cj === 0) && r.chance(0.5) && free(px1 - 4.5, pz0 + 3, px1 - 2.5, pz0 + 19)) {
    parkourPillars(b, r, px1 - 3.5, pz0 + 4, 0, 1, E, tint);
  }
  if ((ci === 0 && cj === 0) || r.chance(0.6)) {
    // beside the south face, or failing that beside the west face
    if (free(ox + CELL / 2 - 20, pz0, ox + CELL / 2 - 12, pz0 + 5.2)) b.pad(ox + CELL / 2 - 16, E, pz0 + 2.6, Math.PI / 2);
    else if (free(px0, pz0 + 9, px0 + 5.8, pz0 + 15)) b.pad(px0 + 2.9, E, pz0 + 12, 0);
  }

  // --- towers
  // The tower zone is the standard 40 m square, slid (never shrunk) to keep the same margin
  // behind every podium face that it has on a standard block, so a deep setback on one side
  // carries its towers back with it and the corner pylons keep their room.
  const ring = INNER - INSET;
  const zx = Math.max(px0 + ring, Math.min(px1 - ring - 40, bx0 + INNER));
  const zz = Math.max(pz0 + ring, Math.min(pz1 - ring - 40, bz0 + INNER));
  const zone = { x0: zx, z0: zz, x1: zx + 40, z1: zz + 40 };
  const dens = districtDensity(ci, cj);
  const home = ci === 0 && cj === 0;
  const layout = home ? quad : pickLayout(r, dens);
  // some blocks stand their towers askew to the street; the turn is limited by how much
  // room the zone has left inside the podium, since turning it grows its footprint
  const slack = Math.min(px1 - zone.x1, zone.x0 - px0, pz1 - zone.z1, zone.z0 - pz0);
  const skew = !home && r.chance(0.3) ? r.uniform(-1, 1) * Math.min(0.26, slack / 40) : 0;
  b.turned((zone.x0 + zone.x1) / 2, (zone.z0 + zone.z1) / 2, skew, () => layout(b, r, zone, E, tint, dens));
}

// ---------------------------------------------------------------------------
// Mesh assembly

/** Draw ranges for one city block: large boxes first, then small detail. */
export interface CellRange {
  lo: [number, number, number];
  hi: [number, number, number];
  /** Boxes big enough to read from anywhere; always drawn. */
  coarseStart: number;
  coarseCount: number;
  /** Smaller structural boxes, dropped beyond FAR_DISTANCE. */
  midStart: number;
  midCount: number;
  /** Small detail (steps, rails, fins), dropped beyond DETAIL_DISTANCE. */
  detailStart: number;
  detailCount: number;
}

export interface RegionMesh {
  rx: number;
  rz: number;
  vertices: Float32Array;
  /** Positions alone, for the depth-only passes. */
  positions: Float32Array;
  indices: Uint32Array;
  groundCount: number; // indices[0..groundCount] is the street slab
  cells: CellRange[];
  pads: (Pad & { id: string })[];
  lamps: number[];
  cars: (ParkedCar & { id: string })[];
  lifts: (Lift & { id: string })[];
  boats: (Pad & { id: string })[];
  maxHeight: number;
  colliders: { ci: number; cj: number; boxes: Float32Array }[];
}

/**
 * Collision boxes (six floats each: min, max) for everything a builder has placed. Turned
 * boxes are broken into axis-aligned slabs, since nothing downstream knows about turns.
 */
/**
 * Collide flag of a box that is solid but never drawn: the fill inside a mass whose walls and
 * roof are other boxes. Nothing can see it, and drawing it was a good share of the triangles.
 */
const HIDDEN = 2;

export function collidersOf(b: Builder): Float32Array {
  const list: number[] = [];
  for (let i = 0; i < b.count; i++) {
    const o = i * FLOATS_PER_BOX;
    if (!b.data[o + 12]) continue;
    const y0 = b.data[o + 1], y1 = b.data[o + 4];
    if (!b.data[o + 14] && !b.data[o + 15] && !b.data[o + 16]) {
      list.push(b.data[o], y0, b.data[o + 2], b.data[o + 3], y1, b.data[o + 5]);
      continue;
    }
    // A sheared box goes the same way a turned one does: the slabs are already cut across its
    // length, so each can simply carry the height of the ramp over its own slice. Outward at
    // both ends — the highest the top reaches over that slice and the lowest the soffit does —
    // because collision may never report less solid than there is, and a runner on a road
    // would rather step up a centimetre than fall through it.
    turnedSlabs(b.data, o, (x0, z0, x1, z1, top, bottom) =>
      list.push(x0, y0 + bottom, z0, x1, y1 + top, z1));
  }
  return Float32Array.from(list);
}

/** Widest slab `turnedSlabs` will cut: the staircase it leaves is about this times the tilt. */
const SLAB_WIDTH = 0.8;
const SLAB_LIMIT = 400;

/**
 * Collision only speaks AABB, and a turned box seen from above is a tilted rectangle. So it
 * is handed over as a run of axis-aligned slabs across its wider side, each holding the full
 * depth of the rectangle over that slice: a staircase that hugs the true outline to within a
 * slab's width times its tilt, and never reports less solid than there is.
 *
 * `out` also gets how far above the box's own y1 that slab's top stands and how far below
 * its y0 the soffit drops, both nothing unless the box is sheared (see `rise` in mesh.ts).
 */
function turnedSlabs(
  d: ArrayLike<number>, o: number,
  out: (x0: number, z0: number, x1: number, z1: number, top: number, bottom: number) => void,
): void {
  const [bx0, bz0, bx1, bz1] = boxBounds(d, o);
  const a = d[o + 14] * YAW_STEP;
  const cs = Math.cos(a), sn = Math.sin(a);
  const hx = (d[o + 3] - d[o]) / 2, hz = (d[o + 5] - d[o + 2]) / 2;
  const cx = d[o] + hx, cz = d[o + 2] + hz;
  const rise = d[o + 15] ?? 0, riseZ = d[o + 16] ?? 0;
  /** How far the shear carries the box over an axis-aligned patch of ground: most, then least. */
  const shearOver = (x0: number, z0: number, x1: number, z1: number): [number, number] => {
    if (!rise && !riseZ) return [0, 0];
    let hi = -Infinity, lo = Infinity;
    for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) {
      // where the patch's corner falls across the box's own two axes, as a fraction of each
      const px = x - cx, pz = z - cz;
      const u = (px * cs + pz * sn) / Math.max(hx, 1e-6);
      const w = (pz * cs - px * sn) / Math.max(hz, 1e-6);
      const d = (rise / 2) * Math.max(-1, Math.min(1, u)) + (riseZ / 2) * Math.max(-1, Math.min(1, w));
      hi = Math.max(hi, d);
      lo = Math.min(lo, d);
    }
    return [hi, lo];
  };
  // corners of the tilted rectangle, in order round it
  const px: number[] = [], pz: number[] = [];
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    px.push(cx + sx * hx * cs - sz * hz * sn);
    pz.push(cz + sx * hx * sn + sz * hz * cs);
  }
  // cut across whichever world axis the rectangle is longer on, so the slabs stay shallow
  const flip = bz1 - bz0 > bx1 - bx0;
  const u0 = flip ? bz0 : bx0, u1 = flip ? bz1 : bx1;
  const n = Math.max(1, Math.min(SLAB_LIMIT, Math.ceil((u1 - u0) / SLAB_WIDTH)));
  if (n === 1) return out(bx0, bz0, bx1, bz1, ...shearOver(bx0, bz0, bx1, bz1));
  const U = flip ? pz : px, V = flip ? px : pz;
  const step = (u1 - u0) / n;
  for (let k = 0; k < n; k++) {
    const ua = u0 + k * step, ub = ua + step;
    let lo = Infinity, hi = -Infinity;
    const take = (v: number) => {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    };
    for (let e = 0; e < 4; e++) {
      const f = (e + 1) % 4;
      if (U[e] >= ua && U[e] <= ub) take(V[e]);
      // where an edge crosses either cut, the rectangle reaches exactly that far
      for (const cut of [ua, ub]) {
        const t = (cut - U[e]) / (U[f] - U[e]);
        if (t >= 0 && t <= 1) take(V[e] + t * (V[f] - V[e]));
      }
    }
    if (lo > hi) continue; // the slice misses the rectangle entirely
    if (flip) out(lo, ua, hi, ub, ...shearOver(lo, ua, hi, ub));
    else out(ua, lo, ub, hi, ...shearOver(ua, lo, ub, hi));
  }
}

/**
 * Faces of a cell's boxes that are buried inside another box, as a per-box bitmask.
 * A box that covers a face has to contain that face's centre, so a grid over the cell
 * narrows the search to a handful of candidates instead of every box in the cell.
 *
 * A box may only hide a face of a box in its own tier or a shorter-lived one: tiers drop
 * out with distance, and a face hidden by something already gone would be a hole — which
 * the shadow pass turns into leaked light, since it drops tiers four times sooner.
 */
function buriedFaces(b: Builder): Uint8Array {
  const EPS = 1e-3, G = 16;
  const n = b.count, d = b.data;
  const masks = new Uint8Array(n);
  // the bucket grid covers whatever this builder actually spans, since a block is no longer
  // a fixed cell of the world
  let ox = Infinity, oz = Infinity, hx = -Infinity, hz = -Infinity;
  for (let i = 0; i < n; i++) {
    const [w0, v0, w1, v1] = boxBounds(d, i * FLOATS_PER_BOX);
    if (w0 < ox) ox = w0;
    if (v0 < oz) oz = v0;
    if (w1 > hx) hx = w1;
    if (v1 > hz) hz = v1;
  }
  const s = G / Math.max(1, Math.max(hx - ox, hz - oz) + 1e-3);
  const cl = (v: number) => Math.min(G - 1, Math.max(0, v | 0));

  // bucket the boxes: counting sort into one flat array, no per-bucket arrays
  const starts = new Int32Array(G * G + 1);
  const bx0 = new Int32Array(n), bx1 = new Int32Array(n), bz0 = new Int32Array(n), bz1 = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * FLOATS_PER_BOX;
    const [w0, v0, w1, v1] = boxBounds(d, o);
    bx0[i] = cl((w0 - ox) * s); bx1[i] = cl((w1 - ox) * s);
    bz0[i] = cl((v0 - oz) * s); bz1[i] = cl((v1 - oz) * s);
    for (let a = bx0[i]; a <= bx1[i]; a++) for (let c = bz0[i]; c <= bz1[i]; c++) starts[a * G + c + 1]++;
  }
  for (let k = 0; k < G * G; k++) starts[k + 1] += starts[k];
  const items = new Int32Array(starts[G * G]);
  const fill = starts.slice(0, G * G);
  for (let i = 0; i < n; i++)
    for (let a = bx0[i]; a <= bx1[i]; a++) for (let c = bz0[i]; c <= bz1[i]; c++) items[fill[a * G + c]++] = i;

  const lo = (i: number, a: number) => d[i * FLOATS_PER_BOX + a];
  const hi = (i: number, a: number) => d[i * FLOATS_PER_BOX + 3 + a];
  // 0 = bulk (always drawn), 1 = mid, 2 = detail: an occluder must outlast what it hides
  const tiers = new Uint8Array(n);
  for (let i = 0; i < n; i++) tiers[i] = boxTier(d, i * FLOATS_PER_BOX);
  for (let i = 0; i < n; i++) {
    const o = i * FLOATS_PER_BOX;
    // a turned or tilted box's faces aren't axis-aligned planes, so it neither hides nor is hidden
    if (d[o + 14] || d[o + 15] || d[o + 16]) continue;
    const tierI = tiers[i];
    const cx = (d[o] + d[o + 3]) / 2, cz = (d[o + 2] + d[o + 5]) / 2;
    let mask = 0;
    // face order matches FACES in mesh.ts: +x, -x, +z, -z, +y, -y
    for (let f = 0; f < 6; f++) {
      const axis = f < 2 ? 0 : f < 4 ? 2 : 1;
      const side = f % 2 === 0 ? 1 : 0; // even faces sit on the box maximum
      const plane = side ? hi(i, axis) : lo(i, axis);
      const u = (axis + 1) % 3, w = (axis + 2) % 3;
      const lu = lo(i, u), hu = hi(i, u), lw = lo(i, w), hw = hi(i, w);
      const fx = axis === 0 ? plane : cx, fz = axis === 2 ? plane : cz;
      const key = cl((fx - ox) * s) * G + cl((fz - oz) * s);
      for (let k = starts[key]; k < starts[key + 1]; k++) {
        const j = items[k];
        if (j === i || d[j * FLOATS_PER_BOX + 14] || d[j * FLOATS_PER_BOX + 15] || d[j * FLOATS_PER_BOX + 16]) continue;
        if (lo(j, u) > lu + EPS || hi(j, u) < hu - EPS) continue;
        if (lo(j, w) > lw + EPS || hi(j, w) < hw - EPS) continue;
        if (side ? !(lo(j, axis) <= plane + EPS && hi(j, axis) > plane + EPS)
                 : !(hi(j, axis) >= plane - EPS && lo(j, axis) < plane - EPS)) continue;
        if (tiers[j] > tierI) continue;
        mask |= 1 << f;
        break;
      }
    }
    masks[i] = mask;
  }
  return masks;
}

/**
 * A box whose largest face is this big still reads as a shape from far away and stays in
 * the coarsest tier. About 3.5 m on a side: at 700 m that is still several pixels across.
 */
const BULK_FACE_AREA = 12;

/** 0 = bulk (drawn at any distance), 1 = smaller structure, 2 = detail. */
function boxTier(d: ArrayLike<number>, o: number): number {
  if (d[o + 13] > 0.5) return 2;
  const w = d[o + 3] - d[o], h = d[o + 4] - d[o + 1], dep = d[o + 5] - d[o + 2];
  return Math.max(w * h, w * dep, h * dep) >= BULK_FACE_AREA ? 0 : 1;
}

export function buildRegion(rx: number, rz: number, faceCull = true): RegionMesh {
  const cells: Part[] = [];
  for (let ci = rx * REGION_CELLS; ci < (rx + 1) * REGION_CELLS; ci++)
    for (let cj = rz * REGION_CELLS; cj < (rz + 1) * REGION_CELLS; cj++) {
      const b = new Builder(new Rng(hashInt(ci, cj, 2)));
      buildCell(ci, cj, b);
      cells.push({ ci, cj, b });
    }
  return assembleRegion(rx, rz, cells, faceCull);
}

/** One piece of a region that meshes on its own: a block, with a name for its colliders. */
export interface Part {
  ci: number;
  cj: number;
  b: Builder;
}

/**
 * Turns the builders of a region into one mesh: the ground slab, then each part's boxes in
 * tier order so any prefix of them is a contiguous draw range, plus its colliders and the
 * bounds the frustum test uses. Shared by both plans — only what fills the builders differs.
 */
export function assembleRegion(rx: number, rz: number, cells: Part[], faceCull = true, street = true): RegionMesh {
  let total = 1;
  for (const c of cells) total += c.b.count;

  const vertices = new Float32Array(total * 24 * FLOATS_PER_VERTEX);
  const indices = new Uint32Array(total * 36);
  let boxIndex = 0;
  let idx = 0;
  let v = 0;
  let maxHeight = 0;

  const emit = (d: ArrayLike<number>, o: number, buried = 0, turn = 0, rise = 0, riseZ = 0) => {
    maxHeight = Math.max(maxHeight, d[o + 4] + (Math.abs(rise) + Math.abs(riseZ)) / 2);
    // a bottom face resting on the street or a sidewalk can never be seen either
    const mask = buried | (d[o + 1] <= 0.19 ? 1 << 5 : 0);
    ({ v, idx } = emitBox(d, o, vertices, v, indices, idx, boxIndex * 24, mask, turn, rise, riseZ));
    boxIndex++;
  };

  // Street slab for the whole region: the grid city's streets are the plane y = 0. The network
  // city has ground of its own, and a slab there floats over every valley and river, drawn
  // only by its edges — long thin beams hanging in the air at every region seam.
  const x0 = rx * REGION, z0 = rz * REGION;
  if (street) emit([x0, -1, z0, x0 + REGION, 0, z0 + REGION, 1, 1, 1, Mat.Asphalt, 0, 0], 0);
  const groundCount = idx;

  const ranges: CellRange[] = [];
  for (const { b } of cells) {
    const d = b.data;
    const buried = faceCull ? buriedFaces(b) : new Uint8Array(b.count);
    // three tiers, emitted in order so that any prefix of them is one contiguous range:
    // bulk (always drawn), the smaller coarse boxes, then detail
    const lo: [number, number, number] = [Infinity, Infinity, Infinity];
    const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < b.count; i++) {
      const o = i * FLOATS_PER_BOX;
      const [w0, v0, w1, v1] = boxBounds(d, o);
      lo[0] = Math.min(lo[0], w0); hi[0] = Math.max(hi[0], w1);
      const shear = (Math.abs(d[o + 15]) + Math.abs(d[o + 16])) / 2;
      lo[1] = Math.min(lo[1], d[o + 1] - shear); hi[1] = Math.max(hi[1], d[o + 4] + shear);
      lo[2] = Math.min(lo[2], v0); hi[2] = Math.max(hi[2], v1);
    }
    const tierPass = (tier: number) => {
      for (let i = 0; i < b.count; i++) {
        const o = i * FLOATS_PER_BOX;
        if (d[o + 12] !== HIDDEN && boxTier(d, o) === tier) emit(d, o, buried[i], d[o + 14], d[o + 15], d[o + 16]);
      }
    };
    const coarseStart = idx;
    tierPass(0);
    const midStart = idx;
    tierPass(1);
    const detailStart = idx;
    tierPass(2);
    ranges.push({
      lo, hi,
      coarseStart, coarseCount: midStart - coarseStart,
      midStart, midCount: detailStart - midStart,
      detailStart, detailCount: idx - detailStart,
    });
  }

  const colliders = cells.map(({ ci, cj, b }) => ({ ci, cj, boxes: collidersOf(b) }));

  const pads = cells.flatMap(({ ci, cj, b }) => b.pads.map((pd, k) => ({ ...pd, id: `p${ci},${cj},${k}` })));
  const cars = cells.flatMap(({ ci, cj, b }) => b.cars.map((c, k) => ({ ...c, id: `c${ci},${cj},${k}` })));
  const lifts = cells.flatMap(({ ci, cj, b }) => b.lifts.map((l, k) => ({ ...l, id: `l${ci},${cj},${k}` })));
  const boats = cells.flatMap(({ ci, cj, b }) => b.boats.map((v, k) => ({ ...v, id: `b${ci},${cj},${k}` })));
  return {
    rx, rz, vertices, positions: positionsOf(vertices, v), indices: indices.slice(0, idx),
    groundCount, cells: ranges, pads, cars, lifts, boats, maxHeight, colliders,
    lamps: cells.flatMap(({ b }) => b.lamps),
  };
}

/** Where the runner starts: on the podium deck of cell (0, 0). */
export function spawnPoint(): { x: number; y: number; z: number; yaw: number } {
  return { x: deckEdge(0, 0, 2) + 3, y: podiumHeight(0, 0), z: 26, yaw: 0 };
}

/** Test hook: the collision slabs of a box `w` x `d` centred on the origin, turned by `a`. */
export function __slabProbe(w: number, d: number, a: number): [number, number, number, number][] {
  const box = [-w / 2, 0, -d / 2, w / 2, 1, d / 2, 1, 1, 1, 0, 0, 0, 1, 0, yawStep(a), 0, 0];
  const out: [number, number, number, number][] = [];
  turnedSlabs(box, 0, (x0, z0, x1, z1) => out.push([x0, z0, x1, z1]));
  return out;
}
