// Reddit post_single handler — fetch ONE post via /api/info.json.
//
// Two callers:
//   1. Worker batch-worker tick (queue type='post_single', from user paste).
//   2. Paste flow (services/events.ts createEvent + redditAdapter's
//      syncStats.fetch / fetchEventPreviewMetadata) calls handlePostSingle
//      synchronously to get parsed fields BEFORE the events INSERT.
//
// Contract for the paste-flow consumer:
//   - All UPSERTs (reddit_posts + reddit_users_cache + reddit_subreddits_cache)
//     complete BEFORE the function returns. Failure throws — never returns
//     a partial result.
//   - One reddit_post_snapshots row per minute (idempotent — the
//     writer minute-truncates polled_at so re-polls collapse).
//   - Returns the parsed fields the caller needs to populate the events
//     row (title / occurredAt / metadata.subreddit / authorIsMe inheritance
//     by author lookup).
//
// Endpoint choice: Reddit exposes two ways to fetch a post —
//   - /comments/<id>.json returns [submissionListing, commentsListing]
//     (single post + full comment tree).
//   - /api/info.json?id=t3_X returns a Listing with up to 100 t3 children.
// We use /api/info because: (a) it's the same endpoint handlePostsRefresh
// uses, so paste + cron + refresh-now all share one Reddit shape, (b)
// it returns ALL fields paste flow needs (selftext, score, num_comments,
// permalink, title, author, subreddit) — we never consumed the comments
// tree from /comments anyway, (c) one endpoint means one mock surface
// in tests + smoke + one place to maintain extractor logic.
//
// Cap-counter timing — read carefully before touching:
//   The 30/15min post-refresh cap is enforced by counting rows on the
//   `user_post` queue lane. The counter row is INSERTed inside the same
//   transaction as the cache writes, AFTER the Reddit fetch returns
//   successfully. A failed fetch (404, 429, network error, JSON-parse
//   error from extractT3FromInfoResponse) leaves NO counter row — the
//   transaction never starts. The cache-hit early-return path also
//   writes no counter row.
//
//   Asymmetry: the cap models "post refreshes that successfully consumed
//   a Reddit unit and produced cache data". Failures don't count — the
//   user shouldn't be charged for upstream issues outside their control.
//   The pacer slot itself protects the operator's rate-limit budget;
//   the cap protects user fairness.
//     - Preview at t=0 (cache miss) → counter row written. Submit at
//       t=5s (cache hit) → no second row. ONE refresh counted.
//     - Preview at t=0 (cache miss) → counter row written. Submit at
//       t=90s (cache miss, dedup window expired) → second counter row.
//       TWO refreshes counted, two Reddit units burned.
//     - Preview at t=0 (cache miss) → Reddit returns 429 → counter row
//       NOT written (tx never started). User retries unpenalized.
//
//   The optional `beforeFetch` gate fires ONLY on the cache-miss branch
//   so cache hits don't consume budget and aren't punished by an
//   exhausted cap. See sources/reddit/server/index.ts syncStats.fetch
//   for the wiring.

import { db, type DbOrTx } from "$lib/server/db/client.js";
import { redditFetch } from "../http.js";
import { upsertRedditPost, upsertRedditUser, upsertRedditSubreddit } from "../upsert.js";
import {
  writeRedditPostSnapshot,
  markPostDeletionDetectedIfNeeded,
  type RedditSnapshotStatus,
} from "../snapshots.js";
import { buildPostMetadata } from "../post-metadata.js";
import { redditPosts, redditPostSnapshots } from "../schema/index.js";
import { adapterRefreshQueue } from "$lib/server/db/schema/index.js";
import { eq, and, gte, desc } from "drizzle-orm";
import { AdapterError } from "$lib/sources/errors.js";
import { logger } from "$lib/server/logger.js";

/** Dedup window — handlePostSingle skips the fetch + UPSERT + snapshot
 *  + cap-counter write when a fresh snapshot for the same post exists
 *  within this window. Tuned to 60s to: (a) handle preview→submit
 *  immediate reuse on /events/new (typical click-through is <30s),
 *  (b) keep the polled_at timeline coarse enough to fit Reddit's
 *  per-minute rate-limit bucket, (c) avoid double-counting the
 *  post-refresh cap when preview and submit fire on the same post. */
const POST_SINGLE_DEDUP_WINDOW_MS = 60_000;

interface T3Data {
  id: string;
  name: string;
  subreddit: string;
  subreddit_id?: string | null;
  author: string;
  author_fullname?: string;
  permalink: string;
  url?: string;
  title: string;
  selftext?: string;
  is_self?: boolean;
  created_utc: number;
  score?: number;
  num_comments?: number;
  upvote_ratio?: number;
  total_awards_received?: number;
  link_flair_text?: string | null;
  over_18?: boolean;
  spoiler?: boolean;
  stickied?: boolean;
  locked?: boolean;
  archived?: boolean;
  removed_by_category?: string | null;
  crosspost_parent?: string | null;
}

export interface HandlePostSingleResult {
  postId: string;
  subreddit: string;
  author: string | null;
  authorFullname: string | null;
  permalink: string;
  title: string;
  submittedAt: Date;
  /** Snapshot metrics — exposed so callers (syncStats.fetch) can
   *  surface live counts without a second SELECT. Fields default to
   *  null when Reddit omits them (e.g. archived posts hide scores). */
  score: number | null;
  numComments: number | null;
  upvoteRatio: number | null;
  /** selftext exposed for paste-preview UX. Empty string for link posts. */
  selftext: string;
  /** True when this call performed a real Reddit HTTP fetch. False on dedup cache hit. */
  fetched: boolean;
}

export async function handlePostSingle(args: {
  postId: string;
  userId: string | null;
  paste?: boolean;
  pacer?: "acquire" | "already-acquired";
  /** Optional gate that fires ONLY when handlePostSingle is about to
   *  perform a real Reddit fetch (i.e. dedup pre-check missed). Throws
   *  from the gate propagate up — the fetch is skipped. Callers use
   *  this to apply cap enforcement that should NOT punish cache hits.
   *  Cron callers (paste !== true) leave this undefined. */
  beforeFetch?: () => Promise<void>;
}): Promise<HandlePostSingleResult> {
  const bareId = args.postId.replace(/^t3_/, "");
  const fullIdGuess = `t3_${bareId}`;

  // Dedup pre-check (paste path only): if a snapshot for this post was
  // written within the dedup window, reuse it instead of re-fetching.
  // Skips the Reddit HTTP call, the 4 UPSERTs, the snapshot write, and
  // the cap-counter increment. Preview→submit on the same /events/new
  // page goes through this path within seconds; the second call should
  // not burn a Reddit unit nor count against the post-refresh cap.
  //
  // Cron / worker callers (paste !== true) ALWAYS fetch — they're
  // service-driven polls explicitly meant to refresh stale data.
  if (args.paste === true) {
    const cached = await readCachedPost(fullIdGuess);
    if (cached !== null) {
      logger.debug(
        { postId: fullIdGuess, userId: args.userId, paste: true },
        "reddit post_single: dedup — reused cached snapshot < 60s old",
      );
      return cached;
    }
  }

  // Cache miss — about to burn a Reddit unit. Fire the optional gate
  // BEFORE the network call so cap-exhausted users see 429 instead of
  // a Reddit response they aren't allowed to consume.
  if (args.beforeFetch !== undefined) {
    await args.beforeFetch();
  }

  const { data } = await redditFetch<unknown>(
    `/api/info.json?id=t3_${encodeURIComponent(bareId)}`,
    { pacer: args.pacer },
  );
  const t3 = extractT3FromInfoResponse(data, bareId);

  // Author identity. Reddit literally writes "[deleted]" when account is
  // gone. Treat as NULL — the schema convention. Reddit usernames are
  // case-insensitive; lowercase on entry so cache keys + owner-match
  // joins are consistent (see url.ts header).
  const author = t3.author === "[deleted]" ? null : t3.author.toLowerCase();
  const subreddit = t3.subreddit.toLowerCase();
  const authorFullname = author === null ? null : (t3.author_fullname ?? null);
  const submittedAt = new Date(t3.created_utc * 1000);
  const fullId = `t3_${t3.id}`;
  const permalink = t3.permalink.startsWith("http")
    ? t3.permalink
    : `https://www.reddit.com${t3.permalink}`;

  // All cache writes + the cap-counter row commit in one transaction
  // so:
  //   1. A crash mid-chain leaves no intermediate state (e.g. reddit_posts
  //      written but reddit_post_snapshots missing).
  //   2. A failed cache write rolls back the cap-counter row — the user
  //      isn't charged for a refresh that didn't actually land data.
  const snapStatus = classifySnapshotStatus(t3);
  await db.transaction(async (tx) => {
    // Cap-counter ledger row. Lives on user_post lane with status='done'
    // (no work to do; the row IS the accounting entry). Only paste-path
    // calls with a known userId write here; cron / worker paths leave
    // the cap untouched.
    if (args.paste === true && args.userId !== null) {
      await claimUserPostRefreshAttempt(tx, args.userId, fullIdGuess);
    }

    // UPSERT subreddit cache first (FK target). Minimum-info INSERT —
    // sub_poll cron later fills in subscribers / description / rules.
    await upsertRedditSubreddit(tx, {
      name: subreddit,
      subredditId: t3.subreddit_id ?? null,
      subscribers: null,
      accountsActive: null,
      description: null,
      publicDescription: null,
    });

    // UPSERT author cache (FK target for reddit_user_snapshots, even
    // though we don't write a user snapshot here — that's author_poll's
    // job).
    if (author !== null) {
      await upsertRedditUser(tx, {
        username: author,
        redditId: authorFullname,
        accountAgeDays: null,
        linkKarma: null,
        commentKarma: null,
        totalKarma: null,
        isSuspended: false,
      });
    }

    // UPSERT the post row + write one snapshot in the same minute window.
    await upsertRedditPost(tx, {
      postId: fullId,
      subreddit,
      author,
      authorFullname,
      permalink,
      title: t3.title,
      submittedAt,
      metadata: buildPostMetadata(t3),
    });

    await writeRedditPostSnapshot(tx, {
      postId: fullId,
      score: t3.score ?? null,
      numComments: t3.num_comments ?? null,
      awardsTotal: t3.total_awards_received ?? null,
      upvoteRatio: t3.upvote_ratio ?? null,
      removedByCategory: t3.removed_by_category ?? null,
      status: snapStatus,
    });
    // Stamp deletion timer on first removed/not_found snapshot.
    // Idempotent and skipped on 'ok'/'archived'. Closes the gap where
    // dead posts re-poll forever and Reddit Public Content Policy
    // 48h-purge never fires.
    await markPostDeletionDetectedIfNeeded(tx, fullId, snapStatus);
  });

  logger.debug(
    {
      postId: fullId,
      subreddit,
      author,
      userId: args.userId,
      paste: args.paste ?? false,
    },
    "reddit post_single: UPSERT + snapshot complete",
  );

  return {
    postId: fullId,
    subreddit,
    author,
    authorFullname,
    permalink,
    title: t3.title,
    submittedAt,
    score: t3.score ?? null,
    numComments: t3.num_comments ?? null,
    upvoteRatio: t3.upvote_ratio ?? null,
    selftext: typeof t3.selftext === "string" ? t3.selftext : "",
    fetched: true,
  };
}

async function claimUserPostRefreshAttempt(
  dbCtx: DbOrTx,
  userId: string,
  postId: string,
): Promise<void> {
  await dbCtx.insert(adapterRefreshQueue).values({
    adapterKind: "reddit_account",
    queueName: "user_post",
    type: "post_single",
    payload: { post_id: postId, flow: "paste" },
    userId,
    priority: 0,
    status: "done",
    lastAttemptAt: new Date(),
  });
}

/** Dedup helper — return cached result if a fresh snapshot exists for
 *  this postId. Returns null when no fresh snapshot is in cache (the
 *  caller proceeds to fetch). Reads from reddit_posts (UPSERTed
 *  metadata) + reddit_post_snapshots (timeseries metrics — most recent
 *  within the dedup window). */
async function readCachedPost(postId: string): Promise<HandlePostSingleResult | null> {
  const since = new Date(Date.now() - POST_SINGLE_DEDUP_WINDOW_MS);
  const snapRows = await db
    .select({
      score: redditPostSnapshots.score,
      numComments: redditPostSnapshots.numComments,
      upvoteRatio: redditPostSnapshots.upvoteRatio,
    })
    .from(redditPostSnapshots)
    .where(and(eq(redditPostSnapshots.postId, postId), gte(redditPostSnapshots.polledAt, since)))
    .orderBy(desc(redditPostSnapshots.polledAt))
    .limit(1);
  if (snapRows.length === 0) return null;
  const snap = snapRows[0]!;

  // Pull the post row for title/author/permalink/submittedAt. The
  // snapshot+UPSERT race that this branch originally guarded against
  // was closed when the five cache writes moved into a single tx
  // (see the db.transaction in handlePostSingle above) — new writes
  // are now atomic. The check is kept defensively for pre-tx-wrap rows
  // that may carry a snapshot without a matching post row; falling
  // through to a fresh fetch is safer than returning partial data.
  const postRows = await db
    .select({
      subreddit: redditPosts.subreddit,
      author: redditPosts.author,
      authorFullname: redditPosts.authorFullname,
      permalink: redditPosts.permalink,
      title: redditPosts.title,
      submittedAt: redditPosts.submittedAt,
      metadata: redditPosts.metadata,
    })
    .from(redditPosts)
    .where(eq(redditPosts.postId, postId))
    .limit(1);
  if (postRows.length === 0) return null;
  const post = postRows[0]!;

  const meta = (post.metadata ?? {}) as { selftext?: unknown };
  const selftext = typeof meta.selftext === "string" ? meta.selftext : "";

  return {
    postId,
    subreddit: post.subreddit,
    author: post.author,
    authorFullname: post.authorFullname,
    permalink: post.permalink,
    title: post.title,
    submittedAt: post.submittedAt,
    score: snap.score,
    numComments: snap.numComments,
    upvoteRatio: snap.upvoteRatio,
    selftext,
    fetched: false,
  };
}

/** Extract the t3 child from /api/info.json's Listing response shape.
 *
 *  Response form:
 *    { kind: "Listing", data: { children: [ { kind: "t3", data: t3 } ] } }
 *
 *  For a single-id query Reddit returns 0 or 1 children (200 OK with
 *  empty `children` = post not found; we surface this as not-found).
 *  Throws AdapterError(permanent) on unexpected shape — unrecoverable
 *  (a Reddit API breaking change would surface this; the worker tick
 *  downgrades the queue row to dead_letter).
 *
 *  Required-field validation runs at the boundary so the rest of the
 *  handler can use the typed shape without per-access null checks:
 *  id / created_utc are load-bearing for the cache PK + submittedAt;
 *  subreddit / permalink / title are load-bearing for the events.metadata
 *  write + display surfaces. Missing any of these = malformed Reddit
 *  response, and falling through with `undefined as string` would crash
 *  later in the chain with a less obvious stack. */
function extractT3FromInfoResponse(data: unknown, expectedId: string): T3Data {
  const listing = data as { data?: { children?: Array<{ kind?: string; data?: T3Data }> } };
  const children = listing?.data?.children ?? [];
  if (children.length === 0) {
    // 200 OK with empty children — the post id doesn't exist (Reddit's
    // graceful 404 shape for /api/info; private subs surface the same way).
    throw new AdapterError(`Reddit post ${expectedId} not found`, { category: "not-found" });
  }
  const t3 = children[0]?.data;
  if (
    !t3 ||
    typeof t3.id !== "string" ||
    typeof t3.created_utc !== "number" ||
    typeof t3.subreddit !== "string" ||
    typeof t3.permalink !== "string" ||
    typeof t3.title !== "string" ||
    typeof t3.author !== "string"
  ) {
    throw new AdapterError(`Reddit /api/info.json?id=${expectedId}: missing required t3 fields`, {
      category: "permanent",
    });
  }
  return t3;
}

/** Map the t3 lifecycle flags onto our 4-value snapshot status vocab. */
export function classifySnapshotStatus(t3: T3Data): RedditSnapshotStatus {
  if (t3.removed_by_category) return "removed";
  if (t3.archived === true) return "archived";
  return "ok";
}
