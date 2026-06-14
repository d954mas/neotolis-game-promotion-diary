// Global twitterapi.io QPS pacer — the proactive slot gate.
//
// twitterapi.io rate-limits PER API KEY, shared across backfill (initial / cron /
// continuation), the warm refresh lane, and paste/preview — and across replicas. The
// http seam (./http.ts) acquires this single DB-backed token BEFORE every twitterapi.io
// call so the global request rate never crosses the QPS floor, however many concurrent
// workers / browser sessions exist. A denied slot surfaces as AdapterError(rate-limited)
// WITHOUT a budget reservation or HTTP call — proactively avoiding a wasted 429 + credit.
//
// Mirrors reddit_pacer (acquireRedditPacerSlotWith) MINUS the escalating pause columns:
// twitter's 429 is a transient QPS ceiling already self-resumed via the http seam's
// retryAfterMs, so a single next_allowed_at is the whole gate.

import { sql } from "drizzle-orm";
import { db, type DbOrTx } from "$lib/server/db/client.js";
import { env } from "$lib/server/config/env.js";

/** The per-account QPS floor twitterapi.io enforces for a NEVER-PAID account: 0.2 QPS
 *  = 1 request every 5000ms. THE single home for the QPS knob — http.ts re-exports it
 *  so the seam + walker lane read ONE constant. After the operator's first top-up the
 *  ceiling rises to 3 QPS (~334ms); a 3-QPS operator can lower this. */
export const TWITTERAPIIO_MIN_REQUEST_INTERVAL_MS = 5000;

/** Pacer slot interval. Tests disable the slot (0ms) so the atomic UPDATE always
 *  acquires — suites never wait seconds between mocked twitterapi.io calls. */
export const TWITTER_PACER_SLOT_MS =
  env.NODE_ENV === "test" ? 0 : TWITTERAPIIO_MIN_REQUEST_INTERVAL_MS;

export interface TwitterPacerSlotResult {
  acquired: boolean;
  waitMs: number;
}

export async function acquireTwitterPacerSlot(dbCtx: DbOrTx = db): Promise<TwitterPacerSlotResult> {
  // Atomic claim: bump next_allowed_at to NOW()+slot ONLY when the slot is already
  // due. The single UPDATE...RETURNING is the lock — concurrent callers across
  // replicas serialize on the row, exactly one wins per slot window.
  const updateResult = await dbCtx.execute<{ next_allowed_at: Date }>(sql`
    UPDATE twitter_pacer
    SET next_allowed_at = NOW() + (${TWITTER_PACER_SLOT_MS} || ' milliseconds')::interval
    WHERE id = 1
      AND next_allowed_at <= NOW()
    RETURNING next_allowed_at
  `);
  const updated =
    (updateResult as unknown as { rows?: Array<{ next_allowed_at: Date }> }).rows ?? [];
  if (updated.length === 1) {
    return { acquired: true, waitMs: 0 };
  }

  const readResult = await dbCtx.execute<{ wait_ms: number | string }>(sql`
    SELECT GREATEST(0, EXTRACT(EPOCH FROM (next_allowed_at - NOW())) * 1000)::int AS wait_ms
    FROM twitter_pacer
    WHERE id = 1
  `);
  const row = (readResult as unknown as { rows?: Array<{ wait_ms: number | string }> }).rows?.[0];
  return { acquired: false, waitMs: row ? Number(row.wait_ms) : TWITTER_PACER_SLOT_MS };
}

export async function __resetTwitterPacerForTest(): Promise<void> {
  await db.execute(sql`UPDATE twitter_pacer SET next_allowed_at = NOW() WHERE id = 1`);
}
