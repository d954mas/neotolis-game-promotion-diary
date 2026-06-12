// TikTok resumable-walker state, persisted on data_source_channel_state.metadata.
//
// SINGLE-FEED (RESEARCH Pattern 2): unlike Instagram (which juggles BOTH a posts
// and a reels feed, each its own cursor + completion sub-state), TikTok is ONE
// feed — `/v3/tiktok/profile/videos` returns one `max_cursor` and one `has_more`
// (10-SPIKE.md Call 1). So this state collapses IG's posts/reels two-cursor split
// to ONE cursor + ONE backfill_complete. `backfill_complete` is set when the
// single feed returned `has_more !== 1` (the normalizer's endOfFeed) or an empty
// page. The running collected-count (the BACK-01 post-count bound) is tracked
// alongside so cost is independent of archive size and resumes across ticks.
//
// Shape (under metadata.tiktok):
//   { cursor: string|null, complete: bool, collected: number, operatorPaused: bool }
//
// `operatorPaused` (BUDGET-01) is the account-level UI hint that the operator's
// prepaid social budget is spent / throttled, so the walker paused polling for
// this account. It lives HERE — on the source-of-truth channel-state row the
// walker already owns — NOT denormalized onto each event row (AGENTS.md no-denorm
// P0). The read side (feed-enrichment) overlays it onto each TikTok event DTO's
// metadata.operator_paused at load time, so the PollingBadge lights up. ONE write
// flips it on pause and ONE on resume — no per-event fan-out, no stale-data bug.
//
// Reuses the same JSONB column the IG/YouTube walkers use; the TikTok sub-tree
// lives under its own `tiktok` key so the adapters never collide. All writes go
// through ensureChannelState/markChannel* (the channel-state service) for
// last_polled_at / backfill_complete; this helper owns ONLY the TikTok-specific
// metadata sub-tree.

import { and, eq, sql } from "drizzle-orm";
import { db, type DbOrTx } from "$lib/server/db/client.js";
import { dataSourceChannelState } from "$lib/server/db/schema/data-source-channel-state.js";
import type { ChannelStateRow } from "$lib/server/services/channel-state.js";

const KIND = "tiktok_account" as const;

export interface TikTokBackfillState {
  /** The single feed's resume cursor (ProviderPage.nextCursor — the coerced
   *  max_cursor string). null at end of feed / before the first page. */
  cursor: string | null;
  /** The single feed exhausted (has_more !== 1 or an empty page). */
  complete: boolean;
  /** Running BACK-01 post-count toward SOCIAL_BACKFILL_MAX_POSTS, persisted across
   *  ticks so cost is independent of archive size. */
  collected: number;
  /** BUDGET-01: the operator's prepaid social budget is spent / throttled and the
   *  walker paused this account's polling this tick. Surfaced to the PollingBadge
   *  via feed-enrichment's metadata.operator_paused overlay. Set true when a tick
   *  is paused by budget, false on a successful unpaused tick — so the badge is
   *  not sticky after the budget is restored. */
  operatorPaused: boolean;
}

const EMPTY: TikTokBackfillState = {
  cursor: null,
  complete: false,
  collected: 0,
  operatorPaused: false,
};

/** Read the TikTok backfill sub-state from a channel-state row's metadata, with
 *  safe defaults for a never-walked channel. */
export function readTikTokBackfillState(
  channelState: ChannelStateRow | undefined,
): TikTokBackfillState {
  const tk = (channelState?.metadata as { tiktok?: Partial<TikTokBackfillState> } | undefined)
    ?.tiktok;
  return {
    cursor: typeof tk?.cursor === "string" ? tk.cursor : null,
    complete: tk?.complete === true,
    collected: typeof tk?.collected === "number" ? tk.collected : 0,
    operatorPaused: tk?.operatorPaused === true,
  };
}

/** Persist the TikTok backfill sub-state. Auto-creates the channel-state row.
 *  Atomic JSONB merge under the metadata.tiktok key — preserves any other
 *  adapter-specific metadata fields. */
export async function writeTikTokBackfillState(
  channelKey: string,
  state: TikTokBackfillState,
  dbCtx: DbOrTx = db,
): Promise<void> {
  const json = JSON.stringify(state);
  await dbCtx
    .insert(dataSourceChannelState)
    .values({
      kind: KIND,
      channelKey,
      metadata: sql`jsonb_build_object('tiktok', ${json}::jsonb)`,
    })
    .onConflictDoUpdate({
      target: [dataSourceChannelState.kind, dataSourceChannelState.channelKey],
      set: {
        metadata: sql`jsonb_set(COALESCE(${dataSourceChannelState.metadata}, '{}'::jsonb), '{tiktok}', ${json}::jsonb, true)`,
        updatedAt: new Date(),
      },
    });
}

/** Convenience: clear the TikTok sub-state (used when a widen forces a fresh deep
 *  walk). Resets the cursor + completion + the running count. */
export async function resetTikTokBackfillState(
  channelKey: string,
  dbCtx: DbOrTx = db,
): Promise<void> {
  await writeTikTokBackfillState(channelKey, { ...EMPTY }, dbCtx);
}

/** Read the TikTok backfill sub-state directly by channelKey (one SELECT). */
export async function getTikTokBackfillState(
  channelKey: string,
  dbCtx: DbOrTx = db,
): Promise<TikTokBackfillState> {
  const rows = await dbCtx
    .select({ metadata: dataSourceChannelState.metadata })
    .from(dataSourceChannelState)
    .where(
      and(eq(dataSourceChannelState.kind, KIND), eq(dataSourceChannelState.channelKey, channelKey)),
    )
    .limit(1);
  return readTikTokBackfillState(
    rows[0] ? ({ metadata: rows[0].metadata } as ChannelStateRow) : undefined,
  );
}
