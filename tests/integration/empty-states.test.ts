import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { render } from "svelte/server";
import EmptyState from "../../src/lib/components/EmptyState.svelte";
import * as m from "../../src/lib/paraglide/messages.js";

/**
 * Plan 02-09 — UX-03 empty-state contract.
 *
 * Wave 0 placeholder names PRESERVED — the two `02-09: UX-03 ...` it.skip
 * stubs from Plan 02-01 are flipped to live `it()` here.
 *
 * W-2 dependency decision (per Plan 02-09 task 3): we use Svelte 5's
 * built-in server-side `render` from `svelte/server`. We do NOT add
 * `@testing-library/svelte` — the empty-state assertions are pure-text
 * shape checks (heading present, monospace `<code>` element wrapping the
 * URL), so the rendered-HTML string is sufficient. Plan 02-11's browser-
 * mode suite handles full-DOM assertion needs.
 *
 * Acceptance hooks for the executor checker:
 *   grep -c "@testing-library/svelte" package.json   → 0 (NOT added)
 *   grep -c 'from "svelte/server"' tests/integration/empty-states.test.ts → 1
 */
describe("empty-state copy + Paraglide invariant (UX-03)", () => {
  it("02-09: UX-03 empty /games shows monospace example URL", () => {
    const url = "https://store.steampowered.com/app/1145360/HADES/";
    const heading = m.empty_games_heading();
    const body = m.empty_games_body({ url });

    const out = render(EmptyState, { props: { heading, body, exampleUrl: url } });
    const html = out.body;

    // Heading copy is rendered.
    expect(html).toContain("No games yet.");

    // The example URL is wrapped in a <code> element so the monospace family
    // applies (D-43 — example URLs are inert literal strings, not anchors).
    // The regex tolerates additional class/title attributes on the <code>.
    expect(html).toMatch(
      /<code[^>]*>https:\/\/store\.steampowered\.com\/app\/1145360\/HADES\/<\/code>/,
    );
  });

  it("02-09: UX-03 all P2 keys present in messages/en.json", () => {
    // Re-asserts a subset of the i18n.test.ts D-41 keyset to keep this test
    // self-contained (a future move of the keyset assertion to a different
    // file should leave both tests green).
    const required = [
      "empty_games_heading",
      "empty_items_heading",
      "empty_events_heading",
      "empty_audit_heading",
      "empty_youtube_channels_heading",
      "empty_keys_steam_heading",
    ];
    const exported = m as Record<string, unknown>;
    for (const k of required) {
      expect(exported[k], `paraglide messages missing key: ${k}`).toBeDefined();
    }
  });

  it("Plan 02.1-09: /keys/steam empty-state body uses the rephrased Plan 02.1-03 copy", () => {
    // UI-SPEC §"Empty states — 3 new + 1 polish-fix": the OLD copy mentioned
    // "manual wishlist entry and Steamworks CSV import" — neither exists in
    // Phase 2.1; Plan 02.1-03 rephrased the key. This assertion locks the
    // rephrasing so a future PR can't accidentally revert.
    const url = "https://steamcommunity.com/dev/apikey";
    const body = m.empty_keys_steam_body({ url });
    expect(body).toContain("Phase 3 lands the manual-entry form");
    expect(body).not.toContain("manual wishlist entry");
  });

  it("Plan 02.1-22: /settings page links to /keys/steam (UAT-NOTES.md §8.1-bug closure)", () => {
    // /keys/steam was unreachable from any nav before round-3 — UAT-NOTES.md
    // §8.1-bug. The minimal fix in Plan 02.1-22 adds a Credentials block on
    // /settings with a single link to /keys/steam. This assertion guards the
    // closure so a future refactor (e.g. Phase 3+ unified /settings/credentials
    // hub per §8.2-redesign) cannot remove the access path before its
    // replacement lands. File-content assertion (vs SSR render) because
    // /settings/+page.svelte depends on +layout.server.ts data shape that an
    // isolated `render` call would have to mock.
    const settingsPage = fs.readFileSync(path.resolve("src/routes/settings/+page.svelte"), "utf8");
    expect(settingsPage).toContain("/keys/steam");
    expect(settingsPage).toContain("settings_credentials_heading");
    expect(settingsPage).toContain("settings_credentials_steam_link_label");
  });
});
