// Age tiering for IG reuses the platform-agnostic tier-resolver: feeding an
// IG publishedAt classifies into active/cold/frozen identically to YouTube.
// Activated by Plan 08-04 Task 2 (flipped live from the Wave-0 it.skip
// placeholder). Pure unit test — no DB, no HTTP.
// Requirements: BACK-04.
//
// This proves IG feeds resolveTier correctly via the AdapterPollState shape
// that instagramFetchPollStateMap returns ({ publishedAt, lastPolledAt,
// lastPollStatus }) — there is NO IG-specific tier code; the SAME boundaries
// the scheduler / PollingBadge use for YouTube apply unchanged.
import { describe, it, expect } from "vitest";
import {
  resolveTier,
  TIER_BOUNDARY_ACTIVE_MS,
  TIER_BOUNDARY_COLD_MS,
} from "$lib/server/services/tier-resolver.js";
import type { AdapterPollState } from "$lib/sources/adapter.js";

// Mirror the cross-source dto overlay call: take the AdapterPollState an IG
// post would carry (the exact shape instagramFetchPollStateMap returns) and
// feed it to the platform-agnostic resolver.
function tierForIgPost(state: AdapterPollState, now: Date) {
  return resolveTier(state.publishedAt, state.lastPollStatus, state.lastPolledAt, now);
}

describe("instagram tier resolution (reuses tier-resolver, BACK-04)", () => {
  const now = new Date("2026-06-06T12:00:00Z");
  const polled = new Date("2026-06-06T11:00:00Z"); // an actual poll happened

  it("an IG post published 1h ago → active (age < 24h)", () => {
    const publishedAt = new Date(now.getTime() - 60 * 60 * 1000);
    expect(tierForIgPost({ publishedAt, lastPolledAt: polled, lastPollStatus: "ok" }, now)).toBe(
      "active",
    );
  });

  it("an IG post published 5d ago → cold (24h ≤ age < 28d)", () => {
    const publishedAt = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
    expect(tierForIgPost({ publishedAt, lastPolledAt: polled, lastPollStatus: "ok" }, now)).toBe(
      "cold",
    );
  });

  it("an IG post published 60d ago (already polled) → frozen (age ≥ 28d)", () => {
    const publishedAt = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
    expect(tierForIgPost({ publishedAt, lastPolledAt: polled, lastPollStatus: "ok" }, now)).toBe(
      "frozen",
    );
  });

  it("an IG post with NULL published_at → pending (taken_at not yet resolved)", () => {
    expect(
      tierForIgPost({ publishedAt: null, lastPolledAt: null, lastPollStatus: null }, now),
    ).toBe("pending");
  });

  it("last_poll_status='not_found' overrides age → unavailable (handle gone / private)", () => {
    const publishedAt = new Date(now.getTime() - 60 * 60 * 1000); // would be active by age
    expect(
      tierForIgPost({ publishedAt, lastPolledAt: polled, lastPollStatus: "not_found" }, now),
    ).toBe("unavailable");
  });

  it("the boundaries are the SAME platform-agnostic constants (no IG-specific tier code)", () => {
    // Exactly-at-active-boundary is cold; exactly-at-cold-boundary is frozen.
    const atActiveBoundary = new Date(now.getTime() - TIER_BOUNDARY_ACTIVE_MS);
    const atColdBoundary = new Date(now.getTime() - TIER_BOUNDARY_COLD_MS);
    expect(
      tierForIgPost(
        { publishedAt: atActiveBoundary, lastPolledAt: polled, lastPollStatus: "ok" },
        now,
      ),
    ).toBe("cold");
    expect(
      tierForIgPost(
        { publishedAt: atColdBoundary, lastPolledAt: polled, lastPollStatus: "ok" },
        now,
      ),
    ).toBe("frozen");
  });
});
