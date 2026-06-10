// TikTok backfill bound — the walker stops at SOCIAL_BACKFILL_MAX_POSTS OR the
// date window, whichever first, so cost is independent of archive size (BACK-01).
//
// WAVE-0 SCAFFOLD: named `it.skip` placeholders the implementing plan (10-04)
// flips to live `it(...)`.
//
// Requirements: PLAT-02.
import { describe, it } from "vitest";

describe("tiktok backfill bound (BACK-01) — Wave-0 scaffold", () => {
  it.skip("[10-04] walks one feed bounded by SOCIAL_BACKFILL_MAX_POSTS (stops at the cap)");
  it.skip("[10-04] stops at the backfill date window when it is reached before the post cap");
});
