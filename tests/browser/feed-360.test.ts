/**
 * tests/browser/feed-360.test.ts
 *
 * Plan 02.1-07 — FEED-01 360px responsive surface.
 *
 * SCOPE: PUBLIC-routed assertion only. The plan's <action> Step D specifies
 * "/feed at 360x640 redirects an anonymous request to /login (public-routed
 * assertion only — auth-routed parts deferred to manual UAT)". The
 * authenticated-user 360px sweep (chips collapse to "Filters (N)" sheet
 * button, FeedRow vertical stack at 360px without horizontal overflow) is
 * deferred to Phase 6 per VALIDATION.md `Manual-Only Verifications` — the
 * cookie-injection harness deferred from Phase 2 still hasn't landed
 * (vitest browser-mode tests run in a separate process from the SvelteKit
 * preview server with no in-test DB connection available).
 *
 * Mirrors the pattern of `tests/browser/responsive-360.test.ts`: viewport
 * resize → goto → assert URL or DOM. CI provisions a `pnpm preview`
 * server on :5173; locally:
 *   pnpm build && pnpm preview --port 5173 &
 *   pnpm test:browser
 */

import { describe, it, expect } from "vitest";
import { page, commands } from "@vitest/browser/context";

const BASE = process.env.BROWSER_TEST_BASE_URL ?? "http://localhost:5173";

describe("FEED-01 (browser): /feed responsive at 360px", () => {
  it("anonymous request to /feed redirects to /login (public-routed)", async () => {
    await page.viewport(360, 640);
    await commands.goto(`${BASE}/feed`);
    // Anonymous → +layout.server.ts protected-paths sweep redirects to /login,
    // OR /feed/+page.server.ts's defense-in-depth `if (!locals.user) throw
    // redirect(303, "/login?next=...")` fires. Either way, the URL after
    // navigation contains "/login". The `?next=` param-encoded value is the
    // original `/feed` path so a subsequent successful sign-in lands the user
    // on the page they originally wanted.
    const url = await commands.currentUrl();
    expect(url).toMatch(/\/login/);
  });

  it.skip(
    "authenticated /feed at 360px (cookie-injection harness deferred to Phase 6 per Phase 2 precedent — see 02.1-VALIDATION.md Manual-Only Verifications)",
  );

  it.skip(
    "authenticated /feed filter chips collapse to 'Filters (N)' button below 600px (manual UAT — see Manual-Only verifications)",
  );
});
