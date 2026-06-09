// Telegram VIZ-05 metric-series reader. Telegram's public t.me/s listing
// exposes TWO chartable metrics: a view count AND a per-post reaction tally (E1
// — Phase 9 UAT second metric); no likes/comments/shares (D-04). This returns
// [viewSeries, reactionsSeries] in the EXACT multi-metric YouTube shape
// (youtube/server/metric-series.ts:67-71 — one EventMetricSeries per snapshot
// column, each filtered out when all-null).
//
// Implements SourceAdapter.fetchEventMetricSeries for the Telegram adapter.
// Self-filters to kind=telegram_post; returns [] for every other kind (the
// caller — the /events/[id] loader iterating allAdapters — does NOT
// pre-filter, mirroring the YouTube/Reddit/Instagram reference impls).
//
// Reads the FULL immutable snapshot history from telegram_post_snapshots
// ORDER BY polled_at ASC (POLL-04: never a mutable current-value column).
// telegram_post_snapshots is a PUBLIC-DATA table (no user_id column —
// allowlisted in Plan 01). The `_userId` parameter is required by the
// SourceAdapter contract but intentionally unused here: the tenant guarantee
// comes from the caller's upstream events SELECT, exactly as the IG reader
// documents.
//
// Metrics-by-presence (D-05): a NULL value means that metric was hidden / absent
// at poll time (views disabled, or no reactions block). Keep it null so the
// chart draws a GAP (connectNulls:false), NEVER coerced to 0 (a false drop). A
// metric whose every point is null (or a post with no snapshot rows at all)
// yields NO series for that metric — the line is omitted, not a flat dead legend
// toggle. So a post with views-only reactions-never returns just the view_count
// series; a post with both returns both.

import { asc, eq } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { telegramPostSnapshots } from "$lib/server/db/schema/index.js";
import type { EventKind, EventMetricSeries } from "$lib/sources/adapter.js";

export async function telegramFetchEventMetricSeries(
  _userId: string,
  event: { kind: EventKind; externalId: string | null },
): Promise<EventMetricSeries[]> {
  if (event.kind !== "telegram_post" || event.externalId === null) return [];

  const rows = await db
    .select({
      polledAt: telegramPostSnapshots.polledAt,
      viewCount: telegramPostSnapshots.viewCount,
      reactionsTotal: telegramPostSnapshots.reactionsTotal,
    })
    .from(telegramPostSnapshots)
    .where(eq(telegramPostSnapshots.postId, event.externalId))
    .orderBy(asc(telegramPostSnapshots.polledAt));
  if (rows.length === 0) return [];

  // bigint columns come back as `number` via mode:"number"; null stays null.
  // One series per metric column, each dropped when all-null — the EXACT
  // multi-metric YouTube shape (view/like/comment → here view/reactions).
  const build = (
    metricKey: string,
    labelKey: string,
    pick: (r: { viewCount: number | null; reactionsTotal: number | null }) => number | null,
  ): EventMetricSeries => ({
    metricKey,
    labelKey,
    points: rows.map((r) => ({ polledAt: r.polledAt.toISOString(), value: pick(r) })),
  });

  return [
    build("view_count", "chart_metric_views", (r) => r.viewCount),
    build("reaction_count", "chart_metric_reactions", (r) => r.reactionsTotal),
  ].filter((s) => s.points.some((p) => p.value !== null));
}
