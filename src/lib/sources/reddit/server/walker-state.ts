// Reddit listing walker — shared cursor state for sub_poll and author_poll.
//
// Reddit's public listing endpoints (`/r/<sub>/new.json`,
// `/user/<handle>/submitted.json`) return at most 100 items per request and
// expose a `data.after` cursor for the next page. The platform caps each
// listing at ~1000 items total — past that point Reddit silently returns
// an empty page no matter what cursor you pass.
//
// The walker's job: drain the listing on a fresh source up to that cap,
// then switch to incremental polling (latest 100 only, no cursor) once we
// hit `data.after === null`. State lives cross-tenant on the public cache
// rows (reddit_subreddits_cache / reddit_users_cache) — one walk per
// subreddit / user, every subscriber free-rides on the fan-out.
//
// State machine per row:
//   backfill_complete=false, after=NULL         → never walked; first
//                                                 fetch is the initial
//                                                 page (no cursor).
//   backfill_complete=false, after!=NULL        → deep walk in progress;
//                                                 next fetch continues
//                                                 from this cursor.
//   backfill_complete=true                      → walker hit
//                                                 data.after===null;
//                                                 subsequent fetches
//                                                 ignore the cursor and
//                                                 just pick up new posts
//                                                 at the top of /new.
//
// Continuation enqueue: when a walker fetch ends with after !== null AND
// backfill_complete=false, the handler enqueues another row on the SAME
// adapter_refresh_queue with `user_id=NULL` on the cron-side lane
// (service_source / service_post). This keeps the per-user source-action
// cap from charging the user once per page — one user click triggers the
// initial fetch (which IS user_source), every subsequent page is operator-
// pool work.
//
// CAP: when the walker terminates we cannot tell whether Reddit ran out of
// posts (small subreddit) or hit its ~1000 listing cap (big subreddit);
// both surface as `data.after === null`. Backfill is "complete enough" in
// either case — Reddit doesn't expose deeper history through the public
// API, so there's nothing more to fetch even if a deeper cap existed.

import { eq, sql } from "drizzle-orm";
import type { DbOrTx } from "$lib/server/db/client.js";
import { redditSubredditsCache, redditUsersCache } from "./schema/index.js";
import { adapterRefreshQueue } from "$lib/server/db/schema/index.js";

export interface WalkerState {
  /** Next-page cursor from the prior fetch. NULL when never walked OR
   *  when the listing has been fully drained (see backfillComplete). */
  afterCursor: string | null;
  /** Sticky terminal flag — once true the walker is done with deep
   *  pagination and only does incremental top-of-listing polls. */
  backfillComplete: boolean;
}

export async function getSubredditWalkState(dbCtx: DbOrTx, sub: string): Promise<WalkerState> {
  const [row] = await dbCtx
    .select({
      afterCursor: redditSubredditsCache.backfillAfterCursor,
      backfillComplete: redditSubredditsCache.backfillComplete,
    })
    .from(redditSubredditsCache)
    .where(eq(redditSubredditsCache.name, sub))
    .limit(1);
  return {
    afterCursor: row?.afterCursor ?? null,
    backfillComplete: row?.backfillComplete ?? false,
  };
}

export async function getAuthorWalkState(dbCtx: DbOrTx, handle: string): Promise<WalkerState> {
  const [row] = await dbCtx
    .select({
      afterCursor: redditUsersCache.backfillAfterCursor,
      backfillComplete: redditUsersCache.backfillComplete,
    })
    .from(redditUsersCache)
    .where(eq(redditUsersCache.username, handle))
    .limit(1);
  return {
    afterCursor: row?.afterCursor ?? null,
    backfillComplete: row?.backfillComplete ?? false,
  };
}

/** Persist the post-fetch state. Cursor=null + complete=true mark the
 *  listing as fully drained; cursor=non-null + complete=false advance the
 *  walk. `deepestAt` is the oldest `submitted_at` we've seen across all
 *  fetched pages — surfaced on the admin dashboard. Always advances
 *  monotonically (lower wins) via GREATEST(NULL, x) -> x semantics. */
export async function persistSubredditWalkProgress(
  dbCtx: DbOrTx,
  sub: string,
  next: { afterCursor: string | null; backfillComplete: boolean; oldestSubmittedAt: Date | null },
): Promise<void> {
  await dbCtx
    .update(redditSubredditsCache)
    .set({
      backfillAfterCursor: next.afterCursor,
      backfillComplete: next.backfillComplete,
      backfillDeepestAt:
        next.oldestSubmittedAt === null
          ? sql`${redditSubredditsCache.backfillDeepestAt}`
          : sql`LEAST(COALESCE(${redditSubredditsCache.backfillDeepestAt}, ${next.oldestSubmittedAt}), ${next.oldestSubmittedAt})`,
    })
    .where(eq(redditSubredditsCache.name, sub));
}

export async function persistAuthorWalkProgress(
  dbCtx: DbOrTx,
  handle: string,
  next: { afterCursor: string | null; backfillComplete: boolean; oldestSubmittedAt: Date | null },
): Promise<void> {
  await dbCtx
    .update(redditUsersCache)
    .set({
      backfillAfterCursor: next.afterCursor,
      backfillComplete: next.backfillComplete,
      backfillDeepestAt:
        next.oldestSubmittedAt === null
          ? sql`${redditUsersCache.backfillDeepestAt}`
          : sql`LEAST(COALESCE(${redditUsersCache.backfillDeepestAt}, ${next.oldestSubmittedAt}), ${next.oldestSubmittedAt})`,
    })
    .where(eq(redditUsersCache.username, handle));
}

/** Enqueue a continuation row on the service lane (user_id=NULL → cap-
 *  exempt). The initial click already burned the user's source-action
 *  budget; subsequent pages are operator-pool work. The worker dequeues
 *  cron rows just like service-cron-driven walks. */
export async function enqueueWalkerContinuation(
  dbCtx: DbOrTx,
  type: "sub_poll" | "author_poll",
  payload: { sub?: string; handle?: string },
): Promise<void> {
  // Both work types continue on the same service_source lane — the
  // service lane is "operator-pool" by construction (user_id=NULL), so
  // sub_poll and author_poll share it. The continuation never lands on
  // user_post; that lane is for paste/refresh-now post fetches, not
  // listing pagination.
  await dbCtx.insert(adapterRefreshQueue).values({
    adapterKind: "reddit_account",
    queueName: "service_source",
    type,
    payload,
    userId: null,
    priority: 0,
  });
}
