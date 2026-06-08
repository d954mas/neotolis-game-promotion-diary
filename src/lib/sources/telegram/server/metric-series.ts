// Telegram VIZ-05 metric-series reader (mirrors instagram/metric-series.ts,
// single view_count series — Telegram exposes ONLY a view count, D-04).
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
// Metrics-by-presence (D-05): a NULL view_count means views were hidden /
// absent at poll time (very new post or views disabled). Keep it null so the
// chart draws a GAP (connectNulls:false), NEVER coerced to 0 (a false drop). A
// post whose snapshots are ALL null-views (or has no snapshot rows at all)
// yields an EMPTY series array — the views line is omitted, not a flat dead
// legend toggle. (snapshots.ts never writes a null-view snapshot row, so in
// practice a null-only history is just an empty row set; the .filter() below is
// the belt-and-suspenders guard.)

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
    })
    .from(telegramPostSnapshots)
    .where(eq(telegramPostSnapshots.postId, event.externalId))
    .orderBy(asc(telegramPostSnapshots.polledAt));
  if (rows.length === 0) return [];

  // bigint column comes back as `number` via mode:"number"; null stays null.
  return [
    {
      metricKey: "view_count",
      labelKey: "chart_metric_views",
      points: rows.map((r) => ({ polledAt: r.polledAt.toISOString(), value: r.viewCount })),
    },
  ].filter((s) => s.points.some((p) => p.value !== null));
}
