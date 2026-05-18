// Reddit feed-enrichment hook.
//
// Called by the /feed loader via the allAdapters[*].enrichFeedDtos
// iterator (cross-source contract). Mutates EventDto rows in place for
// kind='reddit_post' entries; ignores other kinds — callers do NOT
// pre-filter, internal filtering is the contract.
//
// Four batched lookups:
//   1. reddit_post_snapshots — DISTINCT ON (post_id) latest score /
//      num_comments / upvote_ratio / awards_total.
//   2. reddit_subreddits_cache — per-subreddit subscribers count (chip
//      on the FeedCard).
//   3. reddit_users_cache — per-author total_karma (chip on the FeedCard).
//   4. reddit_subreddit_baselines (window='30d') — median/p75 for the
//      "X% of median" badge.
//
// Tables are PUBLIC-DATA (no userId scope). Upstream tenant guarantee
// comes from the events SELECT in mapEventsToDtos; this helper only
// touches post/subreddit/user-keyed metadata.
//
// Errors are swallowed at WARN — a failed enrichment query MUST NOT
// break the /feed render. The card falls back to a stats-less view.
//
// Decoration shape (attached via cast — EventDto.metadata stays the
// original jsonb): we hang a `redditEnrichment` property on the dto
// object. The UI mapper (ui/card-props.ts) reads via the same cast
// shape; no schema changes to EventDto.

import { inArray, eq, and, desc } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { logger } from "$lib/server/logger.js";
import type { EventDto } from "$lib/server/dto.js";
import {
  redditPostSnapshots,
  redditSubredditsCache,
  redditSubredditBaselines,
  redditUsersCache,
} from "./schema/index.js";

export interface RedditEnrichment {
  /** Latest score / num_comments / upvote_ratio from the most-recent
   *  reddit_post_snapshots row. NULL when no snapshot exists yet
   *  (worker hasn't drained the queue for this post). */
  stats: {
    score: number;
    numComments: number;
    upvoteRatio: number;
    awardsTotal: number;
  } | null;
  /** Subreddit subscribers count (from reddit_subreddits_cache). NULL
   *  while the about.json opportunistic refresh hasn't yet populated. */
  subredditSubscribers: number | null;
  /** Author total_karma (from reddit_users_cache). NULL while the
   *  per-author about-page refresh hasn't yet populated. */
  authorKarma: number | null;
  /** Subreddit 30d baseline (median / p75 score) for the "X% of median"
   *  badge. NULL when sample_size < 5 or baselines cron hasn't run yet
   *  for this subreddit. */
  baseline: {
    medianScore24h: number | null;
    p75Score24h: number | null;
    sampleSize: number;
  } | null;
}

/** Discriminator key for the in-place decoration. The card-props mapper
 *  reads the same key via the same cast shape. */
type RedditDecorated = EventDto & { redditEnrichment?: RedditEnrichment };

export async function enrichRedditFeedDtos(
  /** userId required by SourceAdapter.enrichFeedDtos contract;
   *  unused here because all four Reddit cache tables are PUBLIC-DATA.
   *  Tenant scope comes from the upstream events SELECT in
   *  mapEventsToDtos. */
  _userId: string,
  dtos: EventDto[],
): Promise<void> {
  // Internal filter — caller does NOT pre-filter.
  const redditDtos = dtos.filter((d) => d.kind === "reddit_post" && d.externalId !== null);
  if (redditDtos.length === 0) return;

  // Normalize to bare ids (the post_id PK on reddit_posts uses the
  // "t3_<id>" fullname form — the worker writes it that way).
  // events.externalId may be the bare form or the t3_ form depending on
  // ingest path; defend by checking both.
  const externalIds = redditDtos.map((d) => d.externalId as string);
  const lookupKeys = new Set<string>();
  for (const eid of externalIds) {
    lookupKeys.add(eid);
    if (!eid.startsWith("t3_")) lookupKeys.add(`t3_${eid}`);
    else lookupKeys.add(eid.slice(3));
  }
  const lookupArr = Array.from(lookupKeys);

  // Collect subreddits + authors referenced by these dtos for the
  // subscribers + karma chips. Source from dto.metadata.subreddit /
  // dto.metadata.author when set by ingest; some events may have neither
  // (paste of a redd.it short-link before the worker fetched details).
  const subreddits = new Set<string>();
  const authors = new Set<string>();
  for (const d of redditDtos) {
    const md = (d.metadata ?? {}) as { subreddit?: string; author?: string };
    if (typeof md.subreddit === "string" && md.subreddit.length > 0) subreddits.add(md.subreddit);
    if (typeof md.author === "string" && md.author.length > 0) authors.add(md.author);
  }

  try {
    // 1. Latest snapshot per post_id.
    //
    // Drizzle's `sql` template tag spreads JS arrays into N comma-separated
    // bind params, which breaks `ANY($1::text[])` (the cast sees the wrong
    // type at the binary protocol level). The schema-builder `inArray`
    // expands to `IN ($1, $2, ...)` — semantic equivalent for set-membership.
    // Manual DISTINCT-ON in JS because Drizzle's query-builder doesn't
    // expose PG's DISTINCT ON; the ORDER BY (post_id, polled_at DESC) makes
    // the first row per post_id the latest snapshot for that post.
    const snapRows = await db
      .select({
        postId: redditPostSnapshots.postId,
        score: redditPostSnapshots.score,
        numComments: redditPostSnapshots.numComments,
        upvoteRatio: redditPostSnapshots.upvoteRatio,
        awardsTotal: redditPostSnapshots.awardsTotal,
      })
      .from(redditPostSnapshots)
      .where(inArray(redditPostSnapshots.postId, lookupArr))
      .orderBy(redditPostSnapshots.postId, desc(redditPostSnapshots.polledAt));
    const statsMap = new Map<string, RedditEnrichment["stats"]>();
    for (const r of snapRows) {
      // First row per post_id is the latest (rows are sorted post_id ASC,
      // polled_at DESC; subsequent rows for the same post_id are older
      // and skipped). Equivalent to PG's DISTINCT ON (post_id) ... ORDER BY
      // post_id, polled_at DESC.
      if (statsMap.has(r.postId)) continue;
      statsMap.set(r.postId, {
        score: Number(r.score ?? 0),
        numComments: Number(r.numComments ?? 0),
        upvoteRatio: Number(r.upvoteRatio ?? 0),
        awardsTotal: Number(r.awardsTotal ?? 0),
      });
    }

    // 2. Subreddit subscribers + 4. baselines (30d window). One scan
    //    each; both keyed on subreddit name.
    const subSubscribers = new Map<string, number>();
    const baselineMap = new Map<string, RedditEnrichment["baseline"]>();
    if (subreddits.size > 0) {
      const subArr = Array.from(subreddits);
      const subsRows = await db
        .select({
          name: redditSubredditsCache.name,
          subscribers: redditSubredditsCache.subscribers,
        })
        .from(redditSubredditsCache)
        .where(inArray(redditSubredditsCache.name, subArr));
      for (const r of subsRows) {
        if (r.subscribers !== null && r.subscribers !== undefined) {
          subSubscribers.set(r.name, Number(r.subscribers));
        }
      }

      const baselineRows = await db
        .select({
          subreddit: redditSubredditBaselines.subreddit,
          medianScore24h: redditSubredditBaselines.medianScore24h,
          p75Score24h: redditSubredditBaselines.p75Score24h,
          sampleSize: redditSubredditBaselines.sampleSize,
        })
        .from(redditSubredditBaselines)
        .where(
          and(
            eq(redditSubredditBaselines.windowLabel, "30d"),
            inArray(redditSubredditBaselines.subreddit, subArr),
          ),
        );
      for (const r of baselineRows) {
        const sampleSize = Number(r.sampleSize ?? 0);
        // Baselines cron only emits rows with sample_size >= 5 per its
        // HAVING clause, but defense-in-depth here too — the UI hides
        // the badge for < 5 anyway.
        if (sampleSize >= 5) {
          baselineMap.set(r.subreddit, {
            medianScore24h: r.medianScore24h === null ? null : Number(r.medianScore24h),
            p75Score24h: r.p75Score24h === null ? null : Number(r.p75Score24h),
            sampleSize,
          });
        }
      }
    }

    // 3. Author karma chip.
    const authorKarma = new Map<string, number>();
    if (authors.size > 0) {
      const authorArr = Array.from(authors);
      const userRows = await db
        .select({
          username: redditUsersCache.username,
          totalKarma: redditUsersCache.totalKarma,
        })
        .from(redditUsersCache)
        .where(inArray(redditUsersCache.username, authorArr));
      for (const r of userRows) {
        if (r.totalKarma !== null && r.totalKarma !== undefined) {
          authorKarma.set(r.username, Number(r.totalKarma));
        }
      }
    }

    // In-place decoration. Iterate redditDtos (the filtered subset)
    // and attach redditEnrichment to each. The card-props mapper
    // (ui/card-props.ts) reads via the same shape.
    for (const dto of redditDtos) {
      const eid = dto.externalId as string;
      const stats =
        statsMap.get(eid) ??
        statsMap.get(`t3_${eid}`) ??
        statsMap.get(eid.replace(/^t3_/, "")) ??
        null;
      const md = (dto.metadata ?? {}) as { subreddit?: string; author?: string };
      const sub = md.subreddit;
      const author = md.author;
      (dto as RedditDecorated).redditEnrichment = {
        stats,
        subredditSubscribers: sub ? (subSubscribers.get(sub) ?? null) : null,
        authorKarma: author ? (authorKarma.get(author) ?? null) : null,
        baseline: sub ? (baselineMap.get(sub) ?? null) : null,
      };
    }
  } catch (err) {
    logger.warn(
      { err: String((err as Error)?.message ?? err), count: redditDtos.length },
      "reddit.enrichFeedDtos: query failed; feed renders without enrichment",
    );
  }
}
