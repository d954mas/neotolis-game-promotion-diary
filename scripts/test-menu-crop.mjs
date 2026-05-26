import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});
await ctx.addCookies([
  {
    name: "neotolis.session_token",
    value: process.argv[2],
    domain: "localhost",
    path: "/",
    httpOnly: true,
    secure: false,
    sameSite: "Lax",
  },
]);
const p = await ctx.newPage();
await p.goto("http://localhost:5173/feed?date=all", { waitUntil: "networkidle" });
await p.waitForSelector("article.feed-card");

const firstCard = p.locator("article.feed-card").first();
await firstCard.locator(".card-actions button").first().click();
await p.waitForTimeout(300);

const menuBox = await firstCard.locator(".card-menu").boundingBox();
console.log("[menu-bounds]", JSON.stringify(menuBox));

const computed = await firstCard.locator(".card-menu").evaluate((el) => {
  const s = getComputedStyle(el);
  return {
    borderRadius: s.borderRadius,
    overflow: s.overflow,
    zIndex: s.zIndex,
    padding: s.padding,
    background: s.background.substring(0, 50),
  };
});
console.log("[menu-computed]", JSON.stringify(computed));

const articleComputed = await firstCard.evaluate((el) => {
  const s = getComputedStyle(el);
  return {
    zIndex: s.zIndex,
    overflow: s.overflow,
    position: s.position,
  };
});
console.log("[article-computed]", JSON.stringify(articleComputed));

// Crop tight around the menu
const m = menuBox;
if (m) {
  await p.screenshot({
    path: ".planning/phases/03.4-design-v2-ux/comparison/menu-crop.png",
    clip: { x: m.x - 10, y: m.y - 10, width: m.width + 20, height: m.height + 20 },
  });
  console.log("[saved] menu-crop.png");
}
await browser.close();
