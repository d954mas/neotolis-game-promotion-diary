// Belt-and-suspenders runtime coverage for the central kind-display config
// (src/lib/sources/kind-display.ts). The `satisfies Record<EventKind, …>` /
// `Record<SourceKind, …>` constraints already make a MISSING key a COMPILE
// error; this test guards the OTHER direction at runtime — every key resolves
// a non-empty label and carries the required flags — and that the derived
// helper sets stay in lockstep with the per-kind flags.
//
// The kind rosters below are the authoritative EventKind / SourceKind unions
// from adapter.ts, copied as literal arrays so a NEW kind added to the union
// without a config entry fails the `satisfies` in the source (compile) AND, if
// the roster here is updated, surfaces as a missing-entry runtime failure too.

import { describe, it, expect } from "vitest";
import {
  EVENT_KIND_DISPLAY,
  SOURCE_KIND_DISPLAY,
  POLLABLE_EVENT_KINDS,
  CHARTABLE_EVENT_KINDS,
  FEED_FILTERABLE_EVENT_KINDS,
  MANUAL_EVENT_KINDS,
  SOURCE_PLATFORM_GROUPS,
  eventKindLabel,
  sourceKindDisplayLabel,
  sourcePlatformGroupKey,
} from "../../src/lib/sources/kind-display.js";
import type { EventKind, SourceKind } from "../../src/lib/sources/adapter.js";

// Authoritative rosters (mirror the adapter.ts unions). `satisfies` keeps these
// honest: if they drift from EventKind / SourceKind, tsc flags it here.
const ALL_EVENT_KINDS = [
  "youtube_video",
  "twitter_post",
  "telegram_post",
  "discord_drop",
  "reddit_post",
  "conference",
  "talk",
  "press",
  "other",
  "post",
  "instagram_post",
  "tiktok_post",
] as const satisfies readonly EventKind[];

const ALL_SOURCE_KINDS = [
  "youtube_channel",
  "reddit_account",
  "reddit_subreddit",
  "twitter_account",
  "telegram_channel",
  "discord_server",
  "instagram_account",
  "tiktok_account",
] as const satisfies readonly SourceKind[];

describe("kind-display config — EVENT_KIND_DISPLAY", () => {
  it("has an entry for every EventKind", () => {
    for (const k of ALL_EVENT_KINDS) {
      expect(EVENT_KIND_DISPLAY[k], `missing EVENT_KIND_DISPLAY entry for ${k}`).toBeDefined();
    }
    // No stray extra keys beyond the union.
    expect(Object.keys(EVENT_KIND_DISPLAY).sort()).toEqual([...ALL_EVENT_KINDS].sort());
  });

  it("every entry resolves a non-empty label and has boolean pollable/chartable", () => {
    for (const k of ALL_EVENT_KINDS) {
      const d = EVENT_KIND_DISPLAY[k];
      const label = d.label();
      expect(typeof label, `${k} label must be a string`).toBe("string");
      expect(label.length, `${k} label must be non-empty`).toBeGreaterThan(0);
      expect(typeof d.pollable).toBe("boolean");
      expect(typeof d.chartable).toBe("boolean");
      expect(typeof d.manualCreatable).toBe("boolean");
      expect(typeof d.feedFilterable).toBe("boolean");
    }
  });

  it("eventKindLabel falls back to the Other label for an unknown kind", () => {
    expect(eventKindLabel("not_a_real_kind")).toBe(EVENT_KIND_DISPLAY.other.label());
    expect(eventKindLabel("youtube_video")).toBe(EVENT_KIND_DISPLAY.youtube_video.label());
  });
});

describe("kind-display config — SOURCE_KIND_DISPLAY", () => {
  it("has an entry for every SourceKind", () => {
    for (const k of ALL_SOURCE_KINDS) {
      expect(SOURCE_KIND_DISPLAY[k], `missing SOURCE_KIND_DISPLAY entry for ${k}`).toBeDefined();
    }
    expect(Object.keys(SOURCE_KIND_DISPLAY).sort()).toEqual([...ALL_SOURCE_KINDS].sort());
  });

  it("every entry resolves a non-empty label + a platformGroup with key/label/order", () => {
    for (const k of ALL_SOURCE_KINDS) {
      const d = SOURCE_KIND_DISPLAY[k];
      const label = d.label();
      expect(label.length, `${k} label must be non-empty`).toBeGreaterThan(0);
      expect(typeof d.platformGroup.key).toBe("string");
      expect(d.platformGroup.key.length).toBeGreaterThan(0);
      expect(typeof d.platformGroup.label).toBe("string");
      expect(typeof d.platformGroup.order).toBe("number");
    }
  });

  it("reddit_account and reddit_subreddit share one platform group", () => {
    expect(sourcePlatformGroupKey("reddit_account")).toBe(
      sourcePlatformGroupKey("reddit_subreddit"),
    );
    expect(sourcePlatformGroupKey("reddit_account")).toBe("reddit");
  });

  it("instagram_account maps to its own Instagram group", () => {
    expect(sourcePlatformGroupKey("instagram_account")).toBe("instagram");
    const ig = SOURCE_PLATFORM_GROUPS.find((g) => g.key === "instagram");
    expect(ig?.label).toBe("Instagram");
  });

  it("sourceKindDisplayLabel resolves the config label", () => {
    expect(sourceKindDisplayLabel("instagram_account")).toBe(
      SOURCE_KIND_DISPLAY.instagram_account.label(),
    );
  });
});

describe("kind-display config — derived helper sets stay in lockstep", () => {
  it("POLLABLE_EVENT_KINDS equals exactly the pollable=true entries", () => {
    const expected = ALL_EVENT_KINDS.filter((k) => EVENT_KIND_DISPLAY[k].pollable);
    expect([...POLLABLE_EVENT_KINDS].sort()).toEqual([...expected].sort());
    // Sanity: the four polled kinds are in, a free-form kind is out.
    expect(POLLABLE_EVENT_KINDS.has("youtube_video")).toBe(true);
    expect(POLLABLE_EVENT_KINDS.has("reddit_post")).toBe(true);
    expect(POLLABLE_EVENT_KINDS.has("instagram_post")).toBe(true);
    // Phase 09 — telegram_post is now polled (free t.me/s listing + warm lane).
    expect(POLLABLE_EVENT_KINDS.has("telegram_post")).toBe(true);
    expect(POLLABLE_EVENT_KINDS.has("post")).toBe(false);
    expect(POLLABLE_EVENT_KINDS.has("conference")).toBe(false);
    // Still-deferred kinds stay out.
    expect(POLLABLE_EVENT_KINDS.has("twitter_post")).toBe(false);
    expect(POLLABLE_EVENT_KINDS.has("discord_drop")).toBe(false);
  });

  it("CHARTABLE_EVENT_KINDS equals exactly the chartable=true entries", () => {
    const expected = ALL_EVENT_KINDS.filter((k) => EVENT_KIND_DISPLAY[k].chartable);
    expect([...CHARTABLE_EVENT_KINDS].sort()).toEqual([...expected].sort());
    expect(CHARTABLE_EVENT_KINDS.has("instagram_post")).toBe(true);
    // Phase 09 — telegram_post charts its view_count series.
    expect(CHARTABLE_EVENT_KINDS.has("telegram_post")).toBe(true);
    expect(CHARTABLE_EVENT_KINDS.has("other")).toBe(false);
  });

  it("FEED_FILTERABLE_EVENT_KINDS equals exactly the feedFilterable=true entries", () => {
    const expected = ALL_EVENT_KINDS.filter((k) => EVENT_KIND_DISPLAY[k].feedFilterable);
    expect([...FEED_FILTERABLE_EVENT_KINDS].sort()).toEqual([...expected].sort());
    // Phase 10 D-08 — the user-reported regression: the social adapter kinds
    // were missing from the /feed KIND axis. They MUST be members now, and a
    // new adapter kind auto-appears the moment it's marked feedFilterable.
    expect(FEED_FILTERABLE_EVENT_KINDS.has("youtube_video")).toBe(true);
    expect(FEED_FILTERABLE_EVENT_KINDS.has("reddit_post")).toBe(true);
    expect(FEED_FILTERABLE_EVENT_KINDS.has("instagram_post")).toBe(true);
    expect(FEED_FILTERABLE_EVENT_KINDS.has("telegram_post")).toBe(true);
    // Free-form kinds stay filterable (they were never the regression).
    expect(FEED_FILTERABLE_EVENT_KINDS.has("post")).toBe(true);
    expect(FEED_FILTERABLE_EVENT_KINDS.has("other")).toBe(true);
    // No-adapter kinds stay OUT — filtering to a kind you can't create is a
    // footgun (same rationale as manualCreatable:false).
    expect(FEED_FILTERABLE_EVENT_KINDS.has("twitter_post")).toBe(false);
    expect(FEED_FILTERABLE_EVENT_KINDS.has("discord_drop")).toBe(false);
  });
});

describe("kind-display config — Add Event manual picker is config-driven + in sync", () => {
  // The Add Event kind picker (AddEventForm.svelte) renders MANUAL_EVENT_KINDS
  // verbatim. MANUAL_EVENT_KINDS is an EXPLICIT ordered list (chip order is a
  // UX choice the boolean flag can't express); this test is the guard that the
  // ORDER list can never drift from the MEMBERSHIP flags — its kind SET must
  // equal exactly the set of `manualCreatable: true` entries in
  // EVENT_KIND_DISPLAY. So a future kind added with manualCreatable:true but
  // forgotten in the picker list (or vice versa) fails HERE.
  //
  // The `satisfies Record<EventKind, EventKindDisplay>` on EVENT_KIND_DISPLAY
  // is the COMPILE-TIME complement: a new EventKind MUST declare manualCreatable
  // or `pnpm typecheck` fails — it can't be silently omitted from the decision.
  // Together: compile-time forces the flag to exist; this runtime test forces
  // the ordered picker list to agree with it.

  it("MANUAL_EVENT_KINDS equals exactly the manualCreatable=true entries", () => {
    const flagged = ALL_EVENT_KINDS.filter((k) => EVENT_KIND_DISPLAY[k].manualCreatable);
    expect([...MANUAL_EVENT_KINDS].sort()).toEqual([...flagged].sort());
  });

  it("every kind in MANUAL_EVENT_KINDS has manualCreatable:true", () => {
    for (const k of MANUAL_EVENT_KINDS) {
      expect(EVENT_KIND_DISPLAY[k].manualCreatable, `${k} must be manualCreatable`).toBe(true);
    }
  });

  it("includes instagram_post (Phase 08) + telegram_post (Phase 09) + tiktok_post (Phase 10) and excludes the still-deferred kinds", () => {
    const set = new Set<string>(MANUAL_EVENT_KINDS);
    expect(set.has("instagram_post")).toBe(true);
    // Phase 09 — telegram_post joins the paste-flow kinds (free t.me/s).
    expect(set.has("telegram_post")).toBe(true);
    // Phase 10 — tiktok_post joins the paste-flow kinds (paid ScrapeCreators).
    expect(set.has("tiktok_post")).toBe(true);
    // The deferred kinds (no adapter, no paste flow, filtered from /feed) must
    // NOT be manually creatable — letting a user create un-filterable events
    // is the footgun manualCreatable:false prevents.
    expect(set.has("twitter_post")).toBe(false);
    expect(set.has("discord_drop")).toBe(false);
  });

  it("preserves the picker order (instagram after reddit, telegram after instagram, tiktok after telegram)", () => {
    const ri = MANUAL_EVENT_KINDS.indexOf("reddit_post");
    const ii = MANUAL_EVENT_KINDS.indexOf("instagram_post");
    const ti = MANUAL_EVENT_KINDS.indexOf("telegram_post");
    const tk = MANUAL_EVENT_KINDS.indexOf("tiktok_post");
    expect(ri).toBeGreaterThanOrEqual(0);
    expect(ii).toBe(ri + 1);
    expect(ti).toBe(ii + 1);
    expect(tk).toBe(ti + 1);
  });
});
