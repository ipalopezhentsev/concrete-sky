// Hunters in a real browser: they arrive and shoot, can be shot back, and catch
// the player in the end. usage: node scripts/hunters-test.mjs <outDir>
// (expects `vite preview --port 4173`)
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";

const out = process.argv[2] ?? "hunter-shots";
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
const state = () => page.evaluate(() => ({
  ...window.__cs.stats,
  markers: [...document.querySelectorAll("#markers b:not([hidden])")].length,
  score: document.getElementById("score").textContent,
}));
const show = (s) => `hunters=[${s.hunters}] health=${s.health?.toFixed(0)} down=${s.hunterKills} caught=${s.caught} ` +
  `markers=${s.markers} fps=${s.fps?.toFixed(0)} worst=${s.worstMs?.toFixed(1)}ms score="${s.score}"`;
const start = async (url) => {
  await page.goto(url);
  await page.waitForFunction(() => window.__cs?.ready, { timeout: 60000 });
  await page.mouse.click(640, 360);
  await wait(800);
};

// --- close up: one of each, then shoot the runner
await start("http://localhost:4173/?weather=golden%20hour&pose=18.5,18,26,0,0");
await page.evaluate(() => {
  window.__cs.hunter("foot", 9);
  window.__cs.hunter("flyer", 30);
});
await wait(1200);
await page.screenshot({ path: path.join(out, "closeup.png") });
let s = await state();
console.log("close up:", show(s));
await page.mouse.down();
await wait(1500);
await page.mouse.up();
await wait(500);
s = await state();
console.log("after shooting:", show(s));
await page.screenshot({ path: path.join(out, "shot.png") });

// --- left alone: they come by themselves, and in the end they get you
await start("http://localhost:4173/?weather=overcast&pose=18.5,18,26,1.2,0");
for (let t = 0; t < 12; t++) {
  await wait(5000);
  s = await state();
  console.log(`${(t + 1) * 5}s:`, show(s));
  if (t === 4) await page.screenshot({ path: path.join(out, "hunted.png") });
  if (s.caught > 0) break;
}
await page.screenshot({ path: path.join(out, "caught.png") });
await b.close();
