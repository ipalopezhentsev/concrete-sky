// Prints a camera pose standing on an arterial, for scripts/shots.mjs.
//   npx tsx scripts/pose.ts <axis> <line> <station> [height above road]
import { arteryFrame } from "../src/city/network";
import { groundAt } from "../src/city/plan";
import { setWorldSeed, worldSeed } from "../src/math";

setWorldSeed(Number(process.env.SEED ?? worldSeed()));
const axis = Number(process.argv[2]) as 0 | 1;
const line = Number(process.argv[3]);
const s = Number(process.argv[4] ?? 0);
const up = Number(process.argv[5] ?? 2.2);
const side = Number(process.argv[6] ?? 0); // metres off the centreline, to miss the piers
const { p, dir } = arteryFrame(axis, line, s);
const cx = p[0] - dir[1] * side, cz = p[1] + dir[0] * side;
const y = groundAt(cx, cz) + up;
console.log(`${cx.toFixed(1)},${y.toFixed(1)},${cz.toFixed(1)},${Math.atan2(dir[0], dir[1]).toFixed(3)},0.04`);
