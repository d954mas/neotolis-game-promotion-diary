// Reddit snapshot writers — V20 idempotency (D-RDT-SNAPSHOTS).
//
// Three time-series writers, all minute-truncating `polled_at` via
// `date_trunc('minute', NOW())` + ON CONFLICT DO NOTHING on the
// per-table UNIQUE (subject, polled_at) index. Two writes within the
// same minute collapse into one row — idempotent under worker retries
// inside the same tick window.
//
// Pattern mirrors $lib/sources/youtube/server/snapshots.ts's writeSnapshot
// (Phase 03.0 D-NEW). The Reddit version is leaner: no apiKeyId /
// poolKind columns because there's no per-key quota counter under
// DV-RDT-7 (the 8-slot worker is the only rate-limit budget owner).
//
// All three tables are PUBLIC-DATA (no user_id) — see the per-schema
// header comments in src/lib/sources/reddit/server/schema/*.ts for the
// tenant-scope rationale. ESLint allowlist for these tables lives in
// eslint-plugin-tenant-scope/no-unfiltered-tenant-query.js.

import { sql } from "drizzle-orm";
import type { DbOrTx } from "$lib/server/db/client.js";
import {
  redditPostSnapshots,
  redditUserSnapshots,
  redditSubredditSnapshots,
} from "./schema/index.js";

export type RedditSnapshotStatus = "ok" | "removed" | "archived" | "not_found";

/** Idempotent post-snapshot writer.
 *
 *  V20 contract: `polled_at = date_trunc('minute', NOW())`; UNIQUE on
 *  (post_id, polled_at); ON CONFLICT DO NOTHING. Two worker retries
 *  inside the same minute window collapse into one row at the DB level.
 */
export async function writeRedditPostSnapshot(
  dbCtx: DbOrTx,
  args: {
    postId: string;
    score: number | null;
    numComments: number | null;
    awardsTotal: number | null;
    upvoteRatio: number | null;
    removedByCategory: string | null;
    status: RedditSnapshotStatus;
  },
): Promise<void> {
  await dbCtx
    .insert(redditPostSnapshots)
    .values({
      postId: args.postId,
      polledAt: sql`date_trunc('minute', NOW())` as unknown as Date,
      score: args.score,
      numComments: args.numComments,
      awardsTotal: args.awardsTotal,
      upvoteRatio: args.upvoteRatio,
      removedByCategory: args.removedByCategory,
      status: args.status,
    })
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

/** Idempotent subreddit-snapshot writer (per D-RDT-SUB-SNAPSHOTS — all
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
