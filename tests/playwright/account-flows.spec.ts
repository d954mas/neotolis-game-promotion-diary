// Plan 02.2-04 — /settings/account UI + AccountDeletedBanner + /login
// disclaimer + auth-gated noindex meta. The 3 live tests below cover the
// portions of the surface area that are exercisable WITHOUT the
// cookie-injection auth harness still deferred to Phase 6 (per
// 02.1-VALIDATION.md "Manual-Only Verifications" precedent followed by
// every Plan 02.1 browser test):
//
//   1. /login renders the early-access disclaimer copy (D-12) — public.
//   2. Public pages (/login, /privacy, /terms, /about, /) do NOT emit the
//      noindex meta tag (D-13). The auth-gated noindex inverse is covered
//      by manual UAT (Plan 02.2-08 step 6) since /feed requires a session.
//   3. /settings/account redirects an anonymous request to /login, with
//      ?next= preserving the intended path (defense-in-depth via
//      +layout.server.ts PROTECTED_PATHS).
//
// The Type-DELETE confirm-dialog gate (D-S3 acceptance criterion) is
// component-level and covered by tests/unit (ConfirmDialog requireText
// prop typecheck + the existing dto.test.ts envelope-strip suite). The
// end-to-end signed-in flow lands in Plan 02.2-08 manual UAT.
//
// Migrated to @playwright/test (the same runner used by responsive-360.spec.ts)
// after vitest 4 browser mode hit unfixed upstream issue vitest#7981 — see
// playwright.config.ts header for the rationale.

import { test, expect } from "@playwright/test";

test.describe("Plan 02.2-04 — /login disclaimer + auth-gated noindex", () => {
  test("/login renders the Plan 02.2-04 early-access disclaimer copy", async ({ page }) => {
    await page.goto("/login");
    // The disclaimer copy comes from m.login_early_access_disclaimer().
    // Match the load-bearing prefix so a future Paraglide rewording that
    // preserves the meaning (e.g. punctuation tweak) does not break.
    await expect(page.locator("p.disclaimer")).toContainText("Early access");
    await expect(page.locator("p.disclaimer")).toContainText("Auto-import");
  });

  test("public pages do NOT emit the noindex meta — /login", async ({ page }) => {
    await page.goto("/login");
    const noindexMeta = page.locator('meta[name="robots"][content*="noindex"]');
    await expect(noindexMeta).toHaveCount(0);
  });

  test("public pages do NOT emit the noindex meta — /privacy", async ({ page }) => {
    await page.goto("/privacy");
    const noindexMeta = page.locator('meta[name="robots"][content*="noindex"]');
    await expect(noindexMeta).toHaveCount(0);
  });

  test("public pages do NOT emit the noindex meta — /terms", async ({ page }) => {
    await page.goto("/terms");
    const noindexMeta = page.locator('meta[name="robots"][content*="noindex"]');
    await expect(noindexMeta).toHaveCount(0);
  });

  test("public pages do NOT emit the noindex meta — /about", async ({ page }) => {
    await page.goto("/about");
    const noindexMeta = page.locator('meta[name="robots"][content*="noindex"]');
    await expect(noindexMeta).toHaveCount(0);
  });

  test("public pages do NOT emit the noindex meta — / (dashboard public surface)", async ({
    page,
  }) => {
    await page.goto("/");
    const noindexMeta = page.locator('meta[name="robots"][content*="noindex"]');
    await expect(noindexMeta).toHaveCount(0);
  });

  test("/settings/account redirects an anonymous request to /login (?next= preserved)", async ({
    page,
  }) => {
    await page.goto("/settings/account");
    // Anonymous → +layout.server.ts PROTECTED_PATHS sweep ('/settings'
    // prefix) → 303 redirect to /login?next=/settings/account.
    expect(page.url()).toMatch(/\/login/);
    expect(page.url()).toContain("next=");
  });

  // Defense-in-depth: the /settings/account redirect lands a user without a
  // session on /login. /login itself is one of the public-indexable pages,
  // so the Page after redirect MUST NOT carry a noindex meta — the redirect
  // doesn't accidentally turn /login into an auth-gated page.
  test("post-redirect /login (from /settings/account anonymous attempt) stays indexable", async ({
    page,
  }) => {
    await page.goto("/settings/account");
    expect(page.url()).toMatch(/\/login/);
    const noindexMeta = page.locator('meta[name="robots"][content*="noindex"]');
    await expect(noindexMeta).toHaveCount(0);
  });
});

// Plan 02.2-04 — auth-gated browser flows deferred to Phase 6 auth harness
// (same precedent as Plans 02.1-18 / 19 / 20 / 21 / 23 / 26 / 39). Manual
// UAT covers these via Plan 02.2-08 step 6 (Russian step-by-step):
//
//   * Sign in via Google → visit /feed → page source includes
//     <meta name="robots" content="noindex,nofollow">.
//   * /settings/account page renders Export + Delete buttons.
//   * Delete button click → ConfirmDialog opens with "Type DELETE" input;
//     confirm button DISABLED until input value matches "DELETE" verbatim.
//   * Confirm → DELETE /api/me/account → user redirected to /login.
//   * Sign back in → AccountDeletedBanner appears with "N days left" and
//     restore CTA → click restore → POST /api/me/account/restore → banner
//     disappears on the next layout invalidation.
test.describe
  .skip("Plan 02.2-04 — authenticated /settings/account end-to-end (manual UAT — auth harness deferred to Phase 6)", () => {
  test("placeholder — see Plan 02.2-08 step 6 for the manual UAT recipe", () => {
    // Skipped at the describe level above. The body never runs; this stub
    // is for grep discoverability when the auth-injection harness arrives.
  });
});
