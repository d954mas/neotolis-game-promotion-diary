// Reddit VIZ-01 metric-series reader (D-14 reference implementation).
//
// Implements SourceAdapter.fetchEventMetricSeries for the Reddit adapter.
// Self-filters to kind=reddit_post; returns [] for every other kind (the
// caller — the /events/[id] loader iterating allAdapters — does NOT
// pre-filter, mirroring enrichFeedDtos). Sibling of the YouTube reference
// impl in src/lib/sources/youtube/server/metric-series.ts.
//
// Reads the FULL immutable snapshot history from reddit_post_snapshots
// ORDER BY polled_at ASC (POLL-04: never a mutable current-value column).
// reddit_post_snapshots is a PUBLIC-DATA table (no user_id column — already
// in the ESLint tenant-scope allowlist). The `_userId` parameter is required
// by the SourceAdapter contract but intentionally unused here: the tenant
// guarantee comes from the caller's upstream events SELECT, exactly as
// enrichRedditFeedDtos documents.
//
// events.externalId for reddit_post may be stored bare ("abc123") or in t3
// form ("t3_abc123"); reddit_post_snapshots.post_id is the t3 form. Normalize
// to t3 for the SELECT so either stored form resolves.

import { asc, eq } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { redditPostSnapshots } from "./schema/index.js";
import type { EventKind, EventMetricSeries } from "$lib/sources/adapter.js";

export async function redditFetchEventMetricSeries(
  _userId: string,
  event: { kind: EventKind; externalId: string | null },
): Promise<EventMetricSeries[]> {
  if (event.kind !== "reddit_post" || event.externalId === null) return [];

  const postId = event.externalId.startsWith("t3_") ? event.externalId : `t3_${event.externalId}`;
  const rows = await db
    .select({
      polledAt: redditPostSnapshots.polledAt,
      score: redditPostSnapshots.score,
      numComments: redditPostSnapshots.numComments,
    })
    .from(redditPostSnapshots)
    .where(eq(redditPostSnapshots.postId, postId))
    .orderBy(asc(redditPostSnapshots.polledAt));
  if (rows.length === 0) return [];

  // A NULL score / num_comments means the metric was unavailable at poll time
  // (removed post, score hidden during early vote fuzzing): keep it null so the
  // chart draws a GAP, never a false 0. Drop a metric that is null throughout.
  return [
    {
      metricKey: "score",
      labelKey: "chart_metric_score",
      points: rows.map((r) => ({ polledAt: r.polledAt.toISOString(), value: r.score })),
    },
    {
      metricKey: "num_comments",
      labelKey: "chart_metric_num_comments",
      points: rows.map((r) => ({ polledAt: r.polledAt.toISOString(), value: r.numComments })),
    },
  ].filter((s) => s.points.some((p) => p.value !== null));
}
