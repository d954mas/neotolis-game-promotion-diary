// adapter_refresh_queue janitor.
//
// Daily DELETE of terminal-state rows. `done` / `dead_letter` rows older
// than the retention window are dead weight: the cap counter
// (services/quota.ts) filters by a 15-min sliding window, and the
// real audit trail lives in `audit_log`. Without periodic cleanup the
// table grows unbounded (~525k rows/year at the 8 req/min baseline).
//
// Retention is conservative — 14 days gives the operator enough
// forensic depth for "my refresh failed last week" without keeping
// rows that no live query reads.

import { sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { logger } from "$lib/server/logger.js";

/** How long to keep `done` / `dead_letter` rows before the janitor
 *  deletes them. Exported for test setup that wants to construct rows
 *  on the boundary of the retention window. */
export const ADAPTER_REFRESH_QUEUE_RETENTION_DAYS = 14;

export interface JanitorResult {
  rowsDeleted: number;
}

/** Delete terminal-state rows older than the retention window. Returns
 *  the deleted-row count for observability. Idempotent — re-running on
 *  the same day deletes zero additional rows. */
export async function handleAdapterRefreshQueueJanitor(): Promise<JanitorResult> {
  const result = await db.execute(sql`
    DELETE FROM adapter_refresh_queue
    WHERE status IN ('done', 'dead_letter')
      AND enqueued_at < NOW() - (${ADAPTER_REFRESH_QUEUE_RETENTION_DAYS} || ' days')::interval
  `);
  const rowsDeleted = (result as unknown as { rowCount?: number | null }).rowCount ?? 0;
  logger.info(
    { rowsDeleted, retentionDays: ADAPTER_REFRESH_QUEUE_RETENTION_DAYS },
    "adapter_refresh_queue janitor: terminal-state cleanup complete",
  );
  return { rowsDeleted };
}
