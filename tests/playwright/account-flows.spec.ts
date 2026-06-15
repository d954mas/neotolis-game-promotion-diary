// /settings/account UI + AccountDeletedBanner + /login disclaimer +
// auth-gated noindex meta. The 3 live tests below cover the portions of
// the surface area that are exercisable WITHOUT the cookie-injection
// auth harness:
//
//   1. /login renders the early-access disclaimer copy — public.
//   2. Public pages (/login, /privacy, /terms, /about, /) do NOT emit the
//      noindex meta tag. The auth-gated noindex inverse is covered by
//      manual UAT since /feed requires a session.
//   3. /settings/account redirects an anonymous request to /login, with
//      ?next= preserving the intended path (defense-in-depth via
//      +layout.server.ts PROTECTED_PATHS).
//
// The Type-DELETE confirm-dialog gate is component-level and covered by
// tests/unit (ConfirmDialog requireText prop typecheck + the existing
// dto.test.ts envelope-strip suite). The end-to-end signed-in flow lands
// in manual UAT.
//
// Migrated to @playwright/test (the same runner used by
// responsive-360.spec.ts) after vitest 4 browser mode hit unfixed upstream
// issue vitest#7981 — see playwright.config.ts header for the rationale.

import { test, expect } from "@playwright/test";

test.describe("/login disclaimer + auth-gated noindex", () => {
  test("/login renders the early-access disclaimer copy", async ({ page }) => {
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

  test("public pages do NOT emit the noindex meta — /news", async ({ page }) => {
    await page.goto("/news");
    const noindexMeta = page.locator('meta[name="robots"][content*="noindex"]');
    await expect(noindexMeta).toHaveCount(0);
  });

  test("public pages do NOT emit the noindex meta — /news/<article>", async ({ page }) => {
    await page.goto("/news/the-diary-is-live");
    // Positive assertion FIRST: prove the article template actually rendered
    // (the .news-article <h1> only exists on a real post, never on the 404
    // error page). Without this, a future slug rename would 404 and the noindex
    // check below would vacuously pass.
    const h1 = page.locator(".news-article h1");
    await expect(h1).toBeVisible();
    await expect(h1).not.toBeEmpty();
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

// Auth-gated browser flows deferred to a future auth harness. Manual UAT
// covers these (Russian step-by-step):
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
  .skip("authenticated /settings/account end-to-end (manual UAT — auth harness deferred)", () => {
  test("placeholder — see manual UAT recipe", () => {
    // Skipped at the describe level above. The body never runs; this stub
    // is for grep discoverability when the auth-injection harness arrives.
  });
});
