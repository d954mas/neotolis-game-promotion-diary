// Instagram resumable-walker state, persisted on data_source_channel_state.metadata.
//
// The walker pages BOTH feeds (posts + reels), each its own cursor stream with
// its own end-of-feed sub-state (a reel-only account must NOT be marked complete
// because the posts feed ended). Account-level backfill_complete = both
// sub-feeds exhausted. The running collected-count (the BACK-01 post-count bound)
// is tracked alongside so cost is independent of archive size and resumes across
// ticks.
//
// Shape (under metadata.instagram):
//   { posts: { cursor: string|null, complete: bool },
//     reels: { cursor: string|null, complete: bool },
//     collected: number,
//     operatorPaused: bool }
//
// `operatorPaused` (BUDGET-01) is the account-level UI hint that the operator's
// prepaid social budget is spent / throttled, so the walker paused polling for
// this account. It lives HERE — on the source-of-truth channel-state row the
// walker already owns — NOT denormalized onto each event row (AGENTS.md
// no-denorm P0). The read side (feed-enrichment) overlays it onto each IG event
// DTO's metadata.operator_paused at load time (mirroring how fetchPollStateMap
// overlays publishedAt/lastPolledAt), so the PollingBadge lights up. ONE write
// flips it on pause and ONE on resume — no per-event fan-out, no stale-data bug.
//
// Reuses the same JSONB column the YouTube walker uses for lastBackfillPageToken;
// the IG sub-tree lives under its own `instagram` key so the two never collide.
// All writes go through ensureChannelState/markChannel* (the channel-state
// service) for last_polled_at / backfill_complete; this helper owns ONLY the
// IG-specific metadata sub-tree.

import { and, eq, sql } from "drizzle-orm";
import { db, type DbOrTx } from "$lib/server/db/client.js";
import { dataSourceChannelState } from "$lib/server/db/schema/data-source-channel-state.js";
import type { ChannelStateRow } from "$lib/server/services/channel-state.js";

const KIND = "instagram_account" as const;

export interface InstagramFeedState {
  cursor: string | null;
  complete: boolean;
}

export interface InstagramBackfillState {
  posts: InstagramFeedState;
  reels: InstagramFeedState;
  collected: number;
  /** BUDGET-01: the operator's prepaid social budget is spent / throttled and
   *  the walker paused this account's polling this tick. Surfaced to the
   *  PollingBadge via feed-enrichment's metadata.operator_paused overlay. The
   *  walker sets it true when a tick is paused by budget, false on a successful
   *  unpaused tick — so the badge is not sticky after the budget is restored. */
  operatorPaused: boolean;
}

const EMPTY_FEED: InstagramFeedState = { cursor: null, complete: false };

/** Read the IG backfill sub-state from a channel-state row's metadata, with
 *  safe defaults for a never-walked channel. */
export function readInstagramBackfillState(
  channelState: ChannelStateRow | undefined,
): InstagramBackfillState {
  const ig = (channelState?.metadata as { instagram?: Partial<InstagramBackfillState> } | undefined)
    ?.instagram;
  return {
    posts: { ...EMPTY_FEED, ...(ig?.posts ?? {}) },
    reels: { ...EMPTY_FEED, ...(ig?.reels ?? {}) },
    collected: typeof ig?.collected === "number" ? ig.collected : 0,
    operatorPaused: ig?.operatorPaused === true,
  };
}

/** Persist the IG backfill sub-state. Auto-creates the channel-state row.
 *  Atomic JSONB merge under the metadata.instagram key — preserves any other
 *  adapter-specific metadata fields (e.g. a future lastBackfillPageToken). */
export async function writeInstagramBackfillState(
  channelKey: string,
  state: InstagramBackfillState,
  dbCtx: DbOrTx = db,
): Promise<void> {
  const json = JSON.stringify(state);
  await dbCtx
    .insert(dataSourceChannelState)
    .values({
      kind: KIND,
      channelKey,
      metadata: sql`jsonb_build_object('instagram', ${json}::jsonb)`,
    })
    .onConflictDoUpdate({
      target: [dataSourceChannelState.kind, dataSourceChannelState.channelKey],
      set: {
        metadata: sql`jsonb_set(COALESCE(${dataSourceChannelState.metadata}, '{}'::jsonb), '{instagram}', ${json}::jsonb, true)`,
        updatedAt: new Date(),
      },
    });
}

/** Convenience: clear the IG sub-state (used when a widen forces a fresh deep
 *  walk). Resets both feeds' cursors + completion and the running count. */
export async function resetInstagramBackfillState(
  channelKey: string,
  dbCtx: DbOrTx = db,
): Promise<void> {
  await writeInstagramBackfillState(
    channelKey,
    { posts: { ...EMPTY_FEED }, reels: { ...EMPTY_FEED }, collected: 0, operatorPaused: false },
    dbCtx,
  );
}

/** Read the IG backfill sub-state directly by channelKey (one SELECT). */
export async function getInstagramBackfillState(
  channelKey: string,
  dbCtx: DbOrTx = db,
): Promise<InstagramBackfillState> {
  const rows = await dbCtx
    .select({ metadata: dataSourceChannelState.metadata })
    .from(dataSourceChannelState)
    .where(
      and(eq(dataSourceChannelState.kind, KIND), eq(dataSourceChannelState.channelKey, channelKey)),
    )
    .limit(1);
  return readInstagramBackfillState(
    rows[0] ? ({ metadata: rows[0].metadata } as ChannelStateRow) : undefined,
  );
}
