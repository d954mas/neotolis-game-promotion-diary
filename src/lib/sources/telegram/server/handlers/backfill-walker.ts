// Telegram backfill walker — the resumable ?before slow-drain (D-03).
//
// Invoked BY the lane worker dispatch (service_source / user_source rows of type
// 'backfill_page'). ONE page per tick: read the persisted ?before cursor, fetch
// that page (the lane worker has already acquired the pacer slot), write a views
// snapshot per post, then either:
//   - END-OF-HISTORY → set backfill_complete=true (the walk is done; only page-1
//     re-polls from now). Triggered when the page yields ZERO new [data-post]
//     blocks OR the parsed nextBeforeCursor is null (no more-anchor in the
//     markup → no older history).
//   - CONTINUE → persist the next ?before cursor (which monotonically decreases,
//     so no page is ever re-fetched) AND enqueue a continuation backfill_page row
//     on the SERVICE lane (user_id=NULL). Continuations run on the cron lane so a
//     user-triggered backfill costs the user exactly ONE lane row; the operator
//     pool absorbs the follow-up pages (mirrors Reddit's enqueueWalkerContinuation
//     intent).
//
// The newest page of a never-walked channel is fetched WITHOUT a cursor (the
// first backfill_page row carries no/empty cursor → getTelegramWalkState returns
// beforeCursor=null → core.pollListing(channel, null) → newest page).
//
// channelKey for the walker state is the channel slug (data_sources.metadata.channel).

import { and, eq, inArray, sql } from "drizzle-orm";
import { db, type DbOrTx } from "$lib/server/db/client.js";
import { adapterRefreshQueue } from "$lib/server/db/schema/index.js";
import { logger } from "$lib/server/logger.js";
import { telegramChannelAdapterCore } from "../adapter.js";
import { writeTelegramSnapshot } from "../snapshots.js";
import { getTelegramWalkState, persistTelegramWalkProgress } from "../walker-state.js";

const ADAPTER_KIND = "telegram_channel";
const TELEGRAM_BASE = "https://t.me";

function externalUrlForPost(postId: string): string {
  return `${TELEGRAM_BASE}/${postId}`;
}

/** Enqueue a continuation backfill_page row on the service lane (user_id=NULL →
 *  cron-pool, cap-exempt). The user paid for the first page; the operator pool
 *  drains the rest. */
async function enqueueBackfillContinuation(channel: string, dbCtx: DbOrTx): Promise<void> {
  await dbCtx.insert(adapterRefreshQueue).values({
    adapterKind: ADAPTER_KIND,
    queueName: "service_source",
    type: "backfill_page",
    payload: { channel },
    userId: null,
    priority: 0,
  });
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
      nextBeforeCursor: null,
      backfillComplete: true,
      oldestPublishedAt: null,
    });
    return { status: "not_found", written: 0, backfillComplete: true, nextBeforeCursor: null };
  }

  let written = 0;
  let oldestPublishedAt: Date | null = null;
  for (const post of listing.posts) {
    await writeTelegramSnapshot({
      postId: post.externalId,
      textSnippet: post.textSnippet,
      mediaKind: post.mediaKind,
      thumbnailUrl: post.thumbnailUrl,
      externalUrl: externalUrlForPost(post.externalId),
      publishedAt: post.publishedAt,
      viewCount: post.viewCount,
      status: "ok",
    });
    written += 1;
    if (post.publishedAt !== null) {
      if (oldestPublishedAt === null || post.publishedAt.getTime() < oldestPublishedAt.getTime()) {
        oldestPublishedAt = post.publishedAt;
      }
    }
  }

  // End-of-history: a page with NO new [data-post] blocks OR no more-anchor
  // cursor means there is no older history to drain (RESEARCH §End-of-history).
  const backfillComplete = listing.posts.length === 0 || listing.nextBeforeCursor === null;

  await persistTelegramWalkProgress(channel, {
    nextBeforeCursor: listing.nextBeforeCursor,
    backfillComplete,
    oldestPublishedAt,
  });

  // Continue draining on the service lane when there is more history.
  if (!backfillComplete && listing.nextBeforeCursor !== null) {
    await enqueueBackfillContinuation(channel, db);
  }

  logger.debug(
    { channel, written, backfillComplete, nextBeforeCursor: listing.nextBeforeCursor },
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
