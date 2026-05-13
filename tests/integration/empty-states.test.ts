import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { render } from "svelte/server";
import EmptyState from "../../src/lib/components/EmptyState.svelte";
import * as m from "../../src/lib/paraglide/messages.js";

/**
 * Empty-state contract.
 *
 * We use Svelte 5's built-in server-side `render` from `svelte/server`.
 * We do NOT add `@testing-library/svelte` — the empty-state assertions
 * are pure-text shape checks (heading present, monospace `<code>`
 * element wrapping the URL), so the rendered-HTML string is sufficient.
 * The browser-mode suite handles full-DOM assertion needs.
 */
describe("empty-state copy + Paraglide invariant", () => {
  it("empty /games shows monospace example URL", () => {
    const url = "https://store.steampowered.com/app/1145360/HADES/";
    const heading = m.empty_games_heading();
    const body = m.empty_games_body({ url });

    const out = render(EmptyState, { props: { heading, body, exampleUrl: url } });
    const html = out.body;

    // Heading copy is rendered.
    expect(html).toContain("No games yet.");

    // The example URL is wrapped in a <code> element so the monospace
    // family applies — example URLs are inert literal strings, not
    // anchors. The regex tolerates additional class/title attributes on
    // the <code>.
    expect(html).toMatch(
      /<code[^>]*>https:\/\/store\.steampowered\.com\/app\/1145360\/HADES\/<\/code>/,
    );
  });

  it("all required keys present in messages/en.json", () => {
    // Re-asserts a subset of the i18n.test.ts keyset to keep this test
    // self-contained (a future move of the keyset assertion to a
    // different file should leave both tests green).
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

  it("/keys/steam empty-state body uses the rephrased copy", () => {
    // The OLD copy mentioned "manual wishlist entry and Steamworks CSV
    // import" — neither exists today. The rephrased key is locked here
    // so a future PR can't accidentally revert.
    const url = "https://steamcommunity.com/dev/apikey";
    const body = m.empty_keys_steam_body({ url });
    expect(body).toContain("the manual-entry form and the Steamworks CSV importer are coming soon");
    expect(body).not.toContain("manual wishlist entry");
  });

  it("/settings page links to /keys/steam", () => {
    // /keys/steam was unreachable from any nav before this fix. The
    // minimal fix adds a Credentials block on /settings with a single
    // link to /keys/steam. This assertion guards the closure so a future
    // refactor (e.g. a unified /settings/credentials hub) cannot remove
    // the access path before its replacement lands. File-content
    // assertion (vs SSR render) because
    // /settings/+page.svelte depends on +layout.server.ts data shape that an
    // isolated `render` call would have to mock.
    const settingsPage = fs.readFileSync(path.resolve("src/routes/settings/+page.svelte"), "utf8");
    expect(settingsPage).toContain("/keys/steam");
    expect(settingsPage).toContain("settings_credentials_heading");
    expect(settingsPage).toContain("settings_credentials_steam_link_label");
  });
});
