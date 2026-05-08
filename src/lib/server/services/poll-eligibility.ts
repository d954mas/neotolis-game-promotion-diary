// Phase 3.0 post-build refactor (2026-05-08) — extracted from
// src/scheduler/enqueue.ts so the SQL-window + tier-resolver + auto-import
// gate logic can be unit-tested in isolation and re-used by future callers
// (e.g. an admin "what's eligible right now?" debug endpoint, or a manual
// trigger from /sources/[id] without needing to touch enqueue.ts).
//
// The function is intentionally callable WITHOUT a queue handle: it only
// reads (events, youtube_videos, data_sources) and returns video_ids.
// enqueue.ts wraps it in throttle gating + queue dispatch; nothing else
// in this module knows about pg-boss.
//
// Cross-tenant by design — see the eslint-disable lines below for the same
// fan-out rationale enqueue.ts carried before the extraction. Self-host
// parity holds (operator runs the scheduler; aggregation across the
// operator's own tenants is the intended behaviour).

import { sql, and, gt, isNotNull, isNull, lte, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { events } from "../db/schema/events.js";
import { dataSources } from "../db/schema/data-sources.js";
import { youtubeVideos } from "../db/schema/youtube-videos.js";
import { resolveTier } from "./tier-resolver.js";

/**
 * Resolve which video_ids are eligible to poll for a tier.
 *
 * Returns the de-duplicated list of external_ids whose:
 *   - youtube_videos.published_at falls in the (cutoffOldest, cutoffNewest] window
 *   - youtube_videos.last_poll_status is NOT in the unavailable override list
 *     (the JS-side resolveTier check applies it)
 *   - at least one referencing event is alive (not soft-deleted) and either
 *     source_id IS NULL (manual paste — always pollable) or its source has
 *     auto_import=true.
 *
 * The JS-side resolveTier() pass is the authoritative classifier; the SQL
 * filter is the coarse window. Pitfall 7 — never inline a tier boundary.
 */
export async function selectEligibleVideoIds(
  cutoffNewest: Date | null,
  cutoffOldest: Date,
  expectedTier: "active" | "cold",
  now: Date,
): Promise<string[]> {
  // Fetch candidate (external_id, published_at, last_poll_status, source_id)
  // tuples in one JOIN. The eslint-disable is the same fan-out rationale as
  // the prior per-event scheduler — this is the cron tick that builds work
  // across all tenants. Per-video writeSnapshot downstream is public-data,
  // not tenant-scoped (writeSnapshot's UPDATE keys on video_id only).
  // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- scheduler fan-out is service-wide by design (Plan 03.0-09 §"scheduler tick" — one cron tick batches eligible videos across ALL tenants into POLL_ACTIVE/COLD jobs). Per-video writeSnapshot downstream is public-data; tenant scope does not apply.
  const rows = await db
    .selectDistinct({
      videoId: youtubeVideos.videoId,
      publishedAt: youtubeVideos.publishedAt,
      lastPollStatus: youtubeVideos.lastPollStatus,
      sourceId: events.sourceId,
    })
    .from(events)
    .innerJoin(youtubeVideos, eq(events.externalId, youtubeVideos.videoId))
    .where(
      and(
        sql`${events.kind} = 'youtube_video'`,
        isNotNull(events.externalId),
        isNull(events.deletedAt),
        isNotNull(youtubeVideos.publishedAt),
        cutoffNewest ? lte(youtubeVideos.publishedAt, cutoffNewest) : sql`true`,
        gt(youtubeVideos.publishedAt, cutoffOldest),
      ),
    );

  // Authoritative tier classification on the JS side. SQL window is a
  // superset (it does not know about UNAVAILABLE_POLL_STATUSES override).
  const tierMatched = rows.filter(
    (r) => resolveTier(r.publishedAt, r.lastPollStatus, now) === expectedTier,
  );

  // Auto-import gate: events with source_id NOT NULL require their parent
  // data_source's auto_import=true. Manual paste (source_id IS NULL) is
  // always pollable. Note: the JOIN above produces (video_id, source_id)
  // pairs — the SAME video might appear with multiple source_id values
  // (one user pasted manually, another added via auto_import source).
  // We dedup AFTER the auto-import check: if ANY event references this
  // video on a permitted path (manual OR auto-import-enabled source), the
  // video is eligible.
  const sourceIds = Array.from(
    new Set(tierMatched.map((r) => r.sourceId).filter((s): s is string => s !== null)),
  );
  const autoImportSourceIds = new Set<string>();
  if (sourceIds.length > 0) {
    // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- scheduler fan-out, sources lookup batched for the candidate video set.
    const sourceRows = await db
      .select({ id: dataSources.id, autoImport: dataSources.autoImport })
      .from(dataSources)
      .where(and(inArray(dataSources.id, sourceIds), isNull(dataSources.deletedAt)));
    for (const s of sourceRows) {
      if (s.autoImport) autoImportSourceIds.add(s.id);
    }
  }

  const eligibleVideos = new Set<string>();
  for (const r of tierMatched) {
    if (r.sourceId === null || autoImportSourceIds.has(r.sourceId)) {
      eligibleVideos.add(r.videoId);
    }
  }
  return Array.from(eligibleVideos);
}
