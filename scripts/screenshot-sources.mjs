import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
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
await p.goto("http://localhost:5173/sources", { waitUntil: "networkidle" });
await p.waitForTimeout(500);
const out = ".planning/phases/03.4-design-v2-ux/comparison/sources-live.png";
await p.screenshot({ path: out, fullPage: true });
console.log("[saved]", out);
await browser.close();
