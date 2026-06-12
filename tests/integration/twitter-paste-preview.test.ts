// Twitter/X paste/preview single-tweet fetch (Wave-0 scaffold).
//
// Named it.skip placeholders — Plan 11-03 flips these live. A single-tweet fetch
// caches the tweet + writes a snapshot, and the cached externalId is re-derived
// from OUR cache row (not the untrusted request body — the #70 trust boundary;
// mirrors the TikTok resolveCachedExternalId paste flow).
//
// Requirements: PLAT-03 (#70 cached-externalId re-derivation).
import { describe, it } from "vitest";

describe("twitter paste/preview", () => {
  it.skip("[11-03] a single-tweet fetch caches the tweet row + writes a snapshot", () => {});

  it.skip("[11-03] the cached externalId is re-derived from OUR cache row, not the request body (#70)", () => {});

  it.skip("[11-03] the snapshot carries share_count + the D-05 raw components", () => {});
});
