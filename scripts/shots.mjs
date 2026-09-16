// Renders preset views in a real browser and saves screenshots.
// usage: node scripts/shots.mjs <outDir> [weather,...] [view,...]
// Expects `npx vite preview --port 4173` (or dev server via BASE_URL) to be running.
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";

const out = process.argv[2] ?? "shots";
const weathers = (process.argv[3] ?? "clear sky").split(",");
const views = (process.argv[4] ?? "deck").split(",");
const base = process.env.BASE_URL ?? "http://localhost:4173/";
const browserPath = process.env.BROWSER ??
  ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"]
    .find((p) => fs.existsSync(p));

// x, y (feet), z, yaw, pitch
const POSES = {
  deck: [18.5, 18, 26, 0.35, 0.12],
  up: [18.5, 18, 26, -0.6, 0.55],
  street: [-4, 0.2, 30, 0.2, 0.18],
  bridge: [60, 40, 10, 2.4, -0.25],
  high: [150, 120, 150, 3.9, -0.3],
  pad: [18.5, 18, 26, 2.26, -0.25],
  avenue: [-7, 12, 60, 0.05, -0.12],
  fly: [-3, 60, -60, 0.1, -0.18],
  padclose: [24, 18, 24, 2.0, -0.35],
};

fs.mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: browserPath,
  headless: true,
  args: ["--force_high_performance_gpu", "--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=d3d11"],
  defaultViewport: { width: Number(process.env.W ?? 1280), height: Number(process.env.H ?? 720) },
});
const page = await browser.newPage();
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log("[page]", m.text().slice(0, 2000)); });
page.on("pageerror", (e) => console.log("[pageerror]", e.message.slice(0, 2000)));
for (const w of weathers) {
  for (const v of views) {
    const url = `${base}?shot=1&hud=0&weather=${encodeURIComponent(w)}&pose=${POSES[v].join(",")}${process.env.EXTRA ?? ""}`;
    await page.goto(url);
    await page.waitForFunction(() => window.__cs && (window.__cs.error || (window.__cs.ready && window.__cs.frames > (Number(new URLSearchParams(location.search).get("frames")) || 40))), { timeout: 120000 });
    const info = await page.evaluate(() => ({ error: window.__cs.error, renderer: window.__cs.renderer, stats: window.__cs.stats }));
    if (info.error) { console.log("ERROR", info.error.slice(0, 3000)); break; }
    const file = path.join(out, `${w.replace(/ /g, "_")}-${v}.png`);
    await page.screenshot({ path: file });
    console.log(file, info.renderer, JSON.stringify(info.stats));
  }
}
await browser.close();
