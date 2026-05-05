// Phase 3.0 Plan 09 — scheduler enqueue logic.
//
// The scheduler is the SINGLE process that decides "what's due to poll".
// Workers consume jobs blind — they trust the eventIds payload and run.
// This module owns the SQL window + tier-resolver gate + throttle gate.
//
// Pitfall 7 (single source of truth): tier classification flows through
// resolveTier() — never re-derive the 24h / 28d / Unavailable boundaries
// here. The SQL filter is a coarse first-cut (date arithmetic on
// occurred_at + last_polled_at); the JS filter via resolveTier is the
// authoritative classification.
//
// Throttle gate (Pattern 4):
//   - At getThrottleState() === 'eighty':
//       Cold + auto-import paused; Active continues.
//   - At getThrottleState() === 'ninetyfive':
//       Cold + Active paused; refresh-now (poll.user, set by route
//       layer in services/refresh-poll.ts) continues regardless.
//
// Two enqueue functions: enqueueActivePolls + enqueueColdPolls. Both are
// invoked by the scheduler-tick handlers in src/scheduler/index.ts via
// the scheduler.tick.active / scheduler.tick.cold queues.
//
// Manual paste (events.source_id IS NULL) is ALWAYS pollable — the user
// pasted a URL with intent. Auto-import (events.source_id IS NOT NULL)
// requires data_sources.auto_import = true on the parent source.

import { sql, and, eq, gt, isNotNull, isNull, lte, or } from "drizzle-orm";
import { db } from "../lib/server/db/client.js";
import { events } from "../lib/server/db/schema/events.js";
import { dataSources } from "../lib/server/db/schema/data-sources.js";
import {
  resolveTier,
  TIER_BOUNDARY_ACTIVE_MS,
  TIER_BOUNDARY_COLD_MS,
} from "../lib/server/services/tier-resolver.js";
import {
  getThrottleState,
  markThrottleTransition,
  THROTTLE_EIGHTY_THRESHOLD,
} from "../lib/server/services/youtube-quota-tracker.js";
import { QUEUES } from "../lib/server/queues.js";
import { getBoss } from "../lib/server/queue-client.js";
import { logger } from "../lib/server/logger.js";

// pg-boss send batch boundary — videos.list batches at 50 video ids per
// HTTP call (1 quota unit per call regardless of id count up to 50, per
// Plan 03.0-01 spike). Match the batch boundary so the worker can issue
// one HTTP call per job.
const ENQUEUE_BATCH_SIZE = 50;

interface EnqueueResult {
  /** 'ok' | 'eighty' | 'ninetyfive' — observed throttle state at tick start. */
  throttleState: string;
  /** True if the throttle gate caused this enqueue to skip entirely. */
  skipped: boolean;
  /** Number of jobs actually enqueued (each carries up to ENQUEUE_BATCH_SIZE event ids). */
  jobsEnqueued: number;
  /** Number of events covered across all enqueued jobs. */
  eventsCovered: number;
}

/**
 * Active-tier scheduled poll (every 6 hours UTC default — see scheduler/index.ts).
 *
 * Picks events with occurredAt < 24h ago (Active tier per D-05), excludes
 * Unavailable last_poll_status values (D-12), and enqueues batches to
 * POLL_ACTIVE for the worker to process.
 *
 * Throttle gate: pauses at ninetyfive only. eighty leaves Active running
 * (the user-time-budget protection only kicks in at the hard ceiling).
 */
export async function enqueueActivePolls(now: Date = new Date()): Promise<EnqueueResult> {
  const throttle = await getThrottleState(now);
  if (throttle === "ninetyfive") {
    logger.info({ throttle }, "scheduler skip Active — quota at 95%");
    return { throttleState: throttle, skipped: true, jobsEnqueued: 0, eventsCovered: 0 };
  }
  if (throttle === "eighty") {
    // First crossing → emit audit row. markThrottleTransition is idempotent
    // per (date_pacific, state) so daily-fire only.
    try {
      await markThrottleTransition({
        state: "eighty",
        apiKeyId: "scheduler-tick",
        estimatedUnits: THROTTLE_EIGHTY_THRESHOLD,
      });
    } catch (err) {
      logger.warn({ err }, "scheduler: markThrottleTransition (eighty) failed");
    }
  }

  // SQL coarse-filter: events of pollable kind, with externalId, not soft-
  // deleted, occurredAt within the Active window. JS resolveTier filter
  // refines below.
  const cutoff = new Date(now.getTime() - TIER_BOUNDARY_ACTIVE_MS);
  const rows = await db
    .select({
      id: events.id,
      userId: events.userId,
      occurredAt: events.occurredAt,
      lastPollStatus: events.lastPollStatus,
      sourceId: events.sourceId,
    })
    .from(events)
    .where(
      and(
        sql`${events.kind} = 'youtube_video'`,
        gt(events.occurredAt, cutoff),
        isNotNull(events.externalId),
        isNull(events.deletedAt),
      ),
    );

  // Resolve tier per row (defense-in-depth — SQL window is a superset).
  const activeRows = rows.filter(
    (r) => resolveTier(r.occurredAt, r.lastPollStatus, now) === "active",
  );

  // Auto-import gating: events with source_id NOT NULL require the parent
  // data_source's auto_import = true. Manual paste (source_id IS NULL) is
  // always pollable — the user explicitly pasted the URL.
  const sourceIds = Array.from(
    new Set(activeRows.map((r) => r.sourceId).filter((s): s is string => s !== null)),
  );
  const autoImportSourceIds = new Set<string>();
  if (sourceIds.length > 0) {
    const sourceRows = await db
      .select({ id: dataSources.id, autoImport: dataSources.autoImport })
      .from(dataSources)
      .where(
        and(
          sql`${dataSources.id} IN (${sql.join(
            sourceIds.map((sid) => sql`${sid}`),
            sql`, `,
          )})`,
          isNull(dataSources.deletedAt),
        ),
      );
    for (const s of sourceRows) {
      if (s.autoImport) autoImportSourceIds.add(s.id);
    }
  }
  const eligible = activeRows.filter(
    (r) => r.sourceId === null || autoImportSourceIds.has(r.sourceId),
  );

  if (eligible.length === 0) {
    return { throttleState: throttle, skipped: false, jobsEnqueued: 0, eventsCovered: 0 };
  }

  const boss = await getBoss();
  let jobsEnqueued = 0;
  for (let i = 0; i < eligible.length; i += ENQUEUE_BATCH_SIZE) {
    const batch = eligible.slice(i, i + ENQUEUE_BATCH_SIZE).map((e) => e.id);
    await boss.send(
      QUEUES.POLL_ACTIVE,
      { eventIds: batch },
      {
        // singletonKey scopes coalescing per minute — a redundant tick within
        // the same minute (e.g. duplicate scheduler boot) collapses to one
        // job at the queue level.
        singletonKey: `active-${now.toISOString().slice(0, 16)}-${i}`,
      },
    );
    jobsEnqueued += 1;
  }
  logger.info(
    { throttle, jobsEnqueued, eventsCovered: eligible.length },
    "scheduler enqueueActivePolls: sent batches to POLL_ACTIVE",
  );
  return {
    throttleState: throttle,
    skipped: false,
    jobsEnqueued,
    eventsCovered: eligible.length,
  };
}

/**
 * Cold-tier scheduled poll (once per day at 5 AM UTC — see scheduler/index.ts).
 *
 * Picks events 24h-28d old (Cold tier per D-05). Throttle gate: pauses at
 * eighty AND ninetyfive — Cold is the first thing to give up on heavy days.
 */
export async function enqueueColdPolls(now: Date = new Date()): Promise<EnqueueResult> {
  const throttle = await getThrottleState(now);
  if (throttle !== "ok") {
    logger.info({ throttle }, "scheduler skip Cold — quota throttled");
    return { throttleState: throttle, skipped: true, jobsEnqueued: 0, eventsCovered: 0 };
  }

  const activeCutoff = new Date(now.getTime() - TIER_BOUNDARY_ACTIVE_MS);
  const coldCutoff = new Date(now.getTime() - TIER_BOUNDARY_COLD_MS);
  // Cold window: occurredAt is between (now - 28d) and (now - 24h).
  const rows = await db
    .select({
      id: events.id,
      userId: events.userId,
      occurredAt: events.occurredAt,
      lastPollStatus: events.lastPollStatus,
      sourceId: events.sourceId,
    })
    .from(events)
    .where(
      and(
        sql`${events.kind} = 'youtube_video'`,
        lte(events.occurredAt, activeCutoff),
        gt(events.occurredAt, coldCutoff),
        isNotNull(events.externalId),
        isNull(events.deletedAt),
      ),
    );

  const coldRows = rows.filter(
    (r) => resolveTier(r.occurredAt, r.lastPollStatus, now) === "cold",
  );

  const sourceIds = Array.from(
    new Set(coldRows.map((r) => r.sourceId).filter((s): s is string => s !== null)),
  );
  const autoImportSourceIds = new Set<string>();
  if (sourceIds.length > 0) {
    const sourceRows = await db
      .select({ id: dataSources.id, autoImport: dataSources.autoImport })
      .from(dataSources)
      .where(
        and(
          sql`${dataSources.id} IN (${sql.join(
            sourceIds.map((sid) => sql`${sid}`),
            sql`, `,
          )})`,
          isNull(dataSources.deletedAt),
        ),
      );
    for (const s of sourceRows) {
      if (s.autoImport) autoImportSourceIds.add(s.id);
    }
  }
  const eligible = coldRows.filter(
    (r) => r.sourceId === null || autoImportSourceIds.has(r.sourceId),
  );

  if (eligible.length === 0) {
    return { throttleState: throttle, skipped: false, jobsEnqueued: 0, eventsCovered: 0 };
  }

  const boss = await getBoss();
  let jobsEnqueued = 0;
  for (let i = 0; i < eligible.length; i += ENQUEUE_BATCH_SIZE) {
    const batch = eligible.slice(i, i + ENQUEUE_BATCH_SIZE).map((e) => e.id);
    await boss.send(
      QUEUES.POLL_COLD,
      { eventIds: batch },
      {
        singletonKey: `cold-${now.toISOString().slice(0, 13)}-${i}`,
      },
    );
    jobsEnqueued += 1;
  }
  logger.info(
    { throttle, jobsEnqueued, eventsCovered: eligible.length },
    "scheduler enqueueColdPolls: sent batches to POLL_COLD",
  );
  return {
    throttleState: throttle,
    skipped: false,
    jobsEnqueued,
    eventsCovered: eligible.length,
  };
}

// Imports retained for tree-shake clarity; `or` and `eq` may be used by
// future variants of the SQL window.
void or;
void eq;
