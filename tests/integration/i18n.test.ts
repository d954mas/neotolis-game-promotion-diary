import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// i18n at runtime. End-to-end "render a SvelteKit page through Hono and grep
// English text from the response body" lands in the Docker smoke test
// (which boots the actual built image). At the integration-test layer we
// assert two contracts that tie .svelte files to messages/en.json:
//
//   1. Every m.<key>(...) reference in src/routes/*.svelte and
//      src/lib/components/*.svelte MUST resolve to a key defined in
//      messages/en.json (catches typos that the TypeScript build-time check
//      would also catch via Paraglide's typed exports — but matters in
//      addition because this test runs without requiring the Paraglide
//      compile step to have produced output yet).
//
//   2. The required keyset must be present in en.json. Adding a
//      key to en.json is content-only — the locale-add invariant says any
//      future locale (e.g. messages/ru.json) is a content addition, not
//      a code change. Asserting the keyset HERE protects that contract:
//      a future translator needs to provide values for exactly this list.
describe("i18n at runtime", () => {
  it("messages/en.json exists, is valid JSON, and contains every key referenced by .svelte files", () => {
    const raw = JSON.parse(fs.readFileSync(path.resolve("messages/en.json"), "utf8"));
    // Grep .svelte files for m.<key>(...) references and assert each key exists.
    const candidates = [
      path.resolve("src/routes/+page.svelte"),
      path.resolve("src/routes/login/+page.svelte"),
      path.resolve("src/routes/+layout.svelte"),
    ];
    // Sweep the whole components directory so a future component using a
    // typo'd key trips the assertion immediately.
    const componentsDir = path.resolve("src/lib/components");
    if (fs.existsSync(componentsDir)) {
      for (const f of fs.readdirSync(componentsDir)) {
        if (f.endsWith(".svelte")) candidates.push(path.join(componentsDir, f));
      }
    }
    const svelteFiles = candidates.filter((f) => fs.existsSync(f));
    const usedKeys = new Set<string>();
    // The leading negative lookbehind anchors the `m` as a standalone
    // identifier — without it, any `<ident-ending-in-m>.method(` (e.g.
    // `form.append(`) matches the `m.append(` substring and is mistaken for a
    // message key.
    const re = /(?<![A-Za-z0-9_$.])m\.([a-z][a-z_0-9]*)\s*\(/g;
    for (const f of svelteFiles) {
      const src = fs.readFileSync(f, "utf8");
      let match: RegExpExecArray | null;
      while ((match = re.exec(src)) !== null) {
        usedKeys.add(match[1]!);
      }
    }
    expect(usedKeys.size).toBeGreaterThan(0);
    for (const key of usedKeys) {
      expect(raw, `messages/en.json missing key referenced from .svelte: ${key}`).toHaveProperty(
        key,
      );
    }
  });

  it("required keyset present in messages/en.json (locale-add invariant)", () => {
    const raw = JSON.parse(fs.readFileSync(path.resolve("messages/en.json"), "utf8"));
    // The required copywriting keyset. Adding a key here without adding it to
    // en.json (or vice versa) trips this test. Removing a key here without
    // removing the .svelte references trips the previous test.
    const required = [
      // Primary CTAs (per page)
      "games_cta_new_game",
      "events_cta_new_event",
      "keys_steam_cta_save",
      "keys_steam_cta_replace",
      "keys_steam_cta_add_another",
      "youtube_channels_cta_add",
      "settings_cta_save",
      // Empty states (heading + body pairs, plus the YouTube example variant)
      "empty_games_heading",
      "empty_games_body",
      "empty_items_heading",
      "empty_items_example_youtube_url",
      "empty_events_heading",
      "empty_events_body",
      "empty_audit_heading",
      "empty_audit_body",
      "empty_youtube_channels_heading",
      "empty_youtube_channels_body",
      "empty_keys_steam_heading",
      "empty_keys_steam_body",
      // Audit-action chip labels (closed-list, one per audit_log.action)
      "audit_action_all",
      "audit_action_session_signin",
      "audit_action_session_signout",
      "audit_action_session_signout_all",
      "audit_action_key_add",
      "audit_action_key_rotate",
      "audit_action_key_remove",
      "audit_action_game_created",
      "audit_action_game_deleted",
      "audit_action_game_restored",
      // item.* → event.* audit verb rename: the key family converges on
      // audit_action_event_* under the unified events table.
      "audit_action_event_created",
      "audit_action_event_edited",
      "audit_action_event_deleted",
      "audit_action_theme_changed",
      // Error states (reject-inline)
      "ingest_error_malformed_url",
      "keys_steam_error_invalid",
      "keys_steam_error_label_exists",
      "error_server_generic",
      "error_network",
      // Destructive confirmations
      "confirm_game_delete",
      "confirm_event_delete",
      "confirm_item_delete",
      "confirm_key_remove",
      "confirm_key_replace",
      "confirm_signout_all",
      // Status badges + toasts
      "badge_release_tba",
      "badge_purge_in_days",
      "badge_purge_in_days_warning",
      "toast_saved",
      "toast_deleted",
      "toast_restored",
    ];
    for (const k of required) {
      expect(raw, `keyset missing key: ${k}`).toHaveProperty(k);
    }
  });
});
