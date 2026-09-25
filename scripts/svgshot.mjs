import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";
const exe = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find((f) => fs.existsSync(f));
const browser = await puppeteer.launch({ executablePath: exe, headless: true, defaultViewport: { width: 1600, height: 1600 } });
const page = await browser.newPage();
await page.goto("file://" + path.resolve(process.argv[2]).split(path.sep).join("/"));
await page.screenshot({ path: path.resolve(process.argv[3]) });
await browser.close();
