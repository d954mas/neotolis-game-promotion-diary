// Idempotent per-video snapshot writer.
//
// Atomic across 3 ops in a single short db.transaction:
//   1. INSERT row in youtube_video_snapshots with polled_at = date_trunc('minute', now())
// - UNIQUE (video_id, polled_at) ON CONFLICT DO NOTHING makes within-the-minute
//      retries no-op at the row level (idempotent at retry boundary).
//   2. UPDATE youtube_videos.last_polled_at + last_poll_status + poll_failure_count
//      keyed on video_id. PUBLIC-DATA - no userId filter (multiple tenants share
//      one row). poll_failure_count increments on non-ok statuses so the rehab
//      cron's exit gate can fire at >= 5; resets to 0 on 'ok'.
//   3. Optionally UPSERT youtube_service_quota_usage += unitsUsed for callers
//      that did not already reserve quota before HTTP.
//
// Caller is responsible for the HTTP call (which happens OUTSIDE this tx  -
// tx-boundary < 50ms; never hold a row lock while waiting on a 5s HTTP
// request). This service expects the metrics + status as already-resolved
// inputs.
//
// The events row is NOT updated here. Polling state lives on
// youtube_videos; the /feed loader JOINs back to expose last_polled_at +
// last_poll_status to the UI.

import { sql, eq } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { youtubeVideoSnapshots, youtubeVideos } from "$lib/server/db/schema/index.js";

// Lazy-import the quota tracker. Kept dynamic because Vitest's module
// mock contract uses the resolved path; dynamic imports respect vi.mock
// the same as static imports.
async function incrementUsage(args: {
  apiKeyId: string;
  units: number;
  poolKind: "cron" | "user";
  tx: unknown;
}): Promise<void> {
  const tracker = (await import("./quota.js")) as {
    incrementUsage: (a: {
      apiKeyId: string;
      units: number;
      poolKind: "cron" | "user";
      tx?: unknown;
    }) => Promise<void>;
  };
  await tracker.incrementUsage({
    apiKeyId: args.apiKeyId,
    units: args.units,
    poolKind: args.poolKind,
    tx: args.tx,
  });
}

export type SnapshotStatus = "ok" | "not_found" | "private" | "auth_error" | "rate_limited";

export interface WriteSnapshotArgs {
  /** youtube_videos.video_id - keys the public-data UPDATE + snapshot INSERT. */
  videoId: string;
  /**
   * Resolved metrics from the upstream API. NULL when status !== 'ok' (no
   * snapshot row inserted in that case; only the youtube_videos row updates).
   */
  metrics: { view_count: number; like_count: number; comment_count: number } | null;
  /** sha-8 from the quota tracker - identifies which API key burned units. */
  apiKeyId: string;
  /** Units consumed by the upstream call (1 per videos.list call per VERIFIED FACT). */
  unitsUsed: number;
  /**
   * Which origin pool owns the quota accounting. Scheduler handlers pass
   * 'cron'; user-driven handlers pass 'user'.
   */
  poolKind: "cron" | "user";
  /** Outcome label written to youtube_videos.last_poll_status. */
  status: SnapshotStatus;
  /**
   * Shorts classification verdict to persist on youtube_videos.media_type
   * ("short" | "video"). OMITTED (undefined) on the vast majority of writes:
   * the column is only touched when the poll worker has a NEW decisive verdict
   * (a fresh probe result, or the over-ceiling duration prefilter). A NULL /
   * ambiguous verdict is left as `undefined` here so an already-classified row
   * is never CLOBBERED back to NULL by a later tick whose probe budget was
   * spent — only forward transitions (NULL → short/video) are written.
   */
  mediaType?: "short" | "video";
}

export async function writeSnapshot(args: WriteSnapshotArgs): Promise<void> {
  await db.transaction(async (tx) => {
    // 1. Snapshot row - only on success. ON CONFLICT DO NOTHING makes
    //    within-the-same-minute retries idempotent (a worker that crashes
    //    AFTER the upstream HTTP call but BEFORE commit will retry on the
    //    next tick and the second insert is a no-op).
    if (args.status === "ok" && args.metrics !== null) {
      await tx
        .insert(youtubeVideoSnapshots)
        .values({
          videoId: args.videoId,
          polledAt: sql`date_trunc('minute', now())` as unknown as Date,
          viewCount: args.metrics.view_count,
          likeCount: args.metrics.like_count,
          commentCount: args.metrics.comment_count,
        })
        .onConflictDoNothing();
    }

    // 2. youtube_videos UPDATE - public-data, single source of truth for
    //    polling state across all tenants who reference this video.
    //    poll_failure_count increments on non-ok, resets on ok. The
    //    rehab-unavailable cron's exit gate fires at >= 5.
    //    PUBLIC-DATA TABLE - no userId filter (videos are tenant-agnostic).
    //    ESLint tenant-scope rule allowlists youtubeVideos via the schema's
    //    "no tenant scope" header comment.
    await tx
      .update(youtubeVideos)
      .set({
        lastPolledAt: new Date(),
        lastPollStatus: args.status,
        pollFailureCount: args.status === "ok" ? 0 : sql`${youtubeVideos.pollFailureCount} + 1`,
        // media_type is ONLY written when the caller has a fresh decisive verdict
        // (probe result / over-ceiling prefilter). Omitting it (undefined) leaves
        // the existing value untouched — Drizzle drops undefined keys from the SET
        // — so an already-classified row is never clobbered back to NULL by a
        // later budget-exhausted tick.
        ...(args.mediaType !== undefined ? { mediaType: args.mediaType } : {}),
      })
      .where(eq(youtubeVideos.videoId, args.videoId));

    // 3. Quota counter. New worker paths reserve quota before HTTP and pass
    //    unitsUsed=0 here; older direct accounting paths can still charge at
    //    snapshot-write time.
    if (args.unitsUsed > 0) {
      await incrementUsage({
        apiKeyId: args.apiKeyId,
        units: args.unitsUsed,
        poolKind: args.poolKind,
        tx,
      });
    }
  });
}
