// Reddit deletion-propagation cron handler — Reddit Public Content Policy / GDPR
// compliance (D-06/D-08, the legally load-bearing privacy control). Carry-over,
// re-implemented on the Phase-12 tree.
//
// Schedule: 05:00 UTC daily.
//
// ZERO-HTTP pure-DB UPDATE. Posts whose `deletion_detected_at < NOW() - INTERVAL '48
// hours' AND author IS NOT NULL` have their author / author_fullname nulled. Title +
// body excerpt REMAIN (the user's diary context); author-identifying info is removed.
// The deletion is DETECTED by the Variant-A disappearance-from-walk reconciliation
// (walk-core.ts) + the write-path removed_by_category belt (snapshots.ts); this cron
// is the PURGE half that acts on `deletion_detected_at` after the grace window.
//
// GDPR-grade TRANSACTIONAL audit: the UPDATE that nulls author* and the
// `reddit.deletion_propagated` audit INSERT run inside the SAME db.transaction on the
// SAME connection. Either both land or both roll back — there is no window where
// author data is purged but the forensic trail is missing. The audit INSERT goes
// through `tx.insert(auditLog)` (NOT `writeAudit(...)` against the top-level `db`),
// which is critical: calling writeAudit from inside a transaction would acquire a
// SECOND pool connection while the tx still holds its first — the pool-deadlock
// pattern. Using `tx` directly reuses the held connection and sidesteps the deadlock.
//
// When ADMIN_EMAIL_ALLOWLIST is empty (no operator resolvable) the purge STILL runs
// but the audit is skipped (purging is the security-critical work; the missing
// forensic row is logged at INFO). Idempotency: the `author IS NOT NULL` guard makes
// a re-run on an already-purged tick return purged=0 and emit no audit row — and the
// snapshots.ts writeSnapshot never restores a nulled author (COALESCE-preserve).

import { sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { auditLog } from "$lib/server/db/schema/audit-log.js";
import { logger } from "$lib/server/logger.js";
import { resolveOperatorUserId } from "../quota.js";

export async function handleDeletionPropagationCron(): Promise<{ purged: number }> {
  const purged = await db.transaction(async (tx) => {
    const result = await tx.execute(sql`
      WITH purged AS (
        UPDATE reddit_posts
        SET author = NULL, author_fullname = NULL, updated_at = NOW()
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
        logger.info(
          { purged: purgedCount },
          "reddit.deletion_propagation_cron: no ADMIN_EMAIL_ALLOWLIST resolvable; skipping audit",
        );
      } else {
        // IN-TX audit (NOT writeAudit — pool-deadlock). Both commit together.
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

  logger.info({ purged }, "reddit.deletion_propagation_cron: tick complete");
  return { purged };
}
