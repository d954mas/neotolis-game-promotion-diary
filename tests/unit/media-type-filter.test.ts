// Unit guard for the cross-source MEDIA-TYPE feed filter vocabulary
// (src/lib/feed/media-type-filter.ts) — the single source of truth for the
// Short / Video / Other axis (user-requested 2026-06-12).
//
// The load-bearing invariants:
//   1. PARTITION: every per-post media kind AND every EventKind classifies into
//      EXACTLY ONE category. No kind is uncovered (would vanish from all three
//      filters); no kind is double-counted.
//   2. The kind-level defaults match the user-locked mapping (per-post kinds
//      instagram_post / tiktok_post / youtube_video → "per-post"; everything
//      else → other).
//   3. The derived helpers (PER_POST_MEDIA_KINDS, kindLevelKindsForCategory)
//      never drift from the map.

import { describe, it, expect } from "vitest";
import {
  MEDIA_FILTER_CATEGORIES,
  EVENT_KIND_MEDIA_CATEGORY,
  PER_POST_MEDIA_KINDS,
  postMediaKindToCategory,
  kindLevelKindsForCategory,
  isMediaTypeCategory,
  type MediaTypeCategory,
  type PostMediaKind,
} from "../../src/lib/feed/media-type-filter.js";
import type { EventKind } from "../../src/lib/sources/adapter.js";

// The full EventKind union — kept in lock-step with src/lib/sources/adapter.ts.
// A new kind here without a classification in EVENT_KIND_MEDIA_CATEGORY fails
// typecheck (the `satisfies Record<EventKind, …>` guard); a new kind there
// without a row here fails the partition test below.
const ALL_EVENT_KINDS: EventKind[] = [
  "youtube_video",
  "reddit_post",
  "instagram_post",
  "tiktok_post",
  "twitter_post",
  "telegram_post",
  "discord_drop",
  "conference",
  "talk",
  "press",
  "other",
  "post",
];

// Every NormalizedPost["kind"] value.
const ALL_POST_MEDIA_KINDS: PostMediaKind[] = ["video", "short", "image", "carousel", "text"];

describe("media-type-filter vocabulary (Short / Video / Other)", () => {
  it("the three categories are exactly short / video / other in order", () => {
    expect(MEDIA_FILTER_CATEGORIES).toEqual(["short", "video", "other"]);
  });

  it("every per-post media kind classifies into EXACTLY ONE category (total function)", () => {
    for (const k of ALL_POST_MEDIA_KINDS) {
      const cat = postMediaKindToCategory(k);
      expect(MEDIA_FILTER_CATEGORIES, `${k} → ${cat} must be a real category`).toContain(cat);
    }
  });

  it("the per-post media kind → category mapping matches the user-locked spec", () => {
    expect(postMediaKindToCategory("short")).toBe("short");
    expect(postMediaKindToCategory("video")).toBe("video");
    expect(postMediaKindToCategory("image")).toBe("other");
    expect(postMediaKindToCategory("carousel")).toBe("other");
    expect(postMediaKindToCategory("text")).toBe("other");
  });

  it("every EventKind has a classification (no kind uncovered → none vanishes)", () => {
    for (const k of ALL_EVENT_KINDS) {
      const classification = EVENT_KIND_MEDIA_CATEGORY[k];
      expect(
        classification === "per-post" ||
          (MEDIA_FILTER_CATEGORIES as readonly string[]).includes(classification),
        `${k} must classify into a category OR be per-post`,
      ).toBe(true);
    }
  });

  it("the kind-level defaults match the user-locked spec", () => {
    // Per-post kinds. youtube_video joined the per-post set when Shorts
    // detection shipped (media_type 'short' → short, else video — its server
    // SQL + filter-math arms special-case the NULL→video default).
    expect(EVENT_KIND_MEDIA_CATEGORY.instagram_post).toBe("per-post");
    expect(EVENT_KIND_MEDIA_CATEGORY.tiktok_post).toBe("per-post");
    expect(EVENT_KIND_MEDIA_CATEGORY.youtube_video).toBe("per-post");
    // twitter_post joined the per-post set in Phase 11 (D-06): media_type lives
    // on twitter_posts ('video' → video; 'image'/'text'/missing → other).
    expect(EVENT_KIND_MEDIA_CATEGORY.twitter_post).toBe("per-post");
    // Everything else → other.
    for (const k of [
      "reddit_post",
      "telegram_post",
      "discord_drop",
      "conference",
      "talk",
      "press",
      "other",
      "post",
    ] as const) {
      expect(EVENT_KIND_MEDIA_CATEGORY[k], `${k} → other`).toBe("other");
    }
  });

  it("PER_POST_MEDIA_KINDS is exactly the per-post entries of the map (no drift)", () => {
    const derived = ALL_EVENT_KINDS.filter((k) => EVENT_KIND_MEDIA_CATEGORY[k] === "per-post");
    expect([...PER_POST_MEDIA_KINDS].sort()).toEqual(derived.sort());
    // The current per-post kinds are exactly instagram_post + tiktok_post +
    // twitter_post + youtube_video (youtube joined when Shorts detection
    // shipped; twitter joined in Phase 11 D-06).
    expect([...PER_POST_MEDIA_KINDS].sort()).toEqual([
      "instagram_post",
      "tiktok_post",
      "twitter_post",
      "youtube_video",
    ]);
  });

  it("kindLevelKindsForCategory partitions the NON-per-post kinds exactly once", () => {
    const seen = new Set<EventKind>();
    for (const category of MEDIA_FILTER_CATEGORIES) {
      for (const k of kindLevelKindsForCategory(category)) {
        // No kind appears in two categories' kind-level lists.
        expect(seen.has(k), `${k} appears in more than one category's kind-level list`).toBe(false);
        seen.add(k);
        // A kind-level kind is never a per-post kind.
        expect(PER_POST_MEDIA_KINDS.has(k)).toBe(false);
      }
    }
    // The union of all kind-level kinds == every non-per-post EventKind.
    const nonPerPost = ALL_EVENT_KINDS.filter((k) => !PER_POST_MEDIA_KINDS.has(k));
    expect([...seen].sort()).toEqual(nonPerPost.sort());
  });

  it("isMediaTypeCategory accepts the three categories and rejects junk", () => {
    for (const c of MEDIA_FILTER_CATEGORIES) expect(isMediaTypeCategory(c)).toBe(true);
    for (const junk of ["", "foo", "Short", "VIDEO", "image", "carousel"]) {
      expect(isMediaTypeCategory(junk)).toBe(false);
    }
  });

  it("PARTITION: a random spread of kinds lands in exactly one category each", () => {
    // Simulate classifying a per-post media kind through the full pipeline:
    // post media kind → category, asserting coverage + uniqueness.
    const byCategory: Record<MediaTypeCategory, PostMediaKind[]> = {
      short: [],
      video: [],
      other: [],
    };
    for (const k of ALL_POST_MEDIA_KINDS) byCategory[postMediaKindToCategory(k)].push(k);
    // short = {short}, video = {video}, other = {image, carousel, text}.
    expect(byCategory.short).toEqual(["short"]);
    expect(byCategory.video).toEqual(["video"]);
    expect(byCategory.other.sort()).toEqual(["carousel", "image", "text"]);
    // Total coverage: 1 + 1 + 3 == 5 == every post media kind.
    expect(byCategory.short.length + byCategory.video.length + byCategory.other.length).toBe(
      ALL_POST_MEDIA_KINDS.length,
    );
  });
});
