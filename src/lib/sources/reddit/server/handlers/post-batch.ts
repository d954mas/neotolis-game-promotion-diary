// Reddit post_batch handler — refresh up to 100 posts in one HTTP call.
//
// Triggered by the service_post cron (plan 05B, D-RDT-POST-ELIGIBILITY)
// for posts whose snapshots are due (young <24h on a 6h refresh cadence,
// or missing-baseline backfill at the 24h mark), and by user-driven
// "refresh all" bulk actions (user_post lane).
//
// Endpoint: /api/info.json?id=t3_a,t3_b,... (up to 100 ids per request).
//
// Order is NOT guaranteed (RESEARCH §Probe 4). Reddit silently drops
// deleted IDs from the response. We match requested vs returned by
// data.id and write a status='not_found' snapshot for the missing set
// (V20 — minute-trunc idempotent; multiple refresh ticks for the same
// gone post collapse into one snapshot per minute).
//
// Cost: 1 HTTP call → up to 100 snapshots written. The load-bearing
// optimization that makes the 8 req/min ceiling work at any scale.

import { db } from "$lib/server/db/client.js";
import { redditFetch } from "../http.js";
import { upsertRedditPost, upsertRedditUser, upsertRedditSubreddit } from "../upsert.js";
import { writeRedditPostSnapshot } from "../snapshots.js";
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

  const { data } = await redditFetch<ListingResponse>(url);
  const children = data?.data?.children ?? [];

  // Index returned t3s by t3_<id> for O(1) match by-id (NOT by index).
  const returnedById = new Map<string, T3Data>();
  for (const child of children) {
    const t3 = child?.data;
    if (t3 && typeof t3.id === "string") {
      returnedById.set(`t3_${t3.id}`, t3);
    }
  }

  const presentIds: string[] = [];
  const missingIds: string[] = [];

  // Phase 1: UPSERT cache + snapshot for each present id.
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

    // UPSERT FK targets first.
    await upsertRedditSubreddit(db, {
      name: t3.subreddit,
      subredditId: t3.subreddit_id ?? null,
      subscribers: null,
      accountsActive: null,
      description: null,
      publicDescription: null,
    });
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

    await upsertRedditPost(db, {
      postId: reqId,
      subreddit: t3.subreddit,
      author,
      authorFullname,
      permalink,
      title: t3.title,
      submittedAt,
      metadata: {
        is_self: t3.is_self ?? false,
        link_url: t3.url ?? null,
        body_excerpt:
          typeof t3.selftext === "string" && t3.selftext.length > 0
            ? t3.selftext.slice(0, 200)
            : null,
        over_18: t3.over_18 ?? false,
        spoiler: t3.spoiler ?? false,
        stickied: t3.stickied ?? false,
        locked: t3.locked ?? false,
        archived: t3.archived ?? false,
        link_flair_text: t3.link_flair_text ?? null,
        crosspost_parent_id: t3.crosspost_parent ?? null,
      },
    });

    await writeRedditPostSnapshot(db, {
      postId: reqId,
      score: t3.score ?? null,
      numComments: t3.num_comments ?? null,
      awardsTotal: t3.total_awards_received ?? null,
      upvoteRatio: t3.upvote_ratio ?? null,
      removedByCategory: t3.removed_by_category ?? null,
      status: classifySnapshotStatus(t3),
    });
  }

  // Phase 2: status='not_found' snapshot for each missing id. The
  // FK on reddit_post_snapshots.post_id → reddit_posts.post_id requires
  // a parent row exist; for missing-from-batch ids, we DO have the parent
  // row already (cron picks from reddit_posts; user_post is enqueued from
  // existing-paste flow). If the FK ever fails (unexpected), log + skip
  // — the missing-ness is reflected in last_snapshot_at staying old, and
  // the next eligibility scan picks it up again.
  for (const missingId of missingIds) {
    try {
      await writeRedditPostSnapshot(db, {
        postId: missingId,
        score: null,
        numComments: null,
        awardsTotal: null,
        upvoteRatio: null,
        removedByCategory: null,
        status: "not_found",
      });
    } catch (err) {
      // FK violation — parent row doesn't exist. Should not happen for
      // cron-enqueued ids; possible for synthetic test ids.
      logger.warn(
        { postId: missingId, err: String((err as Error)?.message ?? err) },
        "reddit post_batch: not_found snapshot write failed (likely FK miss)",
      );
    }
  }

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
