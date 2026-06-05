// PLACEHOLDER (Wave-0, it.skip) — activated by Plan 08-02.
// Requirements: SOC-04, D-04/D-05.
//
// The IG adapter's normalization mapping: provider posts/reels shapes ->
// NormalizedPost. Metrics-by-presence (D-05): photos have null views, reels
// map play_count -> views; shares is always null for IG (D-04). The verified
// provider shapes (media_type ints, caption.text path, play_count presence)
// are in 08-SPIKE.md. Pure unit test — no DB, no live HTTP.
import { describe, it } from "vitest";
// import { normalizeInstagramPost } from "$lib/sources/instagram/server/adapter.js";

describe("instagram normalizer (provider shape -> NormalizedPost)", () => {
  it.skip("maps a provider posts-shape item to NormalizedPost", async () => {
    // Plan 02: id/kind/publishedAt/metrics/caption/thumbnailUrl/permalink
    // map from the verified posts shape (08-SPIKE.md).
  });

  it.skip("metrics by presence: a photo (media_type=1) has null views; a reel (media_type=2) maps play_count -> views", async () => {
    // Plan 02: D-05 render-by-presence — play_count present only on
    // media_type=2 (confirmed live in 08-SPIKE.md).
  });

  it.skip("shares is always null for Instagram", async () => {
    // Plan 02: D-04 — no share metric in either endpoint (08-SPIKE.md).
  });
});
