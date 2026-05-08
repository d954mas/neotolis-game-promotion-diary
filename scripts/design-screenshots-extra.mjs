// Дополнительные скриншоты: mobile (360×800) и dark theme — для дизайнера.
// Run: node scripts/design-screenshots-extra.mjs <session_cookie_value>

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { Client } from "pg";

const COOKIE_VALUE = process.argv[2];
if (!COOKIE_VALUE) {
  console.error("usage: node design-screenshots-extra.mjs <session_cookie_value>");
  process.exit(1);
}

const BASE = "http://localhost:5173";
const OUT_DIR = ".planning/design-review/screenshots";
await mkdir(OUT_DIR, { recursive: true });

const pg = new Client({ connectionString: "postgres://postgres:postgres@localhost:5432/neotolis" });
await pg.connect();
const game = (
  await pg.query("SELECT id FROM games WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1")
).rows[0];
await pg.end();

const mobileTargets = [
  { name: "30-mobile-feed", url: "/feed" },
  { name: "31-mobile-sources", url: "/sources" },
  { name: "32-mobile-games", url: "/games" },
  { name: "33-mobile-game-detail", url: `/games/${game.id}` },
  { name: "34-mobile-event-new", url: "/events/new" },
  { name: "35-mobile-settings", url: "/settings" },
];

const darkTargets = [
  { name: "40-dark-feed", url: "/feed" },
  { name: "41-dark-sources", url: "/sources" },
  { name: "42-dark-games", url: "/games" },
  { name: "43-dark-event-new", url: "/events/new" },
  { name: "44-dark-settings", url: "/settings" },
];

const browser = await chromium.launch();

async function shoot(target, ctx, opts = {}) {
  const page = await ctx.newPage();
  console.log(`→ ${target.name}: ${target.url}`);
  if (opts.dark) {
    await page.emulateMedia({ colorScheme: "dark" });
  }
  try {
    await page.goto(`${BASE}${target.url}`, { waitUntil: "networkidle", timeout: 30000 });
  } catch (err) {
    console.warn(`   slow / partial load (${err.message}); proceeding`);
  }
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT_DIR}/${target.name}.png`, fullPage: true });
  await page.close();
}

const cookie = {
  name: "neotolis.session_token",
  value: COOKIE_VALUE,
  domain: "localhost",
  path: "/",
  httpOnly: true,
  secure: false,
  sameSite: "Lax",
};

// Mobile (light)
const mobileCtx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
await mobileCtx.addCookies([cookie]);
for (const t of mobileTargets) {
  await shoot(t, mobileCtx);
}
await mobileCtx.close();

// Desktop (dark)
const darkCtx = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  colorScheme: "dark",
});
await darkCtx.addCookies([cookie]);
for (const t of darkTargets) {
  await shoot(t, darkCtx, { dark: true });
}
await darkCtx.close();

await browser.close();
console.log("done");
