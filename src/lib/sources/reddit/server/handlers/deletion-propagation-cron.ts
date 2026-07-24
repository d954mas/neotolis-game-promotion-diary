// Reddit deletion-propagation cron handler — Reddit Public Content Policy / GDPR
// compliance (D-06/D-08, the legally load-bearing privacy control). Carry-over,
// re-implemented on the Phase-12 tree.
//
// Schedule: 05:00 UTC daily.
//
// ZERO-HTTP pure-DB UPDATE. Posts past the 48h grace window have author /
// author_fullname / deletion_detected_by nulled. Title + body excerpt REMAIN (the
// user's diary context); author-identifying info is removed. deletion_detected_by is
// purged too (review fix): for an account walk its value is
// "reddit_account:<username>" — the very author identity this cron exists to erase.
// Consequence (deliberate): clearReappearedDeletions can no longer un-flag a purged
// post (it matches on the subject key) — a purge is TERMINAL, the conservative
// GDPR posture; deletion_detected_at stays set so the freeze + the "Deleted on
// Reddit" notice persist.
// The deletion is DETECTED by the Variant-A disappearance-from-walk reconciliation
// (walk-core.ts) + the write-path removed_by_category belt (snapshots.ts); this cron
// is the PURGE half that acts on `deletion_detected_at` after the grace window.
//
// GDPR-grade TRANSACTIONAL audit: the UPDATE that nulls author* and the
// `reddit.deletion_propagated` audit INSERT run inside the SAME db.transaction on the
// SAME connection. Either both land or both roll back — there is no window where
// author data is purged but the forensic trail is missing. The audit INSERT goes
// through `writeAuditTx(tx, …)` — the tx-aware audit.ts API (AGENTS.md: audit writes
// only via audit.ts) — NOT `writeAudit(...)` against the top-level `db`, which is
// critical: the db-bound writer from inside a transaction would acquire a SECOND pool
// connection while the tx still holds its first — the pool-deadlock pattern.
// writeAuditTx reuses the held connection and sidesteps the deadlock.
//
// When ADMIN_EMAIL_ALLOWLIST is empty (no operator resolvable) the purge STILL runs
// but the audit is skipped (purging is the security-critical work; the missing
// forensic row is logged at INFO). Idempotency: the "any identity column still
// non-null" guard makes a re-run on an already-purged tick return purged=0 and emit
// no audit row — and writeSnapshot never restores a nulled author (the
// deletion_detected_at freeze in snapshots.ts).

import { sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { writeAuditTx } from "$lib/server/audit.js";
import { logger } from "$lib/server/logger.js";
import { resolveOperatorUserId } from "../quota.js";

export async function handleDeletionPropagationCron(): Promise<{ purged: number }> {
  // Resolve the operator BEFORE opening the purge transaction (review fix): the
  // resolver runs on the module-level `db` — called from inside the tx it would
  // acquire a SECOND pool connection while the tx holds its first, hanging the
  // compliance job on a saturated / size-1 pool. The value is memoized, so the
  // unconditional call costs one SELECT on the first tick only.
  const operatorId = await resolveOperatorUserId();
  const purged = await db.transaction(async (tx) => {
    // The guard covers EVERY identity column (not just `author`): a row can carry
    // author_fullname without author (the provider nulls them independently), and
    // deletion_detected_by must be erased even on rows whose author was already null.
    const result = await tx.execute(sql`
      WITH purged AS (
        UPDATE reddit_posts
        SET author = NULL, author_fullname = NULL, deletion_detected_by = NULL, updated_at = NOW()
        WHERE deletion_detected_at IS NOT NULL
          AND deletion_detected_at < NOW() - INTERVAL '48 hours'
          AND (author IS NOT NULL OR author_fullname IS NOT NULL OR deletion_detected_by IS NOT NULL)
        RETURNING post_id
      )
      SELECT COUNT(*)::int AS purged FROM purged
    `);
    const purgedCount = Number(
      (result as unknown as { rows: Array<{ purged: number | string }> }).rows[0]?.purged ?? 0,
    );

    if (purgedCount > 0) {
      if (operatorId === null) {
        logger.info(
          { purged: purgedCount },
          "reddit.deletion_propagation_cron: no ADMIN_EMAIL_ALLOWLIST resolvable; skipping audit",
        );
      } else {
        // IN-TX audit via the tx-aware audit.ts API (NOT the db-bound writeAudit —
        // pool-deadlock). The purge UPDATE + this audit commit together.
        await writeAuditTx(tx, {
          userId: operatorId,
          action: "reddit.deletion_propagated",
          ipAddress: "127.0.0.1",
          metadata: { posts_purged: purgedCount },
        });
      }
    }

    return purgedCount;
  });

  logger.info({ purged }, "reddit.deletion_propagation_cron: tick complete");
  return { purged };
}
