// Deterministic, infinite brutalist city made only of boxes.
//
// The world is a grid of CELL x CELL cells. Streets run along cell borders and sit
// in deep canyons: every block is a raised podium (the main running level) connected
// to its neighbours by bridges. Towers rise from the podiums; mid-rise towers have
// external stairs to their roofs and link to each other and to sky lobbies of
// skyscrapers. Stair towers lead up from the street.

import { hashInt, Rng } from "../math";
import { Mat, Win, type Tint } from "./materials";
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
  constructor(private rng: Rng) {}

  /** Painted landing pad (5 x 5 m) centred at (x, z) on a surface at height y. */
  pad(x: number, y: number, z: number, yaw: number): void {
    this.box(x - 2.6, y, z - 2.6, x + 2.6, y + 0.04, z + 2.6, Mat.Pad, WHITE, 0, { detail: false });
    this.pads.push({ x, y: y + 0.04, z, yaw });
  }

  box(
    x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
    mat: Mat, tint: Tint = WHITE, style = 0,
    opts: { collide?: boolean; detail?: boolean; seed?: number } = {},
  ): void {
    if (x1 - x0 < 1e-3 || y1 - y0 < 1e-3 || z1 - z0 < 1e-3) return;
    const volume = (x1 - x0) * (y1 - y0) * (z1 - z0);
    const detail = opts.detail ?? volume < 20;
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

/** Switchback stair tower. u runs along the axis, v across (v = 6 faces the podium). */
export function stairTower(
  b: Builder, axis: "x" | "z", u0: number, v0: number, vSign: 1 | -1, yTop: number, tint: Tint,
): void {
  const L = 9, D = 5.8;
  const put = (ua: number, ub: number, va: number, vb: number, y0: number, y1: number, mat: Mat, style = 0) => {
    // v measured from the outer side toward the podium
    const p = vSign > 0 ? [v0 + va, v0 + vb] : [v0 - vb, v0 - va];
    if (axis === "x") b.box(u0 + ua, y0, p[0], u0 + ub, y1, p[1], mat, tint, style);
    else b.box(p[0], y0, u0 + ua, p[1], y1, u0 + ub, mat, tint, style);
  };
  const wall = 0.4, lane = (D - 2 * wall - 0.4) / 2; // 2.3
  const laneA = [wall, wall + lane];
  const laneB = [D - wall - lane, D - wall];
  const mid = [wall + lane, D - wall - lane];
  const landU = 2.4;
  const flightU0 = wall + landU, flightU1 = L - wall - landU;
  // walls
  put(0, L, 0, wall, 0, yTop + 1.1, Mat.Windows, Win.Slit);
  put(0, L, D - wall, D, 0, yTop - 1.4, Mat.Board);
  put(0, wall, wall, D - wall, 3.2, yTop + 1.1, Mat.Board);
  put(L - wall, L, wall, D - wall, 0, yTop + 1.1, Mat.Board);
  put(flightU0, flightU1, mid[0], mid[1], 0, yTop + 1.1, Mat.Board);
  const flights = Math.round(yTop / 3);
  const steps = 5;
  const run = (flightU1 - flightU0) / steps;
  for (let k = 0; k < flights; k++) {
    const y = 3 * k;
    const lanes = k % 2 === 0 ? laneA : laneB;
    for (let i = 1; i <= steps; i++) {
      const top = y + 0.5 * i;
      const s0 = k % 2 === 0 ? flightU0 + (i - 1) * run : flightU1 - i * run;
      put(s0, s0 + run, lanes[0], lanes[1], Math.max(y, top - 0.4), top, Mat.Board);
    }
    const landing = y + 3;
    const [la, lb] = k % 2 === 0 ? [flightU1, L - wall] : [wall, flightU0];
    put(la, lb, wall, D - 0.5, landing - 0.4, landing, Mat.Deck);
  }
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
// Towers

interface Footprint { x0: number; z0: number; x1: number; z1: number }

/** Mid-rise with a walkable roof reached by an external stair. Optional tunnel. */
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

/** Skyscraper with setbacks, an optional open sky lobby, fins and a crown. */
function tallTower(b: Builder, r: Rng, f: Footprint, base: number, top: number, tint: Tint, lobby: number | null): void {
  const style = r.pick([Win.Punched, Win.Ribbon, Win.Grid, Win.Slit, Win.Punched]);
  let { x0, z0, x1, z1 } = f;
  const breaks: number[] = [];
  const nSet = r.int(0, 3);
  for (let i = 0; i < nSet; i++) breaks.push(r.uniform(base + 25, top - 20));
  breaks.sort((a, b2) => a - b2);
  // with a sky lobby, set back only above it so the lobby floor keeps the original footprint
  const levels = [base, ...breaks.filter((y) => lobby === null || y > lobby + 14), top];
  const lobbyH = 5;

  if (r.chance(0.35) && lobby === null) fins(b, r, x0, z0, x1, z1, base + 4, levels[1] - 2, 1.1, tint);

  for (let s = 0; s < levels.length - 1; s++) {
    const ya = levels[s], yb = levels[s + 1];
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
      b.box(x0, ya, z0, x1, yb, z1, Mat.Windows, tint, style);
    }
    if (s < levels.length - 2) {
      b.box(x0 - 0.6, yb - 0.8, z0 - 0.6, x1 + 0.6, yb, z1 + 0.6, Mat.Board, tint);
      // step back on one or two sides
      const inset = r.uniform(1.5, 4);
      const sides = r.int(1, 15);
      const nx0 = sides & 1 ? x0 + inset : x0, nx1 = sides & 2 ? x1 - inset : x1;
      const nz0 = sides & 4 ? z0 + inset : z0, nz1 = sides & 8 ? z1 - inset : z1;
      if (nx1 - nx0 > 8 && nz1 - nz0 > 8) [x0, x1, z0, z1] = [nx0, nx1, nz0, nz1];
    }
  }
  // service shaft on the tallest part, clear of the lobby floor
  if (r.chance(0.6) && lobby === null) {
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
    return;
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
}

function tallHeight(r: Rng, base: number): number {
  const roll = r.next();
  if (roll < 0.35) return base + r.uniform(45, 90);
  if (roll < 0.8) return base + r.uniform(90, 170);
  return base + r.uniform(170, 300);
}

function midHeight(r: Rng, base: number, kMax = 5): number {
  return base + 6 * r.int(1, kMax);
}

/** Terraced ziggurat with a stair flight up to every level. */
function terraces(b: Builder, r: Rng, zone: Footprint, base: number, tint: Tint): void {
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
    b.box(sx, y, zStart + 3.0, sx + 2.2, y + h, zStart + 4.2, Mat.Board, tint);
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
    tallTower(b, r, { x0: cx - hw, z0: cz - hw, x1: cx + hw, z1: cz + hw }, y + KERB, tallHeight(r, y), tint, null);
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

type Layout = (b: Builder, r: Rng, zone: Footprint, base: number, tint: Tint) => void;

const single: Layout = (b, r, z, base, tint) => {
  const w = r.uniform(18, 28), d = r.uniform(18, 28);
  const cx = (z.x0 + z.x1) / 2 + r.uniform(-4, 4), cz = (z.z0 + z.z1) / 2 + r.uniform(-4, 4);
  const f = { x0: cx - w / 2, z0: cz - d / 2, x1: cx + w / 2, z1: cz + d / 2 };
  if (r.chance(0.5)) {
    // an accessible low annex wrapped around the base
    const top = midHeight(r, base, 2);
    midTower(b, r, { x0: f.x0 - 3, z0: f.z0 - 3, x1: f.x1 + 3, z1: f.z1 + 3 }, base, top, tint, false);
    tallTower(b, r, f, top + KERB, tallHeight(r, base), tint, null);
  } else {
    tallTower(b, r, f, base, tallHeight(r, base), tint, null);
  }
};

const pair: Layout = (b, r, z, base, tint) => {
  const alongX = r.chance(0.5);
  const w1 = r.uniform(13, 17), w2 = r.uniform(13, 17);
  const d = r.uniform(14, 24);
  const c = alongX ? (z.z0 + z.z1) / 2 : (z.x0 + z.x1) / 2;
  const a0 = alongX ? z.x0 : z.z0, a1 = alongX ? z.x1 : z.z1;
  const make = (s0: number, s1: number): Footprint =>
    alongX ? { x0: s0, z0: c - d / 2, x1: s1, z1: c + d / 2 } : { x0: c - d / 2, z0: s0, x1: c + d / 2, z1: s1 };
  const A = make(a0, a0 + w1), B = make(a1 - w2, a1);
  const level = midHeight(r, base, 4);
  midTower(b, r, A, base, level, tint, r.chance(0.4));
  const roll = r.next();
  let bridge = true;
  if (roll < 0.6) tallTower(b, r, B, base, Math.max(level + 30, tallHeight(r, base)), tint, level);
  else if (roll < 0.85) midTower(b, r, B, base, level, tint, r.chance(0.4));
  else {
    midTower(b, r, B, base, midHeight(r, base), tint, false);
    bridge = false;
  }
  if (bridge) {
    const off = r.uniform(-d / 2 + 4, d / 2 - 4);
    stairBridge(b, r, alongX ? "x" : "z", a0 + w1 + 0.3, a1 - w2 - 0.4, c + off, 3.5, level, level, tint, r.chance(0.5));
  }
};

const quad: Layout = (b, r, z, base, tint) => {
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
      tallTower(b, r, f, base, Math.max(level + 30, tallHeight(r, base)), tint, level);
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
      stairBridge(b, r, "x", a.f.x1 + 0.3, c.f.x0 - 0.4, zc, 3.2, level, level, tint, r.chance(0.3));
    } else {
      const lo = Math.max(a.f.x0, c.f.x0), hi = Math.min(a.f.x1, c.f.x1);
      const xc = sx(a.f) === 0 ? hi - 4 : lo + 4;
      stairBridge(b, r, "z", a.f.z1 + 0.3, c.f.z0 - 0.4, xc, 3.2, level, level, tint, r.chance(0.3));
    }
  };
  const sx = (f: Footprint) => (f.x0 < cx ? 0 : 1);
  const sz = (f: Footprint) => (f.z0 < cz ? 0 : 1);
  link(towers[0], towers[1], true);
  link(towers[2], towers[3], true);
  link(towers[0], towers[2], false);
  link(towers[1], towers[3], false);
};

const garden: Layout = (b, r, z, base, tint) => {
  const cx = (z.x0 + z.x1) / 2, cz = (z.z0 + z.z1) / 2;
  const w = r.uniform(10, 13);
  tallTower(b, r, { x0: z.x1 - w - 2, z0: z.z1 - w - 2, x1: z.x1 - 2, z1: z.z1 - 2 }, base, tallHeight(r, base) + 40, tint, null);
  pergola(b, r, { x0: z.x0 + 2, z0: z.z0 + 2, x1: cx + 4, z1: cz }, base, tint);
  for (let i = 0; i < r.int(1, 3); i++) {
    const mx = r.uniform(z.x0 + 2, cx), mz = r.uniform(cz + 3, z.z1 - 10);
    b.box(mx, base, mz, mx + r.uniform(1.5, 3), base + r.uniform(8, 26), mz + r.uniform(5, 10), Mat.Board, tint);
  }
  parkourPillars(b, r, cx + 6, z.z0 + 4, 0, 1, base, tint);
};

const gate: Layout = (b, r, z, base, tint) => {
  const f = { x0: z.x0 + 2, z0: z.z0 + r.uniform(4, 8), x1: z.x1 - 2, z1: z.z1 - r.uniform(4, 8) };
  const top = midHeight(r, base, 3);
  midTower(b, r, f, base, top, tint, true);
  const w = r.uniform(10, 14);
  const cx = (f.x0 + f.x1) / 2 + r.uniform(-6, 6), cz = (f.z0 + f.z1) / 2 + (r.chance(0.5) ? -1 : 1) * 5;
  tallTower(b, r, { x0: cx - w / 2, z0: cz - w / 2 - 1, x1: cx + w / 2, z1: cz + w / 2 - 1 }, top + KERB, tallHeight(r, top), tint, null);
};

const LAYOUTS: [Layout, number][] = [
  [single, 3],
  [pair, 3],
  [quad, 3],
  [terraces, 2],
  [garden, 1],
  [gate, 2],
];

function pickLayout(r: Rng): Layout {
  const total = LAYOUTS.reduce((s, [, w]) => s + w, 0);
  let x = r.uniform(0, total);
  for (const [l, w] of LAYOUTS) {
    x -= w;
    if (x <= 0) return l;
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

export function buildCell(ci: number, cj: number, b: Builder): void {
  const r = new Rng(hashInt(ci, cj, 1));
  const ox = ci * CELL, oz = cj * CELL;
  const s = STREET / 2;
  const bx0 = ox + s, bz0 = oz + s, bx1 = ox + CELL - s, bz1 = oz + CELL - s;
  const px0 = bx0 + INSET, pz0 = bz0 + INSET, px1 = bx1 - INSET, pz1 = bz1 - INSET;
  const E = podiumHeight(ci, cj);
  const tint = r.pick(TINTS);

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
  b.box(px0, arcade, pz0, px1, E - 1.4, pz1, Mat.Windows, tint, r.pick([Win.Ribbon, Win.Grid, Win.Punched]));
  b.box(px0 - 0.5, E - 1.4, pz0 - 0.5, px1 + 0.5, E, pz1 + 0.5, Mat.Deck, tint);
  kerb(b, px0 - 0.5, pz0 - 0.5, px1 + 0.5, pz1 + 0.5, E, tint, true);

  // --- stair tower from the street up to the deck
  const side = r.int(0, 3);
  const ts = r.uniform(1, 3);
  if (side === 0) stairTower(b, "z", pz0 + ts, px0 - 5.8, 1, E, tint);
  else if (side === 1) stairTower(b, "z", pz1 - 9 - ts, px1 + 5.8, -1, E, tint);
  else if (side === 2) stairTower(b, "x", px0 + ts, pz0 - 5.8, 1, E, tint);
  else stairTower(b, "x", px1 - 9 - ts, pz1 + 5.8, -1, E, tint);

  // --- bridges to the east and north neighbours
  const east = edgeBridge(ci, cj, 0);
  if (east !== null) {
    const En = podiumHeight(ci + 1, cj);
    stairBridge(b, r, "x", px1 + 0.5, px1 + 0.5 + 2 * INSET + STREET - 1, oz + CELL / 2 + east, 4.5, E, En, tint, r.chance(0.35));
  }
  const north = edgeBridge(ci, cj, 1);
  if (north !== null) {
    const En = podiumHeight(ci, cj + 1);
    stairBridge(b, r, "z", pz1 + 0.5, pz1 + 0.5 + 2 * INSET + STREET - 1, ox + CELL / 2 + north, 4.5, E, En, tint, r.chance(0.35));
  }

  // --- deck furniture in the ring between podium edge and towers
  const ringVents = r.int(1, 4);
  for (let i = 0; i < ringVents; i++) {
    const vx = r.chance(0.5) ? r.uniform(px0 + 1.5, px0 + 4) : r.uniform(px1 - 5, px1 - 2.5);
    // keep clear of the bridge landings around the middle of the east and west faces
    const cz = oz + CELL / 2;
    const vz = r.chance(0.5) ? r.uniform(pz0 + 2, cz - 13) : r.uniform(cz + 13, pz1 - 4);
    b.box(vx, E, vz, vx + r.uniform(1.2, 2.5), E + r.uniform(0.8, 1.6), vz + r.uniform(1.2, 2.5), Mat.Metal, tint);
  }
  if (!(ci === 0 && cj === 0) && r.chance(0.5)) {
    parkourPillars(b, r, px1 - 3.5, pz0 + 4, 0, 1, E, tint);
  }
  if ((ci === 0 && cj === 0) || r.chance(0.6)) b.pad(ox + CELL / 2 - 16, E, pz0 + 2.6, Math.PI / 2);

  // --- towers
  const zone = { x0: bx0 + INNER, z0: bz0 + INNER, x1: bx1 - INNER, z1: bz1 - INNER };
  const layout = ci === 0 && cj === 0 ? quad : pickLayout(r);
  layout(b, r, zone, E, tint);
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
  return { rx, rz, vertices, indices: indices.slice(0, idx), groundCount, cells: ranges, pads, cars, maxHeight, colliders };
}

/** Where the runner starts: on the podium deck of cell (0, 0). */
export function spawnPoint(): { x: number; y: number; z: number; yaw: number } {
  return { x: STREET / 2 + INSET + 3, y: podiumHeight(0, 0), z: 26, yaw: 0 };
}
