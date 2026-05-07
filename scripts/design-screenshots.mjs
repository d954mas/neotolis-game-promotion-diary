// Capture screenshots of every page for the designer hand-off — DARK THEME
// (per operator preference: dark-first product). Two light-theme samples
// (feed + sources) are taken at the end for comparison.
//
// Requires: pnpm dev + pnpm dev:mock-oauth + pnpm tsx scripts/seed-design-data.ts
// already run.
//
// Run: node scripts/design-screenshots.mjs <session_cookie_value>
// where <session_cookie_value> is the value printed by seed-design-data.ts
// (the part after `neotolis.session_token=`).

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { Client } from "pg";

const COOKIE_VALUE = process.argv[2];
if (!COOKIE_VALUE) {
  console.error("usage: node design-screenshots.mjs <session_cookie_value>");
  process.exit(1);
}

const BASE = "http://localhost:5173";
const OUT_DIR = ".planning/design-review/screenshots";
await mkdir(OUT_DIR, { recursive: true });

// Look up real game / event ids so the [id] routes are not 404.
const pg = new Client({ connectionString: "postgres://postgres:postgres@localhost:5432/neotolis" });
await pg.connect();
const game = (await pg.query("SELECT id FROM games WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1")).rows[0];
const event = (await pg.query("SELECT id FROM events WHERE deleted_at IS NULL ORDER BY occurred_at DESC LIMIT 1")).rows[0];
await pg.end();

const desktopTargets = [
  // Public / anonymous
  { name: "00-landing-anonymous", url: "/", auth: false },
  { name: "01-login", url: "/login", auth: false },
  { name: "02-privacy", url: "/privacy", auth: false },
  { name: "03-terms", url: "/terms", auth: false },
  { name: "04-about", url: "/about", auth: false },

  // Core authenticated views
  { name: "10-feed", url: "/feed", auth: true },
  { name: "11-sources", url: "/sources", auth: true },
  { name: "12-sources-new", url: "/sources/new", auth: true },
  { name: "13-games", url: "/games", auth: true },
  { name: "14-game-detail", url: `/games/${game.id}`, auth: true },
  { name: "15-event-new", url: "/events/new", auth: true },
  { name: "16-event-detail", url: `/events/${event.id}`, auth: true },
  { name: "17-event-edit", url: `/events/${event.id}/edit`, auth: true },

  // Settings & meta
  { name: "20-audit", url: "/audit", auth: true },
  { name: "21-settings", url: "/settings", auth: true },
  { name: "22-settings-account", url: "/settings/account", auth: true },
  { name: "23-keys-steam", url: "/keys/steam", auth: true },
  { name: "24-admin", url: "/admin", auth: true },
];

const mobileTargets = [
  { name: "30-mobile-feed", url: "/feed", auth: true },
  { name: "31-mobile-sources", url: "/sources", auth: true },
  { name: "32-mobile-games", url: "/games", auth: true },
  { name: "33-mobile-game-detail", url: `/games/${game.id}`, auth: true },
  { name: "34-mobile-event-new", url: "/events/new", auth: true },
  { name: "35-mobile-settings", url: "/settings", auth: true },
];

// A small light-theme sample so the designer can compare.
const lightSamples = [
  { name: "90-light-feed", url: "/feed", auth: true },
  { name: "91-light-sources", url: "/sources", auth: true },
];

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

async function shoot(target, ctx) {
  const page = await ctx.newPage();
  console.log(`→ ${target.name}: ${target.url}`);
  try {
    await page.goto(`${BASE}${target.url}`, { waitUntil: "networkidle", timeout: 30000 });
  } catch (err) {
    console.warn(`   slow / partial load (${err.message}); proceeding`);
  }
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT_DIR}/${target.name}.png`, fullPage: true });
  await page.close();
}

// Desktop dark — anonymous
const anonDarkCtx = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  colorScheme: "dark",
});
for (const t of desktopTargets.filter((t) => !t.auth)) {
  await shoot(t, anonDarkCtx);
}
await anonDarkCtx.close();

// Desktop dark — authenticated
const authDarkCtx = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  colorScheme: "dark",
});
await authDarkCtx.addCookies([cookie]);
for (const t of desktopTargets.filter((t) => t.auth)) {
  await shoot(t, authDarkCtx);
}
await authDarkCtx.close();

// Mobile dark — authenticated
const mobileDarkCtx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  colorScheme: "dark",
});
await mobileDarkCtx.addCookies([cookie]);
for (const t of mobileTargets) {
  await shoot(t, mobileDarkCtx);
}
await mobileDarkCtx.close();

// Light samples — for comparison only
const lightCtx = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  colorScheme: "light",
});
await lightCtx.addCookies([cookie]);
for (const t of lightSamples) {
  await shoot(t, lightCtx);
}
await lightCtx.close();

await browser.close();
console.log("done — screenshots in", OUT_DIR);
