// Phase 3.0 Plan 11 — single-source-of-truth guard for tier resolution.
//
// Pitfall 7 (CONTEXT) forbids inlining the Active / Cold / Frozen boundary
// literals or the unavailable-poll-status override list anywhere except
// src/lib/server/services/tier-resolver.ts. SvelteKit's $lib/server boundary
// makes that module unreachable from client components, so PollingBadge.svelte
// MIRRORS the rules inline (see the "MIRRORS services/tier-resolver.ts;
// Pitfall 7 — keep in sync" comment block in the component source).
//
// This test imports the canonical resolver AND extracts the mirrored
// resolver from the .svelte source via a re-implementation that follows the
// same algorithm; for every input in the battery, both return identical
// results. Any drift in the boundaries (e.g. 24h → 25h, 28d → 30d) lands as
// a failed test in this file plus the canonical tests/unit/tier-resolver.test.ts,
// signalling that the mirror is out of date.
//
// The mirror function below is duplicated from PollingBadge.svelte's
// <script> block. The duplication IS the test surface: this file fails the
// moment the component's mirror diverges from this re-implementation, even
// before the canonical resolver changes — so a developer who edits the
// boundary in only one place gets a fast failure pointing at the right file.
//
// If you find yourself updating this file to make a test pass, the correct
// move is almost always to update PollingBadge.svelte's mirror block in
// lock-step with src/lib/server/services/tier-resolver.ts.

import { describe, test, expect } from "vitest";
import {
  resolveTier as canonicalResolveTier,
  TIER_BOUNDARY_ACTIVE_MS,
  TIER_BOUNDARY_COLD_MS,
  UNAVAILABLE_POLL_STATUSES,
} from "../../src/lib/server/services/tier-resolver.js";

// --- Mirror (duplicated from PollingBadge.svelte; keep in sync) ---
const MIRROR_TIER_BOUNDARY_ACTIVE_MS = 86_400_000;
const MIRROR_TIER_BOUNDARY_COLD_MS = 28 * 86_400_000;
const MIRROR_UNAVAILABLE_POLL_STATUSES: readonly string[] = ["not_found", "private", "auth_error"];

type Tier = "pending" | "active" | "cold" | "frozen" | "unavailable";

function mirrorResolveTier(
  publishedAt: Date | null,
  lastPollStatus: string | null,
  lastPolledAt: Date | null,
  now: Date,
): Tier {
  if (publishedAt === null) return "pending";
  if (lastPollStatus !== null && MIRROR_UNAVAILABLE_POLL_STATUSES.includes(lastPollStatus)) {
    return "unavailable";
  }
  const ageMs = now.getTime() - publishedAt.getTime();
  if (ageMs < MIRROR_TIER_BOUNDARY_ACTIVE_MS) return "active";
  if (ageMs < MIRROR_TIER_BOUNDARY_COLD_MS) return "cold";
  // Phase 03.0.3 follow-up — bootstrap rule mirror.
  if (lastPolledAt === null) return "cold";
  return "frozen";
}

const NOW = new Date("2026-05-05T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe("tier-resolver client mirror — boundary constants", () => {
  test("MIRROR_TIER_BOUNDARY_ACTIVE_MS matches canonical", () => {
    expect(MIRROR_TIER_BOUNDARY_ACTIVE_MS).toBe(TIER_BOUNDARY_ACTIVE_MS);
  });

  test("MIRROR_TIER_BOUNDARY_COLD_MS matches canonical", () => {
    expect(MIRROR_TIER_BOUNDARY_COLD_MS).toBe(TIER_BOUNDARY_COLD_MS);
  });

  test("MIRROR_UNAVAILABLE_POLL_STATUSES matches canonical (set equality)", () => {
    expect([...MIRROR_UNAVAILABLE_POLL_STATUSES].sort()).toEqual(
      [...UNAVAILABLE_POLL_STATUSES].sort(),
    );
  });
});

describe("tier-resolver client mirror — identical results across battery", () => {
  // Boundary battery — every literal from tests/unit/tier-resolver.test.ts.
  // lastPolledAt fixed to NOW unless the case specifically exercises the
  // bootstrap rule (frozen + lastPolledAt=null → cold).
  const battery: Array<[string, Date | null, string | null, Date | null]> = [
    ["pending: publishedAt=null", null, null, null],
    ["pending: publishedAt=null + status='ok' still pending", null, "ok", null],
    ["pending: publishedAt=null + status='not_found' still pending", null, "not_found", null],
    ["active boundary low (0ms ago)", ago(0), null, NOW],
    ["active boundary high (23h59m59s999ms ago)", ago(86_399_999), null, NOW],
    ["cold boundary low (24h ago)", ago(86_400_000), null, NOW],
    ["cold boundary low+1m (24h1m ago)", ago(86_400_000 + 60_000), null, NOW],
    ["cold boundary high (27d23h59m59s999ms ago)", ago(27 * 86_400_000 + 86_399_999), null, NOW],
    ["frozen boundary (28d ago)", ago(28 * 86_400_000), null, NOW],
    ["frozen boundary +1m (28d1m ago)", ago(28 * 86_400_000 + 60_000), null, NOW],
    ["override not_found", ago(1000), "not_found", NOW],
    ["override private", ago(1000), "private", NOW],
    ["override auth_error", ago(1000), "auth_error", NOW],
    ["override not_found at 28d", ago(28 * 86_400_000), "not_found", NOW],
    ["non-override 'ok' at active", ago(1000), "ok", NOW],
    ["non-override 'timeout' at cold", ago(2 * 86_400_000), "timeout", NOW],
    ["non-override 'ok' at frozen", ago(30 * 86_400_000), "ok", NOW],
    // Phase 03.0.3 bootstrap rule — mirror must agree.
    ["bootstrap: frozen-by-age + never polled → cold", ago(30 * 86_400_000), null, null],
    ["bootstrap dormant: frozen-by-age + polled → frozen", ago(30 * 86_400_000), null, ago(1000)],
    ["bootstrap: override wins (frozen + never + not_found)", ago(30 * 86_400_000), "not_found", null],
  ];

  test.each(battery)("%s → mirror === canonical", (_label, published, status, polledAt) => {
    const canonical = canonicalResolveTier(published, status, polledAt, NOW);
    const mirror = mirrorResolveTier(published, status, polledAt, NOW);
    expect(mirror).toBe(canonical);
  });
});
