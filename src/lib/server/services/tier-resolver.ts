// Phase 3.0 Plan 03 + post-build refactor (2026-05-06) — SINGLE SOURCE OF
// TRUTH for tier resolution.
//
// Every place that decides "what tier is this video?" imports from THIS module:
//   - scheduler enqueue path (Plan 03.0-09)         → routes the work to the right queue
//   - worker refresh-poll handler (Plan 03.0-08)    → guards 'pending' videos from poll
//   - PollingBadge UI loader (Plan 03.0-11)         → picks the Paraglide variant to render
//
// Inlining the boundary literals (e.g. `ageDays < 1`) elsewhere is a P0 review
// block. The boundary constants are exported so callers that need to express
// the literals in tests / SQL / Paraglide message picker can reference the
// same symbol; nobody re-derives 86_400_000 in another module.
//
// Per-video refactor (2026-05-06): tier is decided by VIDEO age (publishedAt
// from youtube_videos), not EVENT age (occurred_at from events). Multiple
// events for one video share tier classification — the video is one
// upstream entity with one viewCount-velocity profile. The old per-event
// model classified "I logged a promo for an old video today" as Active
// (occurred_at=today), wasting quota on a video whose stats weren't moving.
//
// New 'pending' tier (2026-05-06): NULL publishedAt means we have not yet
// fetched video metadata from Google. The user pasted a URL but
// channel-context-backfill has not completed (or has not run for this
// video). Scheduler ignores 'pending'; manual refresh rejects 'pending'
// (the backfill will populate the data within seconds — no value in racing
// it). PollingBadge shows "Pending..." with a tooltip explaining the brief
// window.
//
// D-05 (CONTEXT) age boundaries — applied to publishedAt:
//   - publishedAt IS NULL  → 'pending'    (data not yet fetched — backfill in flight)
//   - age <  24h           → 'active'     (Hot path — auto-import + scheduled refresh-poll)
//   - age >= 24h && < 28d  → 'cold'       (Manual refresh-now only; scheduler ignores)
//   - age >= 28d           → 'frozen'     (Read-only by scheduler; manual refresh works)
//
// D-12 (CONTEXT) lastPollStatus overrides — tier collapses to 'unavailable'
// regardless of age when the last poll attempt encountered a permanent failure:
//   - 'not_found'  → channel/video deleted upstream OR video is private
//   - 'private'    → access revoked (where adapter could distinguish from not_found)
//   - 'auth_error' → API key rejected (rotation needed; per-key, not universal)
//
// 'ok' (a successful poll) and 'rate_limited' (transient) are NOT overrides — the
// age rule still applies. This keeps the override list narrow and predictable;
// any new override must land here in lock-step with the worker code that
// writes the new lastPollStatus value.

export type Tier = "pending" | "active" | "cold" | "frozen" | "unavailable";

/** D-05 boundary — Active tier is age < 24 hours. */
export const TIER_BOUNDARY_ACTIVE_MS = 86_400_000;

/** D-05 boundary — Cold tier is age < 28 days. Beyond is Frozen. */
export const TIER_BOUNDARY_COLD_MS = 28 * 86_400_000;

/** D-12 — lastPollStatus values that override age-based tier with 'unavailable'. */
export const UNAVAILABLE_POLL_STATUSES: readonly string[] = ["not_found", "private", "auth_error"];

/**
 * Pure tier resolution. Deterministic given (publishedAt, lastPollStatus, now).
 *
 * Pure-function discipline: no DB / IO / module-level mutable state read.
 * Same inputs → same output, every time. Any caller that needs different
 * behaviour (e.g. "treat 'rate_limited' as override after N consecutive
 * timeouts") MUST encode that as a different lastPollStatus value upstream
 * — this function does NOT keep counters.
 *
 * publishedAt is the YouTube-native timestamp from `youtube_videos.published_at`,
 * loaded by the caller from the JOIN. It is NULL while channel-context-backfill
 * has not yet run (the 'pending' tier window).
 */
export function resolveTier(
  publishedAt: Date | null,
  lastPollStatus: string | null,
  now: Date = new Date(),
): Tier {
  if (publishedAt === null) {
    return "pending";
  }
  if (lastPollStatus !== null && UNAVAILABLE_POLL_STATUSES.includes(lastPollStatus)) {
    return "unavailable";
  }
  const ageMs = now.getTime() - publishedAt.getTime();
  if (ageMs < TIER_BOUNDARY_ACTIVE_MS) return "active";
  if (ageMs < TIER_BOUNDARY_COLD_MS) return "cold";
  return "frozen";
}
