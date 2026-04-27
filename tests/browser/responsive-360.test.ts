/**
 * tests/browser/responsive-360.test.ts
 *
 * Plan 02-11 — UX-02 (D-42 hard requirement): every Phase 2 page renders
 * without horizontal scroll at 360px viewport AND the primary CTA above the
 * fold is reachable without zoom. The mobile-360px contract is the load-
 * bearing first-screen contract for the indie self-host operator opening the
 * dashboard on a phone — which is the exact use case Phase 2 ships for.
 *
 * Scope: PUBLIC routes ('/', '/login') only. Authenticated-route 360px
 * sweep (/games, /games/[id], /events, /audit, /accounts/youtube,
 * /keys/steam, /settings) is deferred to manual checkpoint + Phase 6 — the
 * cookie-injection strategy needs a Better Auth-signed session cookie that
 * only `seedUserDirectly` (integration helper, requires Postgres) can mint,
 * and Vitest browser-mode tests run in a separate process from the vite
 * preview server with no in-test DB connection available. See
 * 02-VALIDATION.md `Manual-Only Verifications` for the authenticated-page
 * checklist.
 *
 * Prerequisites: a SvelteKit preview server running on
 * http://localhost:5173. CI provisions it via the browser-tests job in
 * .github/workflows/ci.yml; locally:
 *   pnpm build && pnpm preview --port 5173 &
 *   pnpm test:browser
 *
 * Assertion shape:
 *   1. `document.documentElement.scrollWidth <= clientWidth` (no horizontal
 *      overflow at 360px). Asserted against clientWidth (not the literal
 *      number 360) because the browser may add scrollbars / device pixel
 *      ratios that nudge the measurement; the load-bearing question is "did
 *      the page produce a horizontal scrollbar?" — equivalent to scrollWidth
 *      <= clientWidth.
 *   2. Primary CTA on /login (the Continue with Google link) is visible
 *      without zoom — `expect.element(...).toBeVisible()` from
 *      @vitest/browser/context handles the visibility check (in-viewport +
 *      not display:none + non-zero box).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { page, commands } from "@vitest/browser/context";

const BASE = process.env.BROWSER_TEST_BASE_URL ?? "http://localhost:5173";

// Public Phase 2 routes — no auth cookie needed. Both render via SvelteKit
// SSR + client hydration; the dashboard '/' is the post-login landing
// (anonymous renders a 'Sign in' link), and '/login' is the OAuth entry.
const PHASE_2_PUBLIC_ROUTES = ["/", "/login"];

// Authenticated Phase 2 routes — gated by Better Auth session cookie. The
// 360px assertion against these is documented in 02-VALIDATION.md
// `Manual-Only Verifications` and exercised in the human checkpoint
// (Plan 02-11 Task 4). Listed here as `it.skip` placeholders so the
// contract surface stays visible to a future Phase 6 task that lifts the
// cookie-injection harness; also so a test runner enumeration sees every
// Phase 2 route by name even when the assertion is deferred.
const PHASE_2_AUTH_ROUTES = [
  "/games",
  "/games/[gameId]",
  "/events",
  "/audit",
  "/accounts/youtube",
  "/keys/steam",
  "/settings",
];

describe("UX-02 — 360px viewport public-route smoke (D-42)", () => {
  beforeAll(async () => {
    // Set the viewport once for the suite. Each test re-asserts it before
    // page.goto — Vitest browser mode resets navigation state but viewport
    // persists across tests within a file by default.
    await page.viewport(360, 640);
  });

  it.each(PHASE_2_PUBLIC_ROUTES)(
    "%s renders without horizontal scroll at 360x640",
    async (route) => {
      await page.viewport(360, 640);
      await commands.goto(`${BASE}${route}`);
      const sw = await commands.measureScrollWidth();
      const cw = await commands.measureClientWidth();
      // Tolerant comparison: scrollWidth must not exceed clientWidth (i.e.
      // the page does not produce a horizontal scroll bar at 360px). Strict
      // `<= 360` would false-fail under devicePixelRatio quirks on CI runners.
      expect(
        sw,
        `${route} scrollWidth=${sw} > clientWidth=${cw} (horizontal overflow at 360px)`,
      ).toBeLessThanOrEqual(cw);
    },
  );

  it("/login primary CTA reachable without zoom at 360px", async () => {
    await page.viewport(360, 640);
    await commands.goto(`${BASE}/login`);
    // The login page renders a 'Continue with Google' link/button. The text
    // is sourced from Paraglide (m.login_continue_with_google) — the regex
    // is tolerant to surrounding whitespace and the small wording shifts a
    // future copy edit might bring.
    const cta = page.getByRole("link", { name: /continue|sign in|google/i });
    await expect.element(cta).toBeVisible();
  });
});

describe("UX-02 — 360px viewport authenticated-route sweep (D-42)", () => {
  // Authenticated 360px assertions deferred to manual checkpoint + Phase 6
  // per 02-VALIDATION.md `Manual-Only Verifications`. Listed here as
  // `it.skip` so the contract surface stays visible.
  it.skip.each(PHASE_2_AUTH_ROUTES)(
    "%s renders without horizontal scroll at 360px (deferred — manual + Phase 6)",
    async () => {
      // Deferred: Vitest browser-mode tests run in a separate process from
      // the SvelteKit preview server with no in-test Postgres connection,
      // so seedUserDirectly + Better Auth signed cookie minting are not
      // available. Phase 6 lifts the cookie-injection harness or adds an
      // APP_ROLE=test bypass; until then 02-VALIDATION.md tracks the
      // manual checklist for these seven routes.
    },
  );
});
