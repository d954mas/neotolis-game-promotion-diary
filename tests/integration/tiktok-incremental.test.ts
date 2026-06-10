// TikTok incremental catch-up — a second tick pulls only posts newer than the
// frontier, not the whole feed again (the Reddit/IG incremental-vs-historical
// flow). Real Postgres; provider faked at the seam.
//
// WAVE-0 SCAFFOLD: named `it.skip` placeholders the implementing plan (10-04)
// flips to live `it(...)`.
//
// Requirements: PLAT-02.
import { describe, it } from "vitest";

describe("tiktok incremental catch-up — Wave-0 scaffold", () => {
  it.skip("[10-04] a follow-up tick imports only posts newer than the persisted frontier");
  it.skip("[10-04] re-importing an already-seen aweme id is idempotent (no duplicate event)");
});
