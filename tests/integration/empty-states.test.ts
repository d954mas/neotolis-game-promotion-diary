import { describe, it, expect } from "vitest";
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
});
