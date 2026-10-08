// People taking vehicles, in a real browser: wind the clock on and see parked flyers, cars and
// launches go out and come back, then stand on a subway platform while trains come and go.
// usage: node scripts/berths-test.mjs <outDir>   (expects `vite preview --port 4173`)
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";

const out = process.argv[2] ?? "berth-shots";
fs.mkdirSync(out, { recursive: true });
const browserPath = process.env.BROWSER ??
  ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"]
    .find((p) => fs.existsSync(p));
const b = await puppeteer.launch({
  executablePath: browserPath, headless: true, args: ["--force_high_performance_gpu"],
  defaultViewport: { width: 1280, height: 720 },
});
const page = await b.newPage();
page.on("dialog", (d) => d.accept());
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
page.on("console", (m) => { if (m.type() === "error") console.log("[console]", m.text().slice(0, 500)); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const info = () => page.evaluate(() => window.__cs.berths());
const shot = (name) => page.screenshot({ path: path.join(out, name) });

await page.goto("http://localhost:4173/?hunters=0&quests=0&demo=0&hud=0&time=08:30");
await page.waitForFunction(() => window.__cs?.ready, { timeout: 90000 });
await page.mouse.click(640, 120);
await wait(1500);

// a platform: people waiting, getting on and getting off
let st = [];
for (let k = 0; k < 60 && !st.length; k++) {
  await wait(500);
  st = (await info()).stations;
}
console.log("stations streamed in:", st.length);
if (st.length) {
  const [x, y, z, yaw] = st[0];
  await page.evaluate((x, y, z, yaw) => window.__cs.goto(x, y + 1.2, z, yaw + Math.PI / 2, -0.05), x, y, z, yaw);
  await wait(2500);
  for (let k = 0; k < 4; k++) {
    const s = await info();
    console.log(`platform, +${k * 12}s: ${s.walkers} people drawn`);
    await shot(`platform-${k}.png`);
    await page.evaluate(() => window.__cs.skip(12));
    await wait(400);
  }
  // on the next train in, and a look along it, both ways, at whoever else is riding
  for (let k = 0; k < 60; k++) {
    const prompt = await page.evaluate(() => document.getElementById("prompt").textContent);
    if (prompt.includes("board")) break;
    await page.evaluate(() => window.__cs.skip(1));
    await wait(150);
  }
  await page.keyboard.press("KeyE");
  await wait(1500);
  for (let k = 0; k < 4; k++) {
    // the train sets where the runner stands; this only turns them
    await page.evaluate((yaw) => window.__cs.goto(0, 0, 0, yaw, -0.08), yaw + (k % 2 ? Math.PI : 0));
    await wait(400);
    const s = await info();
    console.log(`riding, +${k * 6}s: ${s.walkers} people drawn`);
    await shot(`train-${k}.png`);
    await page.evaluate(() => window.__cs.skip(6));
  }
  await page.keyboard.press("KeyE");
}

// a quarter of an hour, half a minute at a time, counting what is out
const seen = { flyer: 0, car: 0, van: 0, boat: 0 };
let caught = null;
for (let k = 0; k < 30; k++) {
  await page.evaluate(() => window.__cs.skip(30));
  await wait(250);
  const s = await info();
  for (const m of s.moving) seen[m.kind]++;
  if (!caught && s.moving.some((m) => m.kind === "car" || m.kind === "van")) caught = s.moving.find((m) => m.kind === "car" || m.kind === "van");
}
console.log("seen out over 15 min:", JSON.stringify(seen));
if (caught) {
  const [x, y, z] = caught.pos;
  // stand back from it and look at it
  await page.evaluate((x, y, z) => window.__cs.goto(x + 9, y + 5, z + 9, Math.atan2(-9, -9), -0.3), x, y, z);
  await wait(300);
  await shot("vehicle.png");
  console.log("looked at a", caught.kind, "at", caught.pos.map((v) => v.toFixed(1)).join(","));
}
await b.close();
