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
 * sweep (/feed, /sources, /games, /games/[id], /events, /audit,
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
  "/feed",
  "/sources",
  "/games",
  "/games/[gameId]",
  "/events",
  "/audit",
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

/**
 * Plan 02.1-22 — sticky positioning + body-scroll-lock at 360px.
 *
 * UAT-NOTES.md §2.2-bug + §1.4-bug closures. Three behaviors are asserted:
 *   (a) AppHeader sticky-top: scrolling the page does not move the header
 *       off-screen (its bounding rect's top stays at 0).
 *   (b) /sources page-header sticky: the "+ Add data source" CTA stays
 *       reachable while a long source list scrolls (the .head element's
 *       top stays anchored under the AppHeader, ~72px from viewport top).
 *   (c) FiltersSheet body-scroll-lock: opening the sheet sets
 *       document.body.style.overflow = "hidden"; closing restores "".
 *
 * Like Plan 02-11's authenticated-route sweep, the in-app interactions
 * (AppHeader visibility, /sources scrolling, FiltersSheet open/close)
 * require an authenticated session that vitest-browser cannot mint without
 * a Postgres harness. The functional UAT for these three behaviors is in
 * the Per-Task Verification Map row "02.1-22 T1" (manual + integration).
 *
 * The placeholder `it.skip` blocks below keep the contract surface visible
 * to a future Phase 6 task that lifts the auth harness — the same pattern
 * Plan 02-11 / 02.1-16 / 02.1-19 / 02.1-20 / 02.1-21 use.
 */
describe("Plan 02.1-22 — sticky + body-scroll-lock at 360px", () => {
  it.skip("AppHeader stays at viewport top after scrolling 200px (deferred — auth harness)", async () => {
    // Manual UAT (Per-Task Verification Map 02.1-22 T1):
    //   1. sign in, viewport 360x640
    //   2. visit any authenticated route with scrollable content (e.g. /feed
    //      with seeded events, or /sources with 6+ sources)
    //   3. window.scrollTo(0, 200)
    //   4. document.querySelector("header.header").getBoundingClientRect().top === 0
    //
    // Asserts the Plan 02.1-22 §2.2-bug closure: position: sticky; top: 0
    // on .header anchored against the layout-root flex column.
  });

  it.skip("/sources page-header stays under AppHeader after scroll (deferred — auth harness)", async () => {
    // Manual UAT (Per-Task Verification Map 02.1-22 T1):
    //   1. sign in, register 6+ sources, viewport 360x640
    //   2. visit /sources, window.scrollTo(0, 400)
    //   3. document.querySelector("section.sources > header.head")
    //        .getBoundingClientRect().top stays ≈ 72px (under sticky AppHeader)
    //
    // Asserts position: sticky; top: 72px on .head with background fill so
    // scrolled content does not bleed through.
  });

  it.skip("FiltersSheet locks body scroll on open + restores on close (deferred — auth harness)", async () => {
    // Manual UAT (Per-Task Verification Map 02.1-22 T1):
    //   1. sign in, viewport 360x640, visit /feed
    //   2. click "Filters" button → sheet opens
    //   3. document.body.style.overflow === "hidden" (background does not scroll)
    //   4. close sheet (Cancel / Apply / Esc / backdrop)
    //   5. document.body.style.overflow === "" (background scroll restored)
    //
    // Asserts UAT-NOTES.md §1.4-bug closure: $effect sets overflow:hidden
    // on showModal() and the cleanup function (+ onDialogCancel) restores
    // it. Covers /feed and /audit reuse via Plan 02.1-21 schema unification.
  });
});
