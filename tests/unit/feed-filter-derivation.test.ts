// Guards the /feed KIND-filter binding (Phase 10 D-08 — the user-reported
// regression: instagram_post + telegram_post never appeared in the LIVE /feed
// KIND axis because feed/+page.svelte carried a hand-maintained ordered array
// (KIND_AXIS_ORDER) that nobody updated when the social adapters shipped. The
// FiltersSheet was the /audit-only mount, so its earlier D-08 fix didn't touch
// the live /feed page).
//
// The fix is a SINGLE ORDERED BINDING: FEED_KIND_FILTER_KINDS in kind-display.ts
// is the source of ORDER, FEED_FILTERABLE_EVENT_KINDS is the source of
// MEMBERSHIP, and BOTH feed/+page.svelte AND FiltersSheet.svelte import the SAME
// FEED_KIND_FILTER_KINDS const. This test asserts the EXPORTED binding directly
// (not a locally re-implemented expression — that was vacuous): it pins the
// exact-set equality between the ordered list and the feedFilterable set, so if
// a future adapter sets feedFilterable but is forgotten in the order list (or
// vice versa), this fails; and if someone re-introduces a hand-list that drops a
// kind, this fails.

import { describe, it, expect } from "vitest";
import {
  FEED_KIND_FILTER_KINDS,
  FEED_FILTERABLE_EVENT_KINDS,
  eventKindLabel,
} from "../../src/lib/sources/kind-display.js";

describe("/feed KIND-filter binding is the shared ordered FEED_KIND_FILTER_KINDS (D-08)", () => {
  it("includes the social adapter kinds that were the regression", () => {
    // The regression: these were ABSENT from the live /feed KIND_AXIS_ORDER.
    expect(FEED_KIND_FILTER_KINDS).toContain("instagram_post");
    expect(FEED_KIND_FILTER_KINDS).toContain("telegram_post");
    // TikTok ships in this phase — it must be present from day one so it can
    // never be the NEXT silently-dropped adapter.
    expect(FEED_KIND_FILTER_KINDS).toContain("tiktok_post");
  });

  it("includes the long-present pollable + free-form kinds", () => {
    expect(FEED_KIND_FILTER_KINDS).toContain("youtube_video");
    expect(FEED_KIND_FILTER_KINDS).toContain("reddit_post");
    expect(FEED_KIND_FILTER_KINDS).toContain("post");
    expect(FEED_KIND_FILTER_KINDS).toContain("conference");
    expect(FEED_KIND_FILTER_KINDS).toContain("talk");
    expect(FEED_KIND_FILTER_KINDS).toContain("press");
    expect(FEED_KIND_FILTER_KINDS).toContain("other");
  });

  it("excludes the no-adapter kinds (filtering to an un-creatable kind is a footgun)", () => {
    expect(FEED_KIND_FILTER_KINDS).not.toContain("twitter_post");
    expect(FEED_KIND_FILTER_KINDS).not.toContain("discord_drop");
  });

  it("is EXACTLY the feedFilterable set (no hand-list drift — the load-bearing guard)", () => {
    // The ordered binding's kind SET must equal the feedFilterable membership
    // set exactly. This is what catches a future adapter marked feedFilterable
    // but forgotten in the order list (or a kind ordered here without the flag).
    expect([...FEED_KIND_FILTER_KINDS].sort()).toEqual([...FEED_FILTERABLE_EVENT_KINDS].sort());
  });

  it("has no duplicate kinds", () => {
    expect(new Set(FEED_KIND_FILTER_KINDS).size).toBe(FEED_KIND_FILTER_KINDS.length);
  });

  it("orders the paste-flow platforms ahead of the free-form catch-alls", () => {
    // The live /feed chip strip leads with the pollable paste-flow platforms
    // (the social adapters), then the free-form kinds. Pin the relative order
    // so the social kinds sit with their peers, not at the tail.
    const idx = (k: string): number => FEED_KIND_FILTER_KINDS.indexOf(k as never);
    expect(idx("youtube_video")).toBeLessThan(idx("instagram_post"));
    expect(idx("instagram_post")).toBeLessThan(idx("telegram_post"));
    expect(idx("telegram_post")).toBeLessThan(idx("tiktok_post"));
    // The free-form catch-alls come after the platform kinds.
    expect(idx("tiktok_post")).toBeLessThan(idx("post"));
    expect(idx("post")).toBeLessThan(idx("other"));
  });

  it("every kind resolves a non-empty label (the chips render text)", () => {
    for (const k of FEED_KIND_FILTER_KINDS) {
      expect(eventKindLabel(k).length).toBeGreaterThan(0);
    }
  });
});
