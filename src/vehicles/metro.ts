// Trains that stop at stations — the subway's, and the elevated railway's — and riding one.
//
// Like everything else that moves through this city on its own, a train is a function of the
// clock rather than a thing being simulated: given the time it can be asked where it is, and
// there is nothing to keep between frames. What is new here is that it stops. Each cycle is
// a dwell at one station and a run to the next, the same cycle for every train on every
// line, so "where is the train that belongs to this platform" is one piece of arithmetic —
// and the answer is the same in the worker that built the tunnel and in the frame drawing it.
//
// The two kinds of line run the same timetable to their own numbers (`LineKind`): how far
// apart their stations are, how long a train stands and runs, how long it is, what height its
// track is at, and which side of it the platform is on.

import { arteryFrame, arteryScale, RAIL_SPACING } from "../city/network";
import {
  PLAT_IN, PLAT_OUT, PLAT_RISE, RAIL_PLAT, RAIL_TRACK, railStationAt, railY, stationAt, SUB_SPACING, subwayY, TRACK_OFF,
} from "../city/plan";
import type { Vec3 } from "../math";
import { CARRIAGE } from "./models";

/** Seconds standing at a platform with the doors open, and seconds running to the next one. */
export const DWELL = 9;
export const HOP = 15;
export const PERIOD = DWELL + HOP;
/** Carriages, and the length of the whole train. */
export const CARS = 4;
export const TRAIN = CARS * CARRIAGE;
/** Half the interior a rider can move about in, across it. */
const INSIDE_ACROSS = 1.1;
/** The floor inside a carriage, above the track bed: level with the platform. */
export const FLOOR = 1.06;

/** One kind of line, and the numbers its timetable runs to. */
export interface LineKind {
  /** Seconds standing at a platform, and in a whole cycle of standing and running to the next slot. */
  dwell: number;
  period: number;
  /** Carriages to a train. */
  cars: number;
  station(axis: 0 | 1, line: number, k: number): { s: number; name: string } | null;
  /** Metres between slots, where a slot with no station stands in for one. */
  spacing: number;
  /** The level the train runs on, at a station along the line. */
  level(axis: 0 | 1, line: number, s: number): number;
  /** How far off the middle of the line each track runs. */
  track: number;
  /** The platform above the track, and where across the line a rider steps off onto it from a train running `dir`. */
  rise: number;
  exit(dir: 1 | -1): number;
  /** Which side of the line the doors of a train running `dir` open towards: the platform's. */
  doors(dir: 1 | -1): 1 | -1;
}

/** The subway: an island platform between the two tracks. */
export const SUBWAY: LineKind = {
  dwell: DWELL, period: PERIOD, cars: CARS, station: stationAt, spacing: SUB_SPACING, level: subwayY, track: TRACK_OFF,
  rise: PLAT_RISE, exit: () => 0, doors: (dir) => (dir > 0 ? -1 : 1),
};

/**
 * The elevated railway: a platform outside each track, longer trains, stations further apart,
 * and a little longer standing at each — it is a main line, not a shuttle.
 */
export const RAILWAY: LineKind = {
  dwell: 12, period: 46, cars: 5, station: railStationAt, spacing: RAIL_SPACING, level: railY, track: RAIL_TRACK,
  rise: RAIL_PLAT, exit: (dir) => ((dir > 0 ? 1 : -1) * (PLAT_IN + PLAT_OUT)) / 2, doors: (dir) => (dir > 0 ? 1 : -1),
};

const ease = (t: number) => t * t * (3 - 2 * t);

/**
 * Where every train running one way is in its cycle: which hop, and how far into it.
 *
 * Every slot takes the same time whether or not it has a platform, which is what keeps the
 * timetable to one piece of arithmetic — but a slot with nothing to stop at gets no dwell.
 * The train runs the whole cycle instead of standing in a dark tunnel for nine seconds
 * waiting for doors it does not have.
 */
export function metroCycle(t: number, dir: 1 | -1, calls = true, kind = SUBWAY): { n: number; frac: number; stopped: boolean } {
  // the two directions are half a cycle apart, so a platform is not always either empty or
  // doubly occupied, and the trains pass each other in the tunnel rather than at the station
  const P = kind.period, D = kind.dwell;
  const u = (t + (dir > 0 ? 0 : P / 2)) / P;
  const n = Math.floor(u);
  const p = (u - n) * P;
  if (!calls) return { n, frac: ease(p / P), stopped: false };
  return p < D ? { n, frac: 0, stopped: true } : { n, frac: ease((p - D) / (P - D)), stopped: false };
}

/** When the train running `dir` comes in to a platform on cycle `n`. */
export function dueAt(n: number, dir: 1 | -1, kind = SUBWAY): number {
  return n * kind.period - (dir > 0 ? 0 : kind.period / 2);
}

/**
 * Where slot `k` of a line stands on the spline.
 *
 * A station slides along the line to find somewhere its entrance can come up, so the stops
 * are not quite evenly spaced; where a slot has no station at all the trains still pause, at
 * the place the station would have been. Nobody is there to notice, and it keeps the
 * timetable to one line of arithmetic.
 */
export function slotAt(axis: 0 | 1, line: number, k: number, kind = SUBWAY): number {
  return kind.station(axis, line, k)?.s ?? k * kind.spacing;
}

/** How many slots either way to look for the stations a train is running between. */
const SEARCH = 16;

/**
 * The middle of the train belonging to slot `k`, as a station on the line.
 *
 * A train runs from one station to the next in one go, speeding up out of the first and
 * slowing into the second, however many slots without a platform lie between them. Eased a
 * slot at a time, it came to a stand at every one of those — in the dark, in the middle of a
 * tunnel, with nobody to let on or off. The slot still steps on every cycle, so this asks how
 * many cycles ago the train left the last station and how many more it has to go.
 */
export function trainAt(axis: 0 | 1, line: number, k: number, dir: 1 | -1, t: number, kind = SUBWAY): number {
  const P = kind.period;
  const u = (t + (dir > 0 ? 0 : P / 2)) / P;
  const p = (u - Math.floor(u)) * P;
  let back = 0, ahead = 1;
  while (back < SEARCH && !kind.station(axis, line, k - dir * back)) back++;
  while (ahead <= SEARCH && !kind.station(axis, line, k + dir * ahead)) ahead++;
  if (back >= SEARCH || ahead > SEARCH) {
    // no platforms anywhere near: it just runs
    const a = slotAt(axis, line, k, kind), b = slotAt(axis, line, k + dir, kind);
    return a + ((b - a) * p) / P;
  }
  const a = slotAt(axis, line, k - dir * back, kind), b = slotAt(axis, line, k + dir * ahead, kind);
  const gone = back * P + p - kind.dwell;
  return gone <= 0 ? a : a + (b - a) * ease(gone / ((back + ahead) * P - kind.dwell));
}

/**
 * Which train is running from slot `k` at time `t`: the slot steps on every cycle, so this is
 * the one thing about a train that stays the same from one end of the line to the other.
 */
export function trainId(k: number, dir: 1 | -1, t: number, kind = SUBWAY): number {
  return k - dir * metroCycle(t, dir, true, kind).n;
}

/** A point beside the line: `s` along it, `off` across, at the level the train runs on. */
export function onTrack(axis: 0 | 1, line: number, s: number, off: number, kind = SUBWAY): { pos: Vec3; yaw: number } {
  const { p, dir } = arteryFrame(axis, line, s);
  return {
    pos: [p[0] - dir[1] * off, kind.level(axis, line, s), p[1] + dir[0] * off],
    yaw: Math.atan2(dir[0], dir[1]),
  };
}

/** Which of the two tracks a direction runs on. Keeping right, as everything here does. */
export const trackOff = (dir: 1 | -1, kind = SUBWAY) => (dir > 0 ? kind.track : -kind.track);

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
  /** Standing at a platform with the doors open. */
  private standing: boolean;

  constructor(
    readonly axis: 0 | 1, readonly line: number, readonly dir: 1 | -1, slot: number, t: number, readonly kind = SUBWAY,
  ) {
    this.slot = slot;
    this.cycle = metroCycle(t, dir, true, kind).n;
    this.standing = metroCycle(t, dir, true, kind).stopped && !!kind.station(axis, line, slot);
  }

  /**
   * The station the train is standing at, if it is standing at one. Not the one it has just
   * pulled out of: the slot it runs from is that station for the whole run to the next.
   */
  get stop() {
    return this.standing ? this.kind.station(this.axis, this.line, this.slot) : null;
  }

  /** Where it is going next, for the sign over the door. */
  get next() {
    for (let i = 1; i <= SEARCH; i++) {
      const st = this.kind.station(this.axis, this.line, this.slot + this.dir * i);
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
    const k = this.kind;
    const { n } = metroCycle(t, this.dir, true, k);
    this.arrived = false;
    while (this.cycle < n) {
      this.cycle++;
      this.slot += this.dir;
      this.arrived = true;
    }
    const stopped = metroCycle(t, this.dir, true, k).stopped && !!k.station(this.axis, this.line, this.slot);
    this.standing = stopped;
    const long = (k.cars * CARRIAGE) / 2 - 2.5;
    this.along = Math.max(-long, Math.min(long, this.along + moveZ * dt * 2.6 * this.dir));
    this.across = Math.max(-INSIDE_ACROSS, Math.min(INSIDE_ACROSS, this.across + moveX * dt * 2.6 * this.dir));
    const mid = trainAt(this.axis, this.line, this.slot, this.dir, t, k);
    // where they stand is metres up the carriage, which is not the same as stations along it
    const s = mid + this.along / trackScale(this.axis, this.line, mid);
    const at = onTrack(this.axis, this.line, s, trackOff(this.dir, k) + this.across, k);
    return { pos: [at.pos[0], at.pos[1] + FLOOR, at.pos[2]], yaw: at.yaw, stopped };
  }

  /** Where the rider is put down when they step out: the platform beside the door. */
  exitSpot(): Vec3 | null {
    const st = this.stop;
    if (!st) return null;
    const k = this.kind;
    const a = onTrack(this.axis, this.line, st.s + this.along / trackScale(this.axis, this.line, st.s), k.exit(this.dir), k);
    return [a.pos[0], a.pos[1] + k.rise, a.pos[2]];
  }
}
