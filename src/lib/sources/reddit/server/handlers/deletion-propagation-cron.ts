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
// Emits ONE `reddit.deletion_propagated` audit row per cron tick when
// posts_purged > 0. The audit row's user_id is the operator (resolved
// via ADMIN_EMAIL_ALLOWLIST[0]) — the same pattern as worker-tick.ts's
// emitQueueDrainedAudit. When ADMIN_EMAIL_ALLOWLIST is empty (no admin
// configured), the purge still runs but the audit is silently skipped
// — purging is the security-critical work; the audit is the forensic
// trail (best-effort).
//
// Idempotency: the WHERE clause filters `author IS NOT NULL`. Re-running
// the cron on a tick where every eligible row was already purged
// returns purged=0 and emits no audit row. The deletion-propagation
// guard in upsert.ts's upsertRedditPost ensures a later re-poll of a
// deleted post won't restore the nulled author (the SET clause omits
// the author* fields).

import { sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { user } from "$lib/server/db/schema/auth.js";
import { writeAudit } from "$lib/server/audit.js";
import { logger } from "$lib/server/logger.js";

export async function handleDeletionPropagationCron(): Promise<{ purged: number }> {
  // CTE-style UPDATE … RETURNING so we can count rows actually purged
  // in one round-trip. Drizzle's `db.execute(sql\`…\`)` returns
  // `{ rows: [...] }`; row count = rows.length.
  const result = await db.execute(sql`
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
  const purged = Number(
    (result as unknown as { rows: Array<{ purged: number | string }> }).rows[0]?.purged ?? 0,
  );

  if (purged > 0) {
    const operatorId = await resolveOperatorUserId();
    if (operatorId === null) {
      // No admin configured — skip the audit but the purge already
      // landed. Log at INFO so self-host operators see the signal.
      logger.info(
        { purged },
        "reddit.deletion_propagation_cron: no ADMIN_EMAIL_ALLOWLIST resolvable; skipping audit",
      );
    } else {
      await writeAudit({
        userId: operatorId,
        action: "reddit.deletion_propagated",
        ipAddress: "127.0.0.1",
        metadata: { posts_purged: purged },
      });
    }
  }

  logger.info({ purged }, "reddit.deletion_propagation_cron: tick complete");
  return { purged };
}

/** Cached operator user_id resolved from ADMIN_EMAIL_ALLOWLIST[0].
 *  Mirrors worker-tick.ts's resolveOperatorUserId for consistent audit
 *  identity across reddit.* verbs. `undefined` = not yet resolved;
 *  `null` = resolved-empty; string = resolved successfully.
 *
 *  Cache is invalidated by the __resetOperatorCacheForTest helper —
 *  integration tests that mutate process.env.ADMIN_EMAIL_ALLOWLIST
 *  must call it to re-resolve. */
let cachedOperatorId: string | null | undefined = undefined;

async function resolveOperatorUserId(): Promise<string | null> {
  if (cachedOperatorId !== undefined) return cachedOperatorId;
  const { env } = await import("$lib/server/config/env.js");
  const allowlist = [...env.ADMIN_EMAIL_ALLOWLIST];
  if (allowlist.length === 0) {
    cachedOperatorId = null;
    return null;
  }
  const rows = await db
    .select({ id: user.id })
    .from(user)
    .where(sql`lower(${user.email}) = ${allowlist[0]}`)
    .limit(1);
  cachedOperatorId = rows[0]?.id ?? null;
  return cachedOperatorId;
}

/** Test-only helper — resets the cached operator id so each test case
 *  starts from a clean resolve. Not exported through any barrel; only
 *  the reddit-cron-handlers.test.ts file imports it. */
export function __resetOperatorCacheForTest(): void {
  cachedOperatorId = undefined;
}
