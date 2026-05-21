import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";

const COOKIE = process.argv[2];
const OUT = ".planning/phases/03.4-design-v2-ux/comparison";
await mkdir(OUT, { recursive: true });

const PROTO_DIR = resolve("docs/design/v2/ui-kit");
const MIME = {
  ".html": "text/html",
  ".jsx": "text/babel",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};
const protoServer = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    let path = url.pathname === "/" ? "/index.html" : url.pathname;
    let abs = resolve(PROTO_DIR, "." + path);
    if (path.startsWith("/../assets/")) abs = resolve(PROTO_DIR, "..", path.slice(4));
    if (path.startsWith("/../tokens.css")) abs = resolve(PROTO_DIR, "..", path.slice(4));
    const body = await readFile(abs);
    res.writeHead(200, { "content-type": MIME[extname(abs)] ?? "application/octet-stream" });
    res.end(body);
  } catch (err) {
    res.writeHead(404);
    res.end(String(err));
  }
});
await new Promise((r) => protoServer.listen(8765, r));

const browser = await chromium.launch();

const ctxOpts = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: "dark" };

const ctx = await browser.newContext(ctxOpts);
await ctx.addCookies([
  { name: "neotolis.session_token", value: COOKIE, domain: "localhost", path: "/", httpOnly: true, secure: false, sameSite: "Lax" },
  { name: "__theme", value: "dark", domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" },
]);
const live = await ctx.newPage();
await live.goto("http://localhost:5173/feed", { waitUntil: "networkidle", timeout: 60000 });
await live.waitForTimeout(800);
await live.screenshot({ path: resolve(OUT, "feed-live-top.png"), clip: { x: 0, y: 0, width: 1440, height: 500 } });
console.log("✓ feed-live-top.png");

const proto = await browser.newContext(ctxOpts);
const protoPage = await proto.newPage();
await protoPage.goto("http://localhost:8765/index.html", { waitUntil: "networkidle", timeout: 60000 });
await protoPage.waitForSelector(".feed-grid, .card, .topbar", { timeout: 30000 });
await protoPage.waitForTimeout(1500);
await protoPage.screenshot({ path: resolve(OUT, "feed-prototype-top.png"), clip: { x: 0, y: 0, width: 1440, height: 500 } });
console.log("✓ feed-prototype-top.png");

await browser.close();
protoServer.close();
