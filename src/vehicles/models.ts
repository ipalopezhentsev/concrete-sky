// Box models for vehicles. Local space: +Z forward, +Y up, origin at the
// bottom centre. "paint" boxes take the vehicle's colour.

import { Mat, type Tint } from "../city/materials";

export interface ModelBox {
  b: [number, number, number, number, number, number];
  mat: Mat;
  paint?: boolean;
}

const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, mat: Mat, paint = false): ModelBox =>
  ({ b: [x0, y0, z0, x1, y1, z1], mat, paint });

/** Mirror a box across x = 0 (models are symmetric). */
const pair = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, mat: Mat, paint = false) =>
  [box(x0, y0, z0, x1, y1, z1, mat, paint), box(-x1, y0, z0, -x0, y1, z1, mat, paint)];

export function carBoxes(van: boolean): ModelBox[] {
  if (van) {
    return [
      box(-1.0, 0.35, -2.8, 1.0, 2.1, 2.3, Mat.Paint, true),
      box(-0.92, 1.1, 2.3, 0.92, 2.0, 2.75, Mat.VGlass),
      box(-1.0, 0.35, 2.3, 1.0, 1.1, 2.8, Mat.Paint, true),
      box(-1.02, 1.3, -2.6, 1.02, 1.75, 2.1, Mat.VGlass),
      ...pair(0.8, 0, 1.45, 1.02, 0.66, 2.05, Mat.Metal),
      ...pair(0.8, 0, -2.25, 1.02, 0.66, -1.65, Mat.Metal),
      ...pair(0.5, 0.75, 2.8, 0.85, 0.88, 2.83, Mat.Glow),
      ...pair(0.6, 0.9, -2.83, 0.92, 1.25, -2.8, Mat.Tail),
    ];
  }
  return [
    box(-0.95, 0.35, -2.2, 0.95, 0.95, 2.2, Mat.Paint, true),
    box(-0.84, 0.95, -1.15, 0.84, 1.4, 0.85, Mat.VGlass),
    box(-0.86, 1.4, -1.05, 0.86, 1.48, 0.75, Mat.Paint, true),
    ...pair(0.76, 0, 1.1, 0.98, 0.62, 1.7, Mat.Metal),
    ...pair(0.76, 0, -1.7, 0.98, 0.62, -1.1, Mat.Metal),
    ...pair(0.55, 0.68, 2.2, 0.86, 0.8, 2.23, Mat.Glow),
    ...pair(0.6, 0.7, -2.23, 0.9, 0.84, -2.2, Mat.Tail),
  ];
}

/**
 * Stand-ins drawn beyond FAR_VEHICLE metres, where a whole car is a few pixels tall:
 * the painted shell, the glazing and the lights, without wheels, struts or ducts.
 */
export function carBoxesFar(van: boolean): ModelBox[] {
  if (van) {
    return [
      box(-1.0, 0.2, -2.8, 1.0, 2.1, 2.8, Mat.Paint, true),
      box(-1.02, 1.3, -2.6, 1.02, 1.75, 2.75, Mat.VGlass),
      ...pair(0.6, 0.9, -2.83, 0.92, 1.25, -2.8, Mat.Tail),
    ];
  }
  return [
    box(-0.95, 0.2, -2.23, 0.95, 0.95, 2.23, Mat.Paint, true),
    box(-0.84, 0.95, -1.15, 0.86, 1.48, 0.85, Mat.VGlass),
    ...pair(0.6, 0.7, -2.23, 0.9, 0.84, -2.2, Mat.Tail),
  ];
}

export function flyerBoxesFar(): ModelBox[] {
  return [
    box(-0.85, 0.3, -1.5, 0.85, 1.05, 1.25, Mat.Paint, true),
    box(-0.7, 1.05, -1.4, 0.72, 1.55, 0.95, Mat.VGlass),
    ...pair(1.25, 0.8, -1.35, 2.05, 1.05, 1.35, Mat.Metal),
    box(-0.6, 0.36, -1.2, 0.6, 0.4, 1.0, Mat.Glow),
    ...pair(0.45, 0.8, -1.52, 0.8, 0.95, -1.5, Mat.Tail),
  ];
}

export const FLYER_HEIGHT = 1.6;
/** Car footprint half sizes (x across, z along) and height, per variant. */
export const CAR_DIMS = { car: { hx: 0.98, hz: 2.23, h: 1.5 }, van: { hx: 1.02, hz: 2.83, h: 2.1 } };

export function flyerBoxes(): ModelBox[] {
  return [
    // skids and struts
    ...pair(0.75, 0, -1.3, 0.95, 0.12, 1.3, Mat.Metal),
    ...pair(0.8, 0.12, -0.8, 0.9, 0.4, -0.65, Mat.Metal),
    ...pair(0.8, 0.12, 0.65, 0.9, 0.4, 0.8, Mat.Metal),
    // fuselage and canopy
    box(-0.85, 0.4, -1.5, 0.85, 1.05, 1.25, Mat.Paint, true),
    box(-0.7, 1.05, -0.7, 0.7, 1.55, 0.95, Mat.VGlass),
    box(-0.72, 1.05, -1.4, 0.72, 1.35, -0.7, Mat.Paint, true),
    box(-0.5, 0.55, 1.25, 0.5, 0.95, 1.6, Mat.VGlass),
    box(-0.12, 1.05, -1.5, 0.12, 1.6, -1.1, Mat.Paint, true),
    // arms and rotor ducts
    ...pair(0.85, 0.85, 0.85, 1.35, 0.97, 1.05, Mat.Metal),
    ...pair(0.85, 0.85, -1.05, 1.35, 0.97, -0.85, Mat.Metal),
    ...pair(1.25, 0.8, 0.55, 2.05, 1.05, 1.35, Mat.Metal),
    ...pair(1.25, 0.8, -1.35, 2.05, 1.05, -0.55, Mat.Metal),
    ...pair(1.35, 0.78, 0.65, 1.95, 0.8, 1.25, Mat.Glow),
    ...pair(1.35, 0.78, -1.25, 1.95, 0.8, -0.65, Mat.Glow),
    // lights
    box(-0.6, 0.36, -1.2, 0.6, 0.4, 1.0, Mat.Glow),
    ...pair(0.3, 0.8, 1.6, 0.48, 0.9, 1.62, Mat.Glow),
    ...pair(0.45, 0.8, -1.52, 0.8, 0.95, -1.5, Mat.Tail),
  ];
}

/**
 * A hunter on foot: long dark coat, helmet with a red visor, gun held forward.
 * stride -1..1 swings the legs and the free arm (0 is standing).
 */
export function figureBoxes(stride: number): ModelBox[] {
  const leg = stride * 0.24, arm = -stride * 0.16;
  return [
    box(0.05, 0, -0.09 + leg, 0.23, 0.92, 0.1 + leg, Mat.Paint, true),
    box(-0.23, 0, -0.09 - leg, -0.05, 0.92, 0.1 - leg, Mat.Paint, true),
    box(0.04, 0, 0.1 + leg, 0.24, 0.1, 0.22 + leg, Mat.Metal),
    box(-0.24, 0, 0.1 - leg, -0.04, 0.1, 0.22 - leg, Mat.Metal),
    // coat and shoulders
    box(-0.27, 0.62, -0.16, 0.27, 1.5, 0.15, Mat.Paint, true),
    box(-0.3, 1.36, -0.15, 0.3, 1.5, 0.14, Mat.Metal),
    // free arm swings, gun arm points ahead
    box(0.27, 0.86, -0.07 + arm, 0.38, 1.46, 0.07 + arm, Mat.Paint, true),
    box(-0.38, 1.24, -0.06, -0.27, 1.38, 0.42, Mat.Paint, true),
    box(-0.37, 1.26, 0.38, -0.29, 1.37, 0.74, Mat.Metal),
    box(-0.35, 1.29, 0.74, -0.31, 1.33, 0.76, Mat.Tail),
    // helmet and visor
    box(-0.12, 1.5, -0.13, 0.12, 1.8, 0.12, Mat.Metal),
    box(-0.1, 1.61, 0.12, 0.1, 1.67, 0.14, Mat.Tail),
    box(-0.08, 1.2, -0.18, 0.08, 1.24, -0.16, Mat.Tail),
  ];
}

/** A lift platform (LIFT_SIZE square, origin at the centre of its top): a concrete slab on a steel frame with lit edges. */
export function liftBoxes(size: number, thick: number): ModelBox[] {
  const h = size / 2;
  return [
    box(-h, -thick, -h, h, 0, h, Mat.Deck),
    box(-h + 0.15, -thick - 0.35, -h + 0.15, h - 0.15, -thick, h - 0.15, Mat.Metal),
    ...pair(h - 0.3, -thick - 0.02, -h + 0.3, h - 0.2, -thick, h - 0.3, Mat.Glow),
    box(-h + 0.3, 0, h - 0.3, h - 0.3, 0.02, h - 0.2, Mat.Glow),
    box(-h + 0.3, 0, -h + 0.2, h - 0.3, 0.02, -h + 0.3, Mat.Glow),
  ];
}

/** Flatten a model to 12-float boxes with a white tint (for instanced meshes). */
export function modelData(model: ModelBox[]): number[] {
  const out: number[] = [];
  for (const m of model) out.push(...m.b, 1, 1, 1, m.mat, m.paint ? 1 : 0, 0);
  return out;
}

export const PAINT_COLORS: Tint[] = [
  [0.72, 0.71, 0.68],
  [0.18, 0.19, 0.2],
  [0.45, 0.47, 0.5],
  [0.55, 0.16, 0.12],
  [0.14, 0.3, 0.33],
  [0.62, 0.48, 0.2],
  [0.82, 0.8, 0.74],
  [0.1, 0.12, 0.18],
];

/** A river launch: hull, a low foredeck and a wheelhouse aft. */
export function boatBoxes(): ModelBox[] {
  return [
    box(-1.9, -1.1, -5.4, 1.9, 0.35, 5.4, Mat.Paint, true),
    box(-1.6, 0.35, -4.6, 1.6, 0.5, 4.6, Mat.Board),
    box(-1.9, 0.35, -5.4, -1.6, 0.95, 5.4, Mat.Panel),
    box(1.6, 0.35, -5.4, 1.9, 0.95, 5.4, Mat.Panel),
    box(-1.3, 0.5, 1.1, 1.3, 2.3, 3.9, Mat.VGlass),
    box(-1.45, 2.3, 0.9, 1.45, 2.55, 4.1, Mat.Board),
    box(-0.2, 2.55, 2.2, 0.2, 3.6, 2.6, Mat.Metal),
    ...pair(0.5, 0.55, -5.2, 0.9, 0.75, -4.9, Mat.Tail),
  ];
}

/** Length of one railway carriage, coupling to coupling. */
export const CARRIAGE = 20;

/** Where the band of windows sits in a carriage side, and how far along the body it runs. */
const WIN_SILL = 2.3, WIN_HEAD = 3.3, WIN_END = 8.8;

/** A railway carriage: a long painted body, a band of windows, a roof and a lit front. */
export function carriageBoxes(): ModelBox[] {
  return [
    box(-1.55, 0.9, -9.6, 1.55, 3.9, 9.6, Mat.Paint, true),
    box(-1.58, WIN_SILL, -WIN_END, 1.58, WIN_HEAD, WIN_END, Mat.VGlass),
    box(-1.3, 3.9, -9.2, 1.3, 4.3, 9.2, Mat.Metal),
    box(-1.2, 0.3, -8.4, 1.2, 0.9, -5.4, Mat.Metal),
    box(-1.2, 0.3, 5.4, 1.2, 0.9, 8.4, Mat.Metal),
    ...pair(0.6, 1.4, 9.6, 1.2, 1.7, 9.64, Mat.Glow),
    ...pair(0.6, 1.4, -9.64, 1.2, 1.7, -9.6, Mat.Tail),
  ];
}

/**
 * The same carriage from the inside, for the one train the runner is on.
 *
 * Vehicle glass is a dark mirror — which is what a carriage should look like from the
 * platform, and what leaves a passenger sealed in a box. So the train being ridden is built
 * without any: the window band is an opening with pillars across it, the body is split into a
 * sill below and a header above, and there is a floor to stand on and a lit ceiling overhead.
 *
 * The shell runs the whole CARRIAGE rather than stopping short of the couplings, so that the
 * cars of a train meet and the inside is one length the runner can walk from end to end —
 * which is what they do, since the controls walk them along the whole train and not one car
 * of it. The two ends are left open for the same reason, and a cabin carries no lights: they
 * would hang in the mouth of the next car along.
 */
export function carriageInsideBoxes(): ModelBox[] {
  const HX = 1.55, WALL = 0.16, HALF = CARRIAGE / 2;
  // The floor stands where metro.ts puts the runner's feet, and a cabin is placed on the
  // track bed rather than up on its rails, so the two agree without an offset between them.
  const FLOOR = 1.06, CEIL = 3.74;
  const out: ModelBox[] = [
    // A floor in plain panel rather than the metal the underframe is: metal here is all but
    // black, and a carriage lit by one tube has no light to spare on the floor of it.
    box(-HX, 0.9, -HALF, HX, FLOOR, HALF, Mat.Panel),
    box(-HX, CEIL, -HALF, HX, 3.9, HALF, Mat.Paint, true),
    box(-1.3, 3.9, -9.2, 1.3, 4.3, 9.2, Mat.Metal),
    box(-1.2, 0.3, -8.4, 1.2, 0.9, -5.4, Mat.Metal),
    box(-1.2, 0.3, 5.4, 1.2, 0.9, 8.4, Mat.Metal),
  ];
  // Tubes down the middle of the ceiling: the same light that is in the tunnels, and the only
  // one there is in here — no daylight reaches this far down. In lengths with gaps between
  // them, because one unbroken tube overhead is a white bar across the top of every view.
  for (let i = 0; i < 6; i++) {
    const z = -HALF + 1.2 + i * 2.95;
    out.push(box(-0.16, CEIL - 0.06, z, 0.16, CEIL, z + 2.25, Mat.Strip));
  }
  const PANES = 8, step = (2 * WIN_END) / PANES;
  for (const s of [1, -1]) {
    const x0 = s > 0 ? HX - WALL : -HX, x1 = s > 0 ? HX : -HX + WALL;
    out.push(box(x0, FLOOR, -HALF, x1, WIN_SILL, HALF, Mat.Paint, true));
    out.push(box(x0, WIN_HEAD, -HALF, x1, CEIL, HALF, Mat.Paint, true));
    // the body beyond either end of the window band, then a pillar between each pair of panes
    out.push(box(x0, WIN_SILL, -HALF, x1, WIN_HEAD, -WIN_END, Mat.Paint, true));
    out.push(box(x0, WIN_SILL, WIN_END, x1, WIN_HEAD, HALF, Mat.Paint, true));
    for (let i = 1; i < PANES; i++) {
      const z = -WIN_END + i * step;
      out.push(box(x0, WIN_SILL, z - 0.09, x1, WIN_HEAD, z + 0.09, Mat.Paint, true));
    }
    // Backing behind the joint with the next car, a hand's breadth either side of it. Two
    // shells that merely meet leave the runner standing on the plane where both of them end
    // as they walk over it — which, for that step, is standing in a carriage with no walls,
    // looking out at the tunnel. This is set two centimetres outside every surface it backs,
    // so it is behind whichever shell is there and is only ever seen at the joint itself.
    out.push(box(x0 + 0.02 * s, FLOOR, HALF - 0.4, x1 + 0.02 * s, CEIL, HALF + 0.4, Mat.Paint, true));
  }
  out.push(box(-HX, 0.9, HALF - 0.4, HX, FLOOR - 0.02, HALF + 0.4, Mat.Metal));
  out.push(box(-HX, CEIL + 0.02, HALF - 0.4, HX, 3.9, HALF + 0.4, Mat.Paint, true));
  return out;
}
