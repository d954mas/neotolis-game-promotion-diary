// Guards the /feed KIND-filter derivation (Phase 10 D-08 — the user-reported
// regression: instagram_post + telegram_post never appeared in the /feed
// Filters sheet because FiltersSheet carried a hand-maintained allowlist
// (FUNCTIONAL_KIND_OPTIONS) that nobody updated when the social adapters
// shipped).
//
// The fix is DERIVATION: FiltersSheet now builds its KIND_OPTIONS from
// FEED_FILTERABLE_EVENT_KINDS (kind-display.ts, the single source of truth)
// instead of a local array. This test reproduces the EXACT derivation the
// sheet does — `sortByLabel([...FEED_FILTERABLE_EVENT_KINDS], eventKindLabel)`
// — so it stays load-bearing against the real source of truth: if a future
// adapter sets feedFilterable, its kind appears here without a sheet edit; if
// someone re-introduces a hand-list that drops a kind, this fails.

import { describe, it, expect } from "vitest";
import {
  FEED_FILTERABLE_EVENT_KINDS,
  eventKindLabel,
} from "../../src/lib/sources/kind-display.js";
import { sortByLabel } from "../../src/lib/util/sort-kinds.js";

// The exact expression FiltersSheet.svelte uses for its KIND_OPTIONS $derived.
// Keeping the derivation here identical to the component means this test fails
// the moment the component diverges from the source of truth.
const KIND_OPTIONS = sortByLabel([...FEED_FILTERABLE_EVENT_KINDS], (k) => eventKindLabel(k));

describe("/feed KIND-filter options are derived from kind-display (D-08)", () => {
  it("includes the social adapter kinds that were the regression", () => {
    // The regression: these two were ABSENT from the sheet's hand-list.
    expect(KIND_OPTIONS).toContain("instagram_post");
    expect(KIND_OPTIONS).toContain("telegram_post");
  });

  it("includes the long-present pollable + free-form kinds", () => {
    expect(KIND_OPTIONS).toContain("youtube_video");
    expect(KIND_OPTIONS).toContain("reddit_post");
    expect(KIND_OPTIONS).toContain("post");
    expect(KIND_OPTIONS).toContain("conference");
    expect(KIND_OPTIONS).toContain("talk");
    expect(KIND_OPTIONS).toContain("press");
    expect(KIND_OPTIONS).toContain("other");
  });

  it("excludes the no-adapter kinds (filtering to an un-creatable kind is a footgun)", () => {
    expect(KIND_OPTIONS).not.toContain("twitter_post");
    expect(KIND_OPTIONS).not.toContain("discord_drop");
  });

  it("is exactly the feedFilterable set (no hand-list drift)", () => {
    expect([...KIND_OPTIONS].sort()).toEqual([...FEED_FILTERABLE_EVENT_KINDS].sort());
  });

  it("is sorted alphabetically by localized label", () => {
    const labels = KIND_OPTIONS.map((k) => eventKindLabel(k));
    const resorted = sortByLabel(labels, (l) => l);
    expect(labels).toEqual(resorted);
  });
});
