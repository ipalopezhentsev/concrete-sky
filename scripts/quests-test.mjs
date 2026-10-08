// Jobs in a real browser: someone offers one, the runner takes it on and is stood at each
// step in turn until it is done. Several cities, so several kinds of job come up.
// usage: node scripts/quests-test.mjs <outDir> [cities]   (expects `vite preview --port 4173`)
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";

const out = process.argv[2] ?? "quest-shots";
const cities = Number(process.argv[3] ?? 4);
fs.mkdirSync(out, { recursive: true });
const browserPath = process.env.BROWSER ??
  ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"]
    .find((p) => fs.existsSync(p));
const b = await puppeteer.launch({
  executablePath: browserPath, headless: true, args: ["--force_high_performance_gpu"],
  defaultViewport: { width: 1280, height: 720 },
});
const page = await b.newPage();
// leaving a run asks first; the test always means it
page.on("dialog", (d) => d.accept());
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
page.on("console", (m) => { if (m.type() === "error") console.log("[console]", m.text().slice(0, 500)); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const job = () => page.evaluate(() => window.__cs.job());
const hud = () => page.evaluate(() => ({
  job: document.getElementById("job").textContent,
  say: document.getElementById("say").textContent,
  prompt: document.getElementById("prompt").textContent,
  caption: document.getElementById("caption").textContent,
  pins: document.querySelectorAll("#goals b:not([hidden])").length,
}));

let done = 0;
for (let c = 0; c < cities; c++) {
  const seed = 1000 + c * 7919;
  await page.goto(`http://localhost:4173/?seed=${seed}&hunters=0&demo=0&time=13:00`);
  await page.waitForFunction(() => window.__cs?.ready, { timeout: 90000 });
  await page.mouse.click(640, 120);
  // someone with a job turns up after a few seconds
  let j;
  for (let t = 0; t < 60; t++) {
    await wait(1000);
    j = await job();
    if (j.offer) break;
  }
  if (!j.offer) {
    console.log(`city ${seed}: no offer`);
    continue;
  }
  console.log(`city ${seed}: ${j.offer.giver} offers [${j.offer.steps.join(", ")}] at ${j.offer.at.where}`);
  await page.screenshot({ path: path.join(out, `${seed}-offer-far.png`) });
  await page.evaluate(() => window.__cs.toJob());
  await wait(600);
  console.log("  prompt:", (await hud()).prompt);
  await page.keyboard.press("KeyE");
  await wait(400);
  let h = await hud();
  console.log("  said:", h.say);
  console.log("  job:", h.job);
  await page.screenshot({ path: path.join(out, `${seed}-taken.png`) });
  for (let step = 0; step < 8; step++) {
    if (!(await page.evaluate(() => window.__cs.toJob()))) break;
    await wait(900);
    j = await job();
    h = await hud();
    console.log(`  step ${step}: carrying=${j.carrying} done=${j.done} failed=${j.failed} | ${h.job || "(no job)"} | ${h.say}`);
    if (step === 0) await page.screenshot({ path: path.join(out, `${seed}-step.png`) });
    if (!j.job) break;
  }
  j = await job();
  console.log(`  result: done=${j.done} failed=${j.failed} caption="${(await hud()).caption}"`);
  done += j.done;
}
console.log(`jobs done: ${done}`);
await b.close();
