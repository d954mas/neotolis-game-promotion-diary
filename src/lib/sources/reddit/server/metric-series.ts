// Reddit VIZ-05 metric-series reader (clone of twitter/server/metric-series.ts,
// trimmed to the D-09 like/comment series).
//
// Implements SourceAdapter.fetchEventMetricSeries for the Reddit adapter.
// Self-filters to kind=reddit_post; returns [] for every other kind (the caller —
// the /events/[id] loader iterating allAdapters — does NOT pre-filter).
//
// Reads the FULL immutable snapshot history from reddit_post_snapshots ORDER BY
// polled_at ASC (POLL-04: never a mutable current-value column). reddit_post_
// snapshots is a PUBLIC-DATA table (no user_id column — allowlisted, Plan 02). The
// `_userId` parameter is required by the contract but intentionally unused: the
// tenant guarantee comes from the caller's upstream events SELECT.
//
// D-09 METRIC SET: likes (score) + comments (num_comments) ONLY. Reddit exposes no
// per-post view count and no share/crosspost count in the ScrapeCreators response
// (spike Q4), so — unlike Twitter's 4-line chart — there is NO views or shares
// series. The raw upvote_ratio / num_crossposts columns are retained on the snapshot
// for reconstruction but NOT charted (Deferred).
//
// Metrics-by-presence: a NULL count means the metric was absent at poll time. Keep
// it null so the chart draws a GAP (connectNulls:false), NEVER coerced to 0. A
// series whose every point is null is dropped entirely.

import { asc, eq } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { redditPostSnapshots } from "$lib/server/db/schema/index.js";
import type { EventKind, EventMetricSeries } from "$lib/sources/adapter.js";

export async function redditFetchEventMetricSeries(
  _userId: string,
  event: { kind: EventKind; externalId: string | null },
): Promise<EventMetricSeries[]> {
  if (event.kind !== "reddit_post" || event.externalId === null) return [];

  const rows = await db
    .select({
      polledAt: redditPostSnapshots.polledAt,
      likeCount: redditPostSnapshots.likeCount,
      commentCount: redditPostSnapshots.commentCount,
    })
    .from(redditPostSnapshots)
    .where(eq(redditPostSnapshots.postId, event.externalId))
    .orderBy(asc(redditPostSnapshots.polledAt));
  if (rows.length === 0) return [];

  // bigint columns come back as `number` via mode:"number"; null stays null.
  return [
    {
      metricKey: "like_count",
      // Reddit's upvote metric is "Score" everywhere it is NAMED (matches the card's
      // card_reddit_metric_score) — NOT the cross-platform "Likes". chart_metric_score
      // also carries the up-arrow glyph (EventHistoryChart), the right affordance for
      // upvotes vs a heart.
      labelKey: "chart_metric_score",
      points: rows.map((r) => ({ polledAt: r.polledAt.toISOString(), value: r.likeCount })),
    },
    {
      metricKey: "comment_count",
      labelKey: "chart_metric_comments",
      points: rows.map((r) => ({ polledAt: r.polledAt.toISOString(), value: r.commentCount })),
    },
  ].filter((s) => s.points.some((p) => p.value !== null));
}
