// Phase 3.0 Plan 04 + post-build refactor (2026-05-06) — idempotent
// per-video snapshot writer.
//
// Atomic across 3 ops in a single short db.transaction:
//   1. INSERT row in youtube_video_snapshots with polled_at = date_trunc('minute', now())
//      — UNIQUE (video_id, polled_at) ON CONFLICT DO NOTHING makes within-the-minute
//      retries no-op at the row level (idempotent at retry boundary).
//   2. UPDATE youtube_videos.last_polled_at + last_poll_status + poll_failure_count
//      keyed on video_id. PUBLIC-DATA — no userId filter (multiple tenants share
//      one row). poll_failure_count increments on non-ok statuses so the rehab
//      cron's exit gate can fire at >= 5; resets to 0 on 'ok'.
//   3. UPSERT youtube_service_quota_usage += unitsUsed (per-key per-day counter,
//      via ./quota.ts incrementUsage with `tx` so the counter cannot
//      disagree with the work that consumed quota).
//
// Caller is responsible for the HTTP call (which happens OUTSIDE this tx —
// Pitfall 5: tx-boundary < 50ms; never hold a row lock while waiting on a 5s
// HTTP request). This service expects the metrics + status as already-resolved
// inputs.
//
// Per-video refactor (2026-05-06): the events row is NOT updated here anymore.
// Polling state lives on youtube_videos; the /feed loader JOINs back to expose
// last_polled_at + last_poll_status to the UI.

import { sql, eq } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { youtubeVideoSnapshots, youtubeVideos } from "$lib/server/db/schema/index.js";

// Lazy-import the quota tracker — historical from Plan 04. Kept dynamic because
// Vitest's module mock contract uses the resolved path; dynamic imports
// respect vi.mock the same as static imports.
async function incrementUsage(args: {
  apiKeyId: string;
  units: number;
  tx: unknown;
}): Promise<void> {
  const tracker = (await import("./quota.js")) as {
    incrementUsage: (a: { apiKeyId: string; units: number; tx?: unknown }) => Promise<void>;
  };
  await tracker.incrementUsage({
    apiKeyId: args.apiKeyId,
    units: args.units,
    tx: args.tx,
  });
}

export type SnapshotStatus = "ok" | "not_found" | "private" | "auth_error" | "rate_limited";

export interface WriteSnapshotArgs {
  /** youtube_videos.video_id — keys the public-data UPDATE + snapshot INSERT. */
  videoId: string;
  /**
   * Resolved metrics from the upstream API. NULL when status !== 'ok' (no
   * snapshot row inserted in that case; only the youtube_videos row updates).
   */
  metrics: { view_count: number; like_count: number; comment_count: number } | null;
  /** sha-8 from the quota tracker — identifies which API key burned units. */
  apiKeyId: string;
  /** Units consumed by the upstream call (1 per videos.list call per VERIFIED FACT). */
  unitsUsed: number;
  /** Outcome label written to youtube_videos.last_poll_status. */
  status: SnapshotStatus;
}

export async function writeSnapshot(args: WriteSnapshotArgs): Promise<void> {
  await db.transaction(async (tx) => {
    // 1. Snapshot row — only on success. ON CONFLICT DO NOTHING makes
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

    // 2. youtube_videos UPDATE — public-data, single source of truth for
    //    polling state across all tenants who reference this video.
    //    poll_failure_count increments on non-ok, resets on ok. The
    //    rehab-unavailable cron's exit gate fires at >= 5.
    //    PUBLIC-DATA TABLE — no userId filter (videos are tenant-agnostic).
    //    ESLint tenant-scope rule allowlists youtubeVideos via the schema's
    //    "no tenant scope" header comment.
    await tx
      .update(youtubeVideos)
      .set({
        lastPolledAt: new Date(),
        lastPollStatus: args.status,
        pollFailureCount: args.status === "ok" ? 0 : sql`${youtubeVideos.pollFailureCount} + 1`,
      })
      .where(eq(youtubeVideos.videoId, args.videoId));

    // 3. Quota counter — UPSERT inside the same tx so the counter cannot
    //    disagree with the snapshot row about units consumed. Pass `tx`
    //    explicitly to chain the UPSERT into THIS transaction.
    await incrementUsage({
      apiKeyId: args.apiKeyId,
      units: args.unitsUsed,
      tx,
    });
  });
}
