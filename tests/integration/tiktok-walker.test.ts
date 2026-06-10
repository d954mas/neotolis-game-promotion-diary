// TikTok account walker — resumable, cursor-persisted (mirrors the IG walker).
// Drives the REAL TikTok backfill handler against real Postgres; the
// ScrapeCreators boundary is faked at the PROVIDER SEAM, never the DB.
//
// WAVE-0 SCAFFOLD: named `it.skip` placeholders the implementing plan (10-04)
// flips to live `it(...)`.
//
// Requirements: PLAT-02.
import { describe, it } from "vitest";

describe("tiktok account walker — Wave-0 scaffold", () => {
  it.skip("[10-04] walks one feed page, inserts events + the tiktok_posts cache rows");
  it.skip("[10-04] persists the next cursor and resumes from it on the following tick");
  it.skip("[10-04] an empty page marks the source backfill complete");
});
