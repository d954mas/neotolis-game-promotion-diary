// Reddit snapshot writers — within-the-minute idempotency.
//
// Three time-series writers, all minute-truncating `polled_at` via
// `date_trunc('minute', NOW())` + ON CONFLICT DO NOTHING on the
// per-table composite PK (subject, polled_at). Two writes within the
// same minute collapse into one row — idempotent under worker retries
// inside the same tick window.
//
// Pattern mirrors $lib/sources/youtube/server/snapshots.ts's writeSnapshot.
// The Reddit version is leaner: no apiKeyId / poolKind columns because
// there's no per-key quota counter — the 8-slot worker is the only
// rate-limit budget owner.
//
// All three tables are PUBLIC-DATA (no user_id) — see the per-schema
// header comments in src/lib/sources/reddit/server/schema/*.ts for the
// tenant-scope rationale. ESLint allowlist for these tables lives in
// eslint-plugin-tenant-scope/no-unfiltered-tenant-query.js.

import { sql, and, eq, isNull, inArray } from "drizzle-orm";
import type { DbOrTx } from "$lib/server/db/client.js";
import {
  redditPostSnapshots,
  redditUserSnapshots,
  redditSubredditSnapshots,
  redditPosts,
} from "./schema/index.js";

export type RedditSnapshotStatus = "ok" | "removed" | "archived" | "not_found";

/** Statuses that signal the post is gone (removed/deleted/banned/private).
 *  When a snapshot lands with one of these AND reddit_posts.deletion_detected_at
 *  is still NULL, the parent row is stamped — this starts the 48h timer
 *  enforced by handleDeletionPropagationCron (Reddit Public Content Policy).
 *
 *  `archived` is NOT a deletion signal — archived posts are visible but
 *  read-only; their stats keep updating until removed.
 *  `not_found` includes 404 from /comments/<id>.json which can be either
 *  removed-by-author or never-existed; the policy treats it as deletion
 *  signal because we can no longer verify author identity. */
const POST_DELETION_STATUSES: ReadonlySet<RedditSnapshotStatus> = new Set(["removed", "not_found"]);

/**
 * Mark reddit_posts.deletion_detected_at = NOW() the FIRST time a snapshot
 * lands with a deletion status. Idempotent: WHERE deletion_detected_at
 * IS NULL guards against re-stamping on subsequent polls. Single point
 * of truth — every snapshot-writing handler must invoke this so the
 * 48h-purge cron has accurate data to act on.
 *
 * Schema-header contract (schema/posts.ts:21 + schema/post-snapshots.ts:25):
 *   "worker sets deletion_detected_at = NOW() when latest snapshot has
 *    removed_by_category != NULL". This is the implementation.
 *
 * Returns true when the column was just stamped (caller may log the
 * transition); false when status is non-deletion OR the column was
 * already set on a prior poll.
 */
export async function markPostDeletionDetectedIfNeeded(
  dbCtx: DbOrTx,
  postId: string,
  status: RedditSnapshotStatus,
): Promise<boolean> {
  if (!POST_DELETION_STATUSES.has(status)) return false;
  const result = await dbCtx
    .update(redditPosts)
    .set({ deletionDetectedAt: sql`NOW()`, lastSnapshotAt: sql`NOW()` })
    .where(and(eq(redditPosts.postId, postId), isNull(redditPosts.deletionDetectedAt)))
    .returning({ id: redditPosts.postId });
  return result.length > 0;
}

/** Batch variant. Takes a list of {postId, status} pairs, filters to
 *  the deletion statuses, and runs ONE UPDATE … WHERE post_id IN (…)
 *  for the whole set. Used by post_batch to avoid a per-row UPDATE
 *  per missing-or-removed id. */
export async function markPostDeletionDetectedIfNeededMany(
  dbCtx: DbOrTx,
  rows: ReadonlyArray<{ postId: string; status: RedditSnapshotStatus }>,
): Promise<void> {
  const deletionIds = rows.filter((r) => POST_DELETION_STATUSES.has(r.status)).map((r) => r.postId);
  if (deletionIds.length === 0) return;
  await dbCtx
    .update(redditPosts)
    .set({ deletionDetectedAt: sql`NOW()`, lastSnapshotAt: sql`NOW()` })
    .where(and(inArray(redditPosts.postId, deletionIds), isNull(redditPosts.deletionDetectedAt)));
}

export interface RedditPostSnapshotWrite {
  postId: string;
  score: number | null;
  numComments: number | null;
  awardsTotal: number | null;
  upvoteRatio: number | null;
  removedByCategory: string | null;
  status: RedditSnapshotStatus;
}

/** Idempotent post-snapshot writer.
 *
 *  `polled_at = date_trunc('minute', NOW())`; composite PK on
 *  (post_id, polled_at) + ON CONFLICT DO NOTHING. Two worker retries
 *  inside the same minute window collapse into one row at the DB level.
 */
export async function writeRedditPostSnapshot(
  dbCtx: DbOrTx,
  args: RedditPostSnapshotWrite,
): Promise<void> {
  await writeRedditPostSnapshotsMany(dbCtx, [args]);
}

/** Multi-row variant — one INSERT for an array of snapshots. Each row
 *  gets the same date_trunc('minute', NOW()) polled_at (single tick),
 *  so the (post_id, polled_at) PK collisions across the array are
 *  impossible if the caller de-duped postIds. */
export async function writeRedditPostSnapshotsMany(
  dbCtx: DbOrTx,
  rows: ReadonlyArray<RedditPostSnapshotWrite>,
): Promise<void> {
  if (rows.length === 0) return;
  await dbCtx
    .insert(redditPostSnapshots)
    .values(
      rows.map((r) => ({
        postId: r.postId,
        polledAt: sql`date_trunc('minute', NOW())` as unknown as Date,
        score: r.score,
        numComments: r.numComments,
        awardsTotal: r.awardsTotal,
        upvoteRatio: r.upvoteRatio,
        removedByCategory: r.removedByCategory,
        status: r.status,
      })),
    )
    .onConflictDoNothing({
      target: [redditPostSnapshots.postId, redditPostSnapshots.polledAt],
    });
}

/** Idempotent user-snapshot writer (OWNED reddit_account sources only —
 *  see schema header for the rationale).
 *
 *  UNIQUE on (username, polled_at) with the same minute-truncation
 *  contract as post snapshots. */
export async function writeRedditUserSnapshot(
  dbCtx: DbOrTx,
  args: {
    username: string;
    linkKarma: number | null;
    commentKarma: number | null;
    totalKarma: number | null;
  },
): Promise<void> {
  await dbCtx
    .insert(redditUserSnapshots)
    .values({
      username: args.username,
      polledAt: sql`date_trunc('minute', NOW())` as unknown as Date,
      linkKarma: args.linkKarma,
      commentKarma: args.commentKarma,
      totalKarma: args.totalKarma,
    })
    .onConflictDoNothing({
      target: [redditUserSnapshots.username, redditUserSnapshots.polledAt],
    });
}

/** Idempotent subreddit-snapshot writer (writes for ALL cached subs —
 *  cached subs get tracked over time).
 *
 *  UNIQUE on (subreddit, polled_at) minute-trunc. */
export async function writeRedditSubredditSnapshot(
  dbCtx: DbOrTx,
  args: {
    subreddit: string;
    subscribers: number | null;
    accountsActive: number | null;
  },
): Promise<void> {
  await dbCtx
    .insert(redditSubredditSnapshots)
    .values({
      subreddit: args.subreddit,
      polledAt: sql`date_trunc('minute', NOW())` as unknown as Date,
      subscribers: args.subscribers,
      accountsActive: args.accountsActive,
    })
    .onConflictDoNothing({
      target: [redditSubredditSnapshots.subreddit, redditSubredditSnapshots.polledAt],
    });
}
