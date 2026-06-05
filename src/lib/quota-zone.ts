// Pure quota-bar threshold helpers (D-05).
//
// Lives at $lib (NOT $lib/server) because QuotaStatusBanner.svelte is a
// client component — a $lib/server import would be rejected by SvelteKit's
// server-only boundary. These are pure functions with no server deps.
//
// Extracted from QuotaStatusBanner.svelte so the SAME code the banner
// renders is unit-testable directly — no drift between "what the test
// asserts" and "what the bar paints". The banner imports quotaPct /
// quotaZone from here; tests/unit/quota-banner-zone.test.ts imports the
// identical functions.
//
// Zones (per capped axis):
//   < 80%   → "ok"      (--accent)
//   80–99%  → "warning" (--warn)
//   ≥ 100%  → "error"   (--danger)

export function quotaPct(used: number, cap: number): number {
  if (cap <= 0) return 0;
  return Math.min(100, Math.round((used / cap) * 100));
}

export type QuotaZone = "ok" | "warning" | "error";

export function quotaZone(pct: number): QuotaZone {
  if (pct >= 100) return "error";
  if (pct >= 80) return "warning";
  return "ok";
}
