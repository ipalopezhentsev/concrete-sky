// Uncapped frame-rate benchmark at fixed views.
// usage: node scripts/bench.mjs [--discrete] [--vsync] [--dpr=2] [--size=1920x1080] [query-suffix]
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}`));
const [w, h] = (flag("size")?.split("=")[1] ?? "1920x1080").split("x").map(Number);
const dpr = Number(flag("dpr")?.split("=")[1] ?? 1);
const extra = args.find((a) => !a.startsWith("--")) ?? "";
const browserPath = process.env.BROWSER ??
  ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"]
    .find((p) => fs.existsSync(p));
const launchArgs = flag("vsync") ? [] : ["--disable-gpu-vsync", "--disable-frame-rate-limit"];
if (flag("discrete")) launchArgs.push("--force_high_performance_gpu");

const POSES = {
  deck: "18.5,18,26,0.35,0.12",
  street: "-4,0.2,30,0.2,0.18",
  high: "150,120,150,3.9,-0.3",
  canyon: "44,24,-10,0,0.05",
};

// BENCH_POSES="name=x,y,z,yaw,pitch;..." replaces the views (the network city needs its own)
if (process.env.BENCH_POSES) {
  for (const k of Object.keys(POSES)) delete POSES[k];
  for (const e of process.env.BENCH_POSES.split(";")) {
    const [n, p] = e.split("=");
    POSES[n] = p;
  }
}

const browser = await puppeteer.launch({
  executablePath: browserPath, headless: true, args: launchArgs,
  defaultViewport: { width: w, height: h, deviceScaleFactor: dpr },
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
for (const [name, pose] of Object.entries(POSES)) {
  await page.goto(`http://localhost:4173/?shot=1&hud=0&weather=drifting%20cumulus&pose=${pose}&scale=1${extra}`);
  await page.waitForFunction(() => window.__cs?.ready || window.__cs?.error, { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 5000));
  const s = await page.evaluate(() => window.__cs.stats);
  const r = await page.evaluate(() => window.__cs.renderer);
  console.log(`${name.padEnd(7)} ${s.fps.toFixed(0).padStart(4)} fps  ${s.size}  ${s.gpu}  sh=${s.shadowRenders} worst=${s.worstMs.toFixed(1)}ms  | ${r.replace(/^ANGLE \([^,]+, (.+?) \(0x.*$/, "$1")}`);
}
await browser.close();
