// Phase 3.0 Plan 09 — daily purge cron handler (PRIV-04 / GDPR Art. 17).
//
// Fires at 04:00 America/Los_Angeles (after the nightly backup at 03:00) —
// the operator wants the backup to capture the soft-deleted user's data
// BEFORE the hard-delete cascade runs, so a 60-day-old account that gets
// purged today is still in yesterday's backup if recovery is needed.
//
// Pipeline:
//   1. listPurgeEligibleUsers() — Plan 05 helper. Returns user_ids whose
//      deletedAt is older than RETENTION_DAYS (default 60). Active users
//      (deletedAt IS NULL) are excluded by construction.
//   2. For each eligible user, call purgeAccount(userId). Per-user errors
//      are caught + logged so one failure doesn't abort the rest of the
//      sweep. purgeAccount itself is idempotent (Plan 05 contract) so a
//      re-run on partial failure is safe.
//
// The purge.completed audit row is written by purgeAccount itself — no
// audit work in this handler.

import { listPurgeEligibleUsers, purgeAccount } from "../../lib/server/services/purge-account.js";
import { logger } from "../../lib/server/logger.js";
import { deleteForwardedOutboxRows } from "./outbox-forwarder.js";

/** Outbox retention window — keep forwarded rows for 7 days so an
 *  operator debugging a recent issue can still trace which jobs were
 *  enqueued via outbox. After 7 days the rows are pure noise. */
const OUTBOX_RETENTION_DAYS = 7;

export async function handlePurgeDaily(job: { id: string; data: object }): Promise<void> {
  const eligible = await listPurgeEligibleUsers();
  logger.info(
    { jobId: job.id, count: eligible.length },
    "purge-daily: starting sweep over eligible users",
  );

  let succeeded = 0;
  let failed = 0;
  for (const userId of eligible) {
    try {
      const result = await purgeAccount(userId, { ipAddress: "system" });
      if (result.purged) succeeded += 1;
    } catch (err) {
      failed += 1;
      logger.error(
        { jobId: job.id, userId, err },
        "purge-daily: per-user purge failed; continuing sweep",
      );
    }
  }

  // Phase 03.0.3 follow-up — outbox cleanup. Forwarded rows older than
  // 7 days are deleted. Pending rows (forwarded_at IS NULL) are NEVER
  // touched here regardless of age — they represent stuck intents the
  // operator must investigate manually (likely a persistent boss.send
  // failure that exhausted MAX_ATTEMPTS in outbox-forwarder.ts).
  try {
    const cutoff = new Date(Date.now() - OUTBOX_RETENTION_DAYS * 86_400_000);
    const deleted = await deleteForwardedOutboxRows(cutoff);
    logger.info(
      { jobId: job.id, deleted, retentionDays: OUTBOX_RETENTION_DAYS },
      "purge-daily: outbox cleanup complete",
    );
  } catch (err) {
    logger.error({ jobId: job.id, err }, "purge-daily: outbox cleanup failed; continuing");
  }

  logger.info(
    { jobId: job.id, total: eligible.length, succeeded, failed },
    "purge-daily: sweep complete",
  );
}
