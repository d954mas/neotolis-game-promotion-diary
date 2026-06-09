// telegram.poll.cron handler — the tier dispatcher + the active/cold listing
// picker (mirrors youtube/handlers/auto-backfill-cron.ts +
// reddit/handlers/enqueue-service-sources-cron.ts: the cross-tenant picker +
// dispatcher live in handlers/, the barrel only wires them onto the queue).
//
// Two exports:
//   - handleTelegramPollCron     — dispatches on job.data.tier. ZERO t.me HTTP.
//       tier='warm'          → handleTelegramWarmRefresh (a DIFFERENT op: the
//                              per-post ?embed=1 producer, NOT the page-1 walk),
//                              so it branches BEFORE the listing picker.
//       tier='active'|'cold' → enqueueServiceListingPolls (one service_source
//                              listing_poll lane row per subscribed channel).
//   - enqueueServiceListingPolls — the cross-tenant picker + skip-if-pending
//       dedup. Exported for the cron-picker integration test (mirrors the other
//       adapters' exported cron handlers). user_id=NULL → cron-pool (cap-exempt).
//
// The cron does ZERO t.me HTTP — it only INSERTs adapter_refresh_queue rows; the
// Telegram lane batch-worker drains them through the global pacer.

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { dataSources } from "$lib/server/db/schema/data-sources.js";
import { adapterRefreshQueue } from "$lib/server/db/schema/index.js";
import { logger } from "$lib/server/logger.js";
import { handleTelegramWarmRefresh } from "./warm-refresh.js";

const KIND = "telegram_channel" as const;

interface TelegramSourceMetadata {
  channel?: string;
}

/** Resolve the channel slug from a source's metadata (the URL-intrinsic handle
 *  injected by normalizeSourceOnCreate — the safe-denorm provider key). Returns
 *  null for a malformed row (defensive; createSource always sets metadata.channel). */
function channelOf(metadata: Record<string, unknown>): string | null {
  const md = (metadata ?? {}) as TelegramSourceMetadata;
  return typeof md.channel === "string" && md.channel !== "" ? md.channel : null;
}

/** poll.cron handler — dispatches on job.data.tier. ZERO t.me HTTP. */
export async function handleTelegramPollCron(job: {
  id?: string;
  data: { tier: "active" | "cold" | "warm" };
}): Promise<void> {
  const tier = job.data.tier;

  // Warm runs FIRST and is a DIFFERENT operation (per-post ?embed=1 producer,
  // NOT the page-1 listing walk), so it branches before the listing picker.
  if (tier === "warm") {
    await handleTelegramWarmRefresh({ id: job.id });
    return;
  }

  // active / cold: enqueue one service_source listing_poll lane row per
  // subscribed channel. The picker selects DISTINCT channels from
  // auto-import-enabled, non-deleted telegram_channel sources. Cron does ZERO
  // t.me HTTP — it only INSERTs lane rows; the lane worker fetches.
  await enqueueServiceListingPolls(tier, job.id);
}

/** Picker + enqueue: one service_source listing_poll row per distinct channel
 *  with an active auto-import telegram_channel source. user_id=NULL → cron-pool
 *  (cap-exempt). Skip-if-pending dedup keeps a channel from piling up if the
 *  prior tick's row hasn't drained — AND skips a channel with an in-flight
 *  backfill_page so the walker (not the listing-poll) materializes its pages (A2).
 *
 *  Exported for the cron-picker integration test (mirrors the other adapters'
 *  exported cron handlers). */
export async function enqueueServiceListingPolls(
  tier: "active" | "cold",
  jobId: string | undefined,
): Promise<number> {
  // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- cron picker is service-wide: it enqueues ONE listing poll per channel across ALL tenants (one fetch serves every subscriber); the per-channel lane row is user_id=NULL cron-pool work.
  const sourceRows = await db
    .selectDistinct({ metadata: dataSources.metadata })
    .from(dataSources)
    .where(
      and(
        eq(dataSources.kind, KIND),
        eq(dataSources.autoImport, true),
        isNull(dataSources.deletedAt),
      ),
    );
  const channels = [
    ...new Set(
      sourceRows
        .map((r) => channelOf((r.metadata ?? {}) as Record<string, unknown>))
        .filter((c): c is string => c !== null),
    ),
  ];
  if (channels.length === 0) {
    logger.debug({ jobId, tier }, "telegram.poll.cron: no auto-import channels to enqueue");
    return 0;
  }

  let enqueued = 0;
  for (const channel of channels) {
    // Skip-if-pending dedup (A2): don't enqueue a listing_poll for a channel that
    // ALREADY has a listing_poll OR a backfill_page in flight. The backfill
    // walker materializes feed events from its own pages (initial + historical);
    // a concurrent listing_poll on the same window would fetch + materialize the
    // SAME newest page → double-fanning the newest posts on onboarding. By
    // excluding any in-flight backfill_page (on EITHER lane — onboarding lands on
    // user_source, continuations on service_source), exactly ONE site
    // materializes a channel per window: the walker until backfill completes,
    // then the listing-poll for steady-state. (A second listing_poll is also
    // skipped — the original page-1 dedup.)
    // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- service_source lane scan: the cron picker writes user_id=NULL listing rows keyed by channel slug across ALL tenants (one fetch serves every subscriber); tenant scope does not apply.
    const existing = await db
      .select({ id: adapterRefreshQueue.id })
      .from(adapterRefreshQueue)
      .where(
        and(
          eq(adapterRefreshQueue.adapterKind, KIND),
          sql`${adapterRefreshQueue.type} IN ('listing_poll','backfill_page')`,
          sql`${adapterRefreshQueue.status} IN ('pending','processing')`,
          sql`${adapterRefreshQueue.payload}->>'channel' = ${channel}`,
        ),
      )
      .limit(1);
    if (existing.length > 0) continue;
    await db.insert(adapterRefreshQueue).values({
      adapterKind: KIND,
      queueName: "service_source",
      type: "listing_poll",
      payload: { channel },
      userId: null,
      priority: 0,
    });
    enqueued += 1;
  }
  logger.info(
    { jobId, tier, channels: channels.length, enqueued },
    "telegram.poll.cron: service_source listing_poll rows enqueued",
  );
  return enqueued;
}
