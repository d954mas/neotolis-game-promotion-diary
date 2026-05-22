import { chromium } from "playwright";

const COOKIE = process.argv[2];
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addCookies([
  { name: "neotolis.session_token", value: COOKIE, domain: "localhost", path: "/", httpOnly: true, secure: false, sameSite: "Lax" },
]);
const page = await ctx.newPage();
page.on("console", (m) => console.log(`[console:${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));

await page.goto("http://localhost:5173/feed?date=all", { waitUntil: "networkidle" });
await page.waitForSelector("article.feed-card");

// Open ⋮ menu → Edit games
await page.locator("article.feed-card").first().locator(".card-actions button").first().click();
await page.waitForTimeout(200);
await page.locator("article.feed-card .card-menu [role=menuitem]").first().click();
await page.waitForTimeout(400);

const dialog = page.locator("dialog.games-picker");
console.log("[step] picker open:", await dialog.evaluate((el) => el.open));

// Inspect the first game checkbox's state BEFORE click
const firstRow = dialog.locator(".row").first();
const labelText = await firstRow.textContent();
console.log("[step] first row label:", labelText?.trim());

// Look at the button[role=checkbox] inside the TriStateCheckbox
const checkboxBefore = await firstRow.locator("button[role=checkbox]").evaluate((el) => ({
  ariaChecked: el.getAttribute("aria-checked"),
  boxState: el.querySelector(".box")?.getAttribute("data-state"),
}));
console.log("[before-click]", JSON.stringify(checkboxBefore));

// Click the button
await firstRow.locator("button[role=checkbox]").click();
await page.waitForTimeout(200);

const checkboxAfter = await firstRow.locator("button[role=checkbox]").evaluate((el) => ({
  ariaChecked: el.getAttribute("aria-checked"),
  boxState: el.querySelector(".box")?.getAttribute("data-state"),
}));
console.log("[after-click]", JSON.stringify(checkboxAfter));

// Did the state change?
if (checkboxBefore.ariaChecked === checkboxAfter.ariaChecked && checkboxBefore.boxState === checkboxAfter.boxState) {
  console.log("[BUG] checkbox state UNCHANGED after click");
} else {
  console.log("[OK] checkbox toggled");
}

await browser.close();
