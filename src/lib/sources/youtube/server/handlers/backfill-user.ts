// Phase 03.0.1 Plan 10 — youtube.backfill.user queue handler.
//
// Triggered by:
//   - POST /api/sources/:id/refresh-content (the "Pull new content" button on
//     /sources/[id]). Audit job.data.flow = 'incremental' (default) or
//     'historical' (when user picked custom date / preset deeper than current
//     frontier).
//   - youtube.auto-backfill.cron daily picker (auto-passive cache hydration).
//     Audit job.data.flow = 'auto_passive'.
//
// Phase 03.0.1 (this commit) extends the handler from a hardcoded 30d-window
// pull into a catch-up flow:
//   1. Look up `latest event.occurred_at` for this source — newest event we
//      have. computeSinceForRefresh derives newSide + oldSide boundaries.
//   2. Single pollContent(source, since=oldSide ?? newSide) — uploads playlist
//      sorted publishedAt DESC; pulling from the deeper boundary covers both
//      "new since latest existing" and "older down to target" in one call.
//      Idempotency via `events.externalId` UNIQUE skips overlap.
//   3. Conditional event INSERT — auto_passive flow honors `source.auto_import`
//      (passive cache hydration but no per-user feed events when auto_import
//      is off). User-driven flows (initial / incremental / historical) ALWAYS
//      INSERT events — user explicitly clicked, override the setting.
//   4. State update — last_polled_at + backfill_oldest_at (frontier moves
//      deeper if MIN(inserted occurred_at) is older than current frontier) +
//      backfill_complete (true when pollContent returned empty HTTP-200, i.e.
//      platform confirmed "no more older content").
//   5. Audit row — flow + platform + requests_used (estimated from page count)
//      + events_inserted. Cap query (services/quota.ts) SUMs these.
//
// CONTRACT (D-10 per-kind queue topology, D-11 cron/user/backfill split):
//   - Queue:   YOUTUBE_BACKFILL_USER ("youtube.backfill.user")
//   - Payload: { sourceId: string; userId: string; origin?: "user" | "cron";
//                flow?: "incremental" | "historical" | "auto_passive" }
//   - Side effects: 0..N event INSERTs scoped to (userId, sourceId). State
//     UPDATE on data_sources (last_polled_at, frontier, complete). One audit
//     row per completion.
//   - Idempotency: pre-INSERT SELECT scoped by (userId, sourceId, kind,
//     externalId) skips events that already exist for THIS source. The
//     partial UNIQUE events_user_kind_source_ext_unq is the DB-level
//     defense-in-depth.
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

import { and, eq, isNotNull, isNull, sql, max } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { dataSources } from "$lib/server/db/schema/data-sources.js";
import { events } from "$lib/server/db/schema/events.js";
import { logger } from "$lib/server/logger.js";
import { writeAudit } from "$lib/server/audit.js";
import {
  computeSinceForRefresh,
  markSourceLastPolledAt,
  markSourceBackfillFrontier,
  markSourceBackfillComplete,
} from "$lib/server/services/data-sources.js";
import { youtubeChannelAdapterCore as adapter } from "../adapter.js";

type BackfillFlow = "initial" | "incremental" | "historical" | "auto_passive";

interface BackfillUserJob {
  id?: string;
  data: {
    sourceId: string;
    userId: string;
    origin?: "user" | "cron";
    /** Phase 03.0.1 — capped-flow discriminator written into audit metadata.
     *  Default 'incremental' (refresh-content button click). Cron picker sets
     *  'auto_passive'; future PATCH-driven historical pulls send 'historical'. */
    flow?: BackfillFlow;
  };
}

export async function handleBackfillUser(job: BackfillUserJob): Promise<void> {
  const { sourceId, userId } = job.data;
  // Phase 03.0.1 (post-review) — flow may upgrade from 'incremental' to
  // 'historical' below if computeSinceForRefresh returns oldSide work
  // (user expanded backfill_target_since past the frontier). Cap query
  // counts both flows equally; the distinction is for forensic semantics
  // ("user explicitly extended back-window vs default catch-up").
  let flow: BackfillFlow = job.data.flow ?? "incremental";

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

  // Phase 03.0.1 — compute catch-up boundaries.
  // newSide = MAX(events.occurred_at) for new content above latest.
  // oldSide = backfill_target_since when frontier hasn't reached target.
  // pollContent(since=deepest) covers both via one paginated walk; uploads
  // playlist DESC ordering means newer events come back first (latest-priority
  // ordering preserved when cap or batch limit cuts pull short).
  const [latestRow] = await db
    .select({ at: max(events.occurredAt) })
    .from(events)
    .where(
      and(eq(events.userId, userId), eq(events.sourceId, source.id), isNull(events.deletedAt)),
    );
  const latestEventOccurredAt = latestRow?.at ?? null;
  const { newSide, oldSide } = computeSinceForRefresh(source, latestEventOccurredAt);
  const since = oldSide ?? newSide;

  // Phase 03.0.1 (post-review) — wire 'historical' flow.
  // When oldSide !== null, this pull goes past the frontier into user-extended
  // back-window territory. Upgrade 'incremental' (default for refresh-content)
  // to 'historical' so audit metadata distinguishes the two. Other flows
  // ('auto_passive', 'initial', 'historical' if endpoint already specified it)
  // keep their declared value.
  if (flow === "incremental" && oldSide !== null) {
    flow = "historical";
  }

  if (since === null) {
    // Caught up — no work needed.
    await markSourceLastPolledAt(userId, source.id);
    await writeBackfillAudit({
      job,
      flow,
      sourceId: source.id,
      sourceKind: source.kind,
      userId,
      requestsUsed: 0,
      eventsInserted: 0,
    });
    logger.info(
      { jobId: job.id, sourceId, userId, flow },
      "youtube.backfill.user: caught up — no pull needed",
    );
    return;
  }

  let pollResult: {
    events: {
      externalId?: string;
      occurredAt: Date;
      title: string;
      url: string;
      metadata?: Record<string, unknown>;
    }[];
    unitsUsed: number;
  };
  try {
    pollResult = await adapter.pollContent(
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

  // Empty HTTP-200 success = platform confirmed no more events since `since`.
  // Mark backfill_complete so auto-cron skips this source on subsequent ticks
  // (until user explicitly resets via refresh-content trust-but-verify).
  //
  // INVARIANT (post-review Issue 6 — fragility flagged): empty result is
  // safe to interpret as «backfill complete» REGARDLESS of which side
  // computeSinceForRefresh used because oldSide===null implies «no historical
  // work to do» (target null OR frontier already past target OR complete
  // already true). Empty result with oldSide!==null means we walked all the
  // way back to target_since with zero new events — also legitimate complete.
  // If a future refactor decouples oldSide from the «has historical work»
  // signal, ветвь this on (oldSide !== null) explicitly to preserve intent.
  if (pollResult.events.length === 0) {
    await markSourceBackfillComplete(userId, source.id);
    await markSourceLastPolledAt(userId, source.id);
    await writeBackfillAudit({
      job,
      flow,
      sourceId: source.id,
      sourceKind: source.kind,
      userId,
      // Adapter reports exact units burned (Phase 03.0.1 post-review #6).
      requestsUsed: pollResult.unitsUsed,
      eventsInserted: 0,
    });
    logger.info(
      { jobId: job.id, sourceId, userId, flow },
      "youtube.backfill.user: empty result — backfill marked complete",
    );
    return;
  }

  // Auto-import idempotency: pre-INSERT SELECT scoped by (userId, sourceId,
  // kind=youtube_video, externalId IN ...). Matches channel-context-backfill
  // (Phase 3.0 post-build review 2026-05-07) — a re-click within the same
  // window is a no-op at row level, and a manual paste of the same video
  // (sourceId=NULL) doesn't block the auto-import event.
  const externalIds = pollResult.events
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

  // Phase 03.0.1 — auto_passive flow honors source.autoImport (cron passive
  // backfill = cache hydration only when user opted out of feed events).
  // User-driven flows (initial / incremental / historical) ALWAYS INSERT —
  // explicit click overrides the passive setting.
  const insertUserEvents = flow !== "auto_passive" || source.autoImport;

  const authorIsMe = source.isOwnedByMe;
  let inserted = 0;
  let oldestInsertedOccurredAt: Date | null = null;

  for (const ev of pollResult.events) {
    if (ev.externalId && existingIds.has(ev.externalId)) continue;
    if (insertUserEvents) {
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
      if (oldestInsertedOccurredAt === null || ev.occurredAt < oldestInsertedOccurredAt) {
        oldestInsertedOccurredAt = ev.occurredAt;
      }
    }
  }

  // Update frontier — moves deeper only if oldest inserted is older than current.
  if (oldestInsertedOccurredAt !== null) {
    if (
      source.backfillOldestAt === null ||
      oldestInsertedOccurredAt.getTime() < source.backfillOldestAt.getTime()
    ) {
      await markSourceBackfillFrontier(userId, source.id, oldestInsertedOccurredAt);
    }
  }

  await markSourceLastPolledAt(userId, source.id);

  // Phase 03.0.1 post-review #6 — exact unitsUsed from adapter. Pre-fix
  // the worker estimated `Math.ceil(events.length / 50)` which assumed
  // every adapter does single-page YouTube playlistItems.list (50/page).
  // For YouTube today this estimate happens to match (single page = 1
  // unit), but Reddit / Twitter pollContent may paginate internally and
  // their actual page sizes differ. Trusting the adapter's reported
  // unitsUsed makes the cap counter exact regardless of platform shape.
  await writeBackfillAudit({
    job,
    flow,
    sourceId: source.id,
    sourceKind: source.kind,
    userId,
    requestsUsed: pollResult.unitsUsed,
    eventsInserted: inserted,
  });

  logger.info(
    {
      jobId: job.id,
      sourceId,
      userId,
      flow,
      candidates: pollResult.events.length,
      inserted,
      requestsUsed: pollResult.unitsUsed,
    },
    "youtube.backfill.user: complete",
  );
}

/**
 * Write the post-completion audit row for a backfill action.
 *
 * Action verb stays `source.refresh_content_requested` (existing pgEnum value
 * shared with the endpoint's intent-row). Worker row is distinguished by
 * non-zero `events_inserted` / `requests_used` and the new `flow` field —
 * cap query in services/quota.ts filters `metadata->>'flow' IN (...)` so it
 * counts ONLY worker-completion rows, not pre-enqueue intent rows.
 *
 * Tenant scope: every metadata field tied to userId — no cross-tenant leak.
 * IP: '0.0.0.0' (worker context — no real IP). User-driven actions store
 * real IP via the endpoint's pre-enqueue intent row.
 */
async function writeBackfillAudit(args: {
  job: BackfillUserJob;
  flow: BackfillFlow;
  sourceId: string;
  sourceKind: string;
  userId: string;
  requestsUsed: number;
  eventsInserted: number;
}): Promise<void> {
  await writeAudit({
    userId: args.userId,
    action: "source.refresh_content_requested",
    ipAddress: "0.0.0.0",
    metadata: {
      source_id: args.sourceId,
      kind: args.sourceKind,
      // Phase 03.0.1 (post-review) — explicit `platform` field for cap query.
      // For source-scoped audit verbs `kind` and `platform` carry the same
      // value, but the cap query relies on the dedicated `platform` field
      // to stay consistent across event-scoped verbs (event.poll_refreshed)
      // where `kind` carries event-kind not source-kind.
      platform: args.sourceKind,
      flow: args.flow,
      queue: "youtube.backfill.user",
      job_id: args.job.id ?? null,
      requests_used: args.requestsUsed,
      events_inserted: args.eventsInserted,
    },
  });
}
