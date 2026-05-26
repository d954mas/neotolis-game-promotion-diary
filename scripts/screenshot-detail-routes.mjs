// Screenshot /events/[id], /sources/[id] for the audit pass.
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const COOKIE_VALUE = process.argv[2];
const EVENT_ID = process.argv[3];
const SOURCE_ID = process.argv[4];
if (!COOKIE_VALUE || !EVENT_ID || !SOURCE_ID) {
  console.error("usage: node scripts/screenshot-detail-routes.mjs <cookie> <eventId> <sourceId>");
  process.exit(1);
}

const BASE = "http://localhost:5173";
const OUT_DIR = ".planning/phases/03.4-design-v2-ux/comparison";
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
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 1400 },
  colorScheme: "dark",
});
await ctx.addCookies([cookie]);

for (const [slug, url] of [
  ["events-detail", `/events/${EVENT_ID}`],
  ["sources-detail", `/sources/${SOURCE_ID}`],
]) {
  const page = await ctx.newPage();
  try {
    await page.goto(`${BASE}${url}`, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT_DIR}/${slug}-live.png`, fullPage: true });
    console.log(`captured ${slug}`);
  } catch (e) {
    console.warn(`failed ${slug}: ${e.message}`);
  } finally {
    await page.close();
  }
}

await ctx.close();
await browser.close();
console.log("done");
