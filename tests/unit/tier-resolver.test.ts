// Phase 3.0 Plan 03 — assertions activated.
//
// tier-resolver is the single source of truth for the Active / Cold /
// Frozen / Unavailable bucket of an event (CONTEXT DV-2 — Pitfall 7
// avoidance: no tier logic in any other service / route / Svelte
// component). Boundary tests are the load-bearing guard against drift in
// the cutoffs.
//
// Boundaries (D-05):
//   - age <  24h           → 'active'
//   - age >= 24h && < 28d  → 'cold'
//   - age >= 28d           → 'frozen'
//
// last_poll_status overrides (D-12) — irrespective of age:
//   - 'not_found' / 'private' / 'auth_error' → 'unavailable'
//   - any other value (including 'ok', null) → falls through to age rule
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
  ] as const)("%s", (_label, occurred, expected) => {
    expect(resolveTier(occurred, null, NOW)).toBe(expected);
  });
});

describe("resolveTier — last_poll_status overrides (D-12)", () => {
  test("lastPollStatus='not_found' overrides → unavailable", () => {
    expect(resolveTier(ago(1000), "not_found", NOW)).toBe("unavailable");
  });

  test("lastPollStatus='private' overrides → unavailable", () => {
    expect(resolveTier(ago(1000), "private", NOW)).toBe("unavailable");
  });

  test("lastPollStatus='auth_error' overrides → unavailable", () => {
    expect(resolveTier(ago(1000), "auth_error", NOW)).toBe("unavailable");
  });

  test("override fires regardless of age (28d-old + 'not_found' still unavailable, NOT frozen)", () => {
    expect(resolveTier(ago(28 * 86_400_000), "not_found", NOW)).toBe("unavailable");
  });

  test("lastPollStatus='ok' is NOT an override — falls through to age-based tier", () => {
    expect(resolveTier(ago(1000), "ok", NOW)).toBe("active");
  });

  test("lastPollStatus='timeout' is NOT an override — falls through to age-based tier", () => {
    expect(resolveTier(ago(1000), "timeout", NOW)).toBe("active");
  });
});

describe("resolveTier — defaults", () => {
  test("default now=new Date() works", () => {
    const recent = new Date(Date.now() - 1000);
    expect(resolveTier(recent, null)).toBe("active");
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
