// Global Reddit rate-limit pacer — single-row DB token bucket.
//
// One acquireRedditPacerSlot() invocation per outgoing Reddit HTTP. The
// helper performs an ATOMIC `UPDATE … RETURNING` that bumps
// reddit_pacer.next_allowed_at when it's reached or passed, otherwise
// reports the wait remaining. Both worker (async, 7.5s interval) and
// user-driven sync paths (preview button, paste Submit) share the same
// token, so the 10 req/min Reddit ceiling is enforced ONCE, globally,
// regardless of how many concurrent sessions exist.
//
// Design notes:
//   - 7500ms slot interval matches the worker's setInterval cadence —
//     the worker NEVER hits the pacer denial path on a healthy system.
//   - Sync paths CAN hit denial under burst (multiple users pasting at
//     once). We surface that as AdapterError(rate-limited) with
//     retryAfterMs set — UI maps to "Reddit busy, try again in Ns".
//   - The CTE form (`UPDATE … RETURNING prior` semantics emulated via
//     a SELECT … FOR UPDATE + conditional UPDATE) keeps the entire
//     operation atomic per row, multi-replica safe.
//
// usesInProcessRateLimiter=true forces N=1 worker today, but the pacer
// is intentionally multi-replica safe: a future Reddit deployment that
// drops that flag (e.g. moves the worker setInterval into a DB-driven
// next_tick_at table) keeps correctness without code changes here.

import { sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { logger } from "$lib/server/logger.js";
import { env } from "$lib/server/config/env.js";

/** Slot interval — matches the worker's setInterval(7500ms). 8 req/min
 *  effective ceiling = 60_000 / 7500.
 *
 *  Test override: env.NODE_ENV === 'test' sets the slot to 0ms
 *  (effectively no pacing). Integration tests fire many Reddit fetches
 *  per spec; a 7.5s slot would block the second call in a single test.
 *  Production always uses the documented 7500ms ceiling. env.NODE_ENV
 *  is the single project-wide gate for env-derived behavior — see
 *  AGENTS.md "env reads only in src/lib/server/config/env.ts". */
export const REDDIT_PACER_SLOT_MS = env.NODE_ENV === "test" ? 0 : 7500;

export interface RedditPacerSlotResult {
  /** True when the pacer was advanced and the caller may proceed. */
  acquired: boolean;
  /** Milliseconds the caller should wait before retrying — only
   *  meaningful when `acquired` is false. */
  waitMs: number;
}

/**
 * Atomically acquire one Reddit rate-limit slot. Returns
 * `{acquired: true}` and advances the pacer when the current `now()`
 * is at or past `next_allowed_at`. Otherwise returns
 * `{acquired: false, waitMs}` — caller decides whether to throw,
 * await, or backoff.
 *
 * Single round-trip via `UPDATE … WHERE next_allowed_at <= NOW()
 * RETURNING (NOW() - prior_next_allowed_at)`. When no row matches the
 * predicate, the UPDATE affects zero rows — we read the row separately
 * to surface the remaining wait.
 */
export async function acquireRedditPacerSlot(): Promise<RedditPacerSlotResult> {
  // Single-statement atomic update — bumps the row only when the slot
  // window has elapsed. RETURNING tells us whether we won.
  const updateResult = await db.execute<{ next_allowed_at: Date }>(sql`
    UPDATE reddit_pacer
    SET next_allowed_at = NOW() + (${REDDIT_PACER_SLOT_MS} || ' milliseconds')::interval
    WHERE id = 1
      AND next_allowed_at <= NOW()
    RETURNING next_allowed_at
  `);
  const updated =
    (updateResult as unknown as { rows?: Array<{ next_allowed_at: Date }> }).rows ?? [];
  if (updated.length === 1) {
    return { acquired: true, waitMs: 0 };
  }
  // UPDATE matched zero rows — slot still ahead. Read the current
  // next_allowed_at to compute the wait.
  const readResult = await db.execute<{
    wait_ms: number | string;
  }>(sql`
    SELECT GREATEST(0, EXTRACT(EPOCH FROM (next_allowed_at - NOW())) * 1000)::int AS wait_ms
    FROM reddit_pacer
    WHERE id = 1
  `);
  const readRows =
    (readResult as unknown as { rows?: Array<{ wait_ms: number | string }> }).rows ?? [];
  const waitMs = readRows.length === 1 ? Number(readRows[0]!.wait_ms) : REDDIT_PACER_SLOT_MS;
  logger.debug({ waitMs }, "reddit pacer: denied; next slot ahead");
  return { acquired: false, waitMs };
}
