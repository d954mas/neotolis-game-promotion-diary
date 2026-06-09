// Telegram batch-worker tick — the fixed-slot round-robin lane drain.
//
// Mirrors reddit/handlers/worker-tick.ts. Fires every 3s. One tick = at most one
// t.me HTTP call (the claimGate acquires ONE global pacer slot before the row is
// claimed; the dispatched handler issues exactly one fetch). The pacer's
// TELEGRAM_PACER_SLOT_MS (3000ms = 20 req/min in prod) is the load-bearing
// politeness ceiling; this tick interval just matches it.
//
// Slot mapping favors user-driven work (latency-sensitive) over cron work:
//   service_source — cron 6h listing poll + backfill continuations (user_id NULL)
//   user_source    — user-initiated channel refresh / backfill (user_id SET)
//   user_post      — user-initiated per-post Refresh Now (user_id SET)
//   service_post   — cron warm per-post ?embed=1 fetch (user_id NULL)
//
// dispatch routes by rows[0].type:
//   'listing_poll'  (service_source / user_source) → handleTelegramListingPoll
//                    (one channel per fetch — maxBatchSize 1)
//   'backfill_page' (service_source / user_source) → handleTelegramBackfillWalker
//                    (one page per tick)
//   'post_stats'    (service_post / user_post)     → single-post ?embed=1 fetch
//                    → parse → writeTelegramSnapshot
//
// Each lane is maxBatchSize 1: every t.me path is a single-resource GET (one
// listing, one page, one post), and a tick only acquires one pacer slot.

import { eq } from "drizzle-orm";
import { AdapterError } from "$lib/sources/errors.js";
import { db } from "$lib/server/db/client.js";
import { telegramPosts } from "$lib/server/db/schema/index.js";
import { writeAudit } from "$lib/server/audit.js";
import { logger } from "$lib/server/logger.js";
import {
  createAdapterBatchLaneWorker,
  type AdapterLaneClaimGateContext,
  type AdapterLaneClaimGateResult,
  type AdapterLaneDispatchContext,
  type AdapterLaneWorkerRow,
  type AdapterBatchLaneWorkerTickResult,
} from "$lib/server/services/adapter-lane-worker.js";
import { acquireTelegramPacerSlotWith } from "../pacer.js";
import { fetchTelegramPost } from "../http.js";
import { parseTelegramPost } from "../parse.js";
import { writeTelegramSnapshot, type TelegramSnapshotStatus } from "../snapshots.js";
import {
  resolveTelegramOperatorUserId,
  __resetTelegramOperatorIdCacheForTest,
} from "../operator-resolver.js";
import { handleTelegramListingPoll } from "./listing-poll.js";
import { handleTelegramBackfillWalker } from "./backfill-walker.js";

type TelegramPacerPermit = { pacer: "already-acquired" };

export const TELEGRAM_SLOT_MAPPING = [
  "service_source",
  "user_source",
  "user_post",
  "user_source",
  "service_post",
  "user_post",
  "user_source",
  "service_post",
] as const;

export const FALLTHROUGH_ORDER = [
  "user_post",
  "user_source",
  "service_post",
  "service_source",
] as const;

export type TelegramQueueName = (typeof TELEGRAM_SLOT_MAPPING)[number];

const MAX_ATTEMPTS = 5;

/** Stale-processing recovery window — a row stuck in 'processing' longer than
 *  this belongs to a crashed worker and is flipped back to 'pending'. */
const STALE_PROCESSING_MS = 5 * 60_000;
const STALE_RECOVERY_INTERVAL_MS = 60_000;

const telegramLaneWorker = createAdapterBatchLaneWorker<TelegramQueueName, TelegramPacerPermit>({
  adapterKind: "telegram_channel",
  slots: TELEGRAM_SLOT_MAPPING,
  fallthrough: FALLTHROUGH_ORDER,
  maxAttempts: MAX_ATTEMPTS,
  // Every lane is single-row: one t.me GET per tick (one listing / one page /
  // one post), one pacer slot.
  maxBatchSize: 1,
  batchScope: "global",
  staleProcessingMs: STALE_PROCESSING_MS,
  staleRecoveryIntervalMs: STALE_RECOVERY_INTERVAL_MS,
  claimGate: claimTelegramPacerSlot,
  dispatch: dispatchByLane,
  emitDrained(stats) {
    // Fire-and-forget audit row so the /admin/quota Telegram observability
    // (getDailyStats SUMs metadata.entries_processed across
    // audit_log.action='telegram.queue_drained' rows) reflects real lane work.
    // Without this emit the daily Telegram stat + recent-audit feed would stay
    // permanently 0 regardless of worker activity (G1/A1). Best-effort: a
    // failed audit write never blocks the worker. Mirrors reddit emitDrained →
    // emitQueueDrainedAudit.
    void emitQueueDrainedAudit(stats);
  },
});

export async function telegramWorkerTick(): Promise<AdapterBatchLaneWorkerTickResult> {
  return telegramLaneWorker.tick();
}

/** claimGate — acquire ONE global t.me pacer slot inside the claim tx (mirrors
 *  reddit claimRedditPacerSlot). A denied slot defers the row WITHOUT burning an
 *  attempt; a paused adapter (after a 403/429) defers for the pause window. */
async function claimTelegramPacerSlot(
  ctx: AdapterLaneClaimGateContext<TelegramQueueName>,
): Promise<AdapterLaneClaimGateResult<TelegramPacerPermit>> {
  const slot = await acquireTelegramPacerSlotWith(ctx.tx);
  if (slot.acquired) {
    return { action: "run", permit: { pacer: "already-acquired" } };
  }
  return {
    action: "defer",
    retryAfterMs: slot.waitMs,
    reason: slot.paused ? "telegram adapter paused" : "telegram global pacer busy",
  };
}

/** Dispatch claimed rows for the current tick. Every lane is maxBatchSize=1, so
 *  rows always carries exactly one row. Route by type. */
async function dispatchByLane(
  rows: AdapterLaneWorkerRow[],
  ctx: AdapterLaneDispatchContext<TelegramPacerPermit>,
): Promise<void> {
  if (rows.length === 0) return;
  // The claimGate already acquired the global pacer slot for this tick — tell
  // the fetch path NOT to re-acquire (a second acquire would always be denied
  // by the slot just taken, dead-lettering every row). Sync paths default to
  // "acquire".
  const pacer = ctx.permit?.pacer ?? "acquire";
  const first = rows[0]!;

  if (first.type === "listing_poll") {
    const channel = first.payload?.channel as string | undefined;
    if (typeof channel !== "string") {
      throw new AdapterError("listing_poll payload missing 'channel'", { category: "permanent" });
    }
    await handleTelegramListingPoll({ channel, userId: first.userId, pacer });
    return;
  }

  if (first.type === "backfill_page") {
    const channel = first.payload?.channel as string | undefined;
    if (typeof channel !== "string") {
      throw new AdapterError("backfill_page payload missing 'channel'", { category: "permanent" });
    }
    await handleTelegramBackfillWalker({ channel, userId: first.userId, pacer });
    return;
  }

  if (first.type === "post_stats") {
    const postId = first.payload?.post_id as string | undefined;
    if (typeof postId !== "string") {
      throw new AdapterError("post_stats payload missing 'post_id'", { category: "permanent" });
    }
    await handleWarmPostFetch(postId, pacer);
    return;
  }

  throw new AdapterError(`unknown telegram queue row type: ${first.type}`, {
    category: "permanent",
  });
}

/** Resolve the renameable fetch slug + messageId for a channelKey-based post_id
 *  from the stored telegram_posts.external_url (the canonical t.me/<slug>/<id>
 *  link written on every snapshot). The post_id prefix is the rename-proof
 *  channelKey — NOT a t.me path segment — so the slug must come from the cached
 *  URL. Returns null when the post has no cached row / external_url (it can't be
 *  warm-refreshed without a known link). */
async function resolveTelegramFetchTarget(
  postId: string,
): Promise<{ channel: string; messageId: string; externalUrl: string } | null> {
  const [row] = await db
    .select({ externalUrl: telegramPosts.externalUrl })
    .from(telegramPosts)
    .where(eq(telegramPosts.postId, postId))
    .limit(1);
  const externalUrl = row?.externalUrl ?? null;
  if (externalUrl === null) return null;
  // external_url is t.me/<slug>/<messageId> — pull the trailing slug/messageId.
  const m = /\/([A-Za-z0-9_]+)\/(\d+)\/?$/.exec(externalUrl);
  if (m === null) return null;
  return { channel: m[1]!, messageId: m[2]!, externalUrl };
}

/** Single-post ?embed=1 fetch → parse → writeTelegramSnapshot. post_id is the
 *  STABLE "<channelKey>/<messageId>" composite — channelKey is NOT a fetchable
 *  t.me path segment, so the renameable SLUG to fetch with is resolved from the
 *  stored telegram_posts.external_url (the canonical t.me/<slug>/<id> URL written
 *  on every snapshot). On a fetch/parse failure write a non-ok snapshot (stamps
 *  last_polled_at — the Refresh button settles, the warm poll_failure_count bound
 *  advances) and NEVER throw (the lane marks the row done; no batch-wide retry).
 *  A pacer/rate-limit denial IS re-thrown so the lane worker defers + retries
 *  (the slot was the gate). */
async function handleWarmPostFetch(
  postId: string,
  pacer: "acquire" | "already-acquired" = "acquire",
): Promise<void> {
  const slash = postId.indexOf("/");
  if (slash <= 0 || slash === postId.length - 1) {
    throw new AdapterError(`post_stats post_id is not "<channelKey>/<messageId>": ${postId}`, {
      category: "permanent",
    });
  }
  // Resolve the fetchable slug from external_url (t.me/<slug>/<messageId>) — the
  // post_id prefix is the channelKey, which t.me cannot serve. external_url is
  // written on every snapshot (preview / listing / backfill), so a warm post
  // already in telegram_posts always has it.
  const target = await resolveTelegramFetchTarget(postId);
  if (target === null) {
    throw new AdapterError(`post_stats no fetchable external_url for ${postId}`, {
      category: "permanent",
    });
  }
  const { channel, messageId, externalUrl } = target;

  try {
    const html = await fetchTelegramPost(channel, messageId, pacer);
    const parsed = parseTelegramPost(html);
    if (parsed === null) {
      // The embed page carried no message block — deleted / private.
      await writeTelegramSnapshot({ postId, externalUrl, viewCount: null, status: "not_found" });
      return;
    }
    await writeTelegramSnapshot({
      postId,
      // The ?embed=1 page also carries the post block's data-view → channel_key
      // is decoded here too, keeping the rename-proof group key fresh for
      // off-listing (warm-lane) posts. The embed page has no channel header, so
      // there is no telegram_channels UPSERT on this path (the 24h listing poll
      // owns the channel-entity refresh).
      channelKey: parsed.channelKey,
      textSnippet: parsed.textSnippet,
      mediaKind: parsed.mediaKind,
      thumbnailUrl: parsed.thumbnailUrl,
      externalUrl,
      publishedAt: parsed.publishedAt,
      viewCount: parsed.viewCount,
      status: "ok",
    });
  } catch (err) {
    // A rate-limited / pacer denial is the lane's gate — re-throw so the worker
    // defers + retries this row (do NOT consume it with a non-ok snapshot).
    if (err instanceof AdapterError && err.category === "rate-limited") throw err;
    // Map the AdapterError category → a Telegram snapshot status. Telegram's
    // status set is {ok, not_found, private, rate_limited} (no auth_error — the
    // free scrape has no credentials to reject), so transient/permanent/operator
    // failures land 'rate_limited' (a non-terminal non-ok that stamps
    // last_polled_at + advances poll_failure_count without freezing the post).
    const status: TelegramSnapshotStatus =
      err instanceof AdapterError && err.category === "not-found" ? "not_found" : "rate_limited";
    if (!(err instanceof AdapterError)) {
      logger.warn(
        { postId, err: String((err as Error)?.message ?? err) },
        "telegram warm fetch: unexpected error",
      );
    }
    await writeTelegramSnapshot({ postId, externalUrl, viewCount: null, status }).catch((e) => {
      logger.warn(
        { postId, err: String((e as Error)?.message ?? e) },
        "telegram warm fetch: snapshot write failed",
      );
    });
  }
}

/** Emit a `telegram.queue_drained` audit row (best-effort). Fired once per
 *  non-empty tick by the lane worker's emitDrained hook. Telegram is FREE (no
 *  per-user cap row, unlike reddit/IG) — this is the Reddit free-lane accounting
 *  model: the row exists purely so observability.getDailyStats /
 *  getRecentAudit see real activity. Failed audit writes are logged at WARN and
 *  never thrown.
 *
 *  Requires a non-empty ADMIN_EMAIL_ALLOWLIST so the operator user_id resolves
 *  (audit_log.user_id is NOT NULL); without it this is a silent no-op. */
export async function emitQueueDrainedAudit(stats: {
  queueName: string;
  entriesProcessed: number;
  durationMs: number;
}): Promise<void> {
  if (stats.entriesProcessed === 0) return;
  try {
    const operatorId = await resolveTelegramOperatorUserId();
    if (operatorId === null) {
      logger.debug({ stats }, "telegram.queue_drained: no operator resolvable; skipping audit");
      return;
    }
    await writeAudit({
      userId: operatorId,
      action: "telegram.queue_drained",
      ipAddress: "127.0.0.1",
      metadata: {
        queue_name: stats.queueName,
        entries_processed: stats.entriesProcessed,
        duration_ms: stats.durationMs,
      },
    });
  } catch (err) {
    logger.warn(
      { err: String((err as Error)?.message ?? err) },
      "telegram.queue_drained audit emit failed",
    );
  }
}

/** Test-only — reset the tick counter + cached operator id so each case starts
 *  from slot 1 with a cold resolver. */
export function __resetTelegramTickCounterForTest(): void {
  telegramLaneWorker.resetForTest();
  __resetTelegramOperatorIdCacheForTest();
}
