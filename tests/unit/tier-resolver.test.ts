// Phase 3.0 Plan 03 + post-build refactor (2026-05-06) — assertions
// activated.
//
// tier-resolver is the single source of truth for the Pending / Active /
// Cold / Frozen / Unavailable bucket of a YouTube video (CONTEXT DV-2 —
// Pitfall 7 avoidance: no tier logic in any other service / route /
// Svelte component). Boundary tests are the load-bearing guard against
// drift in the cutoffs.
//
// Per-video refactor (2026-05-06): tier is keyed on VIDEO age (publishedAt
// from youtube_videos), not EVENT age. New 'pending' tier covers the
// window between event creation and channel-context-backfill completion
// (NULL publishedAt).
//
// Tiers (D-05):
//   - publishedAt IS NULL  → 'pending'
//   - age <  24h           → 'active'
//   - age >= 24h && < 28d  → 'cold'
//   - age >= 28d           → 'frozen'
//
// lastPollStatus overrides (D-12) — irrespective of age:
//   - 'not_found' / 'private' / 'auth_error' → 'unavailable'
//   - any other value (including 'ok', 'rate_limited', null) → falls
//     through to age rule
import { describe, test, expect } from "vitest";

import {
  resolveTier,
  TIER_BOUNDARY_ACTIVE_MS,
  TIER_BOUNDARY_COLD_MS,
  UNAVAILABLE_POLL_STATUSES,
} from "../../src/lib/server/services/tier-resolver.js";

const NOW = new Date("2026-05-05T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe("resolveTier — boundary table (D-05)", () => {
  test.each([
    ["active boundary low (0ms ago)", ago(0), "active"],
    ["active boundary high (23h59m59s999ms ago)", ago(86_399_999), "active"],
    ["cold boundary low (24h ago)", ago(86_400_000), "cold"],
    ["cold boundary low+1m (24h1m ago)", ago(86_400_000 + 60_000), "cold"],
    ["cold boundary high (27d23h59m59s999ms ago)", ago(27 * 86_400_000 + 86_399_999), "cold"],
    ["frozen boundary (28d ago)", ago(28 * 86_400_000), "frozen"],
    ["frozen boundary +1m (28d1m ago)", ago(28 * 86_400_000 + 60_000), "frozen"],
  ] as const)("%s", (_label, published, expected) => {
    // Boundary table fixes lastPolledAt to a non-null date so the
    // bootstrap rule (frozen + lastPolledAt=null → cold) doesn't shadow
    // the age-by-itself classification. The bootstrap rule has its own
    // describe block below.
    expect(resolveTier(published, null, NOW, NOW)).toBe(expected);
  });
});

describe("resolveTier — pending tier (NULL publishedAt)", () => {
  test("publishedAt=null → 'pending' regardless of lastPollStatus / lastPolledAt", () => {
    expect(resolveTier(null, null, null, NOW)).toBe("pending");
    expect(resolveTier(null, "ok", NOW, NOW)).toBe("pending");
    // 'pending' wins over even the unavailable overrides — we have no data
    // to classify yet, the not_found could be a transient backfill miss.
    expect(resolveTier(null, "not_found", null, NOW)).toBe("pending");
  });
});

describe("resolveTier — last_poll_status overrides (D-12)", () => {
  test("lastPollStatus='not_found' overrides → unavailable", () => {
    expect(resolveTier(ago(1000), "not_found", NOW, NOW)).toBe("unavailable");
  });

  test("lastPollStatus='private' overrides → unavailable", () => {
    expect(resolveTier(ago(1000), "private", NOW, NOW)).toBe("unavailable");
  });

  test("lastPollStatus='auth_error' overrides → unavailable", () => {
    expect(resolveTier(ago(1000), "auth_error", NOW, NOW)).toBe("unavailable");
  });

  test("override fires regardless of age (28d-old + 'not_found' still unavailable, NOT frozen)", () => {
    expect(resolveTier(ago(28 * 86_400_000), "not_found", NOW, NOW)).toBe("unavailable");
  });

  test("lastPollStatus='ok' is NOT an override — falls through to age-based tier", () => {
    expect(resolveTier(ago(1000), "ok", NOW, NOW)).toBe("active");
  });

  test("lastPollStatus='timeout' is NOT an override — falls through to age-based tier", () => {
    expect(resolveTier(ago(1000), "timeout", NOW, NOW)).toBe("active");
  });
});

describe("resolveTier — bootstrap rule (Phase 03.0.3 follow-up)", () => {
  // Issue #29 extension: a video that is frozen by age (published_at > 28d
  // ago) but has NEVER been polled (last_polled_at IS NULL) is upgraded
  // to 'cold' so the next scheduler tick picks it up exactly once. After
  // writeSnapshot stamps last_polled_at, the bootstrap rule is dormant
  // for that video forever.
  test("frozen-by-age + lastPolledAt=null → 'cold' (bootstrap upgrade)", () => {
    expect(resolveTier(ago(30 * 86_400_000), null, null, NOW)).toBe("cold");
  });

  test("frozen-by-age + lastPolledAt set → 'frozen' (bootstrap dormant)", () => {
    expect(resolveTier(ago(30 * 86_400_000), null, ago(1000), NOW)).toBe("frozen");
  });

  test("frozen-by-age + lastPolledAt=null + lastPollStatus='not_found' → 'unavailable' (override wins over bootstrap)", () => {
    // A video that was never polled but for which we already know the
    // upstream is gone — bootstrap should NOT bring it back into the
    // polling pool. Defense in depth: the override list is checked first.
    expect(resolveTier(ago(30 * 86_400_000), "not_found", null, NOW)).toBe("unavailable");
  });

  test("active-tier video + lastPolledAt=null → still 'active' (bootstrap dormant in young tiers)", () => {
    expect(resolveTier(ago(1000), null, null, NOW)).toBe("active");
  });

  test("cold-tier video + lastPolledAt=null → still 'cold' (no over-classification)", () => {
    expect(resolveTier(ago(2 * 86_400_000), null, null, NOW)).toBe("cold");
  });
});

describe("resolveTier — defaults", () => {
  test("default now=new Date() works", () => {
    const recent = new Date(Date.now() - 1000);
    expect(resolveTier(recent, null, recent)).toBe("active");
  });
});

describe("tier-resolver — exported boundary constants", () => {
  test("TIER_BOUNDARY_ACTIVE_MS = 24h", () => {
    expect(TIER_BOUNDARY_ACTIVE_MS).toBe(86_400_000);
  });

  test("TIER_BOUNDARY_COLD_MS = 28d", () => {
    expect(TIER_BOUNDARY_COLD_MS).toBe(28 * 86_400_000);
  });

  test("UNAVAILABLE_POLL_STATUSES is the D-12 override list", () => {
    expect([...UNAVAILABLE_POLL_STATUSES].sort()).toEqual(
      ["auth_error", "not_found", "private"].sort(),
    );
  });
});
