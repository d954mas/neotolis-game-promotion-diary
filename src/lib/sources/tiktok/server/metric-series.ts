// TikTok VIZ-05 metric-series reader (clone of instagram/server/metric-series.ts
// with the PLAT-02 share_count series).
//
// Implements SourceAdapter.fetchEventMetricSeries for the TikTok adapter.
// Self-filters to kind=tiktok_post; returns [] for every other kind (the caller —
// the /events/[id] loader iterating allAdapters — does NOT pre-filter).
//
// Reads the FULL immutable snapshot history from tiktok_post_snapshots ORDER BY
// polled_at ASC (POLL-04: never a mutable current-value column).
// tiktok_post_snapshots is a PUBLIC-DATA table (no user_id column — allowlisted,
// Plan 01). The `_userId` parameter is required by the contract but intentionally
// unused: the tenant guarantee comes from the caller's upstream events SELECT.
//
// Metrics-by-presence (D-05): a NULL count means the metric was absent at poll time
// (a photo-mode post has no views; a post with shares hidden has null shares). Keep
// it null so the chart draws a GAP (connectNulls:false), NEVER coerced to 0. A
// series whose every point is null is dropped entirely — e.g. a photo-mode post's
// views line is omitted, not a flat dead legend toggle.
//
// THE PLAT-02 DELTA: the share_count series. TikTok is the FIRST platform to carry a
// real share metric — the chart exposes it as a fourth toggleable line alongside
// views/likes/comments.

import { asc, eq } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { tiktokPostSnapshots } from "$lib/server/db/schema/index.js";
import type { EventKind, EventMetricSeries } from "$lib/sources/adapter.js";

export async function tiktokFetchEventMetricSeries(
  _userId: string,
  event: { kind: EventKind; externalId: string | null },
): Promise<EventMetricSeries[]> {
  if (event.kind !== "tiktok_post" || event.externalId === null) return [];

  const rows = await db
    .select({
      polledAt: tiktokPostSnapshots.polledAt,
      viewCount: tiktokPostSnapshots.viewCount,
      likeCount: tiktokPostSnapshots.likeCount,
      commentCount: tiktokPostSnapshots.commentCount,
      shareCount: tiktokPostSnapshots.shareCount,
    })
    .from(tiktokPostSnapshots)
    .where(eq(tiktokPostSnapshots.awemeId, event.externalId))
    .orderBy(asc(tiktokPostSnapshots.polledAt));
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
      // PLAT-02: the share series TikTok carries that Instagram never did. Drops to
      // a gap (connectNulls:false) on a null point; a fully-null series is filtered
      // out below.
      metricKey: "share_count",
      labelKey: "chart_metric_shares",
      points: rows.map((r) => ({ polledAt: r.polledAt.toISOString(), value: r.shareCount })),
    },
  ].filter((s) => s.points.some((p) => p.value !== null));
}
