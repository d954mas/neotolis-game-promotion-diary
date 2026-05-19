// APP_ROLE=scheduler entrypoint.
//
// Adapter-driven cron registration: the scheduler iterates `allAdapters`
// from src/lib/sources/registry.ts and calls `adapter.scheduleCronTicks(boss)`
// for each per-kind set. Adding a new source (e.g. Reddit) means adding the
// adapter to the registry; the scheduler edits to zero.
//
// Each adapter owns the schedules for its per-kind queues:
//   - youtubeAdapter.scheduleCronTicks registers:
//       youtube.poll.cron (key=active, every 6h UTC)
//       youtube.poll.cron (key=cold, daily 5am Pacific)
//       youtube.quota_reset (daily midnight Pacific)
//       youtube.rehab (weekly Sun 4am Pacific)
//
// Cross-source / non-per-kind schedules stay in this file because they
// apply regardless of source kind:
//   - internal.healthcheck (every 5 minutes)
//   - purge.daily (4 AM Pacific — after backup at 03:00 Pacific so soft-
//     deleted accounts being hard-deleted are still in the night's backup)
//
// tz-aware Pacific schedules MUST use the {tz} option so pg-boss handles
// DST transitions — never hard-code the UTC offset.
//
// SIGTERM drain: stopBoss + pool.end.

import { createBoss, stopBoss } from "../lib/server/queue-client.js";
import { pool } from "../lib/server/db/client.js";
import { logger } from "../lib/server/logger.js";
import { QUEUES } from "../lib/server/queues.js";
import { scrubKekFromEnv } from "../lib/server/config/env.js";
import { allAdapters } from "../lib/sources/registry.js";

export async function startScheduler(): Promise<void> {
  const boss = await createBoss();
  scrubKekFromEnv();

  // Internal healthcheck schedule.
  try {
    await boss.schedule(QUEUES.INTERNAL_HEALTHCHECK, "*/5 * * * *");
  } catch (err) {
    logger.error({ err }, "failed to register internal.healthcheck schedule");
    throw err;
  }

  // Per-kind cron schedules owned by each adapter. Iterate registration
  // order from registry.ts (today: youtube + reddit. Reddit registers
  // 4 daily cron schedules via redditAdapter.scheduleCronTicks per
  // D-RDT-CRON-BURST: enqueue-service-sources 00/06/12/18 UTC,
  // enqueue-service-posts 03/09/15/21 UTC, baselines 04 UTC,
  // deletion-propagation 05 UTC).
  for (const adapter of allAdapters) {
    try {
      await adapter.scheduleCronTicks(boss);
    } catch (err) {
      logger.error({ err, kind: adapter.kind }, "failed to register adapter scheduleCronTicks");
      throw err;
    }
  }

  // Cross-source / non-per-kind schedules — apply across all sources.

  // purge.daily — 4 AM Pacific (after backup at 03:00 Pacific).
  // listPurgeEligibleUsers + purgeAccount cascade.
  await boss.schedule(QUEUES.PURGE_DAILY, "0 4 * * *", {}, { tz: "America/Los_Angeles" });

  // adapter_refresh_queue janitor — 06:30 UTC daily. Sits between the
  // Reddit service-source cron at 06:00 UTC (which INSERTs `pending`
  // rows) and the next cron tick. DELETE only `done`/`dead_letter`
  // rows older than the retention window, so the janitor + cron touch
  // disjoint status rows anyway — the 30-min stagger is belt-and-braces.
  await boss.schedule(QUEUES.ADAPTER_REFRESH_QUEUE_JANITOR, "30 6 * * *", {}, { tz: "UTC" });

  logger.info(
    {
      schedules: [
        QUEUES.INTERNAL_HEALTHCHECK,
        // Per-kind schedules registered by adapter.scheduleCronTicks above
        // — the names are owned by each per-source barrel; we don't
        // enumerate them here to keep the source of truth in one place.
        ...allAdapters.map((a) => `<${a.kind} adapter>`),
        QUEUES.PURGE_DAILY,
      ],
    },
    "scheduler registered cron schedules (adapter-driven)",
  );

  // Smoke assertion — exact string `scheduler ready` on stdout.
  logger.info({ role: "scheduler" }, "scheduler ready");
  console.log("scheduler ready");

  // Graceful shutdown.
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "scheduler received shutdown signal");
    try {
      await stopBoss(boss);
    } catch (err) {
      logger.warn({ err }, "pg-boss stop failed");
    }
    try {
      await pool.end();
    } catch (err) {
      logger.warn({ err }, "pool.end failed");
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  return new Promise<void>(() => {
    /* never resolves — process lives until SIGTERM */
  });
}
