// Reddit subreddit baselines cron handler.
//
// Schedule: 04:00 UTC daily.
//
// ZERO-HTTP pure-DB aggregate. JOIN reddit_posts ⋈ reddit_post_snapshots
// at the ~24h-after-submission mark and compute PERCENTILE_CONT(0.5 /
// 0.75) for score / num_comments / upvote_ratio. UPSERT one row per
// (subreddit, window_label) into reddit_subreddit_baselines.
//
// Two windows per run:
//   - '30d'      — posts submitted in the last 30 days.
//   - 'all_time' — posts submitted in the last 365 days (capped so
//                  2-year-old data doesn't anchor toward old Reddit
//                  norms).
//
// HAVING COUNT(*) >= 5 — subreddits with fewer than 5 snapshotted posts
// in the window emit no baseline row. UI surfaces "Insufficient sample
// — baseline pending" when no row exists.
//
// 24h-mark snapshot pick: for each post, pick the FIRST snapshot whose
// polled_at >= submitted_at + INTERVAL '24 hours'. DISTINCT ON (post_id)
// keeps one row per post even when multiple snapshots exist past the
// 24h boundary.

import { sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { logger } from "$lib/server/logger.js";

const WINDOWS: Array<{ label: string; intervalDays: number }> = [
  { label: "30d", intervalDays: 30 },
  { label: "all_time", intervalDays: 365 },
];

export async function handleBaselinesCron(): Promise<{ windows: number }> {
  for (const w of WINDOWS) {
    await db.execute(sql`
      INSERT INTO reddit_subreddit_baselines (
        subreddit,
        window_label,
        computed_at,
        sample_size,
        median_score_24h,
        p75_score_24h,
        median_comments_24h,
        p75_comments_24h,
        median_upvote_ratio_24h
      )
      SELECT
        rp.subreddit,
        ${w.label}::text AS window_label,
        NOW() AS computed_at,
        COUNT(*) AS sample_size,
        PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY s.score)         AS median_score_24h,
        PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY s.score)         AS p75_score_24h,
        PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY s.num_comments)  AS median_comments_24h,
        PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY s.num_comments)  AS p75_comments_24h,
        PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY s.upvote_ratio)  AS median_upvote_ratio_24h
      FROM reddit_posts rp
      JOIN LATERAL (
        SELECT score, num_comments, upvote_ratio
        FROM reddit_post_snapshots
        WHERE post_id = rp.post_id
          AND polled_at >= rp.submitted_at + INTERVAL '24 hours'
        ORDER BY polled_at ASC
        LIMIT 1
      ) s ON TRUE
      WHERE rp.submitted_at >= NOW() - INTERVAL '${sql.raw(String(w.intervalDays))} days'
      GROUP BY rp.subreddit
      HAVING COUNT(*) >= 5
      ON CONFLICT (subreddit, window_label) DO UPDATE SET
        computed_at             = EXCLUDED.computed_at,
        sample_size             = EXCLUDED.sample_size,
        median_score_24h        = EXCLUDED.median_score_24h,
        p75_score_24h           = EXCLUDED.p75_score_24h,
        median_comments_24h     = EXCLUDED.median_comments_24h,
        p75_comments_24h        = EXCLUDED.p75_comments_24h,
        median_upvote_ratio_24h = EXCLUDED.median_upvote_ratio_24h
    `);
  }

  logger.info({ windows: WINDOWS.length }, "reddit.baselines_cron: tick complete");
  return { windows: WINDOWS.length };
}
