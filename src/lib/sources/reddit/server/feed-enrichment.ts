// Reddit feed-enrichment hook — D-RDT-BASELINES-DISPLAY.
//
// Called by the /feed loader via the allAdapters[*].enrichFeedDtos
// iterator (Phase 03.0.3 §11 contract). Mutates EventDto rows in place
// for kind='reddit_post' entries; ignores other kinds (callers do NOT
// pre-filter — internal filtering is the contract).
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

import { sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { logger } from "$lib/server/logger.js";
import type { EventDto } from "$lib/server/dto.js";

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
  /** userId required by DataSourceAdapter.enrichFeedDtos contract;
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
    // 1. Latest snapshot per post_id. DISTINCT ON keeps the scan tight.
    //    reddit_posts.post_id is the FK target on reddit_post_snapshots —
    //    we look up by post_id IN both shapes (with/without t3_).
    const snapsResult = await db.execute(sql`
      SELECT DISTINCT ON (post_id)
        post_id,
        score,
        num_comments,
        upvote_ratio,
        awards_total
      FROM reddit_post_snapshots
      WHERE post_id = ANY(${lookupArr}::text[])
      ORDER BY post_id, polled_at DESC
    `);
    const snapRows = (
      snapsResult as unknown as {
        rows: Array<{
          post_id: string;
          score: number | string | null;
          num_comments: number | string | null;
          upvote_ratio: number | string | null;
          awards_total: number | string | null;
        }>;
      }
    ).rows;
    const statsMap = new Map<string, RedditEnrichment["stats"]>();
    for (const r of snapRows) {
      statsMap.set(r.post_id, {
        score: Number(r.score ?? 0),
        numComments: Number(r.num_comments ?? 0),
        upvoteRatio: Number(r.upvote_ratio ?? 0),
        awardsTotal: Number(r.awards_total ?? 0),
      });
    }

    // 2. Subreddit subscribers + 4. baselines (30d window). One scan
    //    each; both keyed on subreddit name.
    const subSubscribers = new Map<string, number>();
    const baselineMap = new Map<string, RedditEnrichment["baseline"]>();
    if (subreddits.size > 0) {
      const subArr = Array.from(subreddits);
      const subsResult = await db.execute(sql`
        SELECT name, subscribers
        FROM reddit_subreddits_cache
        WHERE name = ANY(${subArr}::text[])
      `);
      for (const r of (subsResult as unknown as {
        rows: Array<{ name: string; subscribers: number | string | null }>;
      }).rows) {
        if (r.subscribers !== null && r.subscribers !== undefined) {
          subSubscribers.set(r.name, Number(r.subscribers));
        }
      }

      const baselinesResult = await db.execute(sql`
        SELECT subreddit, median_score_24h, p75_score_24h, sample_size
        FROM reddit_subreddit_baselines
        WHERE window_label = '30d'
          AND subreddit = ANY(${subArr}::text[])
      `);
      for (const r of (baselinesResult as unknown as {
        rows: Array<{
          subreddit: string;
          median_score_24h: number | string | null;
          p75_score_24h: number | string | null;
          sample_size: number | string;
        }>;
      }).rows) {
        const sampleSize = Number(r.sample_size ?? 0);
        // Baselines cron only emits rows with sample_size >= 5 per its
        // HAVING clause, but defense-in-depth here too — the UI hides
        // the badge for < 5 anyway.
        if (sampleSize >= 5) {
          baselineMap.set(r.subreddit, {
            medianScore24h: r.median_score_24h === null ? null : Number(r.median_score_24h),
            p75Score24h: r.p75_score_24h === null ? null : Number(r.p75_score_24h),
            sampleSize,
          });
        }
      }
    }

    // 3. Author karma chip.
    const authorKarma = new Map<string, number>();
    if (authors.size > 0) {
      const authorArr = Array.from(authors);
      const usersResult = await db.execute(sql`
        SELECT username, total_karma
        FROM reddit_users_cache
        WHERE username = ANY(${authorArr}::text[])
      `);
      for (const r of (usersResult as unknown as {
        rows: Array<{ username: string; total_karma: number | string | null }>;
      }).rows) {
        if (r.total_karma !== null && r.total_karma !== undefined) {
          authorKarma.set(r.username, Number(r.total_karma));
        }
      }
    }

    // In-place decoration. Iterate redditDtos (the filtered subset)
    // and attach redditEnrichment to each. The card-props mapper
    // (ui/card-props.ts) reads via the same shape.
    for (const dto of redditDtos) {
      const eid = dto.externalId as string;
      const stats = statsMap.get(eid) ?? statsMap.get(`t3_${eid}`) ?? statsMap.get(eid.replace(/^t3_/, "")) ?? null;
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
