import { describe, it, expect } from "vitest";
import { filterValidKinds } from "../../src/lib/util/filter-event-kinds.js";

/**
 * Plan 02.1-37 — feed loader kindList validation.
 *
 * Closes UAT-NOTES.md §5.13 (P2). The /feed page loader filters
 * url.searchParams.getAll("kind") through this helper before passing the
 * resulting list into FeedFilters. Unknown kinds are silently dropped so a
 * malformed URL like /feed?kind=foo no longer surfaces as a Postgres 500
 * (unknown enum value) when the kindList reaches Drizzle's
 * inArray(events.kind, [...]) clause.
 *
 * VALID_EVENT_KINDS is the single source of truth (events service);
 * filterValidKinds and the route-layer eventKindEnum both reference it.
 */
describe("Plan 02.1-37 — filterValidKinds", () => {
  it("filters unknown values, keeps known", () => {
    expect(filterValidKinds(["foo", "youtube_video", "bar"])).toEqual(["youtube_video"]);
  });

  it("returns empty array for all-unknown input", () => {
    expect(filterValidKinds(["foo", "bar"])).toEqual([]);
  });

  it("returns empty array for empty input", () => {
    expect(filterValidKinds([])).toEqual([]);
  });

  it("preserves all when all valid", () => {
    expect(filterValidKinds(["youtube_video", "post"])).toEqual(["youtube_video", "post"]);
  });

  it("preserves order when mixed valid/invalid", () => {
    expect(filterValidKinds(["foo", "post", "bar", "youtube_video", "baz"])).toEqual([
      "post",
      "youtube_video",
    ]);
  });

  it("rejects suspiciously close-but-wrong values (case-sensitive)", () => {
    // Pitfall 6 defense: enum values are case-sensitive at the Postgres level.
    expect(filterValidKinds(["YouTube_Video", "POST"])).toEqual([]);
  });
});
