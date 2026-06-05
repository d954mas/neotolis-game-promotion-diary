// Instagram VIZ-05 metric-series reader (D-14 reference pattern).
//
// Implements SourceAdapter.fetchEventMetricSeries for the IG adapter.
// Self-filters to kind=instagram_post; returns [] for every other kind (the
// caller — the /events/[id] loader iterating allAdapters — does NOT
// pre-filter, mirroring the YouTube/Reddit reference impls).
//
// Reads the FULL immutable snapshot history from instagram_post_snapshots
// ORDER BY polled_at ASC (POLL-04: never a mutable current-value column).
// instagram_post_snapshots is a PUBLIC-DATA table (no user_id column —
// already in the ESLint tenant-scope allowlist, Plan 01). The `_userId`
// parameter is required by the SourceAdapter contract but intentionally
// unused here: the tenant guarantee comes from the caller's upstream events
// SELECT, exactly as the YouTube/Reddit readers document.
//
// Metrics-by-presence (D-05): a NULL view_count means the post has no views
// (a photo / carousel — Instagram exposes play_count only on reels/video).
// Keep it null so the chart draws a GAP (connectNulls:false), NEVER coerced
// to 0 (a false drop). A series whose every point is null is dropped
// entirely — a photo's views line is omitted, not a flat dead legend toggle.

import { asc, eq } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { instagramPostSnapshots } from "$lib/server/db/schema/index.js";
import type { EventKind, EventMetricSeries } from "$lib/sources/adapter.js";

export async function instagramFetchEventMetricSeries(
  _userId: string,
  event: { kind: EventKind; externalId: string | null },
): Promise<EventMetricSeries[]> {
  if (event.kind !== "instagram_post" || event.externalId === null) return [];

  const rows = await db
    .select({
      polledAt: instagramPostSnapshots.polledAt,
      viewCount: instagramPostSnapshots.viewCount,
      likeCount: instagramPostSnapshots.likeCount,
      commentCount: instagramPostSnapshots.commentCount,
    })
    .from(instagramPostSnapshots)
    .where(eq(instagramPostSnapshots.postId, event.externalId))
    .orderBy(asc(instagramPostSnapshots.polledAt));
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
  ].filter((s) => s.points.some((p) => p.value !== null));
}
