// Phase 3.0 Plan 03 — Pitfall 7 mitigation: SINGLE SOURCE OF TRUTH for tier resolution.
//
// Every place that decides "what tier is this event?" imports from THIS module:
//   - scheduler enqueue path (Plan 03.0-09)         → routes the work to the right queue
//   - worker refresh-now handler (Plan 03.0-09)     → guards Frozen events from rescue polls
//   - PollingBadge UI loader (Plan 03.0-11)         → picks the Paraglide variant to render
//
// Inlining the boundary literals (e.g. `ageDays < 1`) elsewhere is a P0 review
// block. The boundary constants are exported so callers that need to express
// the literals in tests / SQL / Paraglide message picker can reference the
// same symbol; nobody re-derives 86_400_000 in another module.
//
// D-05 (CONTEXT) age boundaries:
//   - age <  24h           → 'active'   (Hot path — auto-import + scheduled refresh-poll)
//   - age >= 24h && < 28d  → 'cold'     (Manual refresh-now only; scheduler ignores)
//   - age >= 28d           → 'frozen'   (Read-only; even refresh-now is a no-op)
//
// D-12 (CONTEXT) last_poll_status overrides — tier collapses to 'unavailable'
// regardless of age when the last poll attempt encountered a permanent failure:
//   - 'not_found'  → channel/video deleted upstream
//   - 'private'    → access revoked / video privacy flipped
//   - 'auth_error' → API key rejected (rotation needed; per-key, not universal)
//
// 'ok' (a successful poll) and 'timeout' (transient) are NOT overrides — the
// age rule still applies. This keeps the override list narrow and predictable;
// any new override must land here in lock-step with the worker code that
// writes the new last_poll_status value.

export type Tier = "active" | "cold" | "frozen" | "unavailable";

/** D-05 boundary — Active tier is age < 24 hours. */
export const TIER_BOUNDARY_ACTIVE_MS = 86_400_000;

/** D-05 boundary — Cold tier is age < 28 days. Beyond is Frozen. */
export const TIER_BOUNDARY_COLD_MS = 28 * 86_400_000;

/** D-12 — last_poll_status values that override age-based tier with 'unavailable'. */
export const UNAVAILABLE_POLL_STATUSES: readonly string[] = ["not_found", "private", "auth_error"];

/**
 * Pure tier resolution. Deterministic given (occurredAt, lastPollStatus, now).
 *
 * Pure-function discipline: no DB / IO / module-level mutable state read.
 * Same inputs → same output, every time. Any caller that needs different
 * behaviour (e.g. "treat 'timeout' as override after N consecutive timeouts")
 * MUST encode that as a different last_poll_status value upstream — this
 * function does NOT keep counters.
 */
export function resolveTier(
  occurredAt: Date,
  lastPollStatus: string | null,
  now: Date = new Date(),
): Tier {
  if (lastPollStatus !== null && UNAVAILABLE_POLL_STATUSES.includes(lastPollStatus)) {
    return "unavailable";
  }
  const ageMs = now.getTime() - occurredAt.getTime();
  if (ageMs < TIER_BOUNDARY_ACTIVE_MS) return "active";
  if (ageMs < TIER_BOUNDARY_COLD_MS) return "cold";
  return "frozen";
}
