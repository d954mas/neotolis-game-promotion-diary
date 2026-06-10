// TikTok warm auto-refresh eligibility — a post is warm (gets a paid single-post
// refresh via the service_post lane) while YOUNGER than TIKTOK_WARM_WINDOW_DAYS
// AND staler than TIKTOK_WARM_STALENESS_HOURS, and drops out after
// TIKTOK_WARM_MAX_FAILURES consecutive non-ok polls (mirrors the IG warm lane).
//
// WAVE-0 SCAFFOLD: named `it.skip` placeholders the implementing plan (10-04)
// flips to live `it(...)`.
//
// Requirements: PLAT-02.
import { describe, it } from "vitest";

describe("tiktok warm auto-refresh eligibility — Wave-0 scaffold", () => {
  it.skip("[10-04] a young, stale post is warm-eligible (within window, past staleness gate)");
  it.skip("[10-04] a post older than the warm window is NOT warm-eligible (frozen, manual only)");
  it.skip("[10-04] a post at TIKTOK_WARM_MAX_FAILURES drops out of the warm lane");
});
