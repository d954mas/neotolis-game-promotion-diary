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

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { dataSources } from "$lib/server/db/schema/data-sources.js";
import { logger } from "$lib/server/logger.js";
import { QUEUES } from "$lib/server/queues.js";
import { youtubeObservability } from "../observability.js";
import type { MinimalBoss } from "$lib/sources/adapter.js";

/** Cron pool usage threshold above which auto-backfill defers tick.
 *  Lower priority than cold poll (skip ≥0.80) and active poll (skip ≥0.95).
 *
 *  IMPORTANT: this is a FRACTION (0..1) matching `pctOfDaily` shape returned
 *  by `observability.quota.getDailyStats` (see adapter.ts ObservabilityDailyStats
 *  jsdoc). Pre-fix the constant was `50` and the comparison `pctOfDaily >= 50`
 *  never fired (max real fraction value is 1.0 < 50). Post-fix the gate
 *  actually defers ticks when operator quota is half-spent. */
const SKIP_THRESHOLD_FRACTION = 0.5;

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
  // Priority gate — defer tick when overall operator quota under load.
  //
  // Phase 03.0.1 (post-review) — `pctOfDaily` aggregates ALL keys × ALL pools
  // (cron 80% reservation + user 20% reservation hit the same
  // `youtube_service_quota_usage` rows). The threshold being 50% means «if
  // ANY portion of operator's daily budget is half-spent, auto-backfill
  // cedes». This is over-cautious vs. cron-pool-only check (50% cron + 0%
  // user is 62.5% of cron's slice, but 50% operator-wide) — that's
  // intentional: auto-backfill is the LOWEST priority work and should yield
  // first under contention. Comment fix from pre-review «cron pool ≥50%»
  // wording — the actual semantics are operator-wide.
  const stats = await youtubeObservability.quota.getDailyStats(new Date());
  if (stats.pctOfDaily >= SKIP_THRESHOLD_FRACTION) {
    logger.info(
      { jobId: job.id, pctOfDaily: stats.pctOfDaily, threshold: SKIP_THRESHOLD_FRACTION },
      "youtube.auto_backfill_cron: operator quota under load, deferring this tick",
    );
    return;
  }

  // Picker — incomplete sources, soft-deleted excluded, oldest-poll-first.
  //
  // CROSS-TENANT BY DESIGN (D-11 scheduler fan-out). This SELECT
  // INTENTIONALLY walks all users' incomplete sources to enqueue passive
  // backfill jobs. The worker handler downstream re-applies tenant scope
  // via getSourceById(userId, sourceId) on each enqueued job, so cross-
  // tenant fan-out at the picker level is the correct architectural
  // primitive.
  //
  // Fairness ordering — Phase 03.0.1 (post-review fourth-pass): pre-fix
  // was `ORDER BY user_id ASC, last_polled_at ASC NULLS FIRST` which
  // sorted by tenant FIRST. The user whose UUID sorted first and had >50
  // incomplete sources occupied the entire daily batch; later users
  // never received cron-driven backfill. Now: drop user_id from the sort
  // entirely — global oldest-poll-first wins. This is naturally fair on
  // a per-source basis: if user A has 1000 incomplete sources at
  // T-1d and user B has 1 incomplete source at T-1d+1m, user A wins this
  // tick (older), but once A's sources advance to today, B's becomes
  // the oldest and wins next tick. Power users (more sources = more
  // catch-up work) consume proportionally more cron budget — correct
  // semantics, not a fairness violation.
  //
  // NULLS FIRST — newly-onboarded sources (last_polled_at IS NULL) are
  // always the highest-priority pick. Ensures bootstrap walk happens
  // before any incremental refreshes.
  //
  // P2-3 (post-review) — also excludes needsReconnect sources so broken
  // adapters don't burn cron pool on guaranteed-failing polls.
  //
  // Tenant-scope ESLint disable — this query is intentionally cross-tenant
  // (D-11 scheduler fan-out, see comment block above). The previous version
  // happened to satisfy the loose regex via `asc(dataSources.userId)` in
  // the orderBy; removing that for fairness exposed the rule. The worker
  // handler downstream re-applies tenant scope per job.
  // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query
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
        eq(dataSources.needsReconnect, false),
        isNull(dataSources.deletedAt),
        // Only kinds with adapters that support backfill — youtube_channel today;
        // Phase 03.1+ adds reddit_account when registered. Filter at SQL level
        // avoids enqueueing jobs that the worker would no-op anyway.
        sql`${dataSources.kind} = 'youtube_channel'`,
      ),
    )
    .orderBy(sql`${dataSources.lastPolledAt} ASC NULLS FIRST`)
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
        // Phase 03.0.1 (post-review P2-4) — singletonSeconds=3600 for
        // dedup beyond active state. Pre-fix singletonKey alone deduped
        // jobs only while the prior was active/queued; if the scheduler
        // restarted within the cron tick interval, a second tick within
        // the dedup window could double-enqueue the same source. 1h
        // window covers worst-case scheduler-restart cycles for the
        // daily 03:00 PT cron.
        { singletonKey: `auto-backfill-${src.id}`, singletonSeconds: 3600, priority: 0 },
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
