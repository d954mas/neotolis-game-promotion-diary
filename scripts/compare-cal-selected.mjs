// One-shot screenshot of the DateRangePicker with a partial selection,
// to validate UAT cat C4a (range display) and C4b (selected day cells).
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const COOKIE = process.argv[2];
if (!COOKIE) {
  console.error("usage: node compare-cal-selected.mjs <session_cookie_value>");
  process.exit(1);
}

const OUT = ".planning/phases/03.4-design-v2-ux/comparison";
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();
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
const page = await ctx.newPage();
await page.goto("http://localhost:5173/feed", { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(800);

// Open picker
const dateChip = page.locator(".date-chip").first();
await dateChip.click();
await page.waitForTimeout(400);

// Click on day "5" (first available)
const day5 = page.locator('.cal-day:not(.empty):not([data-future="1"]):has-text("5")').first();
await day5.click();
await page.waitForTimeout(200);

// Hover over day "15"
const day15 = page.locator('.cal-day:not(.empty):not([data-future="1"]):has-text("15")').first();
await day15.hover();
await page.waitForTimeout(200);

await page.screenshot({ path: resolve(OUT, "feed-live-cal-mid-pick.png"), fullPage: false });
console.log("✓ feed-live-cal-mid-pick.png (partial selection)");

// Now click day 15 to complete range
await day15.click();
await page.waitForTimeout(400);

// Reopen since auto-applied + closed
await dateChip.click();
await page.waitForTimeout(400);
await page.screenshot({ path: resolve(OUT, "feed-live-cal-completed.png"), fullPage: false });
console.log("✓ feed-live-cal-completed.png (completed range)");

await browser.close();
console.log("\nSaved to:", OUT);
