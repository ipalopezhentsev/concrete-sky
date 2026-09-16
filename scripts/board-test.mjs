// End-to-end input check in a real browser: board the flyer next to the spawn,
// take off, land again and step out.
// usage: node scripts/board-test.mjs   (expects `vite preview --port 4173`)
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const browserPath = process.env.BROWSER ??
  ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"]
    .find((p) => fs.existsSync(p));
const b = await puppeteer.launch({ executablePath: browserPath, headless: true, defaultViewport: { width: 1280, height: 720 } });
const page = await b.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
// stand next to the spawn pad (pad centre is at x 28, z 18.1)
await page.goto("http://localhost:4173/?hud=0&pose=24.5,18,18.1,1.57,0");
await page.waitForFunction(() => window.__cs?.ready, { timeout: 60000 });
await page.mouse.click(640, 360);
await new Promise((r) => setTimeout(r, 800));
const state = () => page.evaluate(() => ({ ...window.__cs.stats, prompt: document.getElementById("prompt").textContent }));
const hold = async (keys, ms) => {
  for (const k of keys) await page.keyboard.down(k);
  await new Promise((r) => setTimeout(r, ms));
  for (const k of keys) await page.keyboard.up(k);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await wait(700);
let s = await state();
console.log("before:", s.prompt, "flying", s.flying, "pos", s.pos.map((v) => v.toFixed(1)).join(","));
await page.keyboard.press("KeyE");
await wait(700);
s = await state();
console.log("boarded:", s.flying);
await hold(["Space"], 2500);
await hold(["KeyW"], 1500);
await wait(700);
s = await state();
console.log("airborne:", s.pos.map((v) => v.toFixed(1)).join(","), "grounded", s.flyerGrounded);
await hold(["KeyS"], 1500);
await hold(["ControlLeft"], 6000);
await wait(1500);
s = await state();
console.log("landed:", s.pos.map((v) => v.toFixed(1)).join(","), "grounded", s.flyerGrounded, "prompt", s.prompt);
await page.keyboard.press("KeyE");
await wait(700);
s = await state();
console.log("stepped out:", !s.flying, "pos", s.pos.map((v) => v.toFixed(1)).join(","));
await page.screenshot({ path: process.argv[2] ?? "board-test.png" });
await b.close();
