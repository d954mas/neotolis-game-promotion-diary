import { describe, it, expect } from "vitest";
import { resolveSourceLabel } from "../../src/lib/components/feed/parts/derive-card-data.js";

// resolveSourceLabel is the shared feed-card account-label resolver (BaseFeedCard
// reads it for EVERY card variant). The per-platform wrapper's already-resolved
// `sourceLabel` (the LIVE data_sources name via the `source` prop) ALWAYS wins
// when non-empty; only a source-less manual paste (sourceId null) with an empty
// label falls back to the author @handle SNAPSHOT persisted on the event. This
// is NOT a no-denorm violation: a source-less paste has no owning row for the
// author, so the snapshot is a free-standing value and is never read when a
// source is linked. See the helper's doc comment + the events schema header.

describe("resolveSourceLabel", () => {
  it("falls back to @handle for a source-less paste with no live label", () => {
    // The exact problem from UAT: a pasted tweet from an account that isn't a
    // registered source — sourceId null, wrapper produced an empty sourceLabel.
    expect(resolveSourceLabel("", { sourceId: null, authorHandle: "neonicle_dev" })).toBe(
      "@neonicle_dev",
    );
  });

  it("the LIVE source name wins over the snapshot when a source is linked", () => {
    // Even if the event carries an old snapshot, a linked source means the
    // wrapper resolved the live data_sources name — the snapshot is never read.
    expect(
      resolveSourceLabel("Neonicle Games", { sourceId: "src_1", authorHandle: "stale_handle" }),
    ).toBe("Neonicle Games");
  });

  it("the LIVE source name wins even when the event also carries a snapshot and no source-id branch applies", () => {
    // Non-empty label short-circuits regardless of sourceId / authorHandle.
    expect(resolveSourceLabel("Live Name", { sourceId: null, authorHandle: "snapshot" })).toBe(
      "Live Name",
    );
  });

  it("does NOT fall back when a source IS linked but the label resolved empty (honest blank, never the snapshot)", () => {
    // A linked-but-unresolved source (e.g. not-yet-polled) stays blank rather
    // than leaking the snapshot — the snapshot is strictly the source-less path.
    expect(resolveSourceLabel("", { sourceId: "src_1", authorHandle: "snapshot" })).toBe("");
  });

  it("stays blank for a source-less paste with no snapshot (telegram / unresolved preview)", () => {
    expect(resolveSourceLabel("", { sourceId: null, authorHandle: null })).toBe("");
    expect(resolveSourceLabel("", { sourceId: null, authorHandle: undefined })).toBe("");
  });
});
