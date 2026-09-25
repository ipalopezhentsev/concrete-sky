// Draws the ground to an SVG — hillshaded, with contours and the block outlines over it — so
// the landform can be judged before the city is built on it, the way netmap.ts does the plan.
//   npx tsx scripts/relief.ts out.svg [extent] [contour spacing]
import fs from "node:fs";
import { blocksIn, cellOf, riverNear, RIVER_HALF, terrainAt, waterLevel } from "../src/city/network";
import { setWorldSeed, worldSeed } from "../src/math";

setWorldSeed(Number(process.env.SEED ?? worldSeed()));
const out = process.argv[2] ?? "relief.svg";
const extent = Number(process.argv[3] ?? 3000); // metres either side of the origin
const step = Number(process.argv[4] ?? 5); // metres between contours
const N = 300; // cells across
const span = (2 * extent) / N;
const px = (v: number) => ((v + extent) / (2 * extent)) * 1500;

const H: number[][] = [];
let lo = Infinity, hi = -Infinity;
for (let i = 0; i <= N; i++) {
  H[i] = [];
  for (let j = 0; j <= N; j++) {
    const v = terrainAt(-extent + i * span, -extent + j * span);
    H[i][j] = v;
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
}

const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="1500" viewBox="0 0 1500 1500">`];
const cell = 1500 / N + 0.4; // a shade over, so neighbouring cells leave no seam
for (let i = 0; i < N; i++)
  for (let j = 0; j < N; j++) {
    const x = -extent + i * span, z = -extent + j * span;
    const t = (H[i][j] - lo) / (hi - lo || 1);
    // shaded from the north-west, which is what makes a slope read as a slope
    const gx = (H[i + 1][j] - H[i][j]) / span, gz = (H[i][j + 1] - H[i][j]) / span;
    const light = Math.max(0, Math.min(1, 0.55 + (gx + gz) * 4.2));
    const r = riverNear(x, z, RIVER_HALF + 4);
    const fill = r && H[i][j] < waterLevel(r.line)
      ? "rgb(40,70,110)"
      : `rgb(${[90 + t * 150, 105 + t * 140, 95 + t * 120].map((c) => Math.round(c * (0.45 + light * 0.75))).join(",")})`;
    parts.push(`<rect x="${px(x).toFixed(1)}" y="${px(z).toFixed(1)}" width="${cell.toFixed(1)}" height="${cell.toFixed(1)}" fill="${fill}"/>`);
    // a contour wherever the level is crossed between this cell and the next
    const at = (v: number) => Math.floor(v / step);
    if (at(H[i][j]) !== at(H[i + 1][j]) || at(H[i][j]) !== at(H[i][j + 1]))
      parts.push(`<rect x="${px(x).toFixed(1)}" y="${px(z).toFixed(1)}" width="${cell.toFixed(1)}" height="${cell.toFixed(1)}" fill="rgba(20,25,20,0.3)"/>`);
  }

for (const s of blocksIn(-extent, -extent, extent, extent)) {
  const poly = cellOf(s);
  if (!poly) continue;
  const pts = poly.map(([x, z]) => `${px(x).toFixed(1)},${px(z).toFixed(1)}`).join(" ");
  parts.push(`<polygon points="${pts}" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="0.7"/>`);
}

parts.push(`<text x="14" y="26" font-family="monospace" font-size="17" fill="#fff">city no. ${worldSeed()} — ${extent * 2} m across, ground ${lo.toFixed(0)} to ${hi.toFixed(0)} m, contours every ${step} m</text>`);
parts.push(`</svg>`);
fs.writeFileSync(out, parts.join("\n"));
console.log(`${out}  ${extent * 2} x ${extent * 2} m, ground ${lo.toFixed(1)} .. ${hi.toFixed(1)} m`);
