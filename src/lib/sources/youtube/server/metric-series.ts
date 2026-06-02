// YouTube VIZ-01 metric-series reader (D-14 reference implementation).
//
// Implements SourceAdapter.fetchEventMetricSeries for the youtube_channel
// adapter. Self-filters to kind=youtube_video; returns [] for every other
// kind (the caller — the /events/[id] loader iterating allAdapters — does
// NOT pre-filter, mirroring enrichFeedDtos).
//
// Reads the FULL immutable snapshot history from youtube_video_snapshots
// ORDER BY polled_at ASC (POLL-04: never a mutable current-value column).
// Unlike feed-enrichment.ts's DISTINCT ON (latest-only) read, the chart
// wants ALL points to draw the trend.
//
// youtube_video_snapshots is a PUBLIC-DATA table (no user_id column —
// already in the ESLint tenant-scope allowlist). The `_userId` parameter is
// required by the SourceAdapter contract but intentionally unused here: the
// tenant guarantee comes from the caller's upstream events SELECT, exactly
// as youtubeEnrichFeedDtos documents. Adapters whose series read a
// tenant-owned table MUST scope by userId.

import { sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import type { EventKind, EventMetricSeries } from "$lib/sources/adapter.js";

export async function youtubeFetchEventMetricSeries(
  _userId: string,
  event: { kind: EventKind; externalId: string | null },
): Promise<EventMetricSeries[]> {
  if (event.kind !== "youtube_video" || event.externalId === null) return [];

  const rows = await db.execute<{
    polled_at: Date;
    view_count: number | null;
    like_count: number | null;
    comment_count: number | null;
  }>(sql`
    SELECT polled_at, view_count, like_count, comment_count
    FROM youtube_video_snapshots
    WHERE video_id = ${event.externalId}
    ORDER BY polled_at ASC
  `);
  if (rows.rows.length === 0) return [];

  // db.execute returns raw pg driver shapes — bigint columns come back as
  // strings; Number() coerces them. NULL → 0 (an unpolled metric reads as
  // a zero point, not a gap).
  const toIso = (d: Date): string =>
    d instanceof Date ? d.toISOString() : new Date(d as unknown as string).toISOString();

  return [
    {
      metricKey: "view_count",
      labelKey: "chart_metric_views",
      points: rows.rows.map((r) => ({ polledAt: toIso(r.polled_at), value: Number(r.view_count ?? 0) })),
    },
    {
      metricKey: "like_count",
      labelKey: "chart_metric_likes",
      points: rows.rows.map((r) => ({ polledAt: toIso(r.polled_at), value: Number(r.like_count ?? 0) })),
    },
    {
      metricKey: "comment_count",
      labelKey: "chart_metric_comments",
      points: rows.rows.map((r) => ({
        polledAt: toIso(r.polled_at),
        value: Number(r.comment_count ?? 0),
      })),
    },
  ];
}
