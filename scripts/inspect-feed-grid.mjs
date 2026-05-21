import { chromium } from "playwright";

const COOKIE = process.argv[2];
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
});
await ctx.addCookies([{
  name: "neotolis.session_token",
  value: COOKIE,
  domain: "localhost",
  path: "/",
  httpOnly: true,
  secure: false,
  sameSite: "Lax",
}]);
const page = await ctx.newPage();
await page.goto("http://localhost:5173/feed", { waitUntil: "networkidle" });
await page.waitForSelector(".feed-grid", { timeout: 10000 });

const info = await page.evaluate(() => {
  const main = document.querySelector("main");
  const feed = document.querySelector(".feed");
  const grid = document.querySelector(".feed-grid");
  const card = document.querySelector(".feed-card, article.feed-card");
  const cs = (el) => {
    if (!el) return null;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      width: r.width,
      maxWidth: s.maxWidth,
      display: s.display,
      gridTemplateColumns: s.gridTemplateColumns,
      padding: s.padding,
    };
  };
  return {
    viewport: { w: innerWidth, h: innerHeight },
    cssMaxW: getComputedStyle(document.documentElement).getPropertyValue("--max-w"),
    main: cs(main),
    feed: cs(feed),
    grid: cs(grid),
    card: cs(card),
    cardCount: document.querySelectorAll(".feed-grid > article, .feed-grid > .feed-card").length,
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
