import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
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
p.on("console", (m) => console.log(`[console:${m.type()}]`, m.text()));
p.on("response", (r) => {
  if (r.url().includes("/preview-url")) console.log(`[api] ${r.status()}`);
});

await p.goto("http://localhost:5173/feed?date=all", { waitUntil: "networkidle" });
await p.waitForSelector("article.feed-card");
await p.locator(".cta-primary").first().click();
await p.waitForTimeout(300);

const dialog = p.locator("dialog.add-event-modal");
console.log("[open]", await dialog.evaluate((el) => el.open));

const urlInput = dialog.locator("input#addevt-url");
await urlInput.fill("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
console.log("[url filled]");

await dialog.locator(".field-url-fetch").click();
console.log("[fetch clicked]");
await p.waitForTimeout(3000);

const titleVal = await dialog.locator("input#addevt-title").inputValue();
const kindActive = await dialog.locator(".add-kind-chip[data-active='1']").textContent();
const fetchedSrc = await dialog
  .locator(".field-fetch-result")
  .textContent()
  .catch(() => "(no fetch-result)");
console.log("[title]", JSON.stringify(titleVal));
console.log("[kind active]", kindActive?.trim());
console.log("[fetch-result]", fetchedSrc?.trim());

const urlError = await dialog
  .locator(".field-error")
  .textContent()
  .catch(() => null);
if (urlError) console.log("[error]", urlError.trim());

await browser.close();
