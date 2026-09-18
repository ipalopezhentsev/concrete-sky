// Headless movement tests: run with `npx tsx tests/traversal.test.ts`.
import {
  Builder, bridgeOn, buildRegion, CELL, collidersOf, cornerPylon, cornerStair, crossing, edgeBridge, facadeStair,
  deckEdge, PODIUM_LEVELS, podiumHeight, podiumInset, pylonSize, spawnPoint, STREET, streetFlight, streetLift,
} from "../src/city/generate";
import { liftState, Lifts } from "../src/lifts";
import { Rng, setWorldSeed } from "../src/math";
import { Player, type Input } from "../src/player";
import { Flyer, type FlyInput } from "../src/vehicles/flyer";
import { Car } from "../src/vehicles/car";
import { Parking } from "../src/vehicles/parking";
import { Traffic } from "../src/vehicles/traffic";
import { Combat } from "../src/effects/combat";
import { Particles } from "../src/effects/particles";
import { DrivePilot, FlyPilot, RunPilot } from "../src/demo";
import { Hunters, MAX_HEALTH, type Quarry } from "../src/hunters";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`);
  if (!ok) failures++;
};

const boxesOf = (b: Builder): Float32Array => collidersOf(b);

/**
 * Pairs of boxes with a face in the same plane, pointing the same way and overlapping: the two
 * surfaces flicker through each other. Bottom faces are skipped (they rest on something).
 */
function coplanarFaces(boxes: Float32Array): number {
  let n = 0;
  for (let i = 0; i < boxes.length; i += 6)
    for (let j = i + 6; j < boxes.length; j += 6)
      for (let ax = 0; ax < 3; ax++)
        for (const side of ax === 1 ? [3] : [0, 3]) {
          if (Math.abs(boxes[i + ax + side] - boxes[j + ax + side]) > 1e-4) continue;
          let area = 1;
          for (let k = 0; k < 3; k++)
            if (k !== ax) area *= Math.max(0, Math.min(boxes[i + k + 3], boxes[j + k + 3]) - Math.max(boxes[i + k], boxes[j + k]));
          if (area > 1e-4) n++;
        }
  return n;
}

/** Walk through waypoints (x, z); returns the player. */
function walk(p: Player, boxes: Float32Array, waypoints: [number, number][], seconds = 60, stop = (_p: Player) => false): Player {
  let wi = 0;
  const input: Input = { moveX: 0, moveZ: 1, sprint: false, walk: false, jump: false };
  for (let t = 0; t < seconds * 60 && wi < waypoints.length; t++) {
    const [tx, tz] = waypoints[wi];
    const dx = tx - p.pos[0], dz = tz - p.pos[2];
    if (Math.hypot(dx, dz) < 0.4) {
      wi++;
      continue;
    }
    p.yaw = Math.atan2(dx, dz);
    p.update(1 / 60, input, () => boxes);
    if (stop(p)) break;
  }
  return p;
}

function penetrates(p: Player, boxes: Float32Array): boolean {
  const [x, y, z] = p.pos;
  for (let i = 0; i < boxes.length; i += 6) {
    if (boxes[i] < x + 0.3 && boxes[i + 3] > x - 0.3 && boxes[i + 2] < z + 0.3 && boxes[i + 5] > z - 0.3 &&
        boxes[i + 1] < y + 1.7 && boxes[i + 4] > y + 0.6) return true;
  }
  return false;
}

// 1. street stair round a podium corner at (0, 0): up beside the x = 0 face, round the corner,
// along the z = 0 face and onto the deck
for (const E of PODIUM_LEVELS) {
  const b = new Builder(new Rng(1));
  cornerStair(b, 0, 0, 1, 1, E, [1, 1, 1]);
  b.box(-0.5, 0, -0.5, 60, E, 60, 8); // podium with its deck overhang
  const boxes = boxesOf(b);
  const { length } = streetFlight(E);
  const p = new Player(-2.1, 0, length + 2, Math.PI);
  walk(p, boxes, [[-2.1, -2.1], [length + 0.6, -2.1], [length + 0.6, 3]], 120);
  check(`corner stair reaches a ${E} m deck`, Math.abs(p.pos[1] - E) < 0.05 && p.pos[2] > 1, `pos=${p.pos.map((v) => v.toFixed(2))}`);
}

// 1b. street lift: wait on the platform, ride up, step off over the landing onto the deck
{
  const E = 24;
  const b = new Builder(new Rng(11));
  streetLift(b, 0, 0, 1, 1, E, [1, 1, 1]);
  b.box(-0.5, 0, -0.5, 60, E, 60, 8);
  b.box(-20, 0, -20, 0, 0.18, 0, 1); // sidewalk
  const lifts = new Lifts();
  lifts.sync(b.lifts);
  const still = boxesOf(b);
  const all = () => {
    const l = lifts.boxes(0, 0);
    const out = new Float32Array(still.length + l.length);
    out.set(still);
    out.set(l, still.length);
    return out;
  };
  const lift = b.lifts[0];
  const cx = (lift.x0 + lift.x1) / 2, cz = (lift.z0 + lift.z1) / 2;
  const idle: Input = { moveX: 0, moveZ: 0, sprint: false, walk: false, jump: false };
  let time = 0, maxOff = 0, rode = false;
  // step on while it waits at the bottom
  while (liftState(lift, time).moving || liftState(lift, time).y !== lift.y0) time += 0.1;
  const p = new Player(cx, 0.2, cz, 0);
  // stand until the lift has been to the top and is waiting there
  for (let t = 0; t < 60 * 60; t++) {
    time += 1 / 60;
    lifts.update(time);
    p.update(1 / 60, idle, all);
    lifts.carry(p);
    const { y, moving } = liftState(lift, time);
    maxOff = Math.max(maxOff, Math.abs(p.pos[1] - y));
    if (moving && y > 5) rode = true;
    if (rode && !moving && y === lift.y1) break;
  }
  check("street lift carries a rider up", rode && Math.abs(p.pos[1] - E) < 0.01 && maxOff < 0.06, `pos=${p.pos.map((v) => v.toFixed(2))} maxOff=${maxOff.toFixed(3)}`);
  walk(p, all(), [[1.5, cz], [1.5, 3]], 10);
  check("street lift lands beside the deck", Math.abs(p.pos[1] - E) < 0.01 && p.pos[2] > 2, `pos=${p.pos.map((v) => v.toFixed(2))}`);

  // someone the lift comes down on ends up standing on it
  const q = new Player(cx, 0.2, cz, 0);
  let under = false, bad = 0;
  for (let t = 0; t < 60 * 60; t++) {
    time += 1 / 60;
    lifts.update(time);
    const { y } = liftState(lift, time);
    if (y > 3 && !under) {
      under = true;
      q.pos = [cx, 0.2, cz];
    }
    q.update(1 / 60, idle, all);
    lifts.carry(q);
    if (under && y < q.pos[1] + 1.7 && q.pos[1] < y - 0.05) bad++;
  }
  check("a lift coming down lifts whoever is under it", under && bad === 0, `bad frames=${bad}`);
}

// 2. facade stair around a 14 m tower from a deck at 18 to a roof at 36
{
  const b = new Builder(new Rng(2));
  b.box(-30, 0, -30, 30, 18, 30, 8);
  b.box(0, 18, 0, 14, 35, 14, 4);
  b.box(-0.3, 35, -0.3, 14.3, 36, 14.3, 8);
  facadeStair(b, -0.3, -0.3, 14.3, 14.3, 18, 36, [1, 1, 1]);
  const boxes = boxesOf(b);
  const p = new Player(-1.2, 18, -4, 0);
  const wps: [number, number][] = [[-1.2, -1.2], [15.2, -1.2], [15.2, 15.2], [-1.2, 15.2], [-1.2, -1.2]];
  let best = 0;
  for (const wp of wps) {
    walk(p, boxes, [wp], 30, (q) => q.pos[1] >= 36 - 1e-3);
    best = Math.max(best, p.pos[1]);
    if (p.pos[1] >= 36 - 1e-3) break;
  }
  // step sideways onto the roof
  walk(p, boxes, [[7, 7]], 10);
  check("facade stair reaches roof", Math.abs(p.pos[1] - 36) < 0.05 && p.pos[0] > 1 && p.pos[2] > 1, `pos=${p.pos.map((v) => v.toFixed(2))} best=${best.toFixed(2)}`);
}

// 3. mantle onto a 2 m block
{
  const b = new Builder(new Rng(3));
  b.box(-5, 0, 5, 5, 2.0, 10, 2);
  const boxes = boxesOf(b);
  const p = new Player(0, 0, 0, 0);
  const input: Input = { moveX: 0, moveZ: 1, sprint: true, walk: false, jump: false };
  let onTop = false;
  for (let t = 0; t < 120; t++) {
    input.jump = p.pos[2] > 3.5 && p.pos[2] < 5;
    p.update(1 / 60, input, () => boxes);
    if (Math.abs(p.pos[1] - 2) < 0.01 && p.pos[2] > 5 && p.pos[2] < 10 && p.grounded) onTop = true;
  }
  check("mantle onto 2 m ledge", onTop, `pos=${p.pos.map((v) => v.toFixed(2))}`);
}

// 4. random runs through generated city: never end up inside geometry
{
  const regions = new Map<string, ReturnType<typeof buildRegion>>();
  const cells = new Map<string, Float32Array>();
  const colliders = (x: number, z: number) => {
    const ci = Math.floor(x / CELL), cj = Math.floor(z / CELL);
    const parts: Float32Array[] = [];
    for (let i = ci - 1; i <= ci + 1; i++)
      for (let j = cj - 1; j <= cj + 1; j++) {
        const rk = `${Math.floor(i / 3)},${Math.floor(j / 3)}`;
        if (!regions.has(rk)) {
          const m = buildRegion(Math.floor(i / 3), Math.floor(j / 3));
          regions.set(rk, m);
          for (const c of m.colliders) cells.set(`${c.ci},${c.cj}`, c.boxes);
        }
        parts.push(cells.get(`${i},${j}`)!);
      }
    const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  };
  const rng = new Rng(9);
  let stuck = 0, maxY = 0, mantles = 0;
  for (let run = 0; run < 12; run++) {
    const p = new Player(18.5 + run * 3, 18, 26, rng.uniform(0, 6.28));
    if (penetrates(p, colliders(p.pos[0], p.pos[2]))) continue; // start spot occupied (vent etc.)
    for (let t = 0; t < 60 * 40; t++) {
      if (t % 90 === 0) p.yaw += rng.uniform(-1.2, 1.2);
      p.update(1 / 60, { moveX: 0, moveZ: 1, sprint: true, walk: false, jump: rng.chance(0.02) }, colliders);
      if (p.mantled) mantles++;
      maxY = Math.max(maxY, p.pos[1]);
      if (penetrates(p, colliders(p.pos[0], p.pos[2]))) {
        if (stuck < 3) console.log("  inside geometry at", p.pos.map((v) => v.toFixed(2)).join(" "), "run", run, "t", t);
        stuck++;
      }
    }
  }
  check("no penetration during random runs", stuck === 0, `stuck frames=${stuck} maxY=${maxY.toFixed(1)} mantles=${mantles}`);
}

// 5. cross-street stepped bridges between podiums of different heights (several cities)
for (const seed of [1971, 42, 777777]) {
  setWorldSeed(seed);
  const cellsCache = new Map<string, Float32Array>();
  const colliders = (x: number, z: number) => {
    const ci = Math.floor(x / CELL), cj = Math.floor(z / CELL);
    const parts: Float32Array[] = [];
    for (let i = ci - 1; i <= ci + 1; i++)
      for (let j = cj - 1; j <= cj + 1; j++) {
        if (!cellsCache.has(`${i},${j}`)) {
          const m = buildRegion(Math.floor(i / 3), Math.floor(j / 3));
          for (const c of m.colliders) cellsCache.set(`${c.ci},${c.cj}`, c.boxes);
        }
        parts.push(cellsCache.get(`${i},${j}`)!);
      }
    const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  };
  let tested = 0, passed = 0;
  for (let ci = -8; ci < 8 && tested < 20; ci++)
    for (let cj = -8; cj < 8 && tested < 20; cj++) {
      const off = edgeBridge(ci, cj, 0);
      const ha = podiumHeight(ci, cj), hb = podiumHeight(ci + 1, cj);
      if (off === null || ha === hb) continue;
      tested++;
      const zc = cj * CELL + CELL / 2 + off;
      const faceA = ci * CELL + deckEdge(ci, cj, 0);
      const faceB = (ci + 1) * CELL + deckEdge(ci + 1, cj, 2);
      const p = new Player(faceA - 2, ha, zc, Math.PI / 2);
      const input: Input = { moveX: 0, moveZ: 1, sprint: false, walk: false, jump: false };
      for (let t = 0; t < 60 * 12; t++) {
        p.yaw = Math.PI / 2 - Math.max(-0.5, Math.min(0.5, (p.pos[2] - zc) * 0.3));
        p.update(1 / 60, input, colliders);
        if (p.pos[0] > faceB + 2) break; // across: running on would just climb the far block
      }
      const ok = Math.abs(p.pos[1] - hb) < 0.5 && p.pos[0] > faceB + 1;
      if (ok) passed++;
      else console.log(`  bridge ${ci},${cj} ${ha}->${hb} ended at ${p.pos.map((v) => v.toFixed(1))}`);
    }
  check(`stepped bridges connect podiums (seed ${seed})`, tested > 0 && passed === tested, `${passed}/${tested}`);

  // 5b. up a corner pylon (stairs or lift) and over a skyway across the avenue to the next block
  const PD = 5.8;
  const tested5b = { stair: 0, lift: 0 }, passed5b = { stair: 0, lift: 0 };
  for (let ci = -10; ci < 10 && (tested5b.stair < 5 || tested5b.lift < 4); ci++)
    for (let cj = -10; cj < 10 && (tested5b.stair < 5 || tested5b.lift < 4); cj++) {
      const west = cornerPylon(ci, cj, true, false);
      const c = crossing(ci + 1, cj);
      if (!west || west.axis !== "x" || !c?.xn) continue;
      const kind = west.lift ? "lift" : "stair";
      if (tested5b[kind] >= (west.lift ? 4 : 5)) continue;
      tested5b[kind]++;
      const E = podiumHeight(ci, cj);
      const lifts = new Lifts();
      lifts.sync(buildRegion(Math.floor(ci / 3), Math.floor(cj / 3)).lifts);
      const withLifts = (x: number, z: number) => {
        const a = colliders(x, z), l = lifts.boxes(x, z);
        const out = new Float32Array(a.length + l.length);
        out.set(a);
        out.set(l, a.length);
        return out;
      };
      // west pylon: u runs -x from the street end, v runs +z from the podium edge
      const u0 = ci * CELL + deckEdge(ci, cj, 0) - 0.3, v0 = cj * CELL + deckEdge(ci, cj, 3) + 0.3;
      const at = (u: number, v: number): [number, number] => [u0 - u, v0 + v];
      const span = STREET + 0.6 + podiumInset(ci, cj, 0) + podiumInset(ci + 1, cj, 2);
      // a route is a list of waypoints; `null` means wait for the lift to arrive at `level`
      type Step = [number, number] | { wait: number };
      const route: Step[] = [];
      if (west.lift) {
        const start = at(2.9, PD + 1.2);
        route.push(start, { wait: E + 0.02 }, at(2.9, 2.9), { wait: west.level }, at(0.6, 2.9));
      } else {
        const [L] = pylonSize(false, west.level - E);
        const farMid = L - 0.4 - 1.3;
        route.push(at(1.3, 4.25), at(farMid, 4.25), at(farMid, 1.55), at(1.3, 1.55), at(1.3, 2.9), at(-3, 2.9));
      }
      route.push(at(-span - 1.3, 2.9));
      const [sx0, sz0] = west.lift ? at(2.9, PD + 1.2) : at(2, PD + 1.5);
      const p = new Player(sx0, E, sz0, 0);
      let wi = 0, time = 0;
      const input: Input = { moveX: 0, moveZ: 1, sprint: false, walk: false, jump: false };
      for (let t = 0; t < 60 * 180 && wi < route.length; t++) {
        time += 1 / 60;
        lifts.update(time);
        const step = route[wi];
        if ("wait" in step) {
          // wait until the platform stands at the level (it pauses there)
          const l = lifts.boxes(p.pos[0], p.pos[2]);
          let ready = false;
          for (let i = 0; i < l.length; i += 6)
            if (Math.abs(l[i + 4] - step.wait) < 1e-3 && Math.abs((l[i] + l[i + 3]) / 2 - at(2.9, 2.9)[0]) < 0.01 &&
                Math.abs((l[i + 2] + l[i + 5]) / 2 - at(2.9, 2.9)[1]) < 0.01) ready = true;
          input.moveZ = 0;
          p.update(1 / 60, input, withLifts);
          lifts.carry(p);
          if (ready && t % 60 === 0) wi++;
          continue;
        }
        input.moveZ = 1;
        const [tx, tz] = step;
        if (Math.hypot(tx - p.pos[0], tz - p.pos[2]) < 0.3) { wi++; continue; }
        p.yaw = Math.atan2(tx - p.pos[0], tz - p.pos[2]);
        p.update(1 / 60, input, withLifts);
        lifts.carry(p);
      }
      const ok = wi === route.length && Math.abs(p.pos[1] - west.level) < 0.05 && p.pos[0] > u0 + span;
      if (ok) passed5b[kind]++;
      else console.log(`  ${kind} pylon ${ci},${cj} ${E}->${west.level} (${c.xn}) ended at ${p.pos.map((v) => v.toFixed(1))} step ${wi}/${route.length}`);
    }
  check(`stair pylons climb to skyways that cross the street (seed ${seed})`, tested5b.stair > 0 && passed5b.stair === tested5b.stair, `${passed5b.stair}/${tested5b.stair}`);
  check(`lift pylons carry up to skyways that cross the street (seed ${seed})`, tested5b.lift > 0 && passed5b.lift === tested5b.lift, `${passed5b.lift}/${tested5b.lift}`);

  // 5c. nothing else on the block runs into a pylon
  let clashes = 0, pylons = 0;
  for (let ci = -6; ci < 6; ci++)
    for (let cj = -6; cj < 6; cj++) {
      const E = podiumHeight(ci, cj);
      const boxes = colliders(ci * CELL + CELL / 2, cj * CELL + CELL / 2);
      for (const east of [false, true])
        for (const north of [false, true]) {
          const py = cornerPylon(ci, cj, east, north);
          if (!py) continue;
          pylons++;
          const cx = ci * CELL + deckEdge(ci, cj, east ? 0 : 2);
          const cz = cj * CELL + deckEdge(ci, cj, north ? 1 : 3);
          const sx = east ? -1 : 1, sz = north ? -1 : 1;
          const [PL, PW] = pylonSize(py.lift, py.level - E);
          const [lx, lz] = py.axis === "x" ? [PL, PW] : [PW, PL];
          const x0 = Math.min(cx + sx * 0.3, cx + sx * (0.3 + lx)), x1 = Math.max(cx + sx * 0.3, cx + sx * (0.3 + lx));
          const z0 = Math.min(cz + sz * 0.3, cz + sz * (0.3 + lz)), z1 = Math.max(cz + sz * 0.3, cz + sz * (0.3 + lz));
          const own: number[] = [];
          for (let i = 0; i < boxes.length; i += 6) {
            const [bx0, by0, bz0, bx1, by1, bz1] = boxes.subarray(i, i + 6);
            if (bx0 >= x0 - 0.9 && bx1 <= x1 + 0.9 && bz0 >= z0 - 0.9 && bz1 <= z1 + 0.9 && by0 >= E - 0.01) own.push(bx0, by0, bz0, bx1, by1, bz1);
            if (bx1 <= x0 || bx0 >= x1 || bz1 <= z0 || bz0 >= z1 || by1 <= E + 0.05 || by0 >= py.level - 3.5) continue;
            const inside = bx0 >= x0 - 0.9 && bx1 <= x1 + 0.9 && bz0 >= z0 - 0.9 && bz1 <= z1 + 0.9;
            if (!inside) {
              if (clashes < 4) console.log(`  pylon ${ci},${cj} ${east ? "E" : "W"}${north ? "N" : "S"} hits ${[bx0, by0, bz0, bx1, by1, bz1].map((v) => v.toFixed(1))}`);
              clashes++;
            }
          }
          const flicker = coplanarFaces(Float32Array.from(own));
          if (flicker) {
            if (clashes < 4) console.log(`  pylon ${ci},${cj}: ${flicker} pairs of faces share a plane`);
            clashes += flicker;
          }
        }
    }
  check(`pylons stand clear of the towers (seed ${seed})`, pylons > 10 && clashes === 0, `pylons=${pylons} clashes=${clashes}`);

  // 5e. pylons, stairs and deck furniture leave every side of every deck a running line
  {
    const pilot = new RunPilot(0, 0, colliders) as unknown as { ring(ci: number, cj: number): { lines: (number | null)[] } };
    let blocked = 0;
    for (let ci = -6; ci < 6; ci++)
      for (let cj = -6; cj < 6; cj++)
        pilot.ring(ci, cj).lines.forEach((l, side) => {
          if (l !== null) return;
          if (blocked < 3) console.log(`  no running line on side ${side} of ${ci},${cj}`);
          blocked++;
        });
    check(`every deck side has a running line (seed ${seed})`, blocked === 0, `blocked=${blocked}`);
  }

  // 5d. the stubs of a broken bridge can be jumped at a sprint
  let gapTested = 0, gapPassed = 0;
  for (let ci = -8; ci < 8 && gapTested < 4; ci++)
    for (let cj = -8; cj < 8 && gapTested < 4; cj++) {
      const E = podiumHeight(ci, cj);
      if (edgeBridge(ci, cj, 0) !== null || podiumHeight(ci + 1, cj) !== E) continue;
      const faceA = ci * CELL + deckEdge(ci, cj, 0);
      const boxes = colliders(faceA + 15, cj * CELL + CELL / 2);
      // find the stubs: deck tops at E spanning the street, and the gap between them
      const tops: [number, number, number][] = [];
      for (let i = 0; i < boxes.length; i += 6)
        if (Math.abs(boxes[i + 4] - E) < 0.01 && boxes[i + 1] > E - 1 && boxes[i] >= faceA + 0.4 && boxes[i + 3] <= (ci + 1) * CELL + deckEdge(ci + 1, cj, 2) &&
            Math.abs(boxes[i + 5] - boxes[i + 2] - 3.2) < 0.01) tops.push([boxes[i], boxes[i + 3], (boxes[i + 2] + boxes[i + 5]) / 2]);
      tops.sort((a, b) => a[0] - b[0]);
      if (tops.length !== 2 || Math.abs(tops[0][2] - tops[1][2]) > 0.01) {
        console.log(`  gap ${ci},${cj}: ${tops.length} stub decks`);
        continue;
      }
      gapTested++;
      const zc = tops[0][2], gap0 = tops[0][1], gap1 = tops[1][0];
      const p = new Player(faceA - 3, E, zc, Math.PI / 2);
      const input: Input = { moveX: 0, moveZ: 1, sprint: true, walk: false, jump: false };
      for (let t = 0; t < 60 * 6; t++) {
        input.jump = p.pos[0] > gap0 - 0.9 && p.pos[0] < gap0;
        p.update(1 / 60, input, colliders);
        if (p.grounded && p.pos[0] > gap1 + 1.5) break;
      }
      const ok = Math.abs(p.pos[1] - E) < 0.05 && p.pos[0] > gap1;
      if (ok) gapPassed++;
      else console.log(`  gap ${ci},${cj} ${gap0.toFixed(1)}..${gap1.toFixed(1)} ended at ${p.pos.map((v) => v.toFixed(1))}`);
    }
  check(`broken bridges can be jumped (seed ${seed})`, gapTested > 0 && gapPassed === gapTested, `${gapPassed}/${gapTested}`);
}

// 6. flyer: take off from a deck, fly to a taller roof, land, step out
{
  const b = new Builder(new Rng(6));
  b.box(-20, 0, -20, 20, 18, 20, 8); // deck A
  b.box(60, 0, -15, 90, 40, 15, 8); // roof B
  b.box(30, 0, -40, 32, 120, 40, 2); // a tall wall between them
  b.pad(0, 18, 0, 0);
  const boxes = boxesOf(b);
  const hangar = new Parking();
  hangar.sync(b.pads.map((pd, k) => ({ ...pd, id: "t" + k })), []);
  const pad = hangar.nearest(-2.5, 18.04, 0, 1.6);
  check("pad flyer found near player", pad !== null);
  const f = new Flyer(pad!.x, pad!.y, pad!.z, pad!.yaw, [1, 1, 1]);
  hangar.remove(pad!);
  const cols = () => boxes;
  const step = (input: FlyInput, secs: number, yaw: number, pitch = 0, stop = () => false) => {
    for (let t = 0; t < secs * 60; t++) {
      f.update(1 / 60, input, yaw, pitch, cols);
      if (stop()) break;
    }
  };
  const idle: FlyInput = { moveX: 0, moveZ: 0, up: 0, boost: false };
  step(idle, 1, Math.PI / 2);
  check("parked flyer stays put", Math.abs(f.pos[1] - 18.04) < 0.02 && f.grounded, `pos=${f.pos.map((v) => v.toFixed(2))}`);
  // fly straight at the wall at low altitude: must stop in front of it
  step({ moveX: 0, moveZ: 1, up: 0.3, boost: true }, 4, Math.PI / 2);
  check("flyer blocked by wall", f.pos[0] < 30 - 1.6, `pos=${f.pos.map((v) => v.toFixed(2))}`);
  // climb above the wall, cross, descend onto roof B
  step({ moveX: 0, moveZ: 0, up: 1, boost: false }, 12, Math.PI / 2, 0, () => f.pos[1] > 125);
  step({ moveX: 0, moveZ: 1, up: 0, boost: false }, 10, Math.PI / 2, 0, () => f.pos[0] > 75);
  step({ moveX: 0, moveZ: 0, up: -1, boost: false }, 20, Math.PI / 2, 0, () => f.grounded);
  step(idle, 2, Math.PI / 2);
  check("flyer lands on roof", Math.abs(f.pos[1] - 40) < 0.05 && f.canExit, `pos=${f.pos.map((v) => v.toFixed(2))} grounded=${f.grounded}`);
  const spot = f.exitSpot(cols);
  check("exit spot on the roof", spot !== null && Math.abs(spot[1] - 40) < 0.01 && spot[0] > 60 && spot[0] < 90, `spot=${spot}`);
  if (spot) {
    const pl = new Player(spot[0], spot[1], spot[2], 0);
    hangar.drop("flyer", f.pos, f.yaw, f.color);
    const all = () => { const h = hangar.boxes(spot[0], spot[2]); const o = new Float32Array(boxes.length + h.length); o.set(boxes); o.set(h, boxes.length); return o; };
    pl.update(1 / 60, { moveX: 0, moveZ: 0, sprint: false, walk: false, jump: false }, all);
    check("player stands after stepping out", !penetrates(pl, all()) && Math.abs(pl.pos[1] - 40) < 0.01, `pos=${pl.pos.map((v) => v.toFixed(2))}`);
  }
}

// 7. traffic lanes are clear of the city (several cities)
for (const seed of [1971, 42, 777777]) {
  setWorldSeed(seed);
  let carHits = 0, airHits = 0, expressHits = 0;
  const report: string[] = [];
  for (let rx = -3; rx < 3; rx++)
    for (let rz = -3; rz < 3; rz++) {
      const m = buildRegion(rx, rz);
      for (const c of m.colliders) {
        const b = c.boxes;
        for (let i = 0; i < b.length; i += 6) {
          const [x0, y0, z0, x1, y1, z1] = b.subarray(i, i + 6);
          // north-south avenue at x = ci * CELL: car lanes within |dx| in [1.5, 7] and y < 2.2
          for (const lx of [c.ci * CELL, (c.ci + 1) * CELL]) {
            const nx = Math.max(x0 - lx, 0, lx - x1); // distance from line to box in x
            const inCarBand = x0 < lx + 7.1 && x1 > lx - 7.1 && !(x0 > lx - 1.5 && x1 < lx + 1.5);
            if (inCarBand && y0 < 2.2 && y1 > 0.25 && nx < 7.1) {
              carHits++;
              if (report.length < 5) report.push(`car lane x=${lx}: box ${[x0, y0, z0, x1, y1, z1].map((v) => v.toFixed(1))}`);
            }
            // air corridors: |dx| < 5.5 around the line, 45..128 m
            if (x0 < lx + 5.5 && x1 > lx - 5.5 && y0 < 128 && y1 > 45) {
              airHits++;
              if (report.length < 5) report.push(`air ns x=${lx}: box ${[x0, y0, z0, x1, y1, z1].map((v) => v.toFixed(1))}`);
            }
          }
          for (const lz of [c.cj * CELL, (c.cj + 1) * CELL]) {
            if (z0 < lz + 5.5 && z1 > lz - 5.5 && y0 < 128 && y1 > 65) {
              airHits++;
              if (report.length < 5) report.push(`air ew z=${lz}: box ${[x0, y0, z0, x1, y1, z1].map((v) => v.toFixed(1))}`);
            }
            void expressHits;
          }
        }
      }
    }
  for (const r of report) console.log("  " + r);
  check(`car lanes and air corridors are clear (seed ${seed})`, carHits === 0 && airHits === 0, `car=${carHits} air=${airHits}`);
}

// 8. driving: street, kerb, wall, stopping and stepping out
{
  const b = new Builder(new Rng(8));
  b.box(-100, -1, -100, 100, 0, 100, 0); // street
  b.box(6, 0, -100, 40, 0.18, 100, 1); // sidewalk to the east (+x)
  b.box(-100, 0, 60, 100, 10, 62, 2); // wall across the road ahead
  const boxes = boxesOf(b);
  const cols = () => boxes;
  const car = new Car(0, 0, 0, 0, false, [1, 0, 0]);
  const run = (throttle: number, steer: number, secs: number, handbrake = false) => {
    for (let t = 0; t < secs * 60; t++) car.update(1 / 60, { throttle, steer, handbrake, boost: false }, cols);
  };
  run(1, 0, 2);
  check("car accelerates along the street", car.speed > 15 && car.pos[2] > 15 && Math.abs(car.pos[0]) < 0.01, `speed=${car.speed.toFixed(1)} pos=${car.pos.map((v) => v.toFixed(1))}`);
  run(1, 0, 4);
  check("car stopped by the wall", car.pos[2] < 60 - 2.2 && car.pos[2] > 50, `pos=${car.pos.map((v) => v.toFixed(2))} speed=${car.speed.toFixed(2)}`);
  run(-1, 0, 1.5);
  run(0, 0, 3);
  // turn right (towards -x) then left onto the sidewalk (+x) and climb the kerb
  const z0 = car.pos[2];
  run(-1, 0, 1);
  run(0, 0, 2);
  const car2 = new Car(0, 0, 0, Math.PI / 2, false, [1, 0, 0]); // facing +x, toward the kerb
  for (let t = 0; t < 120; t++) car2.update(1 / 60, { throttle: 0.6, steer: 0, handbrake: false, boost: false }, cols);
  check("car climbs the kerb", Math.abs(car2.pos[1] - 0.18) < 0.02 && car2.pos[0] > 8, `pos=${car2.pos.map((v) => v.toFixed(2))}`);
  const turner = new Car(-50, 0, -50, 0, false, [1, 0, 0]);
  for (let t = 0; t < 120; t++) turner.update(1 / 60, { throttle: 0.7, steer: 1, handbrake: false, boost: false }, cols);
  check("steering right turns toward -x", turner.pos[0] < -51, `pos=${turner.pos.map((v) => v.toFixed(1))} yaw=${turner.yaw.toFixed(2)}`);
  for (let t = 0; t < 400; t++) car2.update(1 / 60, { throttle: -1, steer: 0, handbrake: true, boost: false }, cols);
  for (let t = 0; t < 60; t++) car2.update(1 / 60, { throttle: 0, steer: 0, handbrake: false, boost: false }, cols);
  const spot = car2.exitSpot(cols);
  check("car can stop and be left", car2.canExit && spot !== null, `speed=${car2.speed.toFixed(2)} spot=${spot}`);
  void z0;
}

// 9. shooting down a flyer from the traffic streams
{
  const traffic = new Traffic();
  const parking = new Parking();
  const particles = new Particles();
  const combat = new Combat(particles);
  const eye: [number, number, number] = [0, 60, 0];
  traffic.update(10, eye, [0, 0, 1]);
  const list = traffic.flyers;
  // pick a flyer ahead of us
  let target = -1;
  for (let i = 0; i < list.count; i++) {
    const o = i * 10;
    const d = Math.hypot(list.data[o] - eye[0], list.data[o + 1] - eye[1], list.data[o + 2] - eye[2]);
    if (list.data[o + 2] > 30 && d < 250) { target = i; break; }
  }
  check("a flyer to shoot at", target >= 0, `count=${list.count}`);
  if (target >= 0) {
    const key = list.keys[target];
    let t = 10;
    const cols = () => new Float32Array(0);
    for (let f = 0; f < 120 && !traffic.removed.has(key); f++) {
      traffic.update(t, eye, [0, 0, 1]);
      // aim straight at the target's current position, with lead
      const idx = list.keys.indexOf(key);
      if (idx < 0 || idx >= list.count) break;
      const o = idx * 10;
      const v = traffic.velocityOf(key);
      const dist = Math.hypot(list.data[o] - eye[0], list.data[o + 1] - eye[1], list.data[o + 2] - eye[2]);
      const lead = dist / 260;
      combat.trigger([eye[0], eye[1] - 0.9, eye[2] - 2], 0,
        [list.data[o] + v[0] * lead, list.data[o + 1] + 0.8, list.data[o + 2] + v[2] * lead], [0, 0, 0]);
      combat.update(1 / 60, traffic, parking, cols);
      t += 1 / 60;
    }
    check("bolt downs the flyer", traffic.removed.has(key) && combat.kills === 1, `kills=${combat.kills}`);
    traffic.update(t + 1, eye, [0, 0, 1]);
    check("downed flyer stays gone", !list.keys.slice(0, list.count).includes(key));
    for (let f = 0; f < 60 * 12; f++) combat.update(1 / 60, traffic, parking, cols);
    const events = combat.takeEvents();
    check("every wreck falls and explodes", events.explosions.length >= 1 && events.explosions.length === combat.kills, `explosions=${events.explosions.length} kills=${combat.kills}`);
  }
}

// 10. shooting cars: a parked one and one in traffic
{
  setWorldSeed(1971);
  const traffic = new Traffic();
  const parking = new Parking();
  const particles = new Particles();
  const combat = new Combat(particles);
  const noBoxes = () => new Float32Array(0);
  parking.sync([], [{ id: "c1", x: 20, y: 0, z: 30, yaw: Math.PI / 2, van: false, color: [0.5, 0.2, 0.1] }]);
  // from a hovering flyer, aim down at the parked car
  const from: [number, number, number] = [20, 40, 0];
  for (let f = 0; f < 90 && combat.carKills === 0; f++) {
    combat.trigger([from[0], from[1] - 0.9, from[2] - 2], 0, [20, 0.7, 30], [0, 0, 0]);
    combat.update(1 / 60, traffic, parking, noBoxes);
  }
  check("bolt wrecks a parked car", combat.carKills === 1 && parking.nearest(20, 0, 32, 3) === null, `carKills=${combat.carKills}`);
  for (let f = 0; f < 180; f++) combat.update(1 / 60, traffic, parking, noBoxes);
  const wreck = [...parking.all()].find((p) => p.wreck);
  check("the car lands as a wreck that can't be entered", !!wreck && Math.abs(wreck.y) < 1e-6 && parking.nearest(wreck.x, 0, wreck.z + 1, 3) === null,
    `wreck=${wreck ? [wreck.x, wreck.y, wreck.z].map((v) => v.toFixed(1)) : "none"}`);
  check("the wreck is still solid", parking.boxes(20, 30).length === 6);

  // a car driving along the avenue at x = -2.5
  traffic.update(5, [-2.5, 30, 0], [0, 0, 1]);
  const cars = traffic.cars;
  let target = -1;
  for (let i = 0; i < cars.count; i++) {
    const o = i * 10;
    if (Math.abs(cars.data[o]) < 7 && cars.data[o + 2] > 10 && cars.data[o + 2] < 120 && cars.data[o + 1] < 1) { target = i; break; }
  }
  check("a moving car to shoot at", target >= 0, `cars=${cars.count}`);
  if (target >= 0) {
    const key = cars.keys[target];
    let t = 5;
    const before = combat.carKills;
    for (let f = 0; f < 120 && !traffic.removed.has(key); f++) {
      traffic.update(t, [-2.5, 30, 0], [0, 0, 1]);
      const idx = cars.keys.indexOf(key);
      if (idx < 0 || idx >= cars.count) break;
      const o = idx * 10;
      const v = traffic.velocityOf(key);
      const dist = Math.hypot(cars.data[o] + 2.5, cars.data[o + 1] - 30, cars.data[o + 2]);
      const lead = dist / 260;
      combat.trigger([-2.5, 29.1, -2], 0, [cars.data[o] + v[0] * lead, 0.7, cars.data[o + 2] + v[2] * lead], [0, 0, 0]);
      combat.update(1 / 60, traffic, parking, noBoxes);
      t += 1 / 60;
    }
    check("bolt wrecks a car in traffic", traffic.removed.has(key) && combat.carKills === before + 1, `carKills=${combat.carKills}`);
  }
}

// 11. seeds change the city
{
  setWorldSeed(1);
  const a = buildRegion(0, 0);
  setWorldSeed(2);
  const b = buildRegion(0, 0);
  setWorldSeed(1);
  const c = buildRegion(0, 0);
  const same = (x: Float32Array, y: Float32Array) => x.length === y.length && x.every((v, i) => v === y[i]);
  check("different seeds give different cities", !same(a.vertices, b.vertices));
  check("the same seed gives the same city", same(a.vertices, c.vertices));
  setWorldSeed(1971);
}

// A real city's colliders, generated on demand (like World.colliders).
function cityColliders(): (x: number, z: number) => Float32Array {
  const cells = new Map<string, Float32Array>();
  const cache = new Map<string, Float32Array>();
  return (x: number, z: number): Float32Array => {
    const ci = Math.floor(x / CELL), cj = Math.floor(z / CELL);
    const hit = cache.get(`${ci},${cj}`);
    if (hit) return hit;
    const parts: Float32Array[] = [];
    for (let i = ci - 1; i <= ci + 1; i++)
      for (let j = cj - 1; j <= cj + 1; j++) {
        if (!cells.has(`${i},${j}`)) {
          for (const c of buildRegion(Math.floor(i / 3), Math.floor(j / 3)).colliders) cells.set(`${c.ci},${c.cj}`, c.boxes);
        }
        parts.push(cells.get(`${i},${j}`)!);
      }
    const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    cache.set(`${ci},${cj}`, out);
    return out;
  };
}

// deterministic "random" choices
const lcg = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

// 12. demo autopilots in real cities: run the decks, fly the corridors, drive the cross streets
{
  for (const seed of [1971, 42, 777777]) {
    setWorldSeed(seed);
    const colliders = cityColliders();

    // running
    {
      const pilot = new RunPilot(0, 0, colliders, lcg(seed));
      const s = pilot.start;
      const p = new Player(s[0], s[1], s[2], Math.PI / 2);
      let fell = false, stuck = 0, last: number[] = [...p.pos];
      for (let t = 0; t < 90 * 60; t++) {
        const c = pilot.steer(p, 1 / 60);
        p.update(1 / 60, { moveX: c.moveX, moveZ: c.moveZ, sprint: c.sprint, walk: c.down, jump: c.up }, colliders);
        if (pilot.fell(p)) fell = true;
        if (t % 180 === 179) {
          if (Math.hypot(p.pos[0] - last[0], p.pos[2] - last[2]) < 4) stuck++;
          last = [...p.pos];
        }
      }
      check(`demo runner keeps to the decks (seed ${seed})`, !fell && stuck === 0 && pilot.crossings >= 5,
        `fell=${fell} stuck=${stuck} bridges=${pilot.crossings} pos=${p.pos.map((v) => v.toFixed(1))}`);
    }

    // flying
    {
      const pilot = new FlyPilot(0, 30, "ns", 1, lcg(seed + 1));
      const f = new Flyer(0, 60, 30, 0, [1, 1, 1]);
      f.grounded = false;
      const look = { yaw: 0, pitch: -0.1 };
      let turns = 0, hits = 0, axis = pilot.axis, low = Infinity, high = 0;
      for (let t = 0; t < 120 * 60; t++) {
        const c = pilot.steer(f, look, 1 / 60);
        const before = Math.hypot(...f.vel);
        f.update(1 / 60, { moveX: c.moveX, moveZ: c.moveZ, up: c.climb ?? 0, boost: c.sprint }, look.yaw, look.pitch, colliders);
        if (before > 10 && Math.hypot(...f.vel) < before * 0.7) hits++;
        if (pilot.axis !== axis) {
          turns++;
          axis = pilot.axis;
        }
        if (t > 300) {
          low = Math.min(low, f.pos[1]);
          high = Math.max(high, f.pos[1]);
        }
      }
      check(`demo flyer follows the corridors (seed ${seed})`, hits === 0 && turns >= 3 && low > 45,
        `hits=${hits} turns=${turns} height=${low.toFixed(0)}..${high.toFixed(0)} pos=${f.pos.map((v) => v.toFixed(0))}`);
    }

    // driving, with avenue traffic
    {
      const pilot = new DrivePilot(88, 1);
      const car = new Car(44, 0, pilot.lane, Math.PI / 2, false, [1, 1, 1]);
      const traffic = new Traffic();
      let impacts = 0, drift = 0;
      for (let t = 0; t < 60 * 60; t++) {
        const time = t / 60;
        traffic.update(time, [car.pos[0] - 7, 3, car.pos[2]], [1, 0, 0]);
        const c = pilot.steer(car, traffic);
        car.update(1 / 60, { throttle: c.moveZ, steer: c.moveX, handbrake: c.up, boost: c.sprint }, colliders,
          traffic.carBoxes(car.pos[0], car.pos[2], 30));
        if (car.impact > 0) impacts++;
        if (t > 120) drift = Math.max(drift, Math.abs(car.pos[2] - pilot.lane));
      }
      const crossed = Math.floor(car.pos[0] / CELL);
      check(`demo car gives way and keeps its lane (seed ${seed})`, impacts === 0 && drift < 1.5 && crossed >= 8,
        `impacts=${impacts} drift=${drift.toFixed(2)} avenues=${crossed} x=${car.pos[0].toFixed(0)}`);
    }
  }
  setWorldSeed(1971);
}

// 13. hunters in real cities: chase over the bridges, take a flyer, fly in, drive in; shooting both ways
{
  type V3 = [number, number, number];
  const huntWorld = (colliders: (x: number, z: number) => Float32Array) => {
    const particles = new Particles();
    return { colliders, traffic: new Traffic(), parking: new Parking(), combat: new Combat(particles), particles };
  };
  const setup = (colliders: (x: number, z: number) => Float32Array, seed: number) => {
    const w = huntWorld(colliders);
    const hunters = new Hunters(w, lcg(seed));
    hunters.active = true;
    hunters.auto = false;
    return { w, hunters };
  };
  /** Run the hunt for up to `seconds`, the quarry standing still, until `done`. Returns the seconds taken. */
  const hunt = (w: ReturnType<typeof huntWorld>, hunters: Hunters, q: Quarry, seconds: number, done: () => boolean) => {
    const eye: V3 = [q.pos[0], q.pos[1] + 1.6, q.pos[2]];
    let t = 0;
    for (; t < seconds * 60 && !done(); t++) {
      w.traffic.update(t / 60, eye, [0, 0, 1]);
      hunters.update(1 / 60, q, { eye, fwd: [0, 0, 1] });
      w.combat.update(1 / 60, w.traffic, w.parking, w.colliders, hunters);
      w.particles.update(1 / 60);
    }
    return t / 60;
  };
  const standing = (pos: V3): Quarry => ({ pos, vel: [0, 0, 0], mode: "foot", yaw: 0 });

  for (const seed of [1971, 42, 777777]) {
    setWorldSeed(seed);
    const colliders = cityColliders();
    const s = spawnPoint();

    // on foot, from a deck two bridges away
    {
      const depth = new Map<string, number>([["0,0", 0]]);
      const queue: [number, number][] = [[0, 0]];
      let far: [number, number] | null = null;
      while (queue.length && !far) {
        const [i, j] = queue.shift()!;
        for (let side = 0; side < 4 && !far; side++) {
          if (bridgeOn(i, j, side) === null) continue;
          const n: [number, number] = [i + [1, 0, -1, 0][side], j + [0, 1, 0, -1][side]];
          if (depth.has(n.join())) continue;
          depth.set(n.join(), depth.get(`${i},${j}`)! + 1);
          if (depth.get(n.join()) === 2) far = n;
          queue.push(n);
        }
      }
      const { w, hunters } = setup(colliders, seed);
      const q = standing([s.x, s.y, s.z]);
      const start = new RunPilot(far![0], far![1], colliders).start;
      const h = hunters.addRunner(start);
      let low = Infinity;
      const took = hunt(w, hunters, q, 90, () => {
        low = Math.min(low, h.body.pos[1]);
        return hunters.health < MAX_HEALTH - 10;
      });
      const dist = Math.hypot(h.pos[0] - q.pos[0], h.pos[2] - q.pos[2]);
      check(`hunter on foot crosses the bridges and shoots (seed ${seed})`, hunters.health < MAX_HEALTH - 10 && low > PODIUM_LEVELS[0] - 1,
        `from block ${far} took=${took.toFixed(1)}s dist=${dist.toFixed(1)} health=${hunters.health.toFixed(0)} lowest=${low.toFixed(1)}`);
    }

    // takes the parked flyer on the deck when the quarry is up in the air, and flies after it
    {
      const { w, hunters } = setup(colliders, seed);
      w.parking.sync(buildRegion(0, 0).pads, []);
      const q: Quarry = { pos: [60, 110, 300], vel: [0, 0, 0], mode: "flyer", yaw: 0 };
      const h = hunters.addRunner([s.x, s.y, s.z]);
      const boarded = hunt(w, hunters, q, 30, () => h.flyer !== null);
      const took = hunt(w, hunters, q, 60, () => Math.hypot(h.pos[0] - q.pos[0], h.pos[1] - q.pos[1], h.pos[2] - q.pos[2]) < 60);
      const dist = Math.hypot(h.pos[0] - q.pos[0], h.pos[1] - q.pos[1], h.pos[2] - q.pos[2]);
      check(`hunter takes a parked flyer and flies after the quarry (seed ${seed})`, h.flyer !== null && dist < 60,
        `boarded after ${boarded.toFixed(1)}s, then ${took.toFixed(1)}s dist=${dist.toFixed(0)} pos=${h.pos.map((v) => v.toFixed(0))}`);
    }

    // a hunter flyer comes in over the towers
    {
      const { w, hunters } = setup(colliders, seed);
      const q = standing([s.x, s.y, s.z]);
      const h = hunters.addFlyer([s.x + 190, 70, s.z + 120], -2);
      let bumps = 0, prev = 0;
      const took = hunt(w, hunters, q, 60, () => {
        const v = Math.hypot(...h.flyer!.vel);
        if (prev > 15 && v < prev * 0.6) bumps++;
        prev = v;
        return hunters.health < MAX_HEALTH - 10;
      });
      const flat = Math.hypot(h.pos[0] - q.pos[0], h.pos[2] - q.pos[2]);
      check(`hunter flyer closes in and shoots (seed ${seed})`, hunters.health < MAX_HEALTH - 10 && bumps <= 1,
        `took=${took.toFixed(1)}s flat=${flat.toFixed(0)} height=${(h.pos[1] - q.pos[1]).toFixed(0)} bumps=${bumps}`);
    }

    // a hunter car comes along a cross street, turns up the avenue and gets the quarry
    {
      const { w, hunters } = setup(colliders, seed);
      const q = standing([2 * CELL + 7.5, 0.18, 44]);
      const h = hunters.addCar([-40, 0, CELL + 3.5], Math.PI / 2, [0, 0, 0], 15);
      const took = hunt(w, hunters, q, 60, () => hunters.health < MAX_HEALTH - 10);
      const dist = Math.hypot(h.pos[0] - q.pos[0], h.pos[2] - q.pos[2]);
      check(`hunter car drives the grid to the quarry (seed ${seed})`, hunters.health < MAX_HEALTH - 10,
        `took=${took.toFixed(1)}s dist=${dist.toFixed(1)} pos=${h.pos.map((v) => v.toFixed(1))} traffic wrecked=${w.traffic.removed.size}`);
    }
  }

  // bolts: the player's hit hunters; the hunters' hit the player and nothing else
  {
    setWorldSeed(1971);
    const noBoxes = () => new Float32Array(0);
    const w = huntWorld(noBoxes);
    const hunters = new Hunters(w, lcg(5));
    hunters.active = true;
    hunters.auto = false;
    const runner = hunters.addRunner([0, 0, 25]);
    const flyer = hunters.addFlyer([0, 30, 60]);
    for (let f = 0; f < 60 && hunters.kills === 0; f++) {
      w.combat.triggerSidearm([0, 1.4, 0.5], runner.center, [0, 0, 0]);
      w.combat.update(1 / 60, w.traffic, w.parking, noBoxes, hunters);
    }
    check("sidearm takes down a hunter on foot", hunters.kills === 1 && runner.dead);
    let shots = 0;
    for (let f = 0; f < 240 && hunters.kills < 2; f++) {
      if (f % 20 === 0) {
        w.combat.shoot([0, 1.4, 0.5], flyer.center, [0, 0, 0]);
        shots++;
      }
      w.combat.update(1 / 60, w.traffic, w.parking, noBoxes, hunters);
    }
    check("a hunter flyer takes three hits", hunters.kills === 2 && shots === 3, `shots=${shots} kills=${hunters.kills}`);

    // hostile bolts down an avenue full of traffic, at a quarry beyond it
    const eye: V3 = [-2.5, 1.5, 0];
    const far = standing([-2.5, 0, 200]);
    hunters.update(1 / 60, far, { eye, fwd: [0, 0, 1] });
    const before = hunters.health;
    for (let f = 0; f < 90; f++) {
      w.traffic.update(5 + f / 60, eye, [0, 0, 1]);
      if (f % 6 === 0) w.combat.shoot([-2.5, 1.2, 1], [-2.5, 1.2, 200], [0, 0, 0], true);
      w.combat.update(1 / 60, w.traffic, w.parking, noBoxes, hunters);
    }
    check("hunter bolts pass through traffic and hit the player", w.combat.carKills === 0 && w.combat.kills === 0 &&
      w.traffic.removed.size === 0 && hunters.health < before, `health=${hunters.health.toFixed(0)}`);
  }
  setWorldSeed(1971);
}

process.exit(failures ? 1 : 0);
