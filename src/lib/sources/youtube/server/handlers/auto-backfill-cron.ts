// Phase 03.0.1 — auto-backfill daily cron handler.
//
// Picks up incomplete sources (backfill_complete=false) and enqueues passive
// backfill jobs into youtube.backfill.user (with metadata.flow='auto_passive').
// Worker handler distinguishes auto_passive из user-initiated flows:
//   - cache hydration в shared youtube_videos table (always — benefit для всей
//     системы; future paste from другого user'а получает cache hit).
//   - per-user events INSERT only when source.auto_import = true (user opted
//     in to passive feed updates). При auto_import=false — pure cache work.
//
// Schedule: 03:00 Pacific daily — 3 hours after operator's reservoir reset
// at 00:00 PT (Plan 08 quota.ts:resetReservoirsOnBoot). Pool fresh; minimal
// contention с active poll cron (every 6h UTC) и cold poll cron (5am PT).
//
// Priority gate: skip the entire tick when cron pool ≥50% used. This is
// lower priority than cold poll (skip ≥80%) and active poll (skip ≥95%) —
// stats polling protects freshness of existing видео; auto-backfill только
// добавляет историческую глубину. На contention auto-backfill steps aside
// first.
//
// Picker:
//   SELECT * FROM data_sources
//   WHERE backfill_complete = false
//     AND deleted_at IS NULL
//   ORDER BY user_id, last_polled_at NULLS FIRST
//   LIMIT 50;
//
// Per-user round-robin fairness: ORDER BY (user_id, last_polled_at NULLS
// FIRST) gives each user equal chance — user A с 1 source vs user B с 100
// sources gets each up to 1 visit per tick (LIMIT 50 = up to 50 distinct
// users если каждому по 1 source). User'у с 100 sources visits one per
// day (round-robin).
//
// Идемпотентность: enqueue с singletonKey=`auto-backfill-${sourceId}` —
// pg-boss дедупит per-source если cron tick двойной trigger. Job обрабатывается
// в общей backfill-user queue с priority=0 (lowest); user-driven jobs
// priority=1 идут вперёд.

import { and, eq, isNull, asc, sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { dataSources } from "$lib/server/db/schema/data-sources.js";
import { logger } from "$lib/server/logger.js";
import { QUEUES } from "$lib/server/queues.js";
import { youtubeObservability } from "../observability.js";
import type { MinimalBoss } from "$lib/sources/adapter.js";

/** Cron pool usage threshold above which auto-backfill defers tick.
 *  Lower priority than cold poll (skip ≥80%) and active poll (skip ≥95%). */
const SKIP_THRESHOLD_PCT = 50;

/** Maximum sources picked per cron tick. Each enqueues один backfill-user job;
 *  worker processes serially. Bounded picker keeps round-robin fair across
 *  users with many incomplete sources. */
const MAX_PICK = 50;

interface AutoBackfillCronJob {
  id: string;
  data: object;
}

export async function handleAutoBackfillCron(
  job: AutoBackfillCronJob,
  boss: MinimalBoss,
): Promise<void> {
  // Priority gate — defer tick when cron pool под нагрузкой.
  const stats = await youtubeObservability.quota.getDailyStats(new Date());
  if (stats.pctOfDaily >= SKIP_THRESHOLD_PCT) {
    logger.info(
      { jobId: job.id, pctOfDaily: stats.pctOfDaily, threshold: SKIP_THRESHOLD_PCT },
      "youtube.auto_backfill_cron: cron pool busy, deferring this tick",
    );
    return;
  }

  // Picker — incomplete sources, soft-deleted excluded, per-user round-robin.
  const candidates = await db
    .select({
      id: dataSources.id,
      userId: dataSources.userId,
      kind: dataSources.kind,
    })
    .from(dataSources)
    .where(
      and(
        eq(dataSources.backfillComplete, false),
        isNull(dataSources.deletedAt),
        // Only kinds with adapters that support backfill — youtube_channel today;
        // Phase 03.1+ adds reddit_account when registered. Filter at SQL level
        // avoids enqueueing jobs that the worker would no-op anyway.
        sql`${dataSources.kind} = 'youtube_channel'`,
      ),
    )
    .orderBy(asc(dataSources.userId), sql`${dataSources.lastPolledAt} ASC NULLS FIRST`)
    .limit(MAX_PICK);

  if (candidates.length === 0) {
    logger.info(
      { jobId: job.id },
      "youtube.auto_backfill_cron: no incomplete sources to pick — all caught up",
    );
    return;
  }

  let enqueued = 0;
  for (const src of candidates) {
    try {
      await boss.send(
        QUEUES.YOUTUBE_BACKFILL_USER,
        { sourceId: src.id, userId: src.userId, origin: "cron", flow: "auto_passive" },
        { singletonKey: `auto-backfill-${src.id}`, priority: 0 },
      );
      enqueued += 1;
    } catch (err) {
      logger.warn(
        { jobId: job.id, sourceId: src.id, err: String((err as Error)?.message ?? err) },
        "youtube.auto_backfill_cron: enqueue failed for source; continuing",
      );
    }
  }

  logger.info(
    {
      jobId: job.id,
      pctOfDaily: stats.pctOfDaily,
      candidates: candidates.length,
      enqueued,
    },
    "youtube.auto_backfill_cron: tick complete",
  );
}
