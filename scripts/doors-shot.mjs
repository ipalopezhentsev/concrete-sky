// Train doors in a real browser: stand on a subway platform and wait for a train to come in
// and open up, then get on and look at the doors from inside.
// usage: node scripts/doors-shot.mjs <outDir>   (INSIDE=1 to board at once, SEQ=1 for frames of the doors running)   (expects `vite preview --port 4173`)
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";

const out = process.argv[2] ?? "door-shots";
fs.mkdirSync(out, { recursive: true });
const browserPath = process.env.BROWSER ??
  ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"]
    .find((p) => fs.existsSync(p));
const b = await puppeteer.launch({
  executablePath: browserPath, headless: true, args: ["--force_high_performance_gpu"],
  defaultViewport: { width: 1280, height: 720 },
});
const page = await b.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const prompt = () => page.evaluate(() => document.getElementById("prompt").textContent);
await page.goto("http://localhost:4173/?hunters=0&quests=0&demo=0&hud=0&time=12:00&seed=1971");
await page.waitForFunction(() => window.__cs?.ready, { timeout: 90000 });
await page.mouse.click(640, 120);
await wait(1500);
let st = [];
for (let k = 0; k < 60 && !st.length; k++) {
  await wait(500);
  st = (await page.evaluate(() => window.__cs.berths())).stations;
}
const [x, y, z, yaw] = st[0];
await page.evaluate((x, y, z, yaw) => window.__cs.goto(x, y + 1.2, z, yaw + Math.PI / 2, -0.05), x, y, z, yaw);
await wait(2000);
// shut as it comes in, open while it stands
let n = 0;
if (process.env.SEQ) {
  // wait for the platform to be empty, then for the next train, in small steps so as to catch it as it stops
  for (let k = 0; k < 200 && (await prompt()).includes("board"); k++) await page.evaluate(() => window.__cs.skip(0.5));
  for (let k = 0; k < 400 && !(await prompt()).includes("board"); k++) await page.evaluate(() => window.__cs.skip(0.1));
}
for (let k = 0; k < 120 && n < 3; k++) {
  const p = await prompt();
  if (p.includes("board") && n === 0 && process.env.SEQ) {
    // the doors running open, a frame every quarter second, then running shut again
    // whichever track it came in on: a look along each
    for (let f = 0; f < 24; f++) {
      if (f === 12) await page.evaluate(() => window.__cs.skip(4.5));
      for (const [side, turn] of [["a", -Math.PI / 2 + 0.6], ["b", Math.PI / 2 - 0.6]]) {
        await page.evaluate((x, y, z, yaw) => window.__cs.goto(x, y + 1.2, z, yaw, -0.05), x, y, z, yaw + turn);
        await wait(60);
        await page.screenshot({ path: path.join(out, `seq-${String(f).padStart(2, "0")}${side}.png`) });
      }
      await wait(100);
    }
    break;
  }
  if (p.includes("board") && n === 0) {
    await wait(300);
    await page.screenshot({ path: path.join(out, "arrived.png") });
    if (process.env.INSIDE) await page.keyboard.press('KeyE');
    await page.evaluate(() => window.__cs.skip(1.5));
    await wait(400);
    if (!process.env.INSIDE) for (const [name, turn] of [['open-a', Math.PI / 2], ['open-b', -Math.PI / 2], ['open-c', -Math.PI / 2 + 0.6]]) {
      await page.evaluate((x, y, z, yaw) => window.__cs.goto(x, y + 1.2, z, yaw, -0.05), x, y, z, yaw + turn);
      await wait(400);
      await page.screenshot({ path: path.join(out, name + '.png') });
    }
    n = 1;
    if (!process.env.INSIDE) {
      await page.keyboard.press("KeyE");
      await wait(1200);
    }
    for (const [name, turn] of [["inside-a", Math.PI / 2 + 0.7], ["inside-b", Math.PI / 2 - 0.7], ["inside-c", -Math.PI / 2 + 0.7], ["inside-d", -Math.PI / 2 - 0.7]]) {
      await page.evaluate((yaw) => window.__cs.goto(0, 0, 0, yaw, -0.05), yaw + turn);
      await wait(500);
      await page.screenshot({ path: path.join(out, `${name}.png`) });
    }
    n = 3;
  }
  await page.evaluate(() => window.__cs.skip(1));
  await wait(150);
}
await b.close();
