// Phase 03.0.1 Plan 10 — youtube.backfill.user queue handler.
//
// Triggered by POST /api/sources/:id/refresh-content (the "Pull new content"
// button on /sources/[id]). Enumerates the registered channel's recent
// uploads via the existing pollContent path and INSERTs new event rows
// (kind=youtube_video) under the user's tenant. Equivalent to running the
// auto-import poll on demand for one source.
//
// CONTRACT (D-10 per-kind queue topology, D-11 cron/user/backfill split):
//   - Queue:   YOUTUBE_BACKFILL_USER ("youtube.backfill.user")
//   - Payload: { sourceId: string; userId: string; origin?: "user" | "cron" }
//   - Side effects: 0..N events INSERTs scoped to (userId, sourceId).
//   - Idempotency: pre-INSERT SELECT scoped by (userId, sourceId, kind,
//     externalId) skips events that already exist for THIS source. The
//     partial UNIQUE events_user_kind_source_ext_unq is the DB-level
//     defense-in-depth (matches the channel-context-backfill handler's
//     pattern — Phase 3.0 post-build review 2026-05-07).
//
// AUTH GATE: pickKeyForJob() returning null = SERVICE_YOUTUBE_API_KEYS empty.
// We log+skip rather than throw — preserves self-host parity (a self-hoster
// who never sets the env var sees a graceful no-op on click, not a worker
// crash). The button surfaces a 422 only when the adapter is unregistered;
// missing keys are operator-side and don't reach the worker fast-path.
//
// SOURCE LOOKUP: tenant-scoped read by (sourceId, userId) with isNull(deletedAt).
// Matches AGENTS.md Pattern 1 (every Drizzle query against a user-owned table
// includes eq(<table>.userId, userId)). The job payload pairs sourceId with
// userId; even though pg-boss won't deliver a malformed job, the userId
// filter is the load-bearing privacy guarantee — a future bug that lets
// jobs be re-enqueued by a different user is caught at the worker layer.

import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { dataSources } from "$lib/server/db/schema/data-sources.js";
import { events } from "$lib/server/db/schema/events.js";
import { logger } from "$lib/server/logger.js";
import { youtubeChannelAdapterCore as adapter } from "../adapter.js";

interface BackfillUserJob {
  id?: string;
  data: {
    sourceId: string;
    userId: string;
    origin?: "user" | "cron";
  };
}

const BACKFILL_LOOKBACK_MS = 30 * 24 * 3600 * 1000; // 30 days when source has never been polled

export async function handleBackfillUser(job: BackfillUserJob): Promise<void> {
  const { sourceId, userId } = job.data;
  if (typeof sourceId !== "string" || typeof userId !== "string") {
    logger.warn(
      { jobId: job.id, payload: job.data },
      "youtube.backfill.user: malformed payload (missing sourceId/userId); skipping",
    );
    return;
  }

  // Tenant-scoped lookup — Pattern 1 (AGENTS.md). Cross-tenant jobs (or
  // jobs for soft-deleted sources) silently no-op.
  const sourceRow = await db
    .select()
    .from(dataSources)
    .where(
      and(
        eq(dataSources.id, sourceId),
        eq(dataSources.userId, userId),
        isNull(dataSources.deletedAt),
      ),
    )
    .limit(1);
  const source = sourceRow[0];
  if (!source) {
    logger.warn(
      { jobId: job.id, sourceId, userId },
      "youtube.backfill.user: source missing/deleted/cross-tenant; skipping",
    );
    return;
  }

  if (source.kind !== "youtube_channel") {
    logger.warn(
      { jobId: job.id, sourceId, kind: source.kind },
      "youtube.backfill.user: source kind is not youtube_channel; skipping",
    );
    return;
  }

  // pollContent's `since` argument bounds the playlistItems filter. The
  // data_sources schema does NOT carry a per-source last-polled timestamp
  // (polling state lives on youtube_videos per-video — Phase 3.0 post-build
  // refactor 2026-05-06). For an on-demand "Pull new content" click the
  // pragmatic window is the last 30 days; pre-INSERT idempotency below
  // ensures we don't double-create events the cron tick already inserted,
  // so the lookback acts as a content discovery ceiling rather than a
  // duplication risk.
  const since = new Date(Date.now() - BACKFILL_LOOKBACK_MS);

  let rawEvents;
  try {
    rawEvents = await adapter.pollContent(
      {
        id: source.id,
        userId: source.userId,
        metadata: (source.metadata ?? {}) as Record<string, unknown>,
      },
      since,
    );
  } catch (err) {
    logger.warn(
      { jobId: job.id, sourceId, userId, err: String((err as Error)?.message ?? err) },
      "youtube.backfill.user: pollContent threw; skipping",
    );
    return;
  }

  if (rawEvents.length === 0) {
    logger.info(
      { jobId: job.id, sourceId, userId },
      "youtube.backfill.user: no new content since last poll",
    );
    return;
  }

  // Auto-import idempotency: pre-INSERT SELECT scoped by (userId, sourceId,
  // kind=youtube_video, externalId IN ...). Matches channel-context-backfill
  // (Phase 3.0 post-build review 2026-05-07) — a re-click within the same
  // window is a no-op at row level, and a manual paste of the same video
  // (sourceId=NULL) doesn't block the auto-import event.
  const externalIds = rawEvents
    .map((e) => e.externalId)
    .filter((x): x is string => typeof x === "string" && x.length > 0);
  let existingIds = new Set<string>();
  if (externalIds.length > 0) {
    const existing = await db
      .select({ externalId: events.externalId })
      .from(events)
      .where(
        and(
          eq(events.userId, userId),
          eq(events.sourceId, source.id),
          sql`${events.kind} = 'youtube_video'`,
          sql`${events.externalId} IN (${sql.join(
            externalIds.map((eid) => sql`${eid}`),
            sql`, `,
          )})`,
          isNotNull(events.externalId),
          isNull(events.deletedAt),
        ),
      );
    existingIds = new Set(
      existing.map((r) => r.externalId).filter((x): x is string => typeof x === "string"),
    );
  }

  const authorIsMe = source.isOwnedByMe;
  let inserted = 0;
  for (const ev of rawEvents) {
    if (ev.externalId && existingIds.has(ev.externalId)) continue;
    await db.insert(events).values({
      userId,
      sourceId: source.id,
      kind: "youtube_video",
      authorIsMe,
      occurredAt: ev.occurredAt,
      title: ev.title,
      url: ev.url,
      externalId: ev.externalId,
      metadata: ev.metadata ?? {},
    });
    inserted += 1;
  }

  logger.info(
    {
      jobId: job.id,
      sourceId,
      userId,
      origin: job.data.origin ?? "user",
      candidates: rawEvents.length,
      inserted,
    },
    "youtube.backfill.user: complete",
  );
}
