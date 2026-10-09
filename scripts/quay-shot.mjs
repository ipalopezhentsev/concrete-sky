// A look down from the quay at the water steps and the launch tied up at their foot.
// usage: node scripts/quay-shot.mjs <outDir> [weather]   (expects `vite preview --port 4173`)
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";

const out = process.argv[2] ?? "quay-shots";
const weather = process.argv[3] ?? "clear sky";
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
await page.goto(`http://localhost:4173/?hunters=0&quests=0&demo=0&hud=0&time=11:00&weather=${encodeURIComponent(weather)}&seed=${process.env.SEED ?? 1971}`);
await page.waitForFunction(() => window.__cs?.ready, { timeout: 90000 });
await page.mouse.click(640, 120);
await wait(2000);
let boat = null;
for (let k = 0; k < 30 && !boat; k++) {
  boat = await page.evaluate(() => window.__cs.toBoat());
  if (!boat) await wait(500);
}
const at = (await page.evaluate(() => window.__cs.runner())).pos;
// back from the boat over the steps, up on the quay, looking down at it
const dx = at[0] - boat[0], dz = at[2] - boat[2], l = Math.hypot(dx, dz);
const [ux, uz] = [dx / l, dz / l];
const views = { quay: [14, 9, 0.5, -0.45], side: [10, 7, 5, -0.35] };
for (const [name, [back, up, along, pitch]] of Object.entries(views)) {
  const x = boat[0] + ux * back - uz * along, z = boat[2] + uz * back + ux * along;
  const yaw = Math.atan2(boat[0] - x, boat[2] - z);
  await page.evaluate((x, y, z, yaw, p) => { window.__cs.goto(x, y, z, yaw, p); }, x, boat[1] + up, z, yaw, pitch);
  await wait(1500);
  await page.screenshot({ path: path.join(out, `${weather.replace(/ /g, "_")}-${name}.png`) });
}
await b.close();
