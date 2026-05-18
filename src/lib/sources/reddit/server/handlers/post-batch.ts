// Reddit post_batch handler — refresh up to 100 posts in one HTTP call.
//
// Triggered by the service_post cron for posts whose snapshots are due
// (young <24h on a 6h refresh cadence, or missing-baseline backfill at
// the 24h mark) and by user-driven "refresh all" bulk actions on the
// user_post lane.
//
// Endpoint: /api/info.json?id=t3_a,t3_b,... (up to 100 ids per request).
//
// Reddit's response order is NOT guaranteed and missing posts are
// silently dropped. We match requested vs returned by data.id and
// write a status='not_found' snapshot for the missing set — the
// snapshot writer minute-truncates polled_at so multiple refresh
// ticks for the same gone post collapse into one row per minute.
//
// Cost: 1 HTTP call → up to 100 snapshots written. The load-bearing
// optimization that makes the 8 req/min ceiling work at any scale.

import { db } from "$lib/server/db/client.js";
import { redditFetch } from "../http.js";
import {
  upsertRedditPostsMany,
  upsertRedditUsersMany,
  upsertRedditSubredditsMany,
  type RedditPostUpsert,
  type RedditUserUpsert,
  type RedditSubredditUpsert,
} from "../upsert.js";
import {
  writeRedditPostSnapshotsMany,
  markPostDeletionDetectedIfNeededMany,
  type RedditPostSnapshotWrite,
} from "../snapshots.js";
import { buildPostMetadata } from "../post-metadata.js";
import { AdapterError } from "$lib/sources/errors.js";
import { logger } from "$lib/server/logger.js";
import { classifySnapshotStatus } from "./post-single.js";

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
  over_18?: boolean;
  spoiler?: boolean;
  stickied?: boolean;
  locked?: boolean;
  archived?: boolean;
  removed_by_category?: string | null;
  crosspost_parent?: string | null;
  link_flair_text?: string | null;
}

interface ListingResponse {
  kind?: string;
  data?: {
    children?: Array<{ kind?: string; data?: T3Data }>;
  };
}

const MAX_BATCH = 100;

export async function handlePostBatch(args: {
  postIds: string[];
  userId: string | null;
  pacer?: "acquire" | "already-acquired";
}): Promise<{ presentIds: string[]; missingIds: string[] }> {
  if (args.postIds.length === 0) {
    return { presentIds: [], missingIds: [] };
  }
  if (args.postIds.length > MAX_BATCH) {
    // Caller invariant — the cron / route layer must chunk into ≤100.
    // Surfacing as permanent so the queue row dead_letters instead of
    // bashing Reddit with an oversized id list (would 414 anyway).
    throw new AdapterError(`post_batch received ${args.postIds.length} ids; max ${MAX_BATCH}`, {
      category: "permanent",
    });
  }

  // Normalize to t3_<bare> form (Reddit accepts either, but a consistent
  // shape lets us match requested-vs-returned cleanly).
  const requested = args.postIds.map((id) => (id.startsWith("t3_") ? id : `t3_${id}`));
  const url = `/api/info.json?id=${encodeURIComponent(requested.join(","))}`;

  const { data } = await redditFetch<ListingResponse>(url, { pacer: args.pacer });
  const children = data?.data?.children ?? [];

  // Index returned t3s by t3_<id> for O(1) match by-id (NOT by index).
  const returnedById = new Map<string, T3Data>();
  for (const child of children) {
    const t3 = child?.data;
    if (t3 && typeof t3.id === "string") {
      returnedById.set(`t3_${t3.id}`, t3);
    }
  }

  // Bucket the response into FK-target rows (subreddits + users) and
  // post rows + snapshots. Each bucket gets ONE multi-row INSERT below,
  // so a 100-id batch is ~4 DB round-trips total (subs, users, posts,
  // snapshots) instead of ~500 with the per-row pattern.
  const subredditsByName = new Map<string, RedditSubredditUpsert>();
  const usersByName = new Map<string, RedditUserUpsert>();
  const postUpserts: RedditPostUpsert[] = [];
  const snapshotWrites: RedditPostSnapshotWrite[] = [];
  const snapshotStatuses: Array<{
    postId: string;
    status: ReturnType<typeof classifySnapshotStatus>;
  }> = [];
  const presentIds: string[] = [];
  const missingIds: string[] = [];

  for (const reqId of requested) {
    const t3 = returnedById.get(reqId);
    if (!t3) {
      missingIds.push(reqId);
      continue;
    }
    presentIds.push(reqId);

    const author = t3.author === "[deleted]" ? null : t3.author;
    const authorFullname = author === null ? null : (t3.author_fullname ?? null);
    const submittedAt = new Date(t3.created_utc * 1000);
    const permalink = t3.permalink.startsWith("http")
      ? t3.permalink
      : `https://www.reddit.com${t3.permalink}`;

    if (!subredditsByName.has(t3.subreddit)) {
      subredditsByName.set(t3.subreddit, {
        name: t3.subreddit,
        subredditId: t3.subreddit_id ?? null,
        subscribers: null,
        accountsActive: null,
        description: null,
        publicDescription: null,
      });
    }
    if (author !== null && !usersByName.has(author)) {
      usersByName.set(author, {
        username: author,
        redditId: authorFullname,
        accountAgeDays: null,
        linkKarma: null,
        commentKarma: null,
        totalKarma: null,
        isSuspended: false,
      });
    }

    postUpserts.push({
      postId: reqId,
      subreddit: t3.subreddit,
      author,
      authorFullname,
      permalink,
      title: t3.title,
      submittedAt,
      metadata: buildPostMetadata(t3),
    });

    const snapStatus = classifySnapshotStatus(t3);
    snapshotStatuses.push({ postId: reqId, status: snapStatus });
    snapshotWrites.push({
      postId: reqId,
      score: t3.score ?? null,
      numComments: t3.num_comments ?? null,
      awardsTotal: t3.total_awards_received ?? null,
      upvoteRatio: t3.upvote_ratio ?? null,
      removedByCategory: t3.removed_by_category ?? null,
      status: snapStatus,
    });
  }

  // Missing ids → status='not_found' snapshot. The FK on
  // reddit_post_snapshots.post_id requires a parent reddit_posts row;
  // cron-enqueued ids always have one (cron picks FROM reddit_posts).
  // We add the snapshot rows to the same batch; if a synthetic test id
  // ever sneaks in, Postgres FK error surfaces clearly instead of a
  // per-row try/catch hiding it.
  for (const missingId of missingIds) {
    snapshotStatuses.push({ postId: missingId, status: "not_found" });
    snapshotWrites.push({
      postId: missingId,
      score: null,
      numComments: null,
      awardsTotal: null,
      upvoteRatio: null,
      removedByCategory: null,
      status: "not_found",
    });
  }

  await upsertRedditSubredditsMany(db, [...subredditsByName.values()]);
  await upsertRedditUsersMany(db, [...usersByName.values()]);
  await upsertRedditPostsMany(db, postUpserts);
  await writeRedditPostSnapshotsMany(db, snapshotWrites);
  await markPostDeletionDetectedIfNeededMany(db, snapshotStatuses);

  logger.info(
    {
      userId: args.userId,
      requested: requested.length,
      present: presentIds.length,
      missing: missingIds.length,
    },
    "reddit post_batch: complete",
  );

  return { presentIds, missingIds };
}
