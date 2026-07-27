// Every page renders without horizontal scroll at 360px viewport AND the
// primary CTA above the fold is reachable without zoom. The mobile-360px
// contract is the load-bearing first-screen contract for the indie
// self-host operator opening the dashboard on a phone.
//
// Migrated from tests/browser/{feed-360,responsive-360}.test.ts after
// vitest browser mode hit unfixed upstream issue vitest#7981 ("Browser
// connection was closed while running tests"). @playwright/test is the
// official Playwright Team runner; no birpc, no random disconnects.

import { test, expect } from "@playwright/test";

const PUBLIC_ROUTES = ["/", "/login"] as const;

test.describe("360px responsive smoke", () => {
  for (const route of PUBLIC_ROUTES) {
    test(`${route} renders without horizontal scroll at 360x640`, async ({ page }) => {
      await page.goto(route);
      // Tolerant comparison: scrollWidth must not exceed clientWidth.
      // Strict `<= 360` would false-fail under devicePixelRatio quirks.
      const sw = await page.evaluate(() => document.documentElement.scrollWidth);
      const cw = await page.evaluate(() => document.documentElement.clientWidth);
      expect(
        sw,
        `${route} scrollWidth=${sw} > clientWidth=${cw} (horizontal overflow at 360px)`,
      ).toBeLessThanOrEqual(cw);
    });
  }

  test("/login primary CTA reachable without zoom at 360px", async ({ page }) => {
    await page.goto("/login");
    // /login renders <button>Continue with Google</button> (not a link).
    const cta = page.getByRole("button", { name: /continue.*google/i });
    await expect(cta).toBeVisible();
  });

  test("anonymous /feed redirects to /login", async ({ page }) => {
    await page.goto("/feed");
    // SvelteKit +layout.server.ts protected-paths sweep redirects to
    // /login OR /feed/+page.server.ts's defense-in-depth fires. Either
    // way the resolved URL contains /login.
    expect(page.url()).toMatch(/\/login/);
  });

  // The last straggler of the vitest -> playwright migration: the other cases moved
  // when vitest#7981 bit, this one stayed behind in tests/browser/responsive-360.test.ts
  // and was invisible because that project ran in no CI job.
  test("body computed overflow-x is 'clip' (not 'hidden') — sticky descendants anchor to viewport", async ({
    page,
  }) => {
    await page.goto("/");
    const overflowX = await page.evaluate(() => getComputedStyle(document.body).overflowX);
    // `clip` is the load-bearing value: it crops overflow WITHOUT establishing a scroll
    // container, preserving position: sticky on descendants. `hidden` (the regression
    // source) coerces overflow-y to auto and promotes body to a scroll container,
    // breaking sticky anchoring.
    expect(
      overflowX,
      `body computed overflow-x === ${overflowX} — expected 'clip' to preserve sticky descendants`,
    ).toBe("clip");
  });
});
