// Twitter/X VIZ-05 metric-series reader (clone of tiktok/server/metric-series.ts
// with the D-05 share_count series).
//
// Implements SourceAdapter.fetchEventMetricSeries for the Twitter adapter.
// Self-filters to kind=twitter_post; returns [] for every other kind (the caller —
// the /events/[id] loader iterating allAdapters — does NOT pre-filter).
//
// Reads the FULL immutable snapshot history from twitter_post_snapshots ORDER BY
// polled_at ASC (POLL-04: never a mutable current-value column). twitter_post_
// snapshots is a PUBLIC-DATA table (no user_id column — allowlisted, Plan 01). The
// `_userId` parameter is required by the contract but intentionally unused: the
// tenant guarantee comes from the caller's upstream events SELECT.
//
// Metrics-by-presence (D-05): a NULL count means the metric was absent at poll time
// (a protected/limited tweet may hide impressions/shares). Keep it null so the chart
// draws a GAP (connectNulls:false), NEVER coerced to 0. A series whose every point
// is null is dropped entirely.
//
// THE D-05 DELTA: the share_count series is the DERIVED retweet+quote redistribution
// metric — the chart exposes it as a fourth toggleable line alongside
// views/likes/comments. The RAW retweet/quote/bookmark are STORED on the snapshot
// for reconstruction but NOT charted as separate series (shares is the charted
// redistribution metric).

import { asc, eq } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { twitterPostSnapshots } from "$lib/server/db/schema/index.js";
import type { EventKind, EventMetricSeries } from "$lib/sources/adapter.js";

export async function twitterFetchEventMetricSeries(
  _userId: string,
  event: { kind: EventKind; externalId: string | null },
): Promise<EventMetricSeries[]> {
  if (event.kind !== "twitter_post" || event.externalId === null) return [];

  const rows = await db
    .select({
      polledAt: twitterPostSnapshots.polledAt,
      viewCount: twitterPostSnapshots.viewCount,
      likeCount: twitterPostSnapshots.likeCount,
      commentCount: twitterPostSnapshots.commentCount,
      shareCount: twitterPostSnapshots.shareCount,
    })
    .from(twitterPostSnapshots)
    .where(eq(twitterPostSnapshots.tweetId, event.externalId))
    .orderBy(asc(twitterPostSnapshots.polledAt));
  if (rows.length === 0) return [];

  // bigint columns come back as `number` via mode:"number"; null stays null.
  return [
    {
      metricKey: "view_count",
      labelKey: "chart_metric_views",
      points: rows.map((r) => ({ polledAt: r.polledAt.toISOString(), value: r.viewCount })),
    },
    {
      metricKey: "like_count",
      labelKey: "chart_metric_likes",
      points: rows.map((r) => ({ polledAt: r.polledAt.toISOString(), value: r.likeCount })),
    },
    {
      metricKey: "comment_count",
      labelKey: "chart_metric_comments",
      points: rows.map((r) => ({ polledAt: r.polledAt.toISOString(), value: r.commentCount })),
    },
    {
      // D-05: the DERIVED retweet+quote share series. Drops to a gap
      // (connectNulls:false) on a null point; a fully-null series is filtered out below.
      metricKey: "share_count",
      labelKey: "chart_metric_shares",
      points: rows.map((r) => ({ polledAt: r.polledAt.toISOString(), value: r.shareCount })),
    },
  ].filter((s) => s.points.some((p) => p.value !== null));
}
