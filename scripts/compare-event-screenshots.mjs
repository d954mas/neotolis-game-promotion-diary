// Side-by-side screenshots for event-detail + add-event surfaces.
//
// Usage: node scripts/compare-event-screenshots.mjs <session_cookie> <event_id>
// Outputs into .planning/phases/03.4-design-v2-ux/comparison/

import { chromium } from "playwright";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { extname } from "node:path";

const COOKIE = process.argv[2];
const EVENT_ID = process.argv[3];
if (!COOKIE || !EVENT_ID) {
  console.error("usage: node compare-event-screenshots.mjs <session_cookie_value> <event_id>");
  process.exit(1);
}

const OUT = ".planning/phases/03.4-design-v2-ux/comparison";
await mkdir(OUT, { recursive: true });

// Serve prototype over HTTP so React+Babel CDN scripts can hit relative paths.
const PROTO_DIR = resolve("docs/design/v2/ui-kit");
const MIME = {
  ".html": "text/html",
  ".jsx": "text/babel",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};
const protoServer = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    let path = url.pathname === "/" ? "/index.html" : url.pathname;
    let abs = resolve(PROTO_DIR, "." + path);
    if (path.startsWith("/../assets/")) abs = resolve(PROTO_DIR, "..", path.slice(4));
    if (path.startsWith("/../tokens.css")) abs = resolve(PROTO_DIR, "..", path.slice(4));
    const body = await readFile(abs);
    res.writeHead(200, { "content-type": MIME[extname(abs)] ?? "application/octet-stream" });
    res.end(body);
  } catch (err) {
    res.writeHead(404);
    res.end(String(err));
  }
});
await new Promise((r) => protoServer.listen(8765, r));
console.log("prototype served at http://localhost:8765");

const browser = await chromium.launch();

// ─── 1. Live /events/[id] route ────────────────────────────────────────────
const liveCtx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
});
await liveCtx.addCookies([
  {
    name: "neotolis.session_token",
    value: COOKIE,
    domain: "localhost",
    path: "/",
    httpOnly: true,
    secure: false,
    sameSite: "Lax",
  },
  {
    name: "__theme",
    value: "dark",
    domain: "localhost",
    path: "/",
    httpOnly: false,
    secure: false,
    sameSite: "Lax",
  },
]);

const live = await liveCtx.newPage();
await live.goto(`http://localhost:5173/events/${EVENT_ID}`, {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});
await live.waitForTimeout(3000);
await live.screenshot({ path: resolve(OUT, "event-detail-live-route.png"), fullPage: true });
console.log("✓ event-detail-live-route.png");

// ─── 2. Live /feed?event=… (modal) ─────────────────────────────────────────
await live.goto(`http://localhost:5173/feed?event=${EVENT_ID}`, {
  waitUntil: "load",
  timeout: 60000,
});
await live.waitForFunction(
  () => typeof window.__sveltekit_dev !== "undefined" && document.readyState === "complete",
  { timeout: 30000 },
);
await live.waitForTimeout(5000);
await live
  .waitForFunction(
    () => {
      const d = document.querySelector("dialog.event-detail-modal");
      return d && d.open;
    },
    { timeout: 10000 },
  )
  .catch(() => console.warn("⚠ Detail modal didn't auto-open"));
await live.waitForTimeout(1000);
await live.screenshot({ path: resolve(OUT, "event-detail-live-modal.png"), fullPage: false });
console.log("✓ event-detail-live-modal.png");

// ─── 3. Live /events/new (route) ────────────────────────────────────────────
await live.goto("http://localhost:5173/events/new", {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});
await live.waitForTimeout(3000);
await live.screenshot({ path: resolve(OUT, "add-event-live-route.png"), fullPage: true });
console.log("✓ add-event-live-route.png");

// ─── 4. Live /feed → click "+ Add event" → modal ───────────────────────────
await live.goto("http://localhost:5173/feed", { waitUntil: "load", timeout: 60000 });
await live.waitForFunction(
  () => typeof window.__sveltekit_dev !== "undefined" && document.readyState === "complete",
  { timeout: 30000 },
);
await live.waitForTimeout(5000);
const addBtn = await live
  .locator('button:has-text("Add event"), a:has-text("Add event"), [data-add-event]')
  .first();
const addBtnCount = await addBtn.count();
if (addBtnCount > 0) {
  await addBtn.click();
  await live
    .waitForFunction(
      () => {
        const d = document.querySelector("dialog.add-event-modal");
        return d && d.open;
      },
      { timeout: 10000 },
    )
    .catch(() => console.warn("⚠ Modal didn't open in 10s"));
  await live.waitForTimeout(1000);
  await live.screenshot({ path: resolve(OUT, "add-event-live-modal.png"), fullPage: false });
  console.log("✓ add-event-live-modal.png");
} else {
  console.log("⚠ Add event button not found on /feed — skipping modal capture");
}

// ─── 5. Prototype — event detail modal ─────────────────────────────────────
const protoCtx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
});
const protoPage = await protoCtx.newPage();
await protoPage.goto("http://localhost:8765/index.html", {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});
await protoPage.waitForSelector(".feed-grid, .card, .topbar", { timeout: 30000 });
await protoPage.waitForTimeout(1500);

// Open detail by clicking on a card body — prototype opens panel by default.
const firstCard = await protoPage.locator(".card").first();
const firstCardCount = await firstCard.count();
if (firstCardCount > 0) {
  await firstCard.click();
  await protoPage.waitForTimeout(800);
  await protoPage.screenshot({
    path: resolve(OUT, "event-detail-proto-panel.png"),
    fullPage: false,
  });
  console.log("✓ event-detail-proto-panel.png");

  // Try to switch to modal mode via Tweaks panel if available
  // (panel is the default in prototype). For modal mode, we navigate fresh.
  // The toggle is in Tweaks — for now we set window state manually.
  await protoPage.evaluate(() => {
    if (window.localStorage) {
      window.localStorage.setItem("neotolis_detail_mode", "modal");
    }
  });
}

// Reload + screenshot with detail-modal class via JS toggle hack (open detail then force modal).
// Simpler: directly screenshot the .detail-modal if rendered, else panel.

// ─── 6. Prototype — add-event modal ─────────────────────────────────────────
await protoPage.goto("http://localhost:8765/index.html", {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});
await protoPage.waitForSelector(".feed-grid, .card, .topbar", { timeout: 30000 });
await protoPage.waitForTimeout(800);

const protoAddBtn = await protoPage.locator(".btn.add-event").first();
const protoAddBtnCount = await protoAddBtn.count();
if (protoAddBtnCount > 0) {
  await protoAddBtn.click();
  await protoPage.waitForTimeout(800);
  await protoPage.screenshot({ path: resolve(OUT, "add-event-proto-modal.png"), fullPage: false });
  console.log("✓ add-event-proto-modal.png");
} else {
  console.log("⚠ Prototype add-event button not found");
}

await browser.close();
protoServer.close();
console.log("\nSaved to:", OUT);
