// Phase 3.0 Plan 09 — daily YouTube quota reset cron handler.
//
// Fires at 00:00 America/Los_Angeles (the natural reset boundary for YouTube
// Data API v3 quota — Pitfall D). Two responsibilities:
//
//   1. Clear the in-process module-level audit-emission guard
//      (`auditedTransitions` Map + `roundRobinIdx` + `cachedOperatorId`)
//      via resetThrottleState() — Plan 03.0-03 export. Without this, the
//      80%/95% audit gate would hold yesterday's "already emitted today"
//      memory and miss the first crossing of the new day.
//
//   2. Optional housekeeping: trim youtube_service_quota_usage rows older
//      than 7 days. The /admin/quota page shows the last 7 days; older rows
//      are dead weight. Implemented as a single DELETE; safe at any size
//      (the table is operator-scoped and indexed on date_pacific).
//
// Idempotent: a re-run within the same Pacific day is harmless. The Set
// clear is no-op if already empty; the DELETE finds zero rows on re-run.
//
// Note on multi-replica: pg-boss's schedule + boss.work flow guarantees only
// ONE worker receives the job per scheduled tick. If we ever scale to N
// worker replicas, only one of them will process this job — the in-process
// Set clear in the ONE replica that processes the job is sufficient because
// the audit_log lookup in markThrottleTransition handles cross-replica
// drift (see $lib/sources/youtube/server/quota.ts header).

import { sql } from "drizzle-orm";
import { db } from "../../lib/server/db/client.js";
import { youtubeServiceQuotaUsage } from "../../lib/server/db/schema/index.js";
import { resetThrottleState } from "../../lib/sources/youtube/server/quota.js";
import { logger } from "../../lib/server/logger.js";

export async function handleQuotaReset(job: { id: string; data: object }): Promise<void> {
  // 1. Clear in-process state (Set + round-robin + cached operator id).
  resetThrottleState();
  logger.info({ jobId: job.id }, "youtube quota reset — module state cleared");

  // 2. Optional housekeeping — trim rows older than 7 days. Safe DELETE
  //    with a stable WHERE; date_pacific is text in 'YYYY-MM-DD' format
  //    so lexicographic compare matches chronological compare.
  try {
    const cutoff = new Date(Date.now() - 7 * 86_400_000);
    const cutoffDateStr = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(cutoff);
    const result = await db
      .delete(youtubeServiceQuotaUsage)
      .where(sql`${youtubeServiceQuotaUsage.datePacific} < ${cutoffDateStr}`);
    logger.info(
      { jobId: job.id, cutoff: cutoffDateStr, result },
      "youtube quota housekeeping: trimmed rows older than 7 days",
    );
  } catch (err) {
    logger.warn({ jobId: job.id, err }, "youtube quota housekeeping DELETE failed; continuing");
  }
}
