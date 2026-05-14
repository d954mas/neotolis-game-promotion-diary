// Reddit post_single handler — fetch ONE post via /comments/<id>.json.
//
// Two callers:
//   1. Worker batch-worker tick (queue type='post_single', from user paste).
//   2. Paste flow (services/ingest.ts — plan 09) calls handlePostSingle
//      synchronously to get parsed fields BEFORE the events INSERT.
//
// Contract for the paste-flow consumer:
//   - All UPSERTs (reddit_posts + reddit_users_cache + reddit_subreddits_cache)
//     complete BEFORE the function returns. Failure throws — never returns
//     a partial result.
//   - One reddit_post_snapshots row is written for the same minute (V20
//     idempotent — re-poll within 60s collapses).
//   - Returns the parsed fields the caller needs to populate the events
//     row (title / occurredAt / metadata.subreddit / authorIsMe inheritance
//     by author lookup).
//
// Reddit endpoint /comments/<id>.json returns a TWO-ELEMENT array:
//   [submissionListing, commentsListing]
// We consume only [0]: data.children[0].data is the t3 post payload.

import { db } from "$lib/server/db/client.js";
import { redditFetch } from "../http.js";
import { upsertRedditPost, upsertRedditUser, upsertRedditSubreddit } from "../upsert.js";
import { writeRedditPostSnapshot, type RedditSnapshotStatus } from "../snapshots.js";
import { redditPosts, redditPostSnapshots, redditRefreshQueue } from "../schema/index.js";
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
  /** Snapshot metrics — exposed so callers (fetchEventStats) can
   *  surface live counts without a second SELECT. Fields default to
   *  null when Reddit omits them (e.g. archived posts hide scores). */
  score: number | null;
  numComments: number | null;
  upvoteRatio: number | null;
  /** selftext exposed for paste-preview UX. Empty string for link posts. */
  selftext: string;
}

export async function handlePostSingle(args: {
  postId: string;
  userId: string | null;
  paste?: boolean;
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

  const { data } = await redditFetch<unknown>(`/comments/${bareId}.json`);
  const t3 = extractT3FromCommentsResponse(data, bareId);

  // Author identity. Reddit literally writes "[deleted]" when account is
  // gone. Treat as NULL — the schema convention.
  const author = t3.author === "[deleted]" ? null : t3.author;
  const authorFullname = author === null ? null : (t3.author_fullname ?? null);
  const submittedAt = new Date(t3.created_utc * 1000);
  const fullId = `t3_${t3.id}`;
  const permalink = t3.permalink.startsWith("http")
    ? t3.permalink
    : `https://www.reddit.com${t3.permalink}`;

  // UPSERT subreddit cache first (FK target). Minimum-info INSERT —
  // sub_poll cron later fills in subscribers / description / rules.
  await upsertRedditSubreddit(db, {
    name: t3.subreddit,
    subredditId: t3.subreddit_id ?? null,
    subscribers: null,
    accountsActive: null,
    description: null,
    publicDescription: null,
  });

  // UPSERT author cache (FK target for reddit_user_snapshots, even though
  // we don't write a user snapshot here — that's author_poll's job).
  if (author !== null) {
    await upsertRedditUser(db, {
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
  await upsertRedditPost(db, {
    postId: fullId,
    subreddit: t3.subreddit,
    author,
    authorFullname,
    permalink,
    title: t3.title,
    submittedAt,
    metadata: buildPostMetadata(t3),
  });

  await writeRedditPostSnapshot(db, {
    postId: fullId,
    score: t3.score ?? null,
    numComments: t3.num_comments ?? null,
    awardsTotal: t3.total_awards_received ?? null,
    upvoteRatio: t3.upvote_ratio ?? null,
    removedByCategory: t3.removed_by_category ?? null,
    status: classifySnapshotStatus(t3),
  });

  // Paste-path cap-counter increment. Every successful handlePostSingle
  // invoked from a user-facing surface (preview button OR submit
  // fetchEventStats OR future paste UIs) writes a `done` row in
  // reddit_refresh_queue on the user_post lane. checkRedditUserCap
  // (D-RDT-CAP-POST plan 06) reads queue rows in the 5-minute window
  // to count post-refreshes — without this row, user pastes silently
  // bypass the 25/5min cap. Dedup above ensures preview+submit on the
  // same post produces ONE counter tick, not two.
  if (args.paste === true && args.userId !== null) {
    await db.insert(redditRefreshQueue).values({
      queueName: "user_post",
      type: "post_single",
      payload: { post_id: fullId, flow: "paste" },
      userId: args.userId,
      priority: 0,
      status: "done",
      lastAttemptAt: new Date(),
    });
  }

  logger.debug(
    {
      postId: fullId,
      subreddit: t3.subreddit,
      author,
      userId: args.userId,
      paste: args.paste ?? false,
    },
    "reddit post_single: UPSERT + snapshot complete",
  );

  return {
    postId: fullId,
    subreddit: t3.subreddit,
    author,
    authorFullname,
    permalink,
    title: t3.title,
    submittedAt,
    score: t3.score ?? null,
    numComments: t3.num_comments ?? null,
    upvoteRatio: t3.upvote_ratio ?? null,
    selftext: typeof t3.selftext === "string" ? t3.selftext : "",
  };
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

  // Pull the post row for title/author/permalink/submittedAt. If the
  // post row is missing (race window between snapshot write + UPSERT),
  // fall through and fetch fresh — safer to re-fetch than to return
  // partial data.
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
  };
}

/** Extract the t3 child from /comments/<id>.json's two-element array
 *  shape. Throws AdapterError(permanent) when the shape is unexpected —
 *  unrecoverable (a Reddit API breaking change would surface this; the
 *  worker tick downgrades the queue row to dead_letter). */
function extractT3FromCommentsResponse(data: unknown, expectedId: string): T3Data {
  if (!Array.isArray(data) || data.length < 1) {
    throw new AdapterError(
      `Reddit /comments/${expectedId}.json: unexpected response shape (not an array)`,
      { category: "permanent" },
    );
  }
  const submissionListing = data[0] as { data?: { children?: Array<{ data?: T3Data }> } };
  const children = submissionListing?.data?.children ?? [];
  if (children.length === 0) {
    // 200 OK with empty children — the post id doesn't exist (Reddit's
    // graceful 404 shape for permalink fetches; some private subs also
    // surface this way).
    throw new AdapterError(`Reddit post ${expectedId} not found`, { category: "not-found" });
  }
  const t3 = children[0]?.data;
  if (!t3 || typeof t3.id !== "string" || typeof t3.created_utc !== "number") {
    throw new AdapterError(`Reddit /comments/${expectedId}.json: missing required t3 fields`, {
      category: "permanent",
    });
  }
  return t3;
}

/** Subset of t3 fields we persist into reddit_posts.metadata for the
 *  diary's per-post detail view. */
function buildPostMetadata(t3: T3Data): Record<string, unknown> {
  return {
    is_self: t3.is_self ?? false,
    link_url: t3.url ?? null,
    body_excerpt:
      typeof t3.selftext === "string" && t3.selftext.length > 0 ? t3.selftext.slice(0, 200) : null,
    over_18: t3.over_18 ?? false,
    spoiler: t3.spoiler ?? false,
    stickied: t3.stickied ?? false,
    locked: t3.locked ?? false,
    archived: t3.archived ?? false,
    link_flair_text: t3.link_flair_text ?? null,
    crosspost_parent_id: t3.crosspost_parent ?? null,
  };
}

/** Map the t3 lifecycle flags onto our 4-value snapshot status vocab. */
export function classifySnapshotStatus(t3: T3Data): RedditSnapshotStatus {
  if (t3.removed_by_category) return "removed";
  if (t3.archived === true) return "archived";
  return "ok";
}
