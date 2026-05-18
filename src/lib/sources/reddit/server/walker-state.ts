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
// Concurrency model (multi-replica safe via CAS, not FOR UPDATE):
//   The handler reads the cursor BEFORE the network fetch, then persists
//   the next cursor AFTER. Holding a transaction across the HTTP call is
//   an anti-pattern (connection pinned for seconds, slow drain under
//   load). Instead we use compare-and-swap on persist:
//     UPDATE … SET after_cursor = $next
//       WHERE … AND after_cursor IS NOT DISTINCT FROM $expected
//   Two replicas reading cursor=X both fetch the same page (one wasted
//   Reddit unit — soft-fairness loss, accepted) but only ONE persist
//   succeeds. The CAS-loser skips its continuation enqueue, leaving the
//   walk at a consistent state. Without the CAS the second persist would
//   overwrite the first with the same cursor (idempotent today) BUT the
//   continuation enqueue would double-fire — two service_source rows for
//   the same page. The CAS closes that doubling.
//
//   `persistWalkProgress` + `enqueueWalkerContinuation` run inside the
//   SAME caller-supplied transaction so a process crash between the two
//   either commits both (continuation queued) or neither (next cron tick
//   picks up the walk from the still-pending cursor). Pre-fix: walker
//   crash AFTER persist but BEFORE enqueue would leave a stalled walk
//   that only the daily cron could resurrect — up to a 6h tail.
//
// Continuation enqueue: when a walker fetch ends with after !== null AND
// backfill_complete=false, the handler enqueues another row on the SAME
// adapter_refresh_queue with `user_id=NULL` on the cron-side lane
// (service_source). This keeps the per-user source-action cap from
// charging the user once per page — one user click triggers the initial
// fetch (which IS user_source), every subsequent page is operator-pool
// work.
//
// CAP: when the walker terminates we cannot tell whether Reddit ran out of
// posts (small subreddit) or hit its ~1000 listing cap (big subreddit);
// both surface as `data.after === null`. Backfill is "complete enough" in
// either case — Reddit doesn't expose deeper history through the public
// API, so there's nothing more to fetch even if a deeper cap existed.

import { and, eq, sql } from "drizzle-orm";
import { db, type DbOrTx } from "$lib/server/db/client.js";
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

/** Result of a CAS persist call. `committed=false` means a concurrent
 *  walker tick advanced the cursor between our read and our UPDATE;
 *  the caller MUST skip its continuation enqueue to avoid double-firing
 *  on the same page. */
export interface PersistResult {
  committed: boolean;
}

/** Compare-and-swap persist of subreddit walker progress. The UPDATE
 *  matches only when `backfill_after_cursor` still equals what the
 *  caller observed at the start of the tick (`expectedAfterCursor`).
 *  Two simultaneous ticks reading cursor=X both attempt to UPDATE to
 *  cursor=Y; only one succeeds. The other returns `committed=false`
 *  and the caller skips its enqueueWalkerContinuation. */
export async function persistSubredditWalkProgress(
  dbCtx: DbOrTx,
  sub: string,
  next: {
    expectedAfterCursor: string | null;
    afterCursor: string | null;
    backfillComplete: boolean;
    oldestSubmittedAt: Date | null;
  },
): Promise<PersistResult> {
  const result = await dbCtx
    .update(redditSubredditsCache)
    .set({
      backfillAfterCursor: next.afterCursor,
      backfillComplete: next.backfillComplete,
      backfillDeepestAt:
        next.oldestSubmittedAt === null
          ? sql`${redditSubredditsCache.backfillDeepestAt}`
          : sql`LEAST(COALESCE(${redditSubredditsCache.backfillDeepestAt}, ${next.oldestSubmittedAt}), ${next.oldestSubmittedAt})`,
    })
    .where(
      and(
        eq(redditSubredditsCache.name, sub),
        // `IS NOT DISTINCT FROM` treats NULL=NULL as equal — needed because
        // the first walker tick reads afterCursor=NULL and any non-CAS
        // approach (`= $expected`) would silently fail when expected is
        // NULL.
        sql`${redditSubredditsCache.backfillAfterCursor} IS NOT DISTINCT FROM ${next.expectedAfterCursor}`,
      ),
    )
    .returning({ name: redditSubredditsCache.name });
  return { committed: result.length > 0 };
}

export async function persistAuthorWalkProgress(
  dbCtx: DbOrTx,
  handle: string,
  next: {
    expectedAfterCursor: string | null;
    afterCursor: string | null;
    backfillComplete: boolean;
    oldestSubmittedAt: Date | null;
  },
): Promise<PersistResult> {
  const result = await dbCtx
    .update(redditUsersCache)
    .set({
      backfillAfterCursor: next.afterCursor,
      backfillComplete: next.backfillComplete,
      backfillDeepestAt:
        next.oldestSubmittedAt === null
          ? sql`${redditUsersCache.backfillDeepestAt}`
          : sql`LEAST(COALESCE(${redditUsersCache.backfillDeepestAt}, ${next.oldestSubmittedAt}), ${next.oldestSubmittedAt})`,
    })
    .where(
      and(
        eq(redditUsersCache.username, handle),
        sql`${redditUsersCache.backfillAfterCursor} IS NOT DISTINCT FROM ${next.expectedAfterCursor}`,
      ),
    )
    .returning({ username: redditUsersCache.username });
  return { committed: result.length > 0 };
}

/** Enqueue a continuation row on the service lane (user_id=NULL → cap-
 *  exempt). Both work types share `service_source`; user_post is paste/
 *  refresh-now only and never carries listing pagination work. */
export async function enqueueWalkerContinuation(
  dbCtx: DbOrTx,
  type: "sub_poll" | "author_poll",
  payload: { sub?: string; handle?: string },
): Promise<void> {
  await dbCtx.insert(adapterRefreshQueue).values({
    adapterKind: "reddit_account",
    queueName: "service_source",
    type,
    payload,
    userId: null,
    priority: 0,
  });
}

/** Atomic persist + continuation enqueue. The caller already finished
 *  the network fetch + cache writes; this helper runs the bookkeeping
 *  pair inside ONE db.transaction so a crash between them leaves the
 *  walker in a consistent recoverable state (either both happen — the
 *  walk continues — or neither happens — the next cron tick picks it
 *  up from the still-pending cursor).
 *
 *  Returns the persist's CAS result so the caller's logging can report
 *  "lost the race; no continuation enqueued for this tick". */
export async function commitSubredditWalkProgress(
  sub: string,
  payload: {
    expectedAfterCursor: string | null;
    nextAfterCursor: string | null;
    backfillComplete: boolean;
    oldestSubmittedAt: Date | null;
  },
): Promise<PersistResult> {
  return db.transaction(async (tx) => {
    const persistResult = await persistSubredditWalkProgress(tx, sub, {
      expectedAfterCursor: payload.expectedAfterCursor,
      afterCursor: payload.nextAfterCursor,
      backfillComplete: payload.backfillComplete,
      oldestSubmittedAt: payload.oldestSubmittedAt,
    });
    if (persistResult.committed && !payload.backfillComplete && payload.nextAfterCursor !== null) {
      await enqueueWalkerContinuation(tx, "sub_poll", { sub });
    }
    return persistResult;
  });
}

export async function commitAuthorWalkProgress(
  handle: string,
  payload: {
    expectedAfterCursor: string | null;
    nextAfterCursor: string | null;
    backfillComplete: boolean;
    oldestSubmittedAt: Date | null;
  },
): Promise<PersistResult> {
  return db.transaction(async (tx) => {
    const persistResult = await persistAuthorWalkProgress(tx, handle, {
      expectedAfterCursor: payload.expectedAfterCursor,
      afterCursor: payload.nextAfterCursor,
      backfillComplete: payload.backfillComplete,
      oldestSubmittedAt: payload.oldestSubmittedAt,
    });
    if (persistResult.committed && !payload.backfillComplete && payload.nextAfterCursor !== null) {
      await enqueueWalkerContinuation(tx, "author_poll", { handle });
    }
    return persistResult;
  });
}
