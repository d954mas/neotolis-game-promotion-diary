// Instagram per-post stats refresh — SQL lane worker (#69 + #70 warm follow-on).
//
// Two slots over adapter_refresh_queue, mirroring YouTube's user_video/service_video:
//   - "user_post"    — MANUAL "Refresh now" (enqueueRefreshNow). Payload
//                      {event_id, post_id}, user_id SET. Resolved TENANT-SCOPED
//                      (the user owns the event); fetch charges the USER pool.
//   - "service_post" — CRON warm auto-refresh (warm-scheduler / #70). Payload
//                      {post_id}, user_id NULL. PUBLIC-DATA, NO event lookup;
//                      fetch charges the OPERATOR (cron) pool.
//
// This worker claims up to N rows of ONE slot per tick (N =
// env.SOCIAL_REFRESH_LANE_CONCURRENCY; batchScope "global" — across users) and
// refreshes them CONCURRENTLY: Instagram's single-post endpoint can't batch
// (1 request = 1 post), so scale comes from concurrency, not a multi-id call like
// YouTube's videos.list.
//
// Each post is independent, so dispatch uses Promise.allSettled and writes a
// per-post snapshot (ok or non-ok via categoryToSnapshotStatus) and NEVER throws
// — the lane worker then marks every claimed row `done` (no batch-wide retry that
// would re-fetch the successes). A transient failure (429/network) lands a non-ok
// snapshot — which still stamps instagram_posts.last_polled_at, so the
// RefreshNowButton stop-loop settles — and is recovered by the user re-clicking
// after cooldown or the next scheduled source poll.
//
// The credit reserve happens INSIDE provider.fetchPostByUrl (origin "user"), so
// claimGate is a throttle gate ONLY (defer at 95%), never a second reserve —
// avoiding a double-charge (plan D2).

import { and, eq, isNull } from "drizzle-orm";
import { events } from "$lib/server/db/schema/events.js";
import { instagramPosts } from "$lib/server/db/schema/index.js";
import { db } from "$lib/server/db/client.js";
import {
  createAdapterBatchLaneWorker,
  type AdapterBatchLaneWorkerTickResult,
  type AdapterLaneClaimGateContext,
  type AdapterLaneClaimGateResult,
  type AdapterLaneWorkerRow,
} from "$lib/server/services/adapter-lane-worker.js";
import { env } from "$lib/server/config/env.js";
import { logger } from "$lib/server/logger.js";
import { AdapterError, categoryToSnapshotStatus } from "$lib/sources/errors.js";
import { getSocialProvider } from "../provider/registry.js";
import { getSocialSpendToday } from "../quota.js";
import { writeSnapshot } from "../snapshots.js";

export const INSTAGRAM_REFRESH_SLOTS = ["user_post", "service_post"] as const;
export type InstagramRefreshQueueName = (typeof INSTAGRAM_REFRESH_SLOTS)[number];

const MAX_ATTEMPTS = 5;
const STALE_PROCESSING_MS = 5 * 60_000;
const STALE_RECOVERY_INTERVAL_MS = 60_000;
const THROTTLE_DEFER_MS = 5 * 60_000;

const instagramRefreshWorker = createAdapterBatchLaneWorker({
  adapterKind: "instagram_account",
  slots: INSTAGRAM_REFRESH_SLOTS,
  fallthrough: INSTAGRAM_REFRESH_SLOTS,
  maxAttempts: MAX_ATTEMPTS,
  // Concurrency knob (NOT a batch-in-one-request size): claim up to N rows and
  // fetch them in parallel in dispatch.
  maxBatchSize: env.SOCIAL_REFRESH_LANE_CONCURRENCY,
  batchScope: "global",
  staleProcessingMs: STALE_PROCESSING_MS,
  staleRecoveryIntervalMs: STALE_RECOVERY_INTERVAL_MS,
  claimGate: claimInstagramThrottleSlot,
  dispatch: dispatchRefreshBatch,
  // Observability (#70 P3-A): one INFO per drained tick, tagged by slot, so warm
  // (service_post) credit spend is visible in Loki/Grafana SEPARATE from manual
  // (user_post) spend — the lane is where credits are actually burned.
  emitDrained: ({ queueName, entriesProcessed, durationMs }) => {
    logger.info(
      { queueName, entriesProcessed, durationMs },
      "instagram refresh lane: tick drained",
    );
  },
});

export async function instagramRefreshQueueTick(): Promise<AdapterBatchLaneWorkerTickResult> {
  return instagramRefreshWorker.tick();
}

// Throttle gate (D2): NOT a reserve (the single reserve happens inside
// fetchPostByUrl), so no double-charge. It distinguishes the two "exhausted"
// states that getSocialThrottleState would both report as "ninetyfive" (#69 P1-B):
//   - Prepaid balance ≤ 0 is the MONOTONIC hard ceiling — it never resets, so a
//     defer would loop forever and the RefreshNowButton would spin indefinitely.
//     RUN instead: dispatch's in-fetch reserve fails → a non-ok snapshot → the
//     row completes and the button settles (post shows unavailable).
//   - Daily cap ≥ 95% (balance still funded) resets at midnight Pacific — DEFER;
//     it recovers on its own (mirrors the YouTube/Reddit "wait for reset" defer).
//
// Two-pool coupling (#70 P2-B, accepted): getSocialSpendToday SUMS both pools, so
// this coarse gate can defer a service_post tick on user-pool spend (or vice-versa).
// That's fine — the real per-pool ceiling is the in-fetch origin-scoped reserve
// (user_post→user pool, service_post→cron pool); this stays a cheap tick throttle.
async function claimInstagramThrottleSlot(
  _ctx: AdapterLaneClaimGateContext<InstagramRefreshQueueName>,
): Promise<AdapterLaneClaimGateResult> {
  const { creditsUsed, dailyCap, prepaidBalance } = await getSocialSpendToday(
    "instagram",
    "scrapecreators",
  );
  if (prepaidBalance <= 0) return { action: "run" };
  if (dailyCap > 0 && creditsUsed >= Math.floor(dailyCap * 0.95)) {
    return {
      action: "defer",
      retryAfterMs: THROTTLE_DEFER_MS,
      reason: "instagram daily cap at 95%",
    };
  }
  return { action: "run" };
}

// allSettled + per-row snapshot + NEVER throw → the lane worker marks every
// claimed row `done` (independent posts; a per-row failure must not re-fetch the
// successes via a batch-wide throw-to-retry).
async function dispatchRefreshBatch(rows: AdapterLaneWorkerRow[]): Promise<void> {
  await Promise.allSettled(rows.map((row) => processOne(row)));
}

interface ResolvedPost {
  postId: string;
  permalink: string;
}

async function processOne(row: AdapterLaneWorkerRow): Promise<void> {
  try {
    const resolved =
      row.queueName === "service_post"
        ? await resolveServicePostRow(row)
        : await resolveUserPostRow(row);
    if (resolved === null) return; // skip reasons are logged inside the resolvers
    // user_post → user pool (the clicking user pays); service_post → cron pool
    // (operator-funded warm auto-refresh, like YouTube service_video).
    const origin = row.queueName === "service_post" ? "cron" : "user";
    await refreshPost(resolved.postId, resolved.permalink, origin);
  } catch (err) {
    // #70 P1: a failure must NEVER vanish silently into allSettled. A resolution
    // failure (a DB select threw) has no postId yet → it can't write a snapshot,
    // so LOG it here (the prior code let it disappear). refreshPost owns its own
    // non-ok snapshot for fetch/write failures (it has the postId). The row still
    // completes `done`; recovery is the warm predicate re-selecting the stale post
    // next scheduler tick (auto path) or a manual re-click (user_post).
    logger.warn(
      { rowId: row.id, queueName: row.queueName, err: String((err as Error)?.message ?? err) },
      "instagram refresh: row failed before snapshot — recovered by re-selection",
    );
  }
}

// MANUAL path: resolve the post media id from the event, TENANT-SCOPED. A row
// without a userId can't be safely scoped (refresh-now rows always carry one).
async function resolveUserPostRow(row: AdapterLaneWorkerRow): Promise<ResolvedPost | null> {
  if (row.userId === null) return null;
  const eventId = row.payload?.event_id;
  if (typeof eventId !== "string") return null;
  const [event] = await db
    .select({ externalId: events.externalId })
    .from(events)
    .where(
      and(
        eq(events.id, eventId),
        eq(events.userId, row.userId),
        eq(events.kind, "instagram_post"),
        isNull(events.deletedAt),
      ),
    )
    .limit(1);
  const postId = event?.externalId ?? null;
  if (postId === null) return null;
  return resolvePermalink(postId);
}

// CRON warm path: the post media id is in the payload directly. PUBLIC-DATA — no
// event lookup, no userId (mirrors youtube loadVideoWork's service_video branch).
async function resolveServicePostRow(row: AdapterLaneWorkerRow): Promise<ResolvedPost | null> {
  const postId = row.payload?.post_id;
  if (typeof postId !== "string") return null;
  return resolvePermalink(postId);
}

// The single-post endpoint needs the shortcode permalink, which lives on the
// public-data instagram_posts row. No row / no permalink (e.g. a paste before the
// first account poll) → graceful skip; the next scheduled poll fills it (D4).
async function resolvePermalink(postId: string): Promise<ResolvedPost | null> {
  const [postRow] = await db
    .select({ permalink: instagramPosts.permalink })
    .from(instagramPosts)
    .where(eq(instagramPosts.postId, postId))
    .limit(1);
  const permalink = postRow?.permalink ?? null;
  if (permalink === null) {
    logger.info({ postId }, "instagram refresh: post not cached yet — skip");
    return null;
  }
  return { postId, permalink };
}

// Fetch one post + write its snapshot. Owns its own try/catch so a per-row failure
// lands a VISIBLE non-ok snapshot (stamps last_polled_at — the manual button
// settles; the warm predicate's poll_failure_count bound advances) and NEVER
// throws (the lane marks the row done; no batch-wide retry that would re-fetch +
// re-charge the successes). `origin` picks the credit pool (user vs cron).
async function refreshPost(
  postId: string,
  permalink: string,
  origin: "cron" | "user",
): Promise<void> {
  const provider = getSocialProvider("instagram");
  if (provider === null) return; // unconfigured — isEnabled gates the lane; defensive.

  try {
    // fetchPostByUrl reserves one prepaid credit internally from the `origin` pool.
    const post = await provider.fetchPostByUrl("instagram", permalink, { origin });
    if (post === null) {
      // Deleted / private — the envelope carried no media object.
      await writeSnapshot({ postId, permalink, metrics: null, status: "not_found" });
      return;
    }
    await writeSnapshot({
      postId,
      accountId: post.ownerId,
      mediaType: post.kind,
      caption: post.caption,
      permalink,
      thumbnailUrl: post.thumbnailUrl,
      publishedAt: post.publishedAt,
      metrics: {
        views: post.metrics.views,
        likes: post.metrics.likes,
        comments: post.metrics.comments,
      },
      status: "ok",
    });
  } catch (err) {
    // An AdapterError maps to its category; an unexpected throw (a programmer bug)
    // degrades to "auth_error" and is logged.
    const status =
      err instanceof AdapterError ? categoryToSnapshotStatus(err.category) : "auth_error";
    if (!(err instanceof AdapterError)) {
      logger.warn(
        { postId, err: String((err as Error)?.message ?? err) },
        "instagram refresh: unexpected error",
      );
    }
    // Best-effort: if the original failure WAS the snapshot write (DB down), this
    // re-write also fails — swallow so the row still completes, don't re-throw.
    await writeSnapshot({ postId, permalink, metrics: null, status }).catch((e) => {
      logger.warn(
        { postId, err: String((e as Error)?.message ?? e) },
        "instagram refresh: snapshot write failed",
      );
    });
  }
}

export function __resetInstagramRefreshQueueWorkerForTest(): void {
  instagramRefreshWorker.resetForTest();
}
