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
//
// Concurrency model (multi-replica safe via CAS, mirrors reddit walker-state):
//   The handler reads the ?before cursor BEFORE the t.me fetch, then persists the
//   next cursor AFTER (holding a tx across the HTTP call would pin a connection
//   for seconds — an anti-pattern). commitTelegramWalkProgress closes the two
//   resulting hazards in ONE db.transaction:
//     1. CAS — the persist UPDATE matches only when
//        `metadata->>'lastBackfillCursor'` still equals the cursor the tick
//        started from. Two replicas reading cursor=X both fetch the same page
//        (one wasted free t.me request — accepted) but only ONE persist commits;
//        the CAS-loser skips its continuation enqueue → no duplicate backfill_page.
//     2. Atomic persist+enqueue — a crash between persisting the cursor and
//        enqueuing the continuation would otherwise strand the walk until the
//        daily cron resurrected it (a 6h tail). The transaction makes it
//        all-or-nothing.

import { and, eq, sql } from "drizzle-orm";
import { db, type DbOrTx } from "$lib/server/db/client.js";
import { adapterRefreshQueue } from "$lib/server/db/schema/index.js";
import { dataSourceChannelState } from "$lib/server/db/schema/data-source-channel-state.js";
import {
  ensureChannelState,
  markChannelBackfillComplete,
  markChannelBackfillFrontier,
} from "$lib/server/services/channel-state.js";

const KIND = "telegram_channel" as const;

export interface TelegramWalkState {
  /** ?before cursor for the next page. null when never walked OR fully drained. */
  beforeCursor: string | null;
  /** Sticky terminal flag — end-of-history reached; only page-1 re-polls now. */
  backfillComplete: boolean;
  /** Deepest published_at reached so far (frontier). null until set. */
  backfillOldestAt: Date | null;
  /** Running count of posts snapshotted across all walked pages this walk. The
   *  SOCIAL_BACKFILL_MAX_POSTS cap bounds it so the deep walk's cost is
   *  independent of archive size (B1 — mirrors IG state.collected). Persisted in
   *  metadata across continuation ticks; reset to 0 when a widen re-opens the
   *  walk. */
  collected: number;
}

/** Read the walker state for a channel slug. Defaults for a never-walked
 *  channel (no row): cursor null, not complete, no frontier, zero collected. */
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
    .where(
      and(eq(dataSourceChannelState.kind, KIND), eq(dataSourceChannelState.channelKey, channelKey)),
    )
    .limit(1);
  const md =
    (row?.metadata as { lastBackfillCursor?: unknown; backfillCollected?: unknown } | null) ?? null;
  const cursor = md?.lastBackfillCursor;
  const collected = md?.backfillCollected;
  return {
    beforeCursor: typeof cursor === "string" && cursor !== "" ? cursor : null,
    backfillComplete: row?.backfillComplete ?? false,
    backfillOldestAt: row?.backfillOldestAt ?? null,
    collected: typeof collected === "number" && Number.isFinite(collected) ? collected : 0,
  };
}

/** Result of a CAS persist call. `committed=false` means a concurrent walker
 *  tick advanced the cursor between our read and our UPDATE; the caller MUST
 *  skip its continuation enqueue to avoid double-firing on the same page
 *  (mirrors reddit walker-state PersistResult). */
export interface TelegramPersistResult {
  committed: boolean;
}

/**
 * Compare-and-swap persist of a page of walker progress. Auto-creates the
 * channel-state row, then advances the ?before cursor + collected count in
 * metadata ONLY when the row's current cursor still equals what the caller
 * observed at the start of the tick (`expectedBeforeCursor`). When the CAS
 * matches it also stamps last_polled_at, moves the deeper-only frontier, and
 * flips backfill_complete on end-of-history. When the CAS loses (a concurrent
 * tick already advanced the cursor) it returns `committed=false` and touches
 * nothing — the winner already did the side-state writes.
 *
 * The Telegram cursor lives in `metadata.lastBackfillCursor` (JSONB) — unlike
 * reddit's dedicated `backfill_after_cursor` column — so the CAS guard compares
 * `metadata->>'lastBackfillCursor' IS NOT DISTINCT FROM <expected>`
 * (`IS NOT DISTINCT FROM` treats NULL=NULL as equal so the first tick's
 * expected=null still matches a never-walked / cursor-less row). Mirrors reddit
 * persistSubredditWalkProgress.
 *
 * - `expectedBeforeCursor` is the cursor the caller read at tick start
 *   (`state.beforeCursor`). The CAS only commits when the row still carries it.
 * - `nextBeforeCursor` is the cursor for the NEXT page. When `backfillComplete`
 *   is true the cursor is CLEARED to null (the walk is done; page-1 re-polls
 *   ignore it).
 * - `oldestPublishedAt` moves the frontier (deeper-only, WHERE-guarded). null
 *   skips the frontier move (a page with no dated posts).
 * - `collected` is the running post count across the walk (cap bookkeeping for
 *   B1). Cleared to null on completion so a future widen-reopened walk starts
 *   from 0 again.
 */
export async function persistTelegramWalkProgress(
  channelKey: string,
  next: {
    expectedBeforeCursor: string | null;
    nextBeforeCursor: string | null;
    backfillComplete: boolean;
    oldestPublishedAt: Date | null;
    collected: number;
  },
  dbCtx: DbOrTx = db,
): Promise<TelegramPersistResult> {
  await ensureChannelState(KIND, channelKey, dbCtx);

  // Advance (or clear, on completion) the ?before cursor + collected count under
  // metadata. Atomic JSONB merge preserves any other adapter metadata on the row.
  // On completion both keys are dropped (the walk is done; page-1 re-polls ignore
  // them and a future widen restarts the count from 0).
  const cursor = next.backfillComplete ? null : next.nextBeforeCursor;
  const cursorSet =
    cursor === null
      ? sql`COALESCE(${dataSourceChannelState.metadata}, '{}'::jsonb) - 'lastBackfillCursor'`
      : sql`jsonb_set(COALESCE(${dataSourceChannelState.metadata}, '{}'::jsonb), '{lastBackfillCursor}', to_jsonb(${cursor}::text), true)`;
  const collectedSet = next.backfillComplete
    ? sql`(${cursorSet}) - 'backfillCollected'`
    : sql`jsonb_set(${cursorSet}, '{backfillCollected}', to_jsonb(${next.collected}::int), true)`;
  const updated = await dbCtx
    .update(dataSourceChannelState)
    .set({
      metadata: collectedSet,
      lastPolledAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(dataSourceChannelState.kind, KIND),
        eq(dataSourceChannelState.channelKey, channelKey),
        // CAS: only commit when the persisted cursor still equals the one this
        // tick started from. `IS NOT DISTINCT FROM` makes NULL=NULL equal so the
        // first tick (expected=null on a never-walked row) still matches.
        sql`${dataSourceChannelState.metadata}->>'lastBackfillCursor' IS NOT DISTINCT FROM ${next.expectedBeforeCursor}`,
      ),
    )
    .returning({ channelKey: dataSourceChannelState.channelKey });

  // CAS lost — a concurrent tick advanced the cursor between our read and our
  // UPDATE. Touch nothing else (the winner already stamped last_polled_at, moved
  // the frontier, and flipped complete).
  if (updated.length === 0) return { committed: false };

  if (next.oldestPublishedAt !== null) {
    await markChannelBackfillFrontier(KIND, channelKey, next.oldestPublishedAt, dbCtx);
  }
  if (next.backfillComplete) {
    await markChannelBackfillComplete(KIND, channelKey, dbCtx);
  }
  return { committed: true };
}

/** Enqueue a continuation backfill_page row on the service lane (user_id=NULL →
 *  cron-pool, cap-exempt). The user paid for the first page; the operator pool
 *  drains the rest (mirrors reddit enqueueWalkerContinuation). */
async function enqueueTelegramBackfillContinuation(
  channelKey: string,
  dbCtx: DbOrTx,
): Promise<void> {
  await dbCtx.insert(adapterRefreshQueue).values({
    adapterKind: KIND,
    queueName: "service_source",
    type: "backfill_page",
    payload: { channel: channelKey },
    userId: null,
    priority: 0,
  });
}

/**
 * Atomic persist + continuation enqueue. The caller already finished the t.me
 * fetch + snapshot writes + event materialize; this helper runs the bookkeeping
 * pair inside ONE db.transaction so a crash between them leaves the walker in a
 * consistent recoverable state (either both happen — the walk continues — or
 * neither happens — the next cron tick picks it up from the still-pending
 * cursor). The CAS in persistTelegramWalkProgress also means a concurrent worker
 * tick that fetched the same page only enqueues the continuation once.
 *
 * Returns the CAS result so the caller's logging can report "lost the race; no
 * continuation enqueued for this tick". Mirrors reddit commitSubredditWalkProgress.
 */
export async function commitTelegramWalkProgress(
  channelKey: string,
  payload: {
    expectedBeforeCursor: string | null;
    nextBeforeCursor: string | null;
    backfillComplete: boolean;
    oldestPublishedAt: Date | null;
    collected: number;
  },
): Promise<TelegramPersistResult> {
  return db.transaction(async (tx) => {
    const persistResult = await persistTelegramWalkProgress(
      channelKey,
      {
        expectedBeforeCursor: payload.expectedBeforeCursor,
        nextBeforeCursor: payload.nextBeforeCursor,
        backfillComplete: payload.backfillComplete,
        oldestPublishedAt: payload.oldestPublishedAt,
        collected: payload.collected,
      },
      tx,
    );
    if (
      persistResult.committed &&
      !payload.backfillComplete &&
      payload.nextBeforeCursor !== null
    ) {
      await enqueueTelegramBackfillContinuation(channelKey, tx);
    }
    return persistResult;
  });
}

/**
 * Re-open a COMPLETE channel's deep walk after a window widen (G3 — fired by
 * telegramAdapter.resetWalkerStateOnWidening). Clears the sticky
 * `backfill_complete` flag and drops the metadata cursor + collected count so
 * the next backfill_page row re-enters page 1 (newest page, beforeCursor=null)
 * and walks toward the new (deeper) deepest-subscriber target. Mirrors reddit's
 * `backfillAfterCursor=null, backfillComplete=false` reset and YT/IG's state
 * clear.
 *
 * The frontier (`backfill_oldest_at`) is intentionally LEFT IN PLACE — it is the
 * deepest-walked watermark for display + the deeper-only WHERE guard, not a
 * resume cursor; a widen-reopened walk re-discovers older posts past it.
 *
 * Returns the number of channel-state rows that were complete and got reset (0
 * when the channel was never walked / already incomplete — caller logs a no-op).
 */
export async function resetTelegramWalkState(
  channelKey: string,
  dbCtx: DbOrTx = db,
): Promise<number> {
  const result = await dbCtx
    .update(dataSourceChannelState)
    .set({
      backfillComplete: false,
      metadata: sql`COALESCE(${dataSourceChannelState.metadata}, '{}'::jsonb) - 'lastBackfillCursor' - 'backfillCollected'`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(dataSourceChannelState.kind, KIND),
        eq(dataSourceChannelState.channelKey, channelKey),
        eq(dataSourceChannelState.backfillComplete, true),
      ),
    )
    .returning({ channelKey: dataSourceChannelState.channelKey });
  return result.length;
}
