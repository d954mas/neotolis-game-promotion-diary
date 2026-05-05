// Phase 3.0 Plan 04 — idempotent snapshot writer (POLL-04 + Pitfall 5).
//
// Atomic across 3 ops in a single short db.transaction:
//   1. INSERT row in youtube_video_snapshots with polled_at = date_trunc('minute', now())
//      — UNIQUE (video_id, polled_at) ON CONFLICT DO NOTHING makes within-the-minute
//      retries no-op at the row level (idempotent at retry boundary).
//   2. UPDATE events.last_polled_at + last_poll_status (tenant-scoped via userId).
//   3. UPSERT youtube_service_quota_usage += unitsUsed (per-key per-day counter,
//      via youtube-quota-tracker.incrementUsage with `tx` so the counter cannot
//      disagree with the work that consumed quota).
//
// Caller is responsible for the HTTP call (which happens OUTSIDE this tx —
// Pitfall 5: tx-boundary < 50ms; never hold a row lock while waiting on a 5s
// HTTP request). This service expects the metrics + status as already-resolved
// inputs.
//
// Tenant scope (Privacy invariant 1): the `events` UPDATE filter MUST include
// `eq(events.userId, args.userId)` — events is a tenant-owned table and the
// custom ESLint rule `tenant-scope/no-unfiltered-tenant-query` enforces the
// userId clause. The `youtubeVideoSnapshots` and `youtubeServiceQuotaUsage`
// tables are explicitly public-data / operator-scoped and ESLint-allowlisted
// in Plan 01.

import { sql, eq, and } from "drizzle-orm";
import { db } from "../db/client.js";
import { youtubeVideoSnapshots } from "../db/schema/youtube-video-snapshots.js";
import { events } from "../db/schema/events.js";

// Lazy-import the quota tracker so this module loads even when Plan 03
// (which creates youtube-quota-tracker.ts on the same Phase 3.0 branch in
// parallel) has not yet merged its file. Once both plans land on the
// branch, the dynamic import resolves the same `incrementUsage` symbol the
// plan's <key_links> contract names. Tests use `vi.mock(...)` against the
// resolved path; the dynamic import respects the mock the same way a
// static import would (Vitest hoists module mocks before any execution).
async function incrementUsage(args: {
  apiKeyId: string;
  units: number;
  // Drizzle transaction parameter — narrow type kept local so this module
  // does not transitively pull a tracker type that may not yet exist.
  tx: unknown;
}): Promise<void> {
  const tracker = (await import("./youtube-quota-tracker.js")) as {
    incrementUsage: (a: {
      apiKeyId: string;
      units: number;
      tx?: unknown;
    }) => Promise<void>;
  };
  await tracker.incrementUsage({
    apiKeyId: args.apiKeyId,
    units: args.units,
    tx: args.tx,
  });
}

export type SnapshotStatus = "ok" | "not_found" | "private" | "auth_error" | "rate_limited";

export interface WriteSnapshotArgs {
  /** events.external_id — the YouTube videoId. */
  videoId: string;
  /** events.id — the row to update last_polled_at on. */
  eventId: string;
  /**
   * events.user_id — required so the events UPDATE filter is tenant-scoped
   * (Privacy invariant 1; ESLint tenant-scope rule trips otherwise).
   */
  userId: string;
  /**
   * Resolved metrics from the upstream API. NULL when status !== 'ok' (no
   * snapshot row inserted in that case; only the events row updates).
   */
  metrics: { view_count: number; like_count: number; comment_count: number } | null;
  /** sha-8 from the quota tracker — identifies which API key burned units. */
  apiKeyId: string;
  /** Units consumed by the upstream call (1 per videos.list call per VERIFIED FACT). */
  unitsUsed: number;
  /** Outcome label written to events.last_poll_status. */
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

    // 2. Events update — tenant-scoped via userId.
    //    last_polled_at advances on every status (not just 'ok') so the
    //    scheduler doesn't re-pick the same row immediately on a transient
    //    failure; last_poll_status carries the failure mode the tier
    //    resolver later interprets ('not_found' / 'private' / 'auth_error'
    //    → Unavailable tier per D-12).
    await tx
      .update(events)
      .set({
        lastPolledAt: new Date(),
        lastPollStatus: args.status,
      })
      .where(and(eq(events.id, args.eventId), eq(events.userId, args.userId)));

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
