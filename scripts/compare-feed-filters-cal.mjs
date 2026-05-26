// Captures feed filter panel + calendar overlay in both live + prototype.
// Used by Phase 03.4 Plan 11 visual-parity gap-closure.
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";

const COOKIE = process.argv[2];
if (!COOKIE) {
  console.error("usage: node compare-feed-filters-cal.mjs <session_cookie_value>");
  process.exit(1);
}

const OUT = ".planning/phases/03.4-design-v2-ux/comparison";
await mkdir(OUT, { recursive: true });

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

// ── LIVE ────────────────────────────────────────────────────────────────
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 1100 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
});
await ctx.addCookies([
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
const live = await ctx.newPage();
await live.goto("http://localhost:5173/feed", { waitUntil: "networkidle", timeout: 60000 });
await live.waitForTimeout(600);

// Open the filters panel (look for the PageHead Filters toggle button).
const filtersToggle = live.locator('button:has-text("Filters"), button:has-text("Filter")').first();
if ((await filtersToggle.count()) > 0) {
  await filtersToggle.click();
  await live.waitForTimeout(400);
}
await live.screenshot({ path: resolve(OUT, "feed-live-filters-open.png"), fullPage: false });
console.log("✓ feed-live-filters-open.png");

// Now open the calendar overlay — click the date-chip.
const dateChip = live.locator(".date-chip").first();
if ((await dateChip.count()) > 0) {
  await dateChip.click();
  await live.waitForTimeout(500);
  await live.screenshot({ path: resolve(OUT, "feed-live-calendar.png"), fullPage: false });
  console.log("✓ feed-live-calendar.png");
} else {
  console.log("× date-chip not found on live page");
}

// ── PROTOTYPE ───────────────────────────────────────────────────────────
const proto = await browser.newContext({
  viewport: { width: 1440, height: 1100 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
});
const protoPage = await proto.newPage();
await protoPage.goto("http://localhost:8765/index.html", {
  waitUntil: "networkidle",
  timeout: 60000,
});
await protoPage.waitForSelector(".feed-grid, .card, .topbar", { timeout: 30000 });
await protoPage.waitForTimeout(1200);

// Click Filters toggle in prototype top-row.
const protoFiltersToggle = protoPage.locator('button:has-text("Filters")').first();
if ((await protoFiltersToggle.count()) > 0) {
  await protoFiltersToggle.click();
  await protoPage.waitForTimeout(400);
}
await protoPage.screenshot({ path: resolve(OUT, "feed-proto-filters-open.png"), fullPage: false });
console.log("✓ feed-proto-filters-open.png");

// Click the date-chip in prototype to open calendar.
const protoDateChip = protoPage.locator(".date-chip, .btn.date-chip").first();
if ((await protoDateChip.count()) > 0) {
  await protoDateChip.click();
  await protoPage.waitForTimeout(500);
  await protoPage.screenshot({ path: resolve(OUT, "feed-proto-calendar.png"), fullPage: false });
  console.log("✓ feed-proto-calendar.png");
} else {
  console.log("× date-chip not found on prototype");
}

await browser.close();
protoServer.close();
console.log("\nSaved to:", OUT);
