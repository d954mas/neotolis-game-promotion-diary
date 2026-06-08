// Telegram backfill walker state — resumable ?before cursor + completion flag.
//
// Telegram has NO per-channel cache table (no subreddits_cache / users_cache
// equivalent — channel display name lives on data_sources, the no-denorm rule).
// The walker's cross-tenant state therefore lives on the shared
// data_source_channel_state row (kind='telegram_channel', channelKey=<channel
// slug>):
//   - metadata.lastBackfillCursor — the ?before=<messageId> cursor for the NEXT
//     page (mirrors how the YouTube walker stashes lastBackfillPageToken in the
//     same JSONB column, and how IG stashes its per-feed cursors). null = start
//     at the newest page (never walked) OR fully drained (see backfillComplete).
//   - backfill_complete (column) — sticky terminal flag: the walker hit
//     end-of-history (a page with zero new [data-post] blocks OR a null
//     nextBeforeCursor). The cron picker stops deep-walking a complete channel;
//     the 6h listing poll still re-stamps page-1 for new posts.
//   - backfill_oldest_at (column) — the deepest published_at the walk has
//     reached (WHERE-guarded deeper-only via markChannelBackfillFrontier).
//
// State machine per channel row:
//   complete=false, cursor=null       → never walked; first fetch is the newest
//                                        page (no ?before).
//   complete=false, cursor!=null      → deep walk in progress; next fetch pages
//                                        from this ?before cursor.
//   complete=true                     → end-of-history reached; subsequent
//                                        fetches ignore the cursor and just
//                                        re-poll page-1 for new posts.
//
// The cursor monotonically DECREASES (older messageId each page) so the walker
// never re-fetches a page it already drained.
//
// channelKey for Telegram is the channel SLUG (the URL-intrinsic handle stored
// on data_sources.metadata.channel). Unlike YouTube/IG it is not a resolved
// numeric id — Telegram exposes no synchronous resolve, and the slug IS the
// canonical t.me/<slug> identity (the safe-denorm carve-out). channel_key on
// telegram_posts (the numeric data-view id) is a separate per-post anchor; the
// walker keys its state by the slug because that is what every fetch needs.

import { and, eq, sql } from "drizzle-orm";
import { db, type DbOrTx } from "$lib/server/db/client.js";
import { dataSourceChannelState } from "$lib/server/db/schema/data-source-channel-state.js";
import {
  ensureChannelState,
  markChannelBackfillComplete,
  markChannelBackfillFrontier,
  markChannelLastPolledAt,
} from "$lib/server/services/channel-state.js";

const KIND = "telegram_channel" as const;

export interface TelegramWalkState {
  /** ?before cursor for the next page. null when never walked OR fully drained. */
  beforeCursor: string | null;
  /** Sticky terminal flag — end-of-history reached; only page-1 re-polls now. */
  backfillComplete: boolean;
  /** Deepest published_at reached so far (frontier). null until set. */
  backfillOldestAt: Date | null;
}

/** Read the walker state for a channel slug. Defaults for a never-walked
 *  channel (no row): cursor null, not complete, no frontier. */
export async function getTelegramWalkState(
  channelKey: string,
  dbCtx: DbOrTx = db,
): Promise<TelegramWalkState> {
  const [row] = await dbCtx
    .select({
      metadata: dataSourceChannelState.metadata,
      backfillComplete: dataSourceChannelState.backfillComplete,
      backfillOldestAt: dataSourceChannelState.backfillOldestAt,
    })
    .from(dataSourceChannelState)
    .where(and(eq(dataSourceChannelState.kind, KIND), eq(dataSourceChannelState.channelKey, channelKey)))
    .limit(1);
  const cursor = (row?.metadata as { lastBackfillCursor?: unknown } | null)?.lastBackfillCursor;
  return {
    beforeCursor: typeof cursor === "string" && cursor !== "" ? cursor : null,
    backfillComplete: row?.backfillComplete ?? false,
    backfillOldestAt: row?.backfillOldestAt ?? null,
  };
}

/**
 * Persist a page of walker progress. Auto-creates the channel-state row, stamps
 * last_polled_at (every successful walk), advances the ?before cursor in
 * metadata, moves the deeper-only frontier, and flips backfill_complete on
 * end-of-history.
 *
 * - `nextBeforeCursor` is the cursor for the NEXT page (the parsed
 *   nextBeforeCursor). When `backfillComplete` is true the cursor is CLEARED to
 *   null (the walk is done; page-1 re-polls ignore it).
 * - `oldestPublishedAt` moves the frontier (deeper-only, WHERE-guarded). null
 *   skips the frontier move (a page with no dated posts).
 */
export async function persistTelegramWalkProgress(
  channelKey: string,
  next: {
    nextBeforeCursor: string | null;
    backfillComplete: boolean;
    oldestPublishedAt: Date | null;
  },
  dbCtx: DbOrTx = db,
): Promise<void> {
  await ensureChannelState(KIND, channelKey, dbCtx);
  await markChannelLastPolledAt(KIND, channelKey, dbCtx);

  // Advance (or clear, on completion) the ?before cursor under metadata. Atomic
  // JSONB merge preserves any other adapter metadata on the row.
  const cursor = next.backfillComplete ? null : next.nextBeforeCursor;
  await dbCtx
    .update(dataSourceChannelState)
    .set({
      metadata:
        cursor === null
          ? sql`COALESCE(${dataSourceChannelState.metadata}, '{}'::jsonb) - 'lastBackfillCursor'`
          : sql`jsonb_set(COALESCE(${dataSourceChannelState.metadata}, '{}'::jsonb), '{lastBackfillCursor}', to_jsonb(${cursor}::text), true)`,
      updatedAt: new Date(),
    })
    .where(and(eq(dataSourceChannelState.kind, KIND), eq(dataSourceChannelState.channelKey, channelKey)));

  if (next.oldestPublishedAt !== null) {
    await markChannelBackfillFrontier(KIND, channelKey, next.oldestPublishedAt, dbCtx);
  }
  if (next.backfillComplete) {
    await markChannelBackfillComplete(KIND, channelKey, dbCtx);
  }
}
