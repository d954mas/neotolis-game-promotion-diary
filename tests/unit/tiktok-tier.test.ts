// TikTok tier classification — Active / Cold / Frozen by published_at, via the
// shared tier-resolver (the same Active/Cold/Frozen windows the YouTube/IG
// adapters use). Pure unit test — no DB, no HTTP.
//
// WAVE-0 SCAFFOLD: named `it.skip` placeholders the implementing plan (10-04,
// the TikTok polling lanes) flips to live `it(...)`.
//
// Requirements: PLAT-02.
import { describe, it } from "vitest";

describe("tiktok tier classification — Wave-0 scaffold", () => {
  it.skip("[10-04] a post younger than 24h classifies Active");
  it.skip("[10-04] a post between 24h and 28d classifies Cold");
  it.skip("[10-04] a post older than 28d classifies Frozen (no automatic polling)");
});
