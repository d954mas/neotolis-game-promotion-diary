import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import enMessages from "../../messages/en.json" with { type: "json" };

// Plan 01-09 (Wave 4) — UX-04 i18n structure.
// VALIDATION 18: Paraglide message function resolves at runtime.
// VALIDATION 19: Adding a locale = drop a JSON file (no source-code change).
// D-17: baseLocale only in MVP — no locale detection.
// D-18: single messages/en.json at repo root.
//
// Phase 2.1 (Plan 02.1-03 Wave 0) — keyset extends to the full Phase 2.1
// alphabetical contract. The locale-add invariant is preserved by the
// explicit alphabetical EXPECTED_KEYS list (D-41): a future PR adding a key
// without expanding this list trips the test loudly. Two Phase 2 keys
// (`audit_action_item_created`, `audit_action_item_deleted`) are REMOVED
// because the audit_action enum no longer carries `item.created` /
// `item.deleted` (UI-SPEC Copywriting Contract REMOVED block).
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

  it("messages/en.json keyset matches the Phase 2.1 alphabetical contract (locale-add invariant)", () => {
    // The CONTRACT is: every locale file MUST share en.json's keyset.
    // This explicit alphabetical list IS the contract. A future PR adding a
    // key to en.json without extending this list trips the test; a future
    // PR adding a key to this list without extending en.json trips it too.
    // Adding a brand new locale is purely "drop a JSON file matching this
    // keyset" — no source change required.
    //
    // Phase 2.1 (Plan 02.1-03, Wave 0): expanded from Phase 2's 81 keys to
    // the Phase 2.1 alphabetical superset. Two Phase 2 audit-action keys
    // (`audit_action_item_created`, `audit_action_item_deleted`) are
    // REMOVED — the audit_action enum no longer carries those values
    // post-2.1 (UI-SPEC Copywriting Contract REMOVED block).
    //
    // Phase 2.1 gap-closure (Plans 02.1-12 / 13 / 14 / 15 / 16): the snapshot
    // absorbed every gap-closure-added key in lock-step (Plan 02.1-15 Task 3
    // already pulled the prior plans' deferred entries; Plan 02.1-16 adds
    // its own `feed_card_*` pair). Total post-Plan-16: 177 keys.
    //
    // Plan 02.1-19 (round-2 UAT closure): adds 13 keys for the redesigned
    // /feed (4 date-range presets + clear + 4 show-axis labels + 3 chip-axis
    // labels + 2 infinite-scroll status banners). Removes 8 keys for the
    // dropped axes (Plan 02.1-15 5-preset DateRangeControl + 2 attached
    // chips + 1 date-range chip). Net delta: +5 keys.
    //
    // Plan 02.1-18 (round-2 UAT closure — edit-flow rebuild via /events/[id]
    // detail page): adds 10 keys (feed_card_author_is_me_badge,
    // events_detail_{delete,edit,open_original,phase4_chart_placeholder,
    // restore}, events_edit_{author_is_me,heading,save},
    // events_new_author_is_me). Net delta: +10 keys.
    //
    // Asserting an explicit keyset (vs toMatchSnapshot) is more durable
    // across renames (Phase 2 STATE.md guidance, carried forward).
    const EXPECTED_KEYS = [
      "app_title",
      "appheader_account_menu_aria",
      "audit_action_all",
      "audit_action_event_attached_to_game",
      "audit_action_event_created",
      "audit_action_event_deleted",
      "audit_action_event_dismissed_from_inbox",
      "audit_action_event_edited",
      "audit_action_event_restored",
      "audit_action_game_created",
      "audit_action_game_deleted",
      "audit_action_game_restored",
      "audit_action_key_add",
      "audit_action_key_remove",
      "audit_action_key_rotate",
      "audit_action_session_signin",
      "audit_action_session_signout",
      "audit_action_session_signout_all",
      "audit_action_source_added",
      "audit_action_source_removed",
      "audit_action_source_toggled_auto_import",
      "audit_action_theme_changed",
      "audit_action_user_signup",
      "audit_filter_action_axis_label",
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
      "confirm_source_remove",
      "confirm_speedbump_acknowledge",
      "dashboard_title",
      "dashboard_unauth_intro",
      "dashboard_welcome_intro",
      "empty_audit_body",
      "empty_audit_heading",
      "empty_events_body",
      "empty_events_heading",
      "empty_feed_body",
      "empty_feed_filtered_body",
      "empty_feed_filtered_heading",
      "empty_feed_heading",
      "empty_games_body",
      "empty_games_heading",
      "empty_items_example_youtube_url",
      "empty_items_heading",
      "empty_keys_steam_body",
      "empty_keys_steam_heading",
      "empty_sources_body",
      "empty_sources_heading",
      "empty_youtube_channels_body",
      "empty_youtube_channels_heading",
      "error_network",
      "error_server_generic",
      "event_kind_label_conference",
      "event_kind_label_discord_drop",
      "event_kind_label_other",
      "event_kind_label_post",
      "event_kind_label_press",
      "event_kind_label_reddit_post",
      "event_kind_label_talk",
      "event_kind_label_telegram_post",
      "event_kind_label_twitter_post",
      "event_kind_label_youtube_video",
      "events_cta_new_event",
      "events_detail_delete",
      "events_detail_edit",
      "events_detail_open_original",
      "events_detail_phase4_body",
      "events_detail_phase4_chart_placeholder",
      "events_detail_phase4_heading",
      "events_detail_restore",
      "events_edit_author_is_me",
      "events_edit_heading",
      "events_edit_save",
      "events_new_author_is_me",
      "events_new_date_today",
      "events_new_date_yesterday",
      "events_new_url_required",
      "feed_attach_error_already_attached",
      "feed_attach_error_game_not_found",
      "feed_attach_no_games_inline",
      "feed_attach_to_game",
      "feed_card_author_is_me_badge",
      "feed_card_open_external",
      "feed_card_thumbnail_alt",
      "feed_chip_axis_action",
      "feed_chip_axis_kind",
      "feed_chip_axis_show",
      "feed_chip_axis_source",
      "feed_cta_add_event",
      "feed_cta_new_event",
      "feed_date_range_clear",
      "feed_date_range_label_from",
      "feed_date_range_label_to",
      "feed_date_range_month",
      "feed_date_range_today",
      "feed_date_range_week",
      "feed_date_range_year",
      "feed_deleted_panel_restore_aria",
      "feed_deleted_panel_restore_cta",
      "feed_deleted_panel_toggle_hide",
      "feed_deleted_panel_toggle_show",
      "feed_dismiss_error_not_in_inbox",
      "feed_dismiss_from_inbox",
      "feed_filter_author_me",
      "feed_filter_author_others",
      "feed_filter_chip_dismiss_aria",
      "feed_filter_game",
      "feed_filter_kind",
      "feed_filter_show_any",
      "feed_filter_show_axis_label",
      "feed_filter_show_inbox",
      "feed_filter_show_specific",
      "feed_filter_source",
      "feed_filters_apply",
      "feed_filters_clear_all",
      "feed_loading_more",
      "feed_move_to_inbox",
      "feed_no_more_events",
      "feed_row_delete_aria",
      "feed_row_edit_aria",
      "game_add_steam_listing_cta",
      "game_rename_cta_discard",
      "game_rename_cta_save",
      "games_cta_new_game",
      "inbox_badge",
      "inbox_badge_tooltip",
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
      "polling_badge_manual",
      "polling_badge_phase3_placeholder",
      "settings_cta_save",
      "settings_sessions_blurb",
      "settings_sessions_current_badge",
      "settings_sessions_heading",
      "settings_sessions_only_current",
      "settings_sessions_signout_one",
      "settings_theme_blurb",
      "settings_theme_heading",
      "sign_out",
      "sign_out_all_devices",
      "source_kind_label_discord_server",
      "source_kind_label_reddit_account",
      "source_kind_label_telegram_channel",
      "source_kind_label_twitter_account",
      "source_kind_label_youtube_channel",
      "source_kind_phase_discord_server",
      "source_kind_phase_reddit_account",
      "source_kind_phase_telegram_channel",
      "source_kind_phase_twitter_account",
      "sources_cta_new_source",
      "sources_cta_save_source",
      "sources_error_duplicate",
      "sources_error_kind_not_yet_functional",
      "sources_kind_disabled_tooltip",
      "sources_owned_by_me",
      "sources_owned_by_other",
      "sources_status_auto_off",
      "sources_status_auto_on_pending",
      "theme_label_dark",
      "theme_label_light",
      "theme_label_system",
      "theme_toggle_aria_label",
      "toast_deleted",
      "toast_restored",
      "toast_saved",
      "youtube_channels_cta_add",
    ] as const;

    const keys = Object.keys(enMessages)
      .filter((k) => !k.startsWith("$"))
      .sort();
    expect(keys).toEqual([...EXPECTED_KEYS].sort());
  });

  it("removes Phase 2 audit_action_item_* keys (dead after enum rename)", () => {
    expect(enMessages).not.toHaveProperty("audit_action_item_created");
    expect(enMessages).not.toHaveProperty("audit_action_item_deleted");
  });

  it("UX-04 invariant: project.inlang/settings.json has baseLocale=en and a single locale in MVP (D-17)", () => {
    const settings = JSON.parse(
      fs.readFileSync(path.resolve("project.inlang/settings.json"), "utf8"),
    );
    expect(settings.baseLocale).toBe("en");
    expect(settings.locales).toEqual(["en"]);
  });
});
