// Side-by-side screenshot helper for /sources page parity work.
// Captures live /sources and the prototype index.html#sources view.
//
// Run: node scripts/compare-sources.mjs <session_cookie_value>

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const COOKIE_VALUE = process.argv[2];
if (!COOKIE_VALUE) {
  console.error("usage: node scripts/compare-sources.mjs <session_cookie_value>");
  process.exit(1);
}

const BASE = "http://localhost:5173";
const OUT_DIR = ".planning/design-review/sources-compare";
await mkdir(OUT_DIR, { recursive: true });

const cookie = {
  name: "neotolis.session_token",
  value: COOKIE_VALUE,
  domain: "localhost",
  path: "/",
  httpOnly: true,
  secure: false,
  sameSite: "Lax",
};

const browser = await chromium.launch();

// 1) Live /sources — dark + light, desktop.
const liveCtx = await browser.newContext({
  viewport: { width: 1280, height: 1400 },
  colorScheme: "dark",
});
await liveCtx.addCookies([cookie]);
{
  const page = await liveCtx.newPage();
  await page.goto(`${BASE}/sources`, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT_DIR}/live-dark.png`, fullPage: true });
  await page.close();
}
await liveCtx.close();

// 2) Prototype index.html via local http server (file:// blocks XHR for
//    Babel <script type="text/babel" src=...>). We expect the operator to
//    run `python -m http.server 5174 -d docs/design/v2/ui-kit` in a
//    sibling shell. Skip silently if the port is closed.
const protoCtx = await browser.newContext({
  viewport: { width: 1280, height: 1400 },
  colorScheme: "dark",
});
try {
  const page = await protoCtx.newPage();
  page.on("pageerror", (err) => console.warn("proto pageerror:", err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") console.warn("proto console err:", msg.text());
  });
  await page.goto("http://localhost:5174/index.html", { waitUntil: "load", timeout: 8000 });
  await page.waitForSelector(".nav-tabs a", { timeout: 30000 });
  await page.waitForTimeout(1000);
  await page.click('.nav-tabs a[href="#/sources"]');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT_DIR}/proto-dark.png`, fullPage: true });
  await page.close();
} catch (err) {
  console.warn("prototype capture skipped:", err.message);
}
await protoCtx.close();

await browser.close();
console.log("done — screenshots in", OUT_DIR);
