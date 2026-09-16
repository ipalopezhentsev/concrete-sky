// Loads the site as a visitor would and screenshots the title screen.
// usage: node scripts/landing.mjs <out.png>
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const browserPath = process.env.BROWSER ??
  ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"]
    .find((p) => fs.existsSync(p));
const b = await puppeteer.launch({ executablePath: browserPath, headless: true, defaultViewport: { width: 1280, height: 720 } });
const p = await b.newPage();
p.on("pageerror", (e) => console.log("[pageerror]", e.message));
const t0 = Date.now();
await p.goto(process.env.BASE_URL ?? "http://localhost:4173/");
await p.waitForFunction(() => window.__cs?.ready || window.__cs?.error, { timeout: 60000 });
console.log("ready after", Date.now() - t0, "ms", await p.evaluate(() => window.__cs.renderer));
await new Promise((r) => setTimeout(r, Number(process.env.WAIT ?? 2500)));
console.log(JSON.stringify(await p.evaluate(() => window.__cs.stats)));
await p.screenshot({ path: process.argv[2] ?? "landing.png" });
await b.close();
