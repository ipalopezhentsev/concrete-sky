// End-to-end vehicle check in a real browser: get into a parked car and drive,
// then fly and shoot. usage: node scripts/vehicles-test.mjs <outDir>
// (expects `vite preview --port 4173`)
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";

const out = process.argv[2] ?? "vehicle-shots";
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
page.on("console", (m) => { if (m.type() === "error") console.log("[console]", m.text().slice(0, 500)); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const state = () => page.evaluate(() => ({ ...window.__cs.stats, prompt: document.getElementById("prompt").textContent }));
const hold = async (keys, ms) => {
  for (const k of keys) await page.keyboard.down(k);
  await wait(ms);
  for (const k of keys) await page.keyboard.up(k);
};
const fmt = (v) => v.map((x) => x.toFixed(1)).join(",");

// --- driving
await page.goto("http://localhost:4173/?hud=0&pose=30,0.2,3,0,0");
await page.waitForFunction(() => window.__cs?.ready, { timeout: 60000 });
await page.mouse.click(640, 360);
await wait(600);
console.log("teleported to car:", await page.evaluate(() => window.__cs.toCar()));
await wait(700);
let s = await state();
console.log("prompt:", JSON.stringify(s.prompt), "pos", fmt(s.pos));
await page.keyboard.press("KeyE");
await wait(600);
s = await state();
console.log("riding:", s.riding);
await hold(["KeyW"], 2500);
s = await state();
console.log("driving: speed", s.carSpeed?.toFixed(1), "pos", fmt(s.pos));
await page.screenshot({ path: path.join(out, "drive.png") });
await hold(["KeyS"], 2500);
await wait(1500);
await page.keyboard.press("KeyE");
await wait(600);
s = await state();
console.log("after exit riding:", JSON.stringify(s.riding), "pos", fmt(s.pos));

// --- flying and shooting over the avenue
await page.goto("http://localhost:4173/?hud=0&vehicle=1&weather=drifting%20cumulus&pose=-3,66,-40,0,-0.08");
await page.waitForFunction(() => window.__cs?.ready, { timeout: 60000 });
await page.mouse.click(640, 360);
await wait(800);
await page.mouse.down();
for (let i = 0; i < 16; i++) {
  await hold(["KeyW"], 250);
  await page.mouse.move(640 + (i % 2 ? 30 : -30), 360);
}
await page.mouse.up();
await wait(400);
s = await state();
console.log("flying: kills", s.kills, "particles", s.particles, "pos", fmt(s.pos), "fps", s.fps.toFixed(0));
await page.screenshot({ path: path.join(out, "shoot.png") });
await wait(1200);
await page.screenshot({ path: path.join(out, "shoot2.png") });
// --- strafing the avenue
await page.goto("http://localhost:4173/?hud=0&vehicle=1&weather=golden%20hour&pose=-2,24,-10,0,-0.3");
await page.waitForFunction(() => window.__cs?.ready, { timeout: 60000 });
await page.mouse.click(640, 360);
await wait(800);
await page.mouse.down();
await wait(4000);
await page.mouse.up();
await wait(300);
s = await state();
console.log("strafing: cars wrecked", s.carKills, "flyers", s.kills, "seed", s.seed);
await page.screenshot({ path: path.join(out, "strafe.png") });
await wait(2000);
await page.screenshot({ path: path.join(out, "strafe2.png") });
await b.close();
