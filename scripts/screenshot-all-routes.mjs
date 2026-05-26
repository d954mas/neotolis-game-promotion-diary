// Screenshot every route in scope for the route audit pass.
// Saves into .planning/phases/03.4-design-v2-ux/comparison/{slug}-live.png.
//
// Run: node scripts/screenshot-all-routes.mjs <session_cookie_value>

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const COOKIE_VALUE = process.argv[2];
if (!COOKIE_VALUE) {
  console.error("usage: node scripts/screenshot-all-routes.mjs <session_cookie_value>");
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

const ROUTES = [
  { slug: "feed", url: "/feed" },
  { slug: "feed-trash", url: "/feed?view=trash" },
  { slug: "sources", url: "/sources" },
  { slug: "sources-new", url: "/sources/new" },
  { slug: "games", url: "/games" },
  { slug: "settings", url: "/settings" },
  { slug: "audit", url: "/audit" },
  { slug: "login", url: "/login", noAuth: true },
  { slug: "about", url: "/about", noAuth: true },
  { slug: "privacy", url: "/privacy", noAuth: true },
  { slug: "terms", url: "/terms", noAuth: true },
];

const browser = await chromium.launch();
const ctxAuth = await browser.newContext({
  viewport: { width: 1280, height: 1400 },
  colorScheme: "dark",
});
await ctxAuth.addCookies([cookie]);
const ctxAnon = await browser.newContext({
  viewport: { width: 1280, height: 1400 },
  colorScheme: "dark",
});

for (const { slug, url, noAuth } of ROUTES) {
  const ctx = noAuth ? ctxAnon : ctxAuth;
  const page = await ctx.newPage();
  try {
    await page.goto(`${BASE}${url}`, { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${OUT_DIR}/${slug}-live.png`, fullPage: true });
    console.log(`captured ${slug}`);
  } catch (e) {
    console.warn(`failed ${slug}: ${e.message}`);
  } finally {
    await page.close();
  }
}

// Try to discover at least one game id + source id for the detail pages.
{
  const page = await ctxAuth.newPage();
  try {
    await page.goto(`${BASE}/games`, { waitUntil: "networkidle", timeout: 30000 });
    const gameHref = await page
      .locator('a[href^="/games/"]')
      .first()
      .getAttribute("href")
      .catch(() => null);
    if (gameHref) {
      await page.goto(`${BASE}${gameHref}`, { waitUntil: "networkidle", timeout: 30000 });
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${OUT_DIR}/games-detail-live.png`, fullPage: true });
      console.log(`captured games-detail (${gameHref})`);
    } else {
      console.warn("no game rows present — skipped games-detail");
    }
  } catch (e) {
    console.warn(`failed games-detail: ${e.message}`);
  } finally {
    await page.close();
  }
}

{
  const page = await ctxAuth.newPage();
  try {
    await page.goto(`${BASE}/sources`, { waitUntil: "networkidle", timeout: 30000 });
    const srcHref = await page
      .locator('a[href^="/sources/"]')
      .first()
      .getAttribute("href")
      .catch(() => null);
    if (srcHref && !srcHref.endsWith("/new")) {
      await page.goto(`${BASE}${srcHref}`, { waitUntil: "networkidle", timeout: 30000 });
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${OUT_DIR}/sources-detail-live.png`, fullPage: true });
      console.log(`captured sources-detail (${srcHref})`);
    } else {
      console.warn("no source rows present — skipped sources-detail");
    }
  } catch (e) {
    console.warn(`failed sources-detail: ${e.message}`);
  } finally {
    await page.close();
  }
}

// /events/[id] — needs an existing event. Pluck from /feed.
{
  const page = await ctxAuth.newPage();
  try {
    await page.goto(`${BASE}/feed`, { waitUntil: "networkidle", timeout: 30000 });
    // Feed cards usually expose data-event-id or aria-label. Look for the
    // first feed card and click it (the modal opens). For the route version,
    // look for a link.
    const cardId = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="feed-card"]');
      return el ? (el.getAttribute("data-event-id") ?? el.id ?? null) : null;
    });
    if (cardId) {
      await page.goto(`${BASE}/events/${cardId}`, { waitUntil: "networkidle", timeout: 30000 });
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${OUT_DIR}/events-detail-live.png`, fullPage: true });
      console.log(`captured events-detail (${cardId})`);
    } else {
      console.warn("no feed cards — skipped events-detail");
    }
  } catch (e) {
    console.warn(`failed events-detail: ${e.message}`);
  } finally {
    await page.close();
  }
}

{
  const page = await ctxAuth.newPage();
  try {
    await page.goto(`${BASE}/events/new`, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT_DIR}/events-new-live.png`, fullPage: true });
    console.log(`captured events-new`);
  } catch (e) {
    console.warn(`failed events-new: ${e.message}`);
  } finally {
    await page.close();
  }
}

await ctxAuth.close();
await ctxAnon.close();
await browser.close();
console.log("done");
