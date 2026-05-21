import { chromium } from "playwright";

const COOKIE = process.argv[2];
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
await ctx.addCookies([
  { name: "neotolis.session_token", value: COOKIE, domain: "localhost", path: "/", httpOnly: true, secure: false, sameSite: "Lax" },
  { name: "__theme", value: "dark", domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" },
]);
const page = await ctx.newPage();
page.on("console", (msg) => console.log(`[console:${msg.type()}]`, msg.text()));
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
page.on("requestfailed", (r) => console.log("[reqfail]", r.url(), r.failure()?.errorText));
page.on("response", (r) => {
  if (r.url().includes("/api/events/bulk")) console.log(`[api] ${r.request().method()} ${r.url()} → ${r.status()}`);
});

await page.goto("http://localhost:5173/feed?date=all", { waitUntil: "networkidle" });
await page.waitForSelector("article.feed-card, .card", { timeout: 10000 });

const cardLocator = page.locator("article.feed-card").first();
await cardLocator.scrollIntoViewIfNeeded();
// Click the ⋮ overflow button inside the first card.
const overflow = cardLocator.locator(".card-action-btn.overflow, .card-actions button").first();
await overflow.click();
console.log("[step] overflow clicked");
await page.waitForTimeout(200);

// Click "Edit games" menu item.
const editGames = cardLocator.locator(".card-menu [role=menuitem]").first();
const editGamesText = await editGames.textContent();
console.log(`[step] menu item: ${editGamesText}`);
await editGames.click();
await page.waitForTimeout(400);

// Find GamesPicker dialog.
const dialog = page.locator("dialog.games-picker");
const isOpen = await dialog.evaluate((el) => (el).open);
console.log(`[step] picker open: ${isOpen}`);

if (!isOpen) {
  console.log("[fail] picker did not open");
  await browser.close();
  process.exit(1);
}

// Toggle the FIRST game checkbox.
const firstGameCheckbox = dialog.locator(".row").first().locator("label.tri-state").first();
const fgText = await dialog.locator(".row").first().textContent();
console.log(`[step] first game row: ${fgText?.trim()}`);
await firstGameCheckbox.click();
console.log("[step] toggled first game");
await page.waitForTimeout(200);

// Click Apply.
const applyBtn = dialog.locator("button.primary, button:has-text('Apply'), button:has-text('Apply')").last();
console.log(`[step] apply button found: ${await applyBtn.count()}`);
await applyBtn.click();
console.log("[step] apply clicked");
await page.waitForTimeout(2000);

await browser.close();
