// Draws the road network to an SVG, so the street plan can be judged before the city is
// built on it.  usage: npx tsx scripts/netmap.ts out.svg [extent]
import fs from "node:fs";
import { blocksIn, cellOf, grain, SLOT } from "../src/city/network";

const out = process.argv[2] ?? "netmap.svg";
const extent = Number(process.argv[3] ?? 1800); // metres either side of the origin
const px = (v: number) => ((v + extent) / (2 * extent)) * 1600;
const len = (v: number) => (v / (2 * extent)) * 1600;

const parts: string[] = [];
parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1600" viewBox="0 0 1600 1600">`);
parts.push(`<rect width="1600" height="1600" fill="#11151a"/>`);

const sites = blocksIn(-extent - SLOT * 2, -extent - SLOT * 2, extent + SLOT * 2, extent + SLOT * 2);

// The blocks are already pulled back off their kerbs, so the streets are simply the ground
// they leave: road colour behind, blocks painted over it.
parts.push(`<rect width="1600" height="1600" fill="#5d666f"/>`);
for (const s of sites) {
  const poly = cellOf(s);
  if (!poly) continue;
  const pts = poly.map(([x, z]) => `${px(x).toFixed(1)},${px(z).toFixed(1)}`).join(" ");
  const g = grain(s.p[0], s.p[1]);
  const shade = Math.round(26 + g * 20);
  parts.push(`<polygon points="${pts}" fill="rgb(${shade},${shade + 6},${shade + 13})" stroke="none"/>`);
}




parts.push(`</svg>`);
fs.writeFileSync(out, parts.join("\n"));
console.log(`${out}  ${extent * 2} x ${extent * 2} m, ${sites.length} blocks`);
