// Finds surfaces that flicker: pairs of boxes whose tops lie in exactly the same plane and
// cover the same ground. Two of those are one depth value with two textures on it, and which
// one a pixel shows is settled by the last bit of the interpolated depth — so the seam walks
// about as the head turns. Anything this prints is a place that will shimmer on some GPU.
//   SEED=976756 npx tsx scripts/coplanar.ts [rx] [rz]
import { Builder } from "../src/city/generate";
import { buildPlanRegion } from "../src/city/plan";
import { setWorldSeed } from "../src/math";

setWorldSeed(Number(process.env.SEED ?? 1));
const rx = Number(process.argv[2] ?? 0), rz = Number(process.argv[3] ?? 0);

interface Box {
  x0: number; y0: number; z0: number; x1: number; y1: number; z1: number;
  turn: number; mat: number;
  /** Where it was placed from, which is what actually has to be fixed. */
  at: string;
}

// Every box the region lays, taken as the builder is handed it. Boxes marked hidden are the
// fill inside a mass and never reach the mesh, so they cannot fight with anything; sheared
// ones are left out too, since a tie between two of those is a pair of planes and not a pair
// of heights — streets and ground tiles go unchecked because of it.
const boxes: Box[] = [];
const proto = Builder.prototype as unknown as { box: (...a: unknown[]) => void };
const orig = proto.box;
proto.box = function (this: unknown, ...a: unknown[]) {
  const [x0, y0, z0, x1, y1, z1, mat] = a as number[];
  const opts = (a[9] ?? {}) as { turn?: number; hidden?: boolean; rise?: number; riseZ?: number };
  if (!opts.hidden && !opts.rise && !opts.riseZ) {
    const at = (new Error().stack ?? "").split("\n").slice(2, 5)
      .map((l) => (l.match(/at (\S+) /) ?? [])[1] ?? "?").join(" < ");
    boxes.push({ x0, y0, z0, x1, y1, z1, turn: opts.turn ?? 0, mat, at });
  }
  return orig.apply(this, a as never[]);
};
buildPlanRegion(rx, rz);
proto.box = orig;

/** The four corners of a box's footprint, turned about its own centre as the mesh turns it. */
function corners(b: Box): [number, number][] {
  const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
  const cs = Math.cos(b.turn), sn = Math.sin(b.turn);
  return ([[b.x0, b.z0], [b.x1, b.z0], [b.x1, b.z1], [b.x0, b.z1]] as [number, number][])
    .map(([x, z]) => {
      const dx = x - cx, dz = z - cz;
      return [cx + dx * cs - dz * sn, cz + dx * sn + dz * cs] as [number, number];
    });
}

/**
 * Whether two footprints really cross, by separating axis — the four edge normals of the two
 * rectangles. Comparing their axis-aligned bounds instead calls every pair of boxes turned
 * along the same curve an overlap, which on a river or an arterial is all of them.
 */
function overlaps(a: [number, number][], c: [number, number][], slack: number): boolean {
  for (const [p, q] of [[a, c], [c, a]] as const)
    for (let k = 0; k < 4; k++) {
      const ax = p[(k + 1) % 4][0] - p[k][0], az = p[(k + 1) % 4][1] - p[k][1];
      const l = Math.hypot(ax, az) || 1;
      const nx = -az / l, nz = ax / l;
      const pr = (r: [number, number][]) => r.map(([x, z]) => x * nx + z * nz);
      const u = pr(p), v = pr(q);
      if (Math.min(...u) > Math.max(...v) - slack || Math.min(...v) > Math.max(...u) - slack) return false;
    }
  return true;
}

// bucketed by top height, exactly: a tie is a tie only when the two are level to the bit
const byTop = new Map<number, Box[]>();
for (const b of boxes) (byTop.get(b.y1) ?? byTop.set(b.y1, []).get(b.y1)!).push(b);

const found: { a: Box; b: Box }[] = [];
for (const list of byTop.values()) {
  if (list.length < 2) continue;
  const shape = list.map(corners);
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++)
      if (overlaps(shape[i], shape[j], 0.05)) found.push({ a: list[i], b: list[j] });
}

console.log(`${boxes.length} boxes in region ${rx},${rz}: ${found.length} pairs level to the bit and overlapping`);
const tally = new Map<string, number>();
for (const f of found) tally.set(f.a.at, (tally.get(f.a.at) ?? 0) + 1);
for (const [at, n] of [...tally].sort((p, q) => q[1] - p[1])) console.log(`  ${String(n).padStart(4)}  ${at}`);
for (const f of found.slice(0, 10)) {
  const s = (b: Box) => `[${b.x0.toFixed(1)},${b.z0.toFixed(1)}..${b.x1.toFixed(1)},${b.z1.toFixed(1)}] turn ${b.turn.toFixed(3)} mat ${b.mat} ${b.at}`;
  console.log(`  y=${f.a.y1.toFixed(3)}  ${s(f.a)}\n            ${s(f.b)}`);
}
