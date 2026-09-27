// Subway trains, and riding one.
//
// Like everything else that moves through this city on its own, a train is a function of the
// clock rather than a thing being simulated: given the time it can be asked where it is, and
// there is nothing to keep between frames. What is new here is that it stops. Each cycle is
// a dwell at one station and a run to the next, the same cycle for every train on every
// line, so "where is the train that belongs to this platform" is one piece of arithmetic —
// and the answer is the same in the worker that built the tunnel and in the frame drawing it.

import { arteryFrame, arteryScale } from "../city/network";
import { PLAT_RISE, stationAt, SUB_SPACING, subwayY, TRACK_OFF } from "../city/plan";
import type { Vec3 } from "../math";
import { CARRIAGE } from "./models";

/** Seconds standing at a platform with the doors open, and seconds running to the next one. */
export const DWELL = 9;
export const HOP = 15;
export const PERIOD = DWELL + HOP;
/** Carriages, and the length of the whole train. */
export const CARS = 4;
export const TRAIN = CARS * CARRIAGE;
/** Half the interior a rider can move about in. */
const INSIDE_LONG = TRAIN / 2 - 2.5;
const INSIDE_ACROSS = 1.1;
/** The floor inside a carriage, above the track bed: level with the platform. */
export const FLOOR = 1.06;

const ease = (t: number) => t * t * (3 - 2 * t);

/**
 * Where every train running one way is in its cycle: which hop, and how far into it.
 *
 * Every slot takes the same time whether or not it has a platform, which is what keeps the
 * timetable to one piece of arithmetic — but a slot with nothing to stop at gets no dwell.
 * The train runs the whole cycle instead of standing in a dark tunnel for nine seconds
 * waiting for doors it does not have.
 */
export function metroCycle(t: number, dir: 1 | -1, calls = true): { n: number; frac: number; stopped: boolean } {
  // the two directions are half a cycle apart, so a platform is not always either empty or
  // doubly occupied, and the trains pass each other in the tunnel rather than at the station
  const u = (t + (dir > 0 ? 0 : PERIOD / 2)) / PERIOD;
  const n = Math.floor(u);
  const p = (u - n) * PERIOD;
  if (!calls) return { n, frac: ease(p / PERIOD), stopped: false };
  return p < DWELL ? { n, frac: 0, stopped: true } : { n, frac: ease((p - DWELL) / HOP), stopped: false };
}

/**
 * Where slot `k` of a line stands on the spline.
 *
 * A station slides along the line to find somewhere its entrance can come up, so the stops
 * are not quite evenly spaced; where a slot has no station at all the trains still pause, at
 * the place the station would have been. Nobody is there to notice, and it keeps the
 * timetable to one line of arithmetic.
 */
export function slotAt(axis: 0 | 1, line: number, k: number): number {
  return stationAt(axis, line, k)?.s ?? k * SUB_SPACING;
}

/** The middle of the train belonging to slot `k`, as a station on the line. */
export function trainAt(axis: 0 | 1, line: number, k: number, dir: 1 | -1, t: number): number {
  const { frac } = metroCycle(t, dir, !!stationAt(axis, line, k));
  const a = slotAt(axis, line, k), b = slotAt(axis, line, k + dir);
  return a + (b - a) * frac;
}

/** A point beside the line: `s` along it, `off` across, at the height of a carriage floor. */
export function onTrack(axis: 0 | 1, line: number, s: number, off: number): { pos: Vec3; yaw: number } {
  const { p, dir } = arteryFrame(axis, line, s);
  return {
    pos: [p[0] - dir[1] * off, subwayY(axis, line, s), p[1] + dir[0] * off],
    yaw: Math.atan2(dir[0], dir[1]),
  };
}

/** Which of the two tracks a direction runs on. Keeping right, as everything here does. */
export const trackOff = (dir: 1 | -1) => (dir > 0 ? TRACK_OFF : -TRACK_OFF);

/**
 * Metres of track to one unit of `s`, which is not one: see `arteryScale`. Carriages are laid
 * out twenty metres apart and a passenger walks the inside of them in metres, so both have to
 * ask — or four cars stand twenty-six apart with the gaps showing, and the runner pacing them
 * walks out through the end of the train.
 */
export const trackScale = arteryScale;

/** A ride on a train: which train, and where the rider is standing inside it. */
export class Metro {
  /** The slot the train is running from; it steps on by `dir` at every change of cycle. */
  slot: number;
  private cycle: number;
  /** Where the rider stands in the carriage: along the train, and across it. */
  along = 0;
  across = 0;
  /** Set on the frame the train comes to a stand, so the game can say where it is. */
  arrived = false;

  constructor(readonly axis: 0 | 1, readonly line: number, readonly dir: 1 | -1, slot: number, t: number) {
    this.slot = slot;
    this.cycle = metroCycle(t, dir).n;
  }

  /** The station the train is standing at, if it is standing at one. */
  get stop() {
    return stationAt(this.axis, this.line, this.slot);
  }

  /** Where it is going next, for the sign over the door. */
  get next() {
    for (let i = 1; i <= 4; i++) {
      const st = stationAt(this.axis, this.line, this.slot + this.dir * i);
      if (st) return st;
    }
    return null;
  }

  /**
   * Carry the rider. The train is a place, not a vehicle they steer: the controls walk them
   * up and down the carriage, and the train takes them and it wherever it is going.
   */
  update(dt: number, t: number, moveX: number, moveZ: number): { pos: Vec3; yaw: number; stopped: boolean } {
    // A cycle has turned over: the train is now running from the station it just left. This
    // comes first, because whether it dwells at all depends on the slot it is at *now* — ask
    // before stepping the slot on and it takes the last one's answer, and stands for nine
    // seconds in a tunnel it was meant to run straight through.
    const { n } = metroCycle(t, this.dir);
    this.arrived = false;
    while (this.cycle < n) {
      this.cycle++;
      this.slot += this.dir;
      this.arrived = true;
    }
    const { frac, stopped } = metroCycle(t, this.dir, !!this.stop);
    this.along = Math.max(-INSIDE_LONG, Math.min(INSIDE_LONG, this.along + moveZ * dt * 2.6 * this.dir));
    this.across = Math.max(-INSIDE_ACROSS, Math.min(INSIDE_ACROSS, this.across + moveX * dt * 2.6 * this.dir));
    const a = slotAt(this.axis, this.line, this.slot), b = slotAt(this.axis, this.line, this.slot + this.dir);
    const mid = a + (b - a) * frac;
    // where they stand is metres up the carriage, which is not the same as stations along it
    const s = mid + this.along / trackScale(this.axis, this.line, mid);
    const at = onTrack(this.axis, this.line, s, trackOff(this.dir) + this.across);
    return { pos: [at.pos[0], at.pos[1] + FLOOR, at.pos[2]], yaw: at.yaw, stopped };
  }

  /** Where the rider is put down when they step out: the platform beside the door. */
  exitSpot(): Vec3 | null {
    const st = this.stop;
    if (!st) return null;
    const a = onTrack(this.axis, this.line, st.s + this.along / trackScale(this.axis, this.line, st.s), 0);
    return [a.pos[0], a.pos[1] + PLAT_RISE, a.pos[2]];
  }
}
