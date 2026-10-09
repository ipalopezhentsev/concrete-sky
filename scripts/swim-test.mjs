// The river in a real browser: walk down the water steps to a launch, board it, go over the
// side, swim, and climb out up a ladder in the quay wall.
// usage: node scripts/swim-test.mjs <outDir>   (expects `vite preview --port 4173`)
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";

const out = process.argv[2] ?? "swim-shots";
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
const runner = () => page.evaluate(() => window.__cs.runner());
const shot = (name) => page.screenshot({ path: path.join(out, name) });
const seed = process.env.SEED ?? "1971";

await page.goto(`http://localhost:4173/?hunters=0&quests=0&demo=0&hud=1&time=11:00&weather=clear%20sky&seed=${seed}`);
await page.waitForFunction(() => window.__cs?.ready, { timeout: 90000 });
await page.mouse.click(640, 120);
await wait(2000);

let boat = null;
for (let k = 0; k < 30 && !boat; k++) {
  boat = await page.evaluate(() => window.__cs.toBoat());
  if (!boat) await wait(500);
}
console.log("launch:", boat);
if (!boat) process.exit(1);
await wait(1500);
console.log("by the launch:", await runner());
await shot("1-steps.png");

await page.keyboard.press("KeyE");
await wait(800);
console.log("boarded:", await runner());
await shot("2-aboard.png");

// out into the channel, then stop and go over the side
await page.keyboard.down("KeyW");
await wait(5000);
await page.keyboard.up("KeyW");
await page.keyboard.down("KeyS");
await wait(2500);
await page.keyboard.up("KeyS");
await wait(2500);
console.log("afloat:", await runner());
await page.keyboard.press("KeyE");
await wait(1500);
console.log("over the side:", await runner());
await shot("3-swimming.png");
await page.keyboard.down("KeyW");
await wait(3000);
await page.keyboard.up("KeyW");
console.log("swum:", await runner());
await shot("4-swum.png");
// out by a ladder up the quay wall
const ladder = await page.evaluate(() => window.__cs.toLadder());
console.log("ladder:", ladder);
await wait(800);
await shot("5-ladder.png");
await page.keyboard.down("KeyW");
await wait(4500);
await page.keyboard.up("KeyW");
console.log("climbed out:", await runner());
await shot("6-out.png");
await b.close();
