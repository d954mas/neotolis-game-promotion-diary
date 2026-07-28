// Reddit deletion-propagation cron handler — Reddit Public Content Policy / GDPR
// compliance (D-06/D-08, the legally load-bearing privacy control). Carry-over,
// re-implemented on the Phase-12 tree.
//
// Schedule: 05:00 UTC daily.
//
// ZERO-HTTP pure-DB UPDATE (no provider request is needed or issued — detection is
// what costs credits, and it already happened).
//
// ★ THE POLICY (review fix — "anonymize, don't delete"): after the 48h grace window,
// EVERY field from which the deleted post's author is mechanically recoverable is
// erased; the diary CONTENT (title, body excerpt, metrics, thumbnail, the event row
// itself) stays, because that is the user's own record of their promotion work. The
// pre-fix version nulled only author / author_fullname / deletion_detected_by and left
// the username sitting in plain sight in three derived places, so the "purge" did not
// actually purge:
//
//   reddit_posts.author            → NULL
//   reddit_posts.author_fullname   → NULL  (the t2_ id — a stable author identifier)
//   reddit_posts.deletion_detected_by → NULL  ("reddit_account:<username>")
//   reddit_posts.permalink         → a PROFILE post's permalink is
//                                    /user/<name>/comments/<id>/<slug> ⇒ rewritten to
//                                    the subreddit-less canonical /comments/<id>
//   reddit_posts.subreddit_slug    → a PROFILE post lives in the pseudo-subreddit
//                                    `u_<name>` ⇒ NULL
//   events.url                     → same /user/<name>/… rewrite (the diary link stays
//                                    valid: Reddit resolves /comments/<id>, and
//                                    redditParsePostUrl accepts it, so the event stays
//                                    editable/refreshable)
//   events.metadata.subreddit      → `u_<name>` ⇒ null (the card then renders no
//                                    subreddit line instead of the username)
//   events.author_handle           → NULL — the source-less Reddit paste path stores
//                                    the preview's username here (events-mutation),
//                                    so leaving it would keep the purged author
//                                    mechanically recoverable from the diary row
//
// A SUBREDDIT post (/r/<sub>/comments/<id>/<slug>) carries no author anywhere in its
// URL or slug, so only the three columns change for it. The events UPDATE is
// CROSS-TENANT by design — this is an operator compliance job, not a user request; it
// is scoped to the exact purged post ids and to kind='reddit_post'.
//
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
// forensic row is logged at INFO). Idempotency: the "any author residue still present"
// guard (all five predicates, not just `author IS NOT NULL`) makes a re-run on an
// already-purged tick return purged=0 and emit no audit row — and writeSnapshot never
// restores a nulled author (the deletion_detected_at freeze in snapshots.ts).

import { sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { writeAuditTx } from "$lib/server/audit.js";
import { logger } from "$lib/server/logger.js";
import { resolveOperatorUserId } from "../quota.js";

export async function handleDeletionPropagationCron(): Promise<{
  purged: number;
  orphansAnonymized: number;
}> {
  // Resolve the operator BEFORE opening the purge transaction (review fix): the
  // resolver runs on the module-level `db` — called from inside the tx it would
  // acquire a SECOND pool connection while the tx holds its first, hanging the
  // compliance job on a saturated / size-1 pool. The value is memoized, so the
  // unconditional call costs one SELECT on the first tick only.
  const operatorId = await resolveOperatorUserId();
  const purged = await db.transaction(async (tx) => {
    // The guard covers EVERY place the author survives (not just `author`): a row can
    // carry author_fullname without author (the provider nulls them independently),
    // deletion_detected_by must be erased even on rows whose author was already null,
    // and a profile post keeps the username inside permalink + subreddit_slug.
    // `post_id` is the `t3_<base36>` fullname, so the anonymized permalink is rebuilt
    // from it rather than regex-captured out of the old URL.
    const result = await tx.execute<{ post_id: string }>(sql`
      UPDATE reddit_posts
      SET author = NULL,
          author_fullname = NULL,
          deletion_detected_by = NULL,
          permalink = CASE
            WHEN permalink ~* '/user/[^/]+/comments/'
              THEN 'https://www.reddit.com/comments/' || substring(post_id from 4)
            ELSE permalink
          END,
          subreddit_slug = CASE WHEN left(subreddit_slug, 2) = 'u_' THEN NULL ELSE subreddit_slug END,
          updated_at = NOW()
      WHERE deletion_detected_at IS NOT NULL
        AND deletion_detected_at < NOW() - INTERVAL '48 hours'
        AND (
          author IS NOT NULL
          OR author_fullname IS NOT NULL
          OR deletion_detected_by IS NOT NULL
          OR permalink ~* '/user/[^/]+/comments/'
          OR left(subreddit_slug, 2) = 'u_'
        )
      RETURNING post_id
    `);
    const purgedIds = (result as unknown as { rows: Array<{ post_id: string }> }).rows.map(
      (row) => row.post_id,
    );
    const purgedCount = purgedIds.length;

    if (purgedCount > 0) {
      // Derived-copy scrub on the diary rows themselves. CROSS-TENANT by design
      // (operator compliance job), scoped to the purged post ids + kind='reddit_post'.
      // Content columns (title, notes, occurred_at) are untouched — only the
      // author-derivable fields (url, metadata.subreddit, author_handle) are.
      // Drizzle spreads a JS array into separate placeholders, which would build a row
      // constructor — join the ids into an explicit IN list (same pattern as
      // feed-enrichment's DISTINCT ON query).
      const purgedIdList = sql.join(
        purgedIds.map((id) => sql`${id}`),
        sql`, `,
      );
      await tx.execute(sql`
        UPDATE events
        SET url = CASE
              WHEN url ~* '/user/[^/]+/comments/' AND left(external_id, 3) = 't3_'
                THEN 'https://www.reddit.com/comments/' || substring(external_id from 4)
              ELSE url
            END,
            metadata = CASE
              WHEN left(metadata->>'subreddit', 2) = 'u_'
                THEN jsonb_set(metadata, '{subreddit}', 'null'::jsonb)
              ELSE metadata
            END,
            author_handle = NULL,
            updated_at = NOW()
        WHERE kind::text = 'reddit_post'
          AND external_id IN (${purgedIdList})
          AND (
            url ~* '/user/[^/]+/comments/'
            OR left(metadata->>'subreddit', 2) = 'u_'
            OR author_handle IS NOT NULL
          )
      `);

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

  const orphansAnonymized = await anonymizeOrphanedAuthors();

  logger.info({ purged, orphansAnonymized }, "reddit.deletion_propagation_cron: tick complete");
  return { purged, orphansAnonymized };
}

/** How long a cached post may sit with NOBODY interested before its author is dropped. */
const ORPHAN_AUTHOR_RETENTION_DAYS = 90;

/**
 * ORPHAN GC — the other half of the Reddit Public Content Policy posture.
 *
 * A `reddit_subreddit` walk caches EVERY post in the sub, which means it stores THIRD
 * PARTIES' usernames + their stable `t2_` ids — not the tenant's own identity. The
 * purge above only ever fires on `deletion_detected_at`, and that flag is only ever set
 * by a walk of that subject. So the moment the source is deleted (or the whole tenant
 * account is), no walk runs again, nothing is ever flagged, and those identities freeze
 * in the table with no mechanism that can ever remove them — exactly the outcome the
 * deletion-propagation control exists to prevent. The other paid adapters do not have
 * this exposure because they only ever cache the account owner's own posts.
 *
 * A row is orphaned when NOTHING references it any more:
 *   - no diary event points at it (any tenant — the row is public data), and
 *   - no live source covers its subject (neither the author as a reddit_account nor
 *     its subreddit as a reddit_subreddit), and
 *   - no walk has touched it for the retention window (a live walk rewrites author on
 *     every re-sighting, so a stale updated_at is itself evidence nobody is polling it).
 *
 * Content is preserved — this anonymizes the author, it does not delete the post row,
 * mirroring the "anonymize, don't delete" rule of the purge above. ZERO-HTTP.
 */
async function anonymizeOrphanedAuthors(): Promise<number> {
  // Same erase-every-recoverable-field posture as the purge above: a PROFILE post
  // keeps the username inside its /user/<name>/comments/… permalink and its
  // `u_<name>` pseudo-subreddit slug, so nulling author/author_fullname alone
  // leaves the identity mechanically recoverable. Rewrite both with the same CASE
  // scrubs the main purge uses (permalink rebuilt from the t3_ post_id fullname).
  const result = await db.execute<{ post_id: string }>(sql`
    UPDATE reddit_posts p
    SET author = NULL,
        author_fullname = NULL,
        permalink = CASE
          WHEN p.permalink ~* '/user/[^/]+/comments/'
            THEN 'https://www.reddit.com/comments/' || substring(p.post_id from 4)
          ELSE p.permalink
        END,
        subreddit_slug = CASE WHEN left(p.subreddit_slug, 2) = 'u_' THEN NULL ELSE p.subreddit_slug END,
        updated_at = NOW()
    WHERE (
        p.author IS NOT NULL
        OR p.author_fullname IS NOT NULL
        OR p.permalink ~* '/user/[^/]+/comments/'
        OR left(p.subreddit_slug, 2) = 'u_'
      )
      AND p.updated_at < NOW() - ${sql.raw(`INTERVAL '${ORPHAN_AUTHOR_RETENTION_DAYS} days'`)}
      AND NOT EXISTS (
        SELECT 1 FROM events e
         WHERE e.kind::text = 'reddit_post' AND e.external_id = p.post_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM data_sources ds
         WHERE ds.deleted_at IS NULL
           AND (
             (ds.kind::text = 'reddit_account' AND LOWER(ds.channel_id) = LOWER(p.author))
             OR (ds.kind::text = 'reddit_subreddit' AND ds.channel_id = p.subreddit_slug)
           )
      )
    RETURNING p.post_id
  `);
  return (result as unknown as { rows: Array<{ post_id: string }> }).rows.length;
}
