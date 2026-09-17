// Headless movement tests: run with `npx tsx tests/traversal.test.ts`.
import { Builder, bridgeOn, buildRegion, CELL, edgeBridge, facadeStair, PODIUM_LEVELS, podiumHeight, spawnPoint, STREET, stairTower } from "../src/city/generate";
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

function boxesOf(b: Builder): Float32Array {
  const out: number[] = [];
  for (let i = 0; i < b.count; i++) {
    const o = i * 14;
    if (b.data[o + 12]) out.push(...b.data.slice(o, o + 6));
  }
  return Float32Array.from(out);
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

// 1. switchback stair tower: axis z, u from 0, outer wall at x = 0, podium at x = 5.8
{
  const b = new Builder(new Rng(1));
  const top = 24;
  stairTower(b, "z", 0, 0, 1, top, [1, 1, 1]);
  b.box(5.8, 0, -20, 40, top, 40, 2); // podium
  const boxes = boxesOf(b);
  const p = new Player(1.6, 0, -3, 0);
  // lane A centre x ~1.55, lane B centre x ~4.25; landings at z 0.4..2.8 and 6.2..8.6
  const wps: [number, number][] = [[1.55, 1.6]];
  for (let k = 0; k < top / 3; k++) {
    if (k % 2 === 0) wps.push([1.55, 7.4], [4.25, 7.4]);
    else wps.push([4.25, 1.6], [1.55, 1.6]);
  }
  wps.push([4.25, 1.6], [8, 1.6]);
  walk(p, boxes, wps, 120);
  check("stair tower reaches podium deck", Math.abs(p.pos[1] - top) < 0.05 && p.pos[0] > 6, `pos=${p.pos.map((v) => v.toFixed(2))}`);
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
      const faceA = ci * CELL + CELL - STREET / 2 - 6.5;
      const p = new Player(faceA - 2, ha, zc, Math.PI / 2);
      const input: Input = { moveX: 0, moveZ: 1, sprint: false, walk: false, jump: false };
      for (let t = 0; t < 60 * 12; t++) {
        p.yaw = Math.PI / 2 - Math.max(-0.5, Math.min(0.5, (p.pos[2] - zc) * 0.3));
        p.update(1 / 60, input, colliders);
      }
      const ok = Math.abs(p.pos[1] - hb) < 0.5 && p.pos[0] > faceA + 32;
      if (ok) passed++;
      else console.log(`  bridge ${ci},${cj} ${ha}->${hb} ended at ${p.pos.map((v) => v.toFixed(1))}`);
    }
  check(`stepped bridges connect podiums (seed ${seed})`, tested > 0 && passed === tested, `${passed}/${tested}`);
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
