// Smoke test: each SourceRow affordance and confirm reactions. Each test
// runs in a fresh browser context so state doesn't leak across cases.
//
// Run: node scripts/smoke-sources-affordances.mjs <session_cookie_value>

import { chromium } from "playwright";

const COOKIE_VALUE = process.argv[2];
if (!COOKIE_VALUE) {
  console.error("usage: node scripts/smoke-sources-affordances.mjs <cookie>");
  process.exit(1);
}

const BASE = "http://localhost:5173";
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

async function openSourcesPage() {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    colorScheme: "dark",
  });
  await ctx.addCookies([cookie]);
  const page = await ctx.newPage();
  page.on("pageerror", (err) => console.warn("pageerror:", err.message));
  await page.goto(`${BASE}/sources`, { waitUntil: "load", timeout: 180000 });
  await page.waitForSelector(".source-row", { timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 60000 });
  await page.waitForTimeout(1000);
  return { ctx, page };
}

// --- Test 1: ⋯ overflow opens menu with Remove option
{
  const { ctx, page } = await openSourcesPage();
  const firstRow = page.locator(".source-row").first();
  await firstRow.locator(".card-action-btn.overflow").click();
  await page.waitForTimeout(300);
  const menuVisible = await page.locator(".card-menu").first().isVisible();
  const removeText = (await page.locator(".card-menu-item.danger").first().innerText()).trim();
  console.log("[1] ⋯ menu visible:", menuVisible, "remove label:", JSON.stringify(removeText));
  await ctx.close();
}

// --- Test 2: avatar opens AuthorPopover
{
  const { ctx, page } = await openSourcesPage();
  const firstRow = page.locator(".source-row").first();
  await firstRow.locator(".author-avatar.source-author-trigger").click();
  await page.waitForTimeout(300);
  const popVisible = await page.locator(".author-pick-pop").first().isVisible();
  console.log("[2] Author popover visible:", popVisible);
  await ctx.close();
}

// --- Test 3: click handle text → rename input
{
  const { ctx, page } = await openSourcesPage();
  const firstRow = page.locator(".source-row").first();
  await firstRow.locator(".source-title-text").click();
  await page.waitForTimeout(300);
  const inputVisible = await firstRow.locator(".source-title-input").isVisible();
  console.log("[3] Rename input visible:", inputVisible);
  await ctx.close();
}

// --- Test 4: toggle data-on flips after click (we revert by clicking again)
{
  const { ctx, page } = await openSourcesPage();
  const firstRow = page.locator(".source-row").first();
  const toggle = firstRow.locator(".source-toggle");
  const initialOn = await toggle.getAttribute("data-on");
  console.log("[4a] initial data-on:", initialOn);
  await toggle.click();
  // PATCH is async; wait for invalidateAll() to re-render
  await page.waitForTimeout(2500);
  const afterOn = await toggle.getAttribute("data-on");
  console.log("[4b] after-click data-on:", afterOn);
  // Toggle back to leave state clean
  await toggle.click();
  await page.waitForTimeout(2500);
  const restored = await toggle.getAttribute("data-on");
  console.log("[4c] restored data-on:", restored);
  await ctx.close();
}

await browser.close();
console.log("smoke done.");
