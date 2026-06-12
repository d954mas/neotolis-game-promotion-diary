// Twitter/X resumable-walker state, persisted on data_source_channel_state.metadata.
//
// SINGLE-FEED (RESEARCH Pattern 4): `/twitter/user/last_tweets` returns ONE
// next_cursor (a STRING) + ONE has_next_page (a boolean — 11-SPIKE.md Q2). So this
// state is one cursor + one backfill_complete, structurally identical to TikTok's
// single feed. `backfill_complete` is set when the single feed returned
// `!has_next_page || !next_cursor` (the spike-confirmed end-of-feed signal) or an
// empty page. The running collected-count (the BACK-01 post-count bound) is tracked
// alongside so cost is independent of archive size and resumes across ticks.
//
// CURSOR DELTA vs TikTok: twitterapi.io's cursor is ALREADY a string (first page is
// the empty string `""`, mapped to null by the normalizer), so there is NO
// number→string coercion (TikTok's max_cursor was a number it had to String()). The
// cursor we persist is the ProviderPage.nextCursor the normalizer already
// stringified.
//
// Shape (under metadata.twitter):
//   { cursor: string|null, complete: bool, collected: number, operatorPaused: bool }
//
// `operatorPaused` (BUDGET-01) is the account-level UI hint that the operator's
// prepaid twitterapi.io budget is spent / throttled, so the walker paused polling for
// this account. It lives HERE — on the source-of-truth channel-state row the walker
// already owns — NOT denormalized onto each event row (AGENTS.md no-denorm P0). The
// read side (feed-enrichment) overlays it onto each Twitter event DTO's
// metadata.operator_paused at load time, so the PollingBadge lights up. ONE write
// flips it on pause and ONE on resume — no per-event fan-out, no stale-data bug.
//
// Reuses the same JSONB column the IG/TikTok/YouTube walkers use; the Twitter
// sub-tree lives under its own `twitter` key so the adapters never collide. All
// writes go through ensureChannelState/markChannel* (the channel-state service) for
// last_polled_at / backfill_complete; this helper owns ONLY the Twitter-specific
// metadata sub-tree.

import { and, eq, sql } from "drizzle-orm";
import { db, type DbOrTx } from "$lib/server/db/client.js";
import { dataSourceChannelState } from "$lib/server/db/schema/data-source-channel-state.js";
import type { ChannelStateRow } from "$lib/server/services/channel-state.js";

const KIND = "twitter_account" as const;

export interface TwitterBackfillState {
  /** The single feed's resume cursor (ProviderPage.nextCursor — already a string;
   *  the normalizer maps the first-page empty string to null). null at end of feed /
   *  before the first page. */
  cursor: string | null;
  /** The single feed exhausted (!has_next_page || !next_cursor or an empty page). */
  complete: boolean;
  /** Running BACK-01 post-count toward SOCIAL_BACKFILL_MAX_POSTS, persisted across
   *  ticks so cost is independent of archive size. */
  collected: number;
  /** BUDGET-01: the operator's prepaid twitterapi.io budget is spent / throttled and
   *  the walker paused this account's polling this tick. Surfaced to the
   *  PollingBadge via feed-enrichment's metadata.operator_paused overlay. Set true
   *  when a tick is paused by budget, false on a successful unpaused tick — so the
   *  badge is not sticky after the budget is restored. */
  operatorPaused: boolean;
}

const EMPTY: TwitterBackfillState = {
  cursor: null,
  complete: false,
  collected: 0,
  operatorPaused: false,
};

/** Read the Twitter backfill sub-state from a channel-state row's metadata, with
 *  safe defaults for a never-walked channel. */
export function readTwitterBackfillState(
  channelState: ChannelStateRow | undefined,
): TwitterBackfillState {
  const tw = (channelState?.metadata as { twitter?: Partial<TwitterBackfillState> } | undefined)
    ?.twitter;
  return {
    cursor: typeof tw?.cursor === "string" ? tw.cursor : null,
    complete: tw?.complete === true,
    collected: typeof tw?.collected === "number" ? tw.collected : 0,
    operatorPaused: tw?.operatorPaused === true,
  };
}

/** Persist the Twitter backfill sub-state. Auto-creates the channel-state row.
 *  Atomic JSONB merge under the metadata.twitter key — preserves any other
 *  adapter-specific metadata fields. */
export async function writeTwitterBackfillState(
  channelKey: string,
  state: TwitterBackfillState,
  dbCtx: DbOrTx = db,
): Promise<void> {
  const json = JSON.stringify(state);
  await dbCtx
    .insert(dataSourceChannelState)
    .values({
      kind: KIND,
      channelKey,
      metadata: sql`jsonb_build_object('twitter', ${json}::jsonb)`,
    })
    .onConflictDoUpdate({
      target: [dataSourceChannelState.kind, dataSourceChannelState.channelKey],
      set: {
        metadata: sql`jsonb_set(COALESCE(${dataSourceChannelState.metadata}, '{}'::jsonb), '{twitter}', ${json}::jsonb, true)`,
        updatedAt: new Date(),
      },
    });
}

/** Convenience: clear the Twitter sub-state (used when a widen forces a fresh deep
 *  walk). Resets the cursor + completion + the running count. */
export async function resetTwitterBackfillState(
  channelKey: string,
  dbCtx: DbOrTx = db,
): Promise<void> {
  await writeTwitterBackfillState(channelKey, { ...EMPTY }, dbCtx);
}

/** Read the Twitter backfill sub-state directly by channelKey (one SELECT). */
export async function getTwitterBackfillState(
  channelKey: string,
  dbCtx: DbOrTx = db,
): Promise<TwitterBackfillState> {
  const rows = await dbCtx
    .select({ metadata: dataSourceChannelState.metadata })
    .from(dataSourceChannelState)
    .where(
      and(eq(dataSourceChannelState.kind, KIND), eq(dataSourceChannelState.channelKey, channelKey)),
    )
    .limit(1);
  return readTwitterBackfillState(
    rows[0] ? ({ metadata: rows[0].metadata } as ChannelStateRow) : undefined,
  );
}
