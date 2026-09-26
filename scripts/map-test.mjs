// Opens the map in a real browser, waits for its tiles, zooms out and back, and saves a shot
// of each zoom level. Checks that the plan fills in and that the panel is actually painted.
// usage: node scripts/map-test.mjs [outDir]   (expects `vite preview --port 4173`)
// SEED= and POSE="x,y,z,yaw,pitch" pick where to stand.
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";

const out = process.argv[2] ?? "map-test";
const base = process.env.BASE_URL ?? "http://localhost:4173/";
const browserPath = process.env.BROWSER ??
  ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"]
    .find((p) => fs.existsSync(p));

fs.mkdirSync(out, { recursive: true });
const b = await puppeteer.launch({
  executablePath: browserPath,
  headless: true,
  args: ["--force_high_performance_gpu", "--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=d3d11"],
  defaultViewport: { width: 1280, height: 800 },
});
const page = await b.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message.slice(0, 2000)));
page.on("console", (m) => { if (m.type() === "error") console.log("[page]", m.text().slice(0, 1000)); });

const pose = process.env.POSE ? `&pose=${process.env.POSE}` : "";
await page.goto(`${base}?seed=${process.env.SEED ?? 4242}&hunters=0&demo=0${pose}`);
await page.waitForFunction(() => window.__cs?.ready || window.__cs?.error, { timeout: 120000 });
const err = await page.evaluate(() => window.__cs.error);
if (err) {
  console.log("ERROR", err.slice(0, 2000));
  await b.close();
  process.exit(1);
}
// start playing: off to one side, clear of the "watch the demo" button in the middle
await page.mouse.click(120, 700);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(600);

const state = () => page.evaluate(() => ({
  open: !document.getElementById("map").hidden,
  across: window.__cs.stats.map,
  pending: window.__cs.stats.mapPending,
  // is anything actually drawn? count the distinct colours down the middle of the panel
  painted: (() => {
    const c = document.getElementById("mapview");
    const g = c.getContext("2d");
    const row = g.getImageData(0, Math.floor(c.height / 3), c.width, 1).data;
    const seen = new Set();
    for (let i = 0; i < row.length; i += 4) seen.add(`${row[i]},${row[i + 1]},${row[i + 2]}`);
    return seen.size;
  })(),
}));

await page.keyboard.press("KeyM");
await wait(400);
console.log("opened:", JSON.stringify(await state()));

for (const [step, name] of [[0, "1000m"], [1, "2000m"], [-1, "1000m-back"], [-1, "500m"]]) {
  if (step) await page.keyboard.press(step > 0 ? "Minus" : "Equal");
  // let the tiles come in; a fresh zoom level can want three dozen of them
  for (let i = 0; i < 60; i++) {
    await wait(500);
    if ((await state()).pending === 0) break;
  }
  const s = await state();
  console.log(`${name}: across ${s.across} m, pending ${s.pending}, colours ${s.painted}`);
  await page.screenshot({ path: path.join(out, `map-${name}.png`) });
}

// what the map costs to keep on screen while running: the plan under it is only redrawn
// when the runner reaches the margin it was drawn with, so most frames are one blit
const fps = async (label) => {
  await page.keyboard.down("KeyW");
  await page.keyboard.down("ShiftLeft");
  await wait(4000);
  const s = await page.evaluate(() => window.__cs.stats);
  await page.keyboard.up("ShiftLeft");
  await page.keyboard.up("KeyW");
  console.log(`${label}: ${s.fps.toFixed(0)} fps, cpu ${s.cpuMs.toFixed(1)} ms, worst ${s.worstMs.toFixed(1)} ms`);
};
await fps("sprinting, map open");
await page.keyboard.press("KeyM");
await wait(300);
console.log("closed:", (await state()).open === false);
await fps("sprinting, map shut");
await b.close();
