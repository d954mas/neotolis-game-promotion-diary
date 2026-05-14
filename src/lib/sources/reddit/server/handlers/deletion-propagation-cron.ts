// Reddit deletion-propagation cron handler (D-RDT-DELETION-PROPAGATION,
// Reddit Public Content Policy).
//
// Schedule: 05:00 UTC daily.
//
// What this does: ZERO-HTTP pure-DB UPDATE. Posts with
// `deletion_detected_at < NOW() - INTERVAL '48 hours' AND author IS NOT
// NULL` have their author / author_fullname fields nulled. Title + body
// excerpt remain (user's diary context); author-identifying info is
// removed.
//
// GDPR-grade transactional audit: the UPDATE that nulls author* columns
// and the `reddit.deletion_propagated` audit INSERT run inside the SAME
// db.transaction on the SAME connection. Either both land or both roll
// back — there is no window where author data is purged but the forensic
// trail is missing. The audit INSERT goes through `tx.insert(auditLog)`
// (not `writeAudit(...)` against the top-level `db`), which is critical:
// calling `writeAudit` from inside a transaction would acquire a second
// pool connection while the tx still holds its first — the well-known
// pool-deadlock pattern documented in services/quota.ts. Using `tx`
// directly reuses the held connection and sidesteps the deadlock.
//
// When ADMIN_EMAIL_ALLOWLIST is empty (no admin configured), the purge
// still runs but the audit is silently skipped — purging is the
// security-critical work; the missing forensic row is logged at INFO so
// self-host operators see the signal.
//
// Idempotency: the WHERE clause filters `author IS NOT NULL`. Re-running
// the cron on a tick where every eligible row was already purged
// returns purged=0 and emits no audit row. The deletion-propagation
// guard in upsert.ts's upsertRedditPost ensures a later re-poll of a
// deleted post won't restore the nulled author (the SET clause omits
// the author* fields).

import { sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { auditLog } from "$lib/server/db/schema/audit-log.js";
import { logger } from "$lib/server/logger.js";
import { resolveOperatorUserId } from "../operator-resolver.js";

export async function handleDeletionPropagationCron(): Promise<{
  purged: number;
  queueRowsCleaned: number;
}> {
  // Transactional UPDATE + audit INSERT. Both succeed together or both
  // roll back. See file header for the GDPR rationale.
  const purged = await db.transaction(async (tx) => {
    const result = await tx.execute(sql`
      WITH purged AS (
        UPDATE reddit_posts
        SET author = NULL, author_fullname = NULL
        WHERE deletion_detected_at IS NOT NULL
          AND deletion_detected_at < NOW() - INTERVAL '48 hours'
          AND author IS NOT NULL
        RETURNING post_id
      )
      SELECT COUNT(*)::int AS purged FROM purged
    `);
    const purgedCount = Number(
      (result as unknown as { rows: Array<{ purged: number | string }> }).rows[0]?.purged ?? 0,
    );

    if (purgedCount > 0) {
      const operatorId = await resolveOperatorUserId();
      if (operatorId === null) {
        // No admin configured — skip the audit but the purge already
        // landed. Log at INFO so self-host operators see the signal.
        logger.info(
          { purged: purgedCount },
          "reddit.deletion_propagation_cron: no ADMIN_EMAIL_ALLOWLIST resolvable; skipping audit",
        );
      } else {
        await tx.insert(auditLog).values({
          userId: operatorId,
          action: "reddit.deletion_propagated",
          ipAddress: "127.0.0.1",
          userAgent: null,
          metadata: { posts_purged: purgedCount },
        });
      }
    }

    return purgedCount;
  });

  // Queue cleanup — `done` and `dead_letter` rows accumulate forever
  // otherwise. Schema header for reddit_refresh_queue (schema/refresh-queue.ts)
  // promises "kept ~7 days for audit, then truncated by deletion-propagation
  // cron" — this is the implementation. Without it, ~4M rows/year on a
  // healthy instance (8 req/min × 60 × 24 × 365). 7-day window keeps the
  // forensic audit window long enough to investigate failed batches.
  const queueCleanup = await db.execute(sql`
    WITH cleaned AS (
      DELETE FROM reddit_refresh_queue
      WHERE status IN ('done', 'dead_letter')
        AND last_attempt_at IS NOT NULL
        AND last_attempt_at < NOW() - INTERVAL '7 days'
      RETURNING id
    )
    SELECT COUNT(*)::int AS cleaned FROM cleaned
  `);
  const queueRowsCleaned = Number(
    (queueCleanup as unknown as { rows: Array<{ cleaned: number | string }> }).rows[0]?.cleaned ??
      0,
  );

  logger.info({ purged, queueRowsCleaned }, "reddit.deletion_propagation_cron: tick complete");
  return { purged, queueRowsCleaned };
}

/** Re-exported for tests — see ../operator-resolver.ts. */
export { __resetOperatorIdCacheForTest as __resetOperatorCacheForTest } from "../operator-resolver.js";
