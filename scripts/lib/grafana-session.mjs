// Shared Grafana session for all audit scripts.
//
// Uses a persistent browser context (user-data-dir) so the Grafana login
// cookie survives across script runs — log in ONCE, every subsequent run
// reuses the session. No password re-entry.
//
// Session dir: scripts/.grafana-session/ (gitignored).

import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSION_DIR = join(__dirname, "..", ".grafana-session");

export const DEFAULT_GRAFANA_URL = "https://neotolis-diary.dev/grafana";

/**
 * Opens a persistent browser context and ensures the user is logged into
 * Grafana. If a saved session cookie is still valid, returns immediately
 * without prompting. Otherwise opens the login page and waits for the user.
 *
 * Returns { context, page, grafanaUrl, fetchJson, close }.
 * Call close() when done (keeps the user-data-dir for next time).
 */
export async function openGrafana(grafanaUrl = DEFAULT_GRAFANA_URL, { headless = false } = {}) {
  const context = await chromium.launchPersistentContext(SESSION_DIR, {
    headless,
    viewport: { width: 1920, height: 1080 },
  });
  const page = context.pages()[0] ?? (await context.newPage());

  // Probe: are we already authenticated? /api/user returns 200 with a valid cookie.
  await page.goto(`${grafanaUrl}/?orgId=1`, { waitUntil: "load" });
  const authed = await page.evaluate(async (url) => {
    const r = await fetch(`${url}/api/user`, { credentials: "include" });
    return r.status === 200;
  }, grafanaUrl);

  if (!authed) {
    console.log(">>> Not logged in. Opening login page — please log in (one time)...");
    await page.goto(`${grafanaUrl}/login`, { waitUntil: "load" });
    await page.waitForURL((u) => !u.toString().includes("/login"), { timeout: 120_000 });
    console.log(">>> Logged in. Session saved for next time.");
    await page.waitForTimeout(1500);
  } else {
    console.log(">>> Reusing saved session (no login needed).");
  }

  const fetchJson = async (path) =>
    page.evaluate(async (u) => {
      const r = await fetch(u, { credentials: "include" });
      const text = await r.text();
      try {
        return { status: r.status, body: JSON.parse(text) };
      } catch {
        return { status: r.status, body: text.slice(0, 500) };
      }
    }, grafanaUrl + path);

  return {
    context,
    page,
    grafanaUrl,
    fetchJson,
    close: () => context.close(),
  };
}
