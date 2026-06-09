// Telegram per-event Refresh-Now enqueue (split out of index.ts; the
// RefreshQueueCapability.enqueue the cross-source requestRefreshPoll delegates
// to). Mirrors the youtube/reddit/instagram refresh-enqueue split.
//
// INSERTs ONE user_post row into adapter_refresh_queue; the lane worker fetches
// that post via ?embed=1 + writeTelegramSnapshot. INSERT via the passed tx
// (requestRefreshPoll calls this inside its tx). No skip-if-pending dedup — the
// 5-min cooldown in requestRefreshPoll is the dedup; a conscious Refresh always
// fetches fresh (mirrors Reddit/IG). post_id is the channelKey-based
// "<channelKey>/<messageId>" external id (#1) — the lane worker resolves the
// fetchable slug from telegram_posts.external_url.

import type { EventKind } from "$lib/sources/adapter.js";
import { db, type DbOrTx } from "$lib/server/db/client.js";
import { adapterRefreshQueue } from "$lib/server/db/schema/index.js";
import { adapterRefreshQueueLabel } from "$lib/server/services/adapter-lane-worker.js";

const KIND = "telegram_channel" as const;

export async function enqueueRefreshNow(input: {
  eventId: string;
  userId: string;
  externalId: string;
  eventKind: EventKind;
  tx?: DbOrTx;
}): Promise<{ queue: string; jobId: string | null }> {
  const dbCtx = input.tx ?? db;
  const [row] = await dbCtx
    .insert(adapterRefreshQueue)
    .values({
      adapterKind: KIND,
      queueName: "user_post",
      type: "post_stats",
      payload: { event_id: input.eventId, post_id: input.externalId },
      userId: input.userId,
      priority: -10,
      status: "pending",
    })
    .returning({ id: adapterRefreshQueue.id });
  return {
    queue: adapterRefreshQueueLabel(KIND, "user_post"),
    jobId: row ? String(row.id) : null,
  };
}
