// Telegram backfill walker — the resumable ?before slow-drain (D-03).
//
// Invoked BY the lane worker dispatch (service_source / user_source rows of type
// 'backfill_page'). ONE page per tick: read the persisted ?before cursor, fetch
// that page (the lane worker has already acquired the pacer slot), write a views
// snapshot per post, then either:
//   - WALK BOUNDED → set backfill_complete=true (the walk is done; only page-1
//     re-polls from now). Triggered when ANY of:
//       * END-OF-HISTORY — a page with ZERO new [data-post] blocks OR a null
//         parsed nextBeforeCursor (no more-anchor → no older history).
//       * WINDOW CROSSED (B1) — the page reached a post older than the DEEPEST
//         subscriber's backfillTargetSince. The walk's depth is the deepest
//         window any current subscriber asked for (the channel-state row is
//         cross-tenant, one per slug → "complete" means the deepest subscriber's
//         window is satisfied; a later widen re-opens it via
//         resetTelegramWalkState). A channel with NO bounded subscriber (every
//         subscriber chose "everything") has target=null and walks to
//         end-of-history.
//       * POST-COUNT CAP (B1) — the running collected count hit
//         env.TELEGRAM_BACKFILL_MAX_POSTS (Telegram's own cap, deeper than IG's
//         since the t.me/s scrape is free), so a giant archive costs a bounded
//         number of pages regardless of size (mirrors IG backfill-account.ts
//         state.collected >= maxPosts).
//   - CONTINUE → persist the next ?before cursor (which monotonically decreases,
//     so no page is ever re-fetched) + the running collected count AND enqueue a
//     continuation backfill_page row on the SERVICE lane (user_id=NULL).
//     Continuations run on the cron lane so a user-triggered backfill costs the
//     user exactly ONE lane row; the operator pool absorbs the follow-up pages
//     (mirrors Reddit's enqueueWalkerContinuation intent).
//
// The newest page of a never-walked channel is fetched WITHOUT a cursor (the
// first backfill_page row carries no/empty cursor → getTelegramWalkState returns
// beforeCursor=null → core.pollListing(channel, null) → newest page).
//
// channelKey for the walker state is the channel slug (data_sources.metadata.channel).

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { adapterRefreshQueue } from "$lib/server/db/schema/index.js";
import { dataSources } from "$lib/server/db/schema/data-sources.js";
import { env } from "$lib/server/config/env.js";
import { logger } from "$lib/server/logger.js";
import { telegramChannelAdapterCore } from "../adapter.js";
import { writeTelegramSnapshot, upsertTelegramChannel } from "../snapshots.js";
import { materializeTelegramEvents } from "../events.js";
import {
  getTelegramWalkState,
  persistTelegramWalkProgress,
  commitTelegramWalkProgress,
} from "../walker-state.js";
import type { ParsedTelegramPost } from "../parse.js";

const ADAPTER_KIND = "telegram_channel";
const TELEGRAM_BASE = "https://t.me";

function externalUrlForPost(postId: string): string {
  return `${TELEGRAM_BASE}/${postId}`;
}

/** Resolve the DEEPEST backfillTargetSince across the channel's active
 *  auto-import subscribers — the depth the walk must reach (B1). The channel
 *  state row is cross-tenant (one per slug), so the walk serves the most
 *  ambitious window any current subscriber asked for; a shallower subscriber's
 *  events are filtered at the materialize fan-out by their own target.
 *
 *  Returns the EARLIEST (smallest .getTime()) backfillTargetSince — that is the
 *  deepest window. null when no subscriber has a bound (every subscriber chose
 *  "everything", stored as NULL backfillTargetSince → walk to end-of-history) OR
 *  the channel has no subscriber row yet (test/diagnostic direct walk). */
async function resolveDeepestTargetSince(channel: string): Promise<Date | null> {
  // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- channel-scoped depth resolution: the cross-tenant channel-state walk serves the deepest window any subscriber requested; per-tenant filtering happens at the events materialize fan-out.
  const rows = await db
    .select({ backfillTargetSince: dataSources.backfillTargetSince })
    .from(dataSources)
    .where(
      and(
        eq(dataSources.kind, ADAPTER_KIND),
        sql`${dataSources.metadata}->>'channel' = ${channel}`,
        eq(dataSources.autoImport, true),
        isNull(dataSources.deletedAt),
      ),
    );
  if (rows.length === 0) return null;
  // A single subscriber with NULL backfillTargetSince ("everything") means no
  // depth bound at all — the deepest possible. So if ANY subscriber is unbounded,
  // the walk is unbounded.
  let deepest: Date | null = null;
  for (const r of rows) {
    if (r.backfillTargetSince === null) return null;
    if (deepest === null || r.backfillTargetSince.getTime() < deepest.getTime()) {
      deepest = r.backfillTargetSince;
    }
  }
  return deepest;
}

export async function handleTelegramBackfillWalker(args: {
  channel: string;
  userId?: string | null;
  pacer?: "acquire" | "already-acquired";
}): Promise<{
  status: "ok" | "not_found";
  written: number;
  backfillComplete: boolean;
  nextBeforeCursor: string | null;
}> {
  const channel = args.channel;
  const state = await getTelegramWalkState(channel);

  // Once the walk is complete, deep pagination is done — there is nothing more
  // to drain. (The 6h listing poll handles new posts via the listing-poll path.)
  if (state.backfillComplete) {
    logger.debug({ channel }, "telegram.backfill: already complete — no deep walk needed");
    return { status: "ok", written: 0, backfillComplete: true, nextBeforeCursor: null };
  }

  const listing = await telegramChannelAdapterCore.pollListing(
    channel,
    state.beforeCursor,
    args.pacer ?? "acquire",
  );

  if (listing.status === "not_found") {
    // A not_found mid-walk (channel renamed/deleted) — mark complete so we stop
    // re-fetching a dead channel. The cursor is cleared by persist on complete.
    logger.info(
      { channel },
      "telegram.backfill: channel not found mid-walk — marking complete (stop fetching)",
    );
    await persistTelegramWalkProgress(channel, {
      expectedBeforeCursor: state.beforeCursor,
      nextBeforeCursor: null,
      backfillComplete: true,
      oldestPublishedAt: null,
      collected: state.collected,
    });
    return { status: "not_found", written: 0, backfillComplete: true, nextBeforeCursor: null };
  }

  // UPSERT the channel subject entity from this page's header (every page of the
  // walk carries the same header — refresh the channel metadata regardless of
  // whether this page's posts fall in-window). No-ops without a channel id;
  // COALESCE-preserves prior good metadata on a partial parse.
  if (listing.channelHeader !== null) {
    await upsertTelegramChannel(listing.channelHeader);
  }

  // Depth bound (B1): the deepest window any current subscriber asked for. null =
  // unbounded (an "everything" subscriber, or a direct test walk with no
  // subscriber row).
  const target = await resolveDeepestTargetSince(channel);
  const maxPosts = env.TELEGRAM_BACKFILL_MAX_POSTS;

  // Snapshot each post NEWER than the depth target; stop the page the moment we
  // cross below it (the listing is newest-first) OR the running count hits the
  // post cap. crossedWindow / capReached both terminate the walk — there is no
  // value in fetching older pages once the deepest window is satisfied.
  let written = 0;
  let collected = state.collected;
  let oldestPublishedAt: Date | null = null;
  let crossedWindow = false;
  let capReached = false;
  const inWindowPosts: ParsedTelegramPost[] = [];
  for (const post of listing.posts) {
    if (
      target !== null &&
      post.publishedAt !== null &&
      post.publishedAt.getTime() < target.getTime()
    ) {
      crossedWindow = true;
      break;
    }
    await writeTelegramSnapshot({
      postId: post.externalId,
      channelKey: post.channelKey,
      textSnippet: post.textSnippet,
      mediaKind: post.mediaKind,
      thumbnailUrl: post.thumbnailUrl,
      externalUrl: externalUrlForPost(post.externalId),
      publishedAt: post.publishedAt,
      viewCount: post.viewCount,
      reactionsTotal: post.reactionsTotal,
      reactionsTop: post.reactionsTop,
      status: "ok",
    });
    inWindowPosts.push(post);
    written += 1;
    collected += 1;
    if (post.publishedAt !== null) {
      if (oldestPublishedAt === null || post.publishedAt.getTime() < oldestPublishedAt.getTime()) {
        oldestPublishedAt = post.publishedAt;
      }
    }
    if (collected >= maxPosts) {
      capReached = true;
      break;
    }
  }

  // Materialize feed events from THIS page's in-window posts (source_id set) so
  // the backfilled + initial history lands in /feed and counts on /sources. The
  // backfill walker owns historical + the initial newest page; the steady-state
  // newest page is owned by listing-poll. The cron picker (index.ts) skips
  // listing-polling a channel with an in-flight backfill_page so the two never
  // double-fan the same page (A2). The materialize fan-out itself filters each
  // post per-subscriber by their own backfillTargetSince — a shallower
  // subscriber on a deep-walked channel doesn't get out-of-window events.
  await materializeTelegramEvents(channel, inWindowPosts, { userId: args.userId });

  // The walk is complete when ANY bound is hit:
  //   - end-of-history (empty page OR null more-anchor cursor),
  //   - the deepest subscriber's window was crossed (B1),
  //   - the post-count cap was reached (B1 — cost independent of archive size).
  const backfillComplete =
    listing.posts.length === 0 || listing.nextBeforeCursor === null || crossedWindow || capReached;

  // Persist the new cursor/frontier/complete AND enqueue the continuation
  // backfill_page row in ONE transaction, guarded by an expected-cursor CAS
  // (mirrors reddit commitSubredditWalkProgress). The CAS re-checks the
  // channel-state cursor inside the tx and only commits/continues when it still
  // equals the cursor THIS tick started from (state.beforeCursor); a concurrent
  // worker that already advanced it loses the CAS → no duplicate continuation.
  // The atomic pair also closes the crash-between-persist-and-enqueue window: a
  // crash leaves either both (walk continues) or neither (next cron tick resumes
  // from the still-pending cursor). The helper only enqueues a continuation when
  // committed AND there is more in-window history (not complete, more-anchor
  // present) — never past the window / cap bound (B1).
  const persistResult = await commitTelegramWalkProgress(channel, {
    expectedBeforeCursor: state.beforeCursor,
    nextBeforeCursor: listing.nextBeforeCursor,
    backfillComplete,
    oldestPublishedAt,
    collected,
  });

  logger.debug(
    {
      channel,
      written,
      collected,
      backfillComplete,
      crossedWindow,
      capReached,
      casLost: !persistResult.committed,
      target: target?.toISOString() ?? null,
      nextBeforeCursor: listing.nextBeforeCursor,
    },
    "telegram.backfill: page walked",
  );
  return {
    status: "ok",
    written,
    backfillComplete,
    nextBeforeCursor: backfillComplete ? null : listing.nextBeforeCursor,
  };
}

/** Test/diagnostic helper — count pending backfill_page rows for a channel on
 *  the service lane (used by the walker integration test to assert a
 *  continuation was enqueued). */
export async function countPendingBackfillContinuations(channel: string): Promise<number> {
  // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- service-wide backfill-lane scan: continuation rows are user_id=NULL cron-pool work keyed by channel slug, not by tenant; mirrors the service_post lane scan in enqueue-service-warm.ts
  const rows = await db
    .select({ id: adapterRefreshQueue.id })
    .from(adapterRefreshQueue)
    .where(
      and(
        eq(adapterRefreshQueue.adapterKind, ADAPTER_KIND),
        eq(adapterRefreshQueue.type, "backfill_page"),
        inArray(adapterRefreshQueue.status, ["pending", "processing"]),
        sql`${adapterRefreshQueue.payload}->>'channel' = ${channel}`,
      ),
    );
  return rows.length;
}
