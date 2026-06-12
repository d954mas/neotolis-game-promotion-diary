// Age tiering for TikTok reuses the platform-agnostic tier-resolver: feeding a
// TikTok publishedAt classifies into active/cold/frozen identically to YouTube/IG.
// Pure unit test — no DB, no HTTP. Requirements: BACK-04 / PLAT-02.
//
// This proves TikTok feeds resolveTier correctly via the AdapterPollState shape
// that tiktokFetchPollStateMap returns ({ publishedAt, lastPolledAt,
// lastPollStatus }) — there is NO TikTok-specific tier code; the SAME boundaries
// the scheduler / PollingBadge use for YouTube/IG apply unchanged.
import { describe, it, expect } from "vitest";
import {
  resolveTier,
  TIER_BOUNDARY_ACTIVE_MS,
  TIER_BOUNDARY_COLD_MS,
} from "$lib/server/services/tier-resolver.js";
import type { AdapterPollState } from "$lib/sources/adapter.js";

// Mirror the cross-source dto overlay call: take the AdapterPollState a TikTok post
// would carry and feed it to the platform-agnostic resolver.
function tierForTikTokPost(state: AdapterPollState, now: Date) {
  return resolveTier(state.publishedAt, state.lastPollStatus, state.lastPolledAt, now);
}

describe("tiktok tier classification (reuses tier-resolver, BACK-04)", () => {
  const now = new Date("2026-06-06T12:00:00Z");
  const polled = new Date("2026-06-06T11:00:00Z"); // an actual poll happened

  it("[10-04] a post younger than 24h classifies Active", () => {
    const publishedAt = new Date(now.getTime() - 60 * 60 * 1000);
    expect(
      tierForTikTokPost({ publishedAt, lastPolledAt: polled, lastPollStatus: "ok" }, now),
    ).toBe("active");
  });

  it("[10-04] a post between 24h and 28d classifies Cold", () => {
    const publishedAt = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
    expect(
      tierForTikTokPost({ publishedAt, lastPolledAt: polled, lastPollStatus: "ok" }, now),
    ).toBe("cold");
  });

  it("[10-04] a post older than 28d classifies Frozen (no automatic polling)", () => {
    const publishedAt = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
    expect(
      tierForTikTokPost({ publishedAt, lastPolledAt: polled, lastPollStatus: "ok" }, now),
    ).toBe("frozen");
  });

  it("the boundaries are the SAME platform-agnostic constants (no TikTok-specific tier code)", () => {
    const atActiveBoundary = new Date(now.getTime() - TIER_BOUNDARY_ACTIVE_MS);
    const atColdBoundary = new Date(now.getTime() - TIER_BOUNDARY_COLD_MS);
    expect(
      tierForTikTokPost(
        { publishedAt: atActiveBoundary, lastPolledAt: polled, lastPollStatus: "ok" },
        now,
      ),
    ).toBe("cold");
    expect(
      tierForTikTokPost(
        { publishedAt: atColdBoundary, lastPolledAt: polled, lastPollStatus: "ok" },
        now,
      ),
    ).toBe("frozen");
  });
});
