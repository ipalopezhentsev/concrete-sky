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
import { emitBox, FLOATS_PER_VERTEX } from "./mesh";

export { VERTEX_LAYOUT, FLOATS_PER_VERTEX } from "./mesh";

export const CELL = 88;
export const STREET = 18;
export const REGION_CELLS = 3;
export const REGION = CELL * REGION_CELLS;
export const LAMP_HEIGHT = 7.2;
export const PODIUM_LEVELS = [18, 24, 30];
export const INSET = 6.5; // block edge -> podium face
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

/** Lamp head (x, z) positions in cell-local coordinates (shared with the shader). */
export function lampHeadsLocal(): [number, number][] {
  const s = STREET / 2;
  const over = s + 0.6 - 1.6;
  const far = CELL - over;
  const a = CELL * 0.3, b = CELL * 0.7;
  return [[over, a], [over, b], [far, a], [far, b], [a, over], [b, over], [a, far], [b, far]];
}

export const FLOATS_PER_BOX = 14; // x0 y0 z0 x1 y1 z1 r g b mat style seed collide detail

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
  cars: ParkedCar[] = [];
  lifts: Lift[] = [];
  /** Concrete finish given to Mat.Board boxes that don't ask for one. */
  finish: Finish = Finish.Boards;
  constructor(private rng: Rng) {}

  /** Painted landing pad (5 x 5 m) centred at (x, z) on a surface at height y. */
  pad(x: number, y: number, z: number, yaw: number): void {
    this.box(x - 2.6, y, z - 2.6, x + 2.6, y + 0.04, z + 2.6, Mat.Pad, WHITE, 0, { detail: false });
    this.pads.push({ x, y: y + 0.04, z, yaw });
  }

  lift(x0: number, z0: number, x1: number, z1: number, y0: number, y1: number): void {
    this.lifts.push({ x0, z0, x1, z1, y0, y1, phase: this.rng.next() });
  }

  box(
    x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
    mat: Mat, tint: Tint = WHITE, style = 0,
    opts: { collide?: boolean; detail?: boolean; seed?: number } = {},
  ): void {
    if (x1 - x0 < 1e-3 || y1 - y0 < 1e-3 || z1 - z0 < 1e-3) return;
    const volume = (x1 - x0) * (y1 - y0) * (z1 - z0);
    const detail = opts.detail ?? volume < 20;
    if (mat === Mat.Board && style === 0) style = this.finish;
    this.data.push(
      x0, y0, z0, x1, y1, z1, tint[0], tint[1], tint[2], mat, style,
      opts.seed ?? this.rng.next(), opts.collide === false ? 0 : 1, detail ? 1 : 0,
    );
    this.count++;
  }
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
  const land = 3;
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

function kerb(b: Builder, x0: number, z0: number, x1: number, z1: number, y: number, tint: Tint, glow = false): void {
  const t = 0.35;
  b.box(x0, y, z0, x1, y + KERB, z0 + t, Mat.Board, tint);
  b.box(x0, y, z1 - t, x1, y + KERB, z1, Mat.Board, tint);
  b.box(x0, y, z0 + t, x0 + t, y + KERB, z1 - t, Mat.Board, tint);
  b.box(x1 - t, y, z0 + t, x1, y + KERB, z1 - t, Mat.Board, tint);
  if (glow) {
    const g = { collide: false, detail: true };
    b.box(x0 + 0.1, y + KERB, z0 + 0.12, x1 - 0.1, y + KERB + 0.03, z0 + 0.2, Mat.Glow, tint, 0, g);
    b.box(x0 + 0.1, y + KERB, z1 - 0.2, x1 - 0.1, y + KERB + 0.03, z1 - 0.12, Mat.Glow, tint, 0, g);
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
      const span = 2 * (INSET + 0.3) + STREET;
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
  const x = ci * CELL + (east ? CELL - STREET / 2 - INSET : STREET / 2 + INSET);
  const z = cj * CELL + (north ? CELL - STREET / 2 - INSET : STREET / 2 + INSET);
  return [x, z, east ? -1 : 1, north ? -1 : 1];
}

export function buildCell(ci: number, cj: number, b: Builder): void {
  const r = new Rng(hashInt(ci, cj, 1));
  const ox = ci * CELL, oz = cj * CELL;
  const s = STREET / 2;
  const bx0 = ox + s, bz0 = oz + s, bx1 = ox + CELL - s, bz1 = oz + CELL - s;
  const px0 = bx0 + INSET, pz0 = bz0 + INSET, px1 = bx1 - INSET, pz1 = bz1 - INSET;
  const E = podiumHeight(ci, cj);
  const tint = r.pick(TINTS);
  b.finish = r.pick([Finish.Boards, Finish.Boards, Finish.Ribbed, Finish.Cast]);

  streetLevel(b, ox, oz);
  expressways(b, ci, cj, ox, oz);
  parkedCars(b, r, ox, oz);

  // --- podium: arcade on the street, office floors, walkable deck on top
  const arcade = 5.5;
  b.box(px0 + 3, 0.18, pz0 + 3, px1 - 3, arcade, pz1 - 3, Mat.Windows, tint, Win.Grid);
  // light strips under the overhang
  const g = { collide: false, detail: true };
  b.box(px0 + 1.4, arcade - 0.05, pz0 + 1.4, px1 - 1.4, arcade, pz0 + 1.6, Mat.Glow, tint, 0, g);
  b.box(px0 + 1.4, arcade - 0.05, pz1 - 1.6, px1 - 1.4, arcade, pz1 - 1.4, Mat.Glow, tint, 0, g);
  b.box(px0 + 1.4, arcade - 0.05, pz0 + 1.6, px0 + 1.6, arcade, pz1 - 1.6, Mat.Glow, tint, 0, g);
  b.box(px1 - 1.6, arcade - 0.05, pz0 + 1.6, px1 - 1.4, arcade, pz1 - 1.6, Mat.Glow, tint, 0, g);
  const colStep = 7.1;
  for (let x = px0 + 0.6; x < px1; x += colStep) {
    b.box(x - 0.6, 0.18, pz0, x + 0.6, arcade, pz0 + 1.2, Mat.Board, tint);
    b.box(x - 0.6, 0.18, pz1 - 1.2, x + 0.6, arcade, pz1, Mat.Board, tint);
  }
  for (let z = pz0 + 0.6 + colStep; z < pz1 - colStep; z += colStep) {
    b.box(px0, 0.18, z - 0.6, px0 + 1.2, arcade, z + 0.6, Mat.Board, tint);
    b.box(px1 - 1.2, 0.18, z - 0.6, px1, arcade, z + 0.6, Mat.Board, tint);
  }
  b.box(px0, arcade, pz0, px1, E - 1.4, pz1, Mat.Windows, tint, r.pick([Win.Ribbon, Win.Grid, Win.Punched, Win.Crate]));
  b.box(px0 - 0.5, E - 1.4, pz0 - 0.5, px1 + 0.5, E, pz1 + 0.5, Mat.Deck, tint);
  kerb(b, px0 - 0.5, pz0 - 0.5, px1 + 0.5, pz1 + 0.5, E, tint, true);

  // --- from the street up to the deck: a stair round one corner, often a lift in another
  const stairAt = r.int(0, 3);
  cornerStair(b, ...streetCorner(ci, cj, stairAt), E, tint);
  if (r.chance(0.55)) streetLift(b, ...streetCorner(ci, cj, (stairAt + r.int(1, 3)) % 4), E, tint);

  // --- bridges to the east and north neighbours
  const east = edgeBridge(ci, cj, 0);
  if (east !== null) {
    const En = podiumHeight(ci + 1, cj);
    stairBridge(b, r, "x", px1 + 0.5, px1 + 0.5 + 2 * INSET + STREET - 1, oz + CELL / 2 + east, 4.5, E, En, tint, r.chance(0.35));
  } else if (hashInt(ci, cj, 26) % 100 < 70) {
    const off = (hashInt(ci, cj, 27) % 15) - 6;
    brokenBridge(b, r, "x", px1 + 0.5, px1 + 0.5 + 2 * INSET + STREET - 1, oz + CELL / 2 + off, E, podiumHeight(ci + 1, cj), tint);
  }
  const north = edgeBridge(ci, cj, 1);
  if (north !== null) {
    const En = podiumHeight(ci, cj + 1);
    stairBridge(b, r, "z", pz1 + 0.5, pz1 + 0.5 + 2 * INSET + STREET - 1, ox + CELL / 2 + north, 4.5, E, En, tint, r.chance(0.35));
  } else if (hashInt(ci, cj, 28) % 100 < 70) {
    const off = (hashInt(ci, cj, 29) % 15) - 6;
    brokenBridge(b, r, "z", pz1 + 0.5, pz1 + 0.5 + 2 * INSET + STREET - 1, ox + CELL / 2 + off, E, podiumHeight(ci, cj + 1), tint);
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
  const zone = { x0: bx0 + INNER, z0: bz0 + INNER, x1: bx1 - INNER, z1: bz1 - INNER };
  const dens = districtDensity(ci, cj);
  const layout = ci === 0 && cj === 0 ? quad : pickLayout(r, dens);
  layout(b, r, zone, E, tint, dens);
}

// ---------------------------------------------------------------------------
// Mesh assembly

/** Draw ranges for one city block: large boxes first, then small detail. */
export interface CellRange {
  lo: [number, number, number];
  hi: [number, number, number];
  coarseStart: number;
  coarseCount: number;
  detailStart: number;
  detailCount: number;
}

export interface RegionMesh {
  rx: number;
  rz: number;
  vertices: Float32Array;
  indices: Uint32Array;
  groundCount: number; // indices[0..groundCount] is the street slab
  cells: CellRange[];
  pads: (Pad & { id: string })[];
  cars: (ParkedCar & { id: string })[];
  lifts: (Lift & { id: string })[];
  maxHeight: number;
  colliders: { ci: number; cj: number; boxes: Float32Array }[];
}

export function buildRegion(rx: number, rz: number): RegionMesh {
  const cells: { ci: number; cj: number; b: Builder }[] = [];
  let total = 1;
  for (let ci = rx * REGION_CELLS; ci < (rx + 1) * REGION_CELLS; ci++)
    for (let cj = rz * REGION_CELLS; cj < (rz + 1) * REGION_CELLS; cj++) {
      const b = new Builder(new Rng(hashInt(ci, cj, 2)));
      buildCell(ci, cj, b);
      cells.push({ ci, cj, b });
      total += b.count;
    }

  const vertices = new Float32Array(total * 24 * FLOATS_PER_VERTEX);
  const indices = new Uint32Array(total * 36);
  let boxIndex = 0;
  let idx = 0;
  let v = 0;
  let maxHeight = 0;

  const emit = (d: ArrayLike<number>, o: number) => {
    maxHeight = Math.max(maxHeight, d[o + 4]);
    // a bottom face resting on the street or a sidewalk can never be seen
    ({ v, idx } = emitBox(d, o, vertices, v, indices, idx, boxIndex * 24, d[o + 1] <= 0.19));
    boxIndex++;
  };

  // street slab for the whole region
  const x0 = rx * REGION, z0 = rz * REGION;
  emit([x0, -1, z0, x0 + REGION, 0, z0 + REGION, 1, 1, 1, Mat.Asphalt, 0, 0], 0);
  const groundCount = idx;

  const ranges: CellRange[] = [];
  for (const { b } of cells) {
    const d = b.data;
    const lo: [number, number, number] = [Infinity, Infinity, Infinity];
    const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < b.count; i++)
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], d[i * FLOATS_PER_BOX + k]);
        hi[k] = Math.max(hi[k], d[i * FLOATS_PER_BOX + 3 + k]);
      }
    const coarseStart = idx;
    for (let i = 0; i < b.count; i++) if (d[i * FLOATS_PER_BOX + 13] === 0) emit(d, i * FLOATS_PER_BOX);
    const detailStart = idx;
    for (let i = 0; i < b.count; i++) if (d[i * FLOATS_PER_BOX + 13] !== 0) emit(d, i * FLOATS_PER_BOX);
    ranges.push({
      lo, hi, coarseStart, coarseCount: detailStart - coarseStart, detailStart, detailCount: idx - detailStart,
    });
  }

  const colliders = cells.map(({ ci, cj, b }) => {
    const list: number[] = [];
    for (let i = 0; i < b.count; i++) {
      const o = i * FLOATS_PER_BOX;
      if (b.data[o + 12]) list.push(b.data[o], b.data[o + 1], b.data[o + 2], b.data[o + 3], b.data[o + 4], b.data[o + 5]);
    }
    return { ci, cj, boxes: Float32Array.from(list) };
  });

  const pads = cells.flatMap(({ ci, cj, b }) => b.pads.map((pd, k) => ({ ...pd, id: `p${ci},${cj},${k}` })));
  const cars = cells.flatMap(({ ci, cj, b }) => b.cars.map((c, k) => ({ ...c, id: `c${ci},${cj},${k}` })));
  const lifts = cells.flatMap(({ ci, cj, b }) => b.lifts.map((l, k) => ({ ...l, id: `l${ci},${cj},${k}` })));
  return { rx, rz, vertices, indices: indices.slice(0, idx), groundCount, cells: ranges, pads, cars, lifts, maxHeight, colliders };
}

/** Where the runner starts: on the podium deck of cell (0, 0). */
export function spawnPoint(): { x: number; y: number; z: number; yaw: number } {
  return { x: STREET / 2 + INSET + 3, y: podiumHeight(0, 0), z: 26, yaw: 0 };
}
