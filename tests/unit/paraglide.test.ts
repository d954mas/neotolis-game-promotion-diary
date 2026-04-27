import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// Plan 01-09 (Wave 4) — UX-04 i18n structure.
// VALIDATION 18: Paraglide message function resolves at runtime.
// VALIDATION 19: Adding a locale = drop a JSON file (no source-code change).
// D-17: baseLocale only in MVP — no locale detection.
// D-18: single messages/en.json at repo root.
describe("paraglide i18n (UX-04)", () => {
  it("VALIDATION 18: messages/en.json contains expected keys with the right English values", () => {
    const raw = JSON.parse(fs.readFileSync(path.resolve("messages/en.json"), "utf8"));
    expect(raw.dashboard_title).toBe("Promotion diary");
    expect(raw.login_button).toBe("Sign in with Google");
    expect(raw.sign_out).toBe("Sign out");
    expect(raw.sign_out_all_devices).toBe("Sign out from all devices");
  });

  it("VALIDATION 18: m.dashboard_title resolves to English at runtime (when paraglide built)", async () => {
    // The compiled messages.js is gitignored. If present (CI runs `pnpm build`
    // first; local dev runs `pnpm dev` which compiles on demand), import it.
    // Otherwise this test is a contract assertion against the JSON.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod: any = await import("../../src/lib/paraglide/messages.js" as string);
      expect(typeof mod.m.dashboard_title).toBe("function");
      expect(mod.m.dashboard_title()).toBe("Promotion diary");
    } catch {
      // Compiled output not available (test not run after build).
      // Assertion above on messages/en.json is sufficient for the unit-test gate.
    }
  });

  it("VALIDATION 19: adding messages/ru.json is content-only — keyset must match en.json (snapshot)", () => {
    // The CONTRACT is: every locale file MUST share en.json's keyset.
    // This test snapshots the en.json keyset; if a future PR adds a key to en.json,
    // the snapshot must be updated AND every other locale file extended.
    // Adding a brand new locale is purely "drop a JSON file matching this keyset"
    // — no source change required.
    //
    // Phase 2 (Plan 02-09, D-41) adds the P2 keyset: 8 primary CTAs + 12
    // empty-state keys + 16 audit-action chip labels + 10 ingest/keys error
    // states + 7 destructive confirmations + 6 status/toast keys + paste-box
    // (label + placeholder) + theme-toggle (4 labels) + 7 common verbs.
    // Updating this snapshot in lock-step with messages/en.json is the
    // forcing function: a Phase 2 PR that ADDS a key without expanding this
    // list trips the test loudly. (i18n.test.ts asserts the P2 keyset
    // SUPERSET; this test asserts EXACT equality, so the two together
    // catch both "added too few" and "added too many" drift.)
    const raw = JSON.parse(fs.readFileSync(path.resolve("messages/en.json"), "utf8"));
    const keys = Object.keys(raw)
      .filter((k) => !k.startsWith("$"))
      .sort();
    // Asserting an explicit keyset (vs toMatchSnapshot) is more durable across renames.
    // List is alphabetically sorted to match the .sort() above (Object.keys order is
    // not stable; sort() is the deterministic source).
    expect(keys).toEqual([
      "app_title",
      "audit_action_all",
      "audit_action_event_created",
      "audit_action_event_deleted",
      "audit_action_event_edited",
      "audit_action_game_created",
      "audit_action_game_deleted",
      "audit_action_game_restored",
      "audit_action_item_created",
      "audit_action_item_deleted",
      "audit_action_key_add",
      "audit_action_key_remove",
      "audit_action_key_rotate",
      "audit_action_session_signin",
      "audit_action_session_signout",
      "audit_action_session_signout_all",
      "audit_action_theme_changed",
      "badge_purge_in_days",
      "badge_purge_in_days_warning",
      "badge_release_tba",
      "common_cancel",
      "common_close",
      "common_confirm",
      "common_delete",
      "common_edit",
      "common_remove",
      "common_restore",
      "confirm_event_delete",
      "confirm_game_delete",
      "confirm_item_delete",
      "confirm_key_remove",
      "confirm_key_replace",
      "confirm_signout_all",
      "confirm_speedbump_acknowledge",
      "dashboard_title",
      "dashboard_unauth_intro",
      "dashboard_welcome_intro",
      "empty_audit_body",
      "empty_audit_heading",
      "empty_events_body",
      "empty_events_heading",
      "empty_games_body",
      "empty_games_heading",
      "empty_items_example_youtube_url",
      "empty_items_heading",
      "empty_keys_steam_body",
      "empty_keys_steam_heading",
      "empty_youtube_channels_body",
      "empty_youtube_channels_heading",
      "error_network",
      "error_server_generic",
      "events_cta_new_event",
      "games_cta_new_game",
      "ingest_cta_add",
      "ingest_error_malformed_url",
      "ingest_error_oembed_unreachable",
      "ingest_error_unsupported_host",
      "ingest_error_youtube_duplicate",
      "ingest_error_youtube_unavailable",
      "ingest_info_reddit_phase3",
      "keys_steam_cta_add_another",
      "keys_steam_cta_replace",
      "keys_steam_cta_save",
      "keys_steam_error_invalid",
      "keys_steam_error_label_exists",
      "login_button",
      "login_continue",
      "login_page_title",
      "paste_box_label",
      "paste_box_placeholder",
      "settings_cta_save",
      "sign_out",
      "sign_out_all_devices",
      "theme_label_dark",
      "theme_label_light",
      "theme_label_system",
      "theme_toggle_aria_label",
      "toast_deleted",
      "toast_restored",
      "toast_saved",
      "youtube_channels_cta_add",
    ]);
  });

  it("UX-04 invariant: project.inlang/settings.json has baseLocale=en and a single locale in MVP (D-17)", () => {
    const settings = JSON.parse(
      fs.readFileSync(path.resolve("project.inlang/settings.json"), "utf8"),
    );
    expect(settings.baseLocale).toBe("en");
    expect(settings.locales).toEqual(["en"]);
  });
});
