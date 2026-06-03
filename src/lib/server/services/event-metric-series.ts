// Per-event metric-series orchestration (VIZ-01, D-14).
//
// ONE home for the adapter loop that both the GET /api/events/:id/metric-series
// route and the /events/[id] SSR loader used to duplicate inline. Each adapter
// self-filters to its own kind (non-matching → []), reads its immutable
// *_snapshots history (POLL-04) by externalId, and contributes its chartable
// series. Routes-call-services / routes-call-adapters: no db.select() here —
// getEventById is the tenant gate (service), allAdapters.fetchEventMetricSeries
// is the public-data read (adapter), exactly as enrichFeedDtos documents.
//
// Two entry points so each caller stays at its natural granularity:
//   - getEventMetricSeries(userId, eventId): resolves the event via getEventById
//     FIRST (404 NotFoundError for a foreign/missing id — never 403) and then
//     reads its series. Used by the API route, which only has the event id.
//   - getEventMetricSeriesForRow(userId, row): the bare adapter loop for a row
//     the caller already loaded + tenant-vetted (the loader has the full event
//     row in hand, so re-SELECTing by id would be a wasted query). The caller is
//     responsible for tenant-scoping the row it passes — every current caller
//     (the loader) gets the row from getEventById on the same user.

import { getEventById } from "./events.js";
import { allAdapters } from "$lib/sources/registry.js";
import type { EventKind, EventMetricSeries } from "$lib/sources/adapter.js";

/**
 * Run every adapter's fetchEventMetricSeries against an already-resolved,
 * already-tenant-scoped event row. Adapters self-filter to their own kind, so
 * non-matching adapters contribute nothing. NO tenant gate here — the caller
 * must have vetted `row` (it owns the event SELECT). Use getEventMetricSeries
 * when you only have an event id and need the 404 gate.
 */
export async function getEventMetricSeriesForRow(
  userId: string,
  row: { kind: EventKind; externalId: string | null },
): Promise<EventMetricSeries[]> {
  const series: EventMetricSeries[] = [];
  for (const adapter of allAdapters) {
    if (adapter.fetchEventMetricSeries === undefined) continue;
    series.push(
      ...(await adapter.fetchEventMetricSeries(userId, {
        kind: row.kind,
        externalId: row.externalId,
      })),
    );
  }
  return series;
}

/**
 * Tenant-scoped per-event metric series by event id. getEventById throws
 * NotFoundError for a missing OR cross-tenant id (→ 404, never 403) BEFORE any
 * snapshot read, so the adapter public-data reads only ever run for a vetted
 * event. Used by GET /api/events/:id/metric-series (the modal lazy-fetch path).
 */
export async function getEventMetricSeries(
  userId: string,
  eventId: string,
): Promise<EventMetricSeries[]> {
  const ev = await getEventById(userId, eventId);
  return getEventMetricSeriesForRow(userId, { kind: ev.kind, externalId: ev.externalId });
}
