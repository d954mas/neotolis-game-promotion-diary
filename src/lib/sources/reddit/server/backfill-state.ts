// Reddit resumable-walker state, persisted on data_source_channel_state.metadata
// (clone of twitter/server/backfill-state.ts).
//
// SINGLE-FEED per source: both Reddit walkers return ONE `after` cursor + an
// end-of-feed signal (12-SPIKE Q3: the terminal page carries `after: null` while
// posts[] may still be non-empty). The author-search endpoint and the native
// subreddit endpoint share the SAME feed envelope + cursor shape (normalize.ts
// RedditFeedPage), so ONE state shape serves both kinds — only the
// data_source_channel_state.kind differs (`reddit_account` vs `reddit_subreddit`),
// threaded as a param so the two source kinds never collide on one channelKey.
//
// `backfill_complete` is set when the feed returned null-`after` (the spike-frozen
// end-of-feed signal) OR an empty page. The running collected-count (the
// SOCIAL_BACKFILL_MAX_POSTS bound) is tracked alongside so cost is independent of
// archive size and resumes across ticks.
//
// Shape (under metadata.reddit):
//   { cursor: string|null, complete: bool, collected: number, operatorPaused: bool }
//
// `operatorPaused` is the source-level UI hint that the operator's prepaid
// ScrapeCreators budget is spent / throttled, so the walker paused polling for this
// source. It lives HERE — on the source-of-truth channel-state row the walker
// already owns — NOT denormalized onto each event row (AGENTS.md no-denorm P0). The
// read side (feed-enrichment) overlays it onto each Reddit event DTO's
// metadata.operator_paused at load time so the PollingBadge lights up. ONE write
// flips it on pause and ONE on resume — no per-event fan-out, no stale-data bug.
//
// Reuses the same JSONB column the IG/TikTok/Twitter walkers use; the Reddit
// sub-tree lives under its own `reddit` key so the adapters never collide.

import { and, eq, sql } from "drizzle-orm";
import { db, type DbOrTx } from "$lib/server/db/client.js";
import { dataSourceChannelState } from "$lib/server/db/schema/data-source-channel-state.js";
import type { ChannelStateRow } from "$lib/server/services/channel-state.js";

/** The two Reddit source kinds a channel-state row anchors on. */
export type RedditSourceKind = "reddit_account" | "reddit_subreddit";

/** The ONE channel-scoped singleton key EVERY Reddit walk producer uses — initial
 *  create (onSourceCreated), manual refresh (backfillSource), the poll-cron ticks, and
 *  the widening reset. So at most ONE paid walk per (kind, channelKey) is queued/active
 *  at a time regardless of which tenant or producer triggered it: two tenants tracking
 *  the same channel, or manual+cron overlapping across worker replicas, dedupe to a
 *  single walk instead of double-spending the shared prepaid budget + racing channel
 *  state. Plain singletonKey ONLY (never paired with singletonSeconds): pg-boss keys
 *  singleton uniqueness on (queue, singletonKey, singleton_on), and a throttled send
 *  carries a non-null singleton_on while a plain send carries NULL — so mixing the two
 *  styles on one key would NOT dedupe against each other, re-opening the concurrent-walk
 *  gap this closes. */
export function redditWalkSingletonKey(kind: RedditSourceKind, channelKey: string): string {
  return `reddit-walk-${kind}-${channelKey}`;
}

export interface RedditBackfillState {
  /** The single feed's resume cursor (ProviderPage.nextCursor = the opaque base64
   *  `after` blob). null at end of feed / before the first page. */
  cursor: string | null;
  /** The single feed exhausted (null-`after` or an empty page). */
  complete: boolean;
  /** Running post-count toward SOCIAL_BACKFILL_MAX_POSTS, persisted across ticks so
   *  cost is independent of archive size. */
  collected: number;
  /** The operator's prepaid ScrapeCreators budget is spent / throttled and the
   *  walker paused this source's polling this tick. Surfaced to the PollingBadge via
   *  feed-enrichment's metadata.operator_paused overlay. Set true when a tick is
   *  paused by budget, false on a successful unpaused tick — so the badge is not
   *  sticky after the budget is restored. */
  operatorPaused: boolean;
  /** The depth-bound target (ISO) of the IN-PROGRESS deep backfill, persisted so a
   *  paused deep RESUMES to its ORIGINAL target rather than being truncated to the
   *  daily poll-cron's 14-day incremental window. Set when a fresh deep starts,
   *  carried across resume ticks, and cleared to null once the deep completes / a
   *  non-deep (incremental/exhausted) pass runs. null ⇒ no deep in progress. */
  deepTargetIso: string | null;
  /** CONSECUTIVE complete passes that saw ZERO posts. Corroboration counter for the
   *  "authoritative empty feed ⇒ the subject deleted everything" inference, which
   *  mass-flags the subject's whole cached history for GDPR purge. That inference is
   *  only as trustworthy as the feed: the ACCOUNT path is a broad
   *  `search?query=author:<handle>` against Reddit's SEARCH INDEX, which returns zero
   *  results for reasons that are not deletion (index rebuild, shadowban, temporary
   *  suspension, subs opting out of indexing). Acting on a single empty response would
   *  destroy author + permalink data for every tenant referencing those posts, and the
   *  flag is terminal by design (deletion_detected_by is nulled at purge, so
   *  clearReappearedDeletions can never un-flag it). Reset to 0 by any pass with
   *  sightings. */
  emptyPasses: number;
  /** Consecutive first-page 404s from the provider. Established sources require three
   * corroborating misses before needs_reconnect; one transient provider 404 must not
   * strand every tenant subscribed to the shared channel. */
  notFoundPasses: number;
}

const EMPTY: RedditBackfillState = {
  cursor: null,
  complete: false,
  collected: 0,
  operatorPaused: false,
  deepTargetIso: null,
  emptyPasses: 0,
  notFoundPasses: 0,
};

/** Read the Reddit backfill sub-state from a channel-state row's metadata, with
 *  safe defaults for a never-walked source. */
export function readRedditBackfillState(
  channelState: ChannelStateRow | undefined,
): RedditBackfillState {
  const r = (channelState?.metadata as { reddit?: Partial<RedditBackfillState> } | undefined)
    ?.reddit;
  return {
    cursor: typeof r?.cursor === "string" ? r.cursor : null,
    complete: r?.complete === true,
    collected: typeof r?.collected === "number" ? r.collected : 0,
    operatorPaused: r?.operatorPaused === true,
    deepTargetIso: typeof r?.deepTargetIso === "string" ? r.deepTargetIso : null,
    emptyPasses: typeof r?.emptyPasses === "number" ? r.emptyPasses : 0,
    notFoundPasses: typeof r?.notFoundPasses === "number" ? r.notFoundPasses : 0,
  };
}

/** Persist the Reddit backfill sub-state. Auto-creates the channel-state row for the
 *  given kind. Atomic JSONB merge under the metadata.reddit key — preserves any
 *  other adapter-specific metadata fields. */
export async function writeRedditBackfillState(
  kind: RedditSourceKind,
  channelKey: string,
  state: RedditBackfillState,
  dbCtx: DbOrTx = db,
): Promise<void> {
  const json = JSON.stringify(state);
  await dbCtx
    .insert(dataSourceChannelState)
    .values({
      kind,
      channelKey,
      metadata: sql`jsonb_build_object('reddit', ${json}::jsonb)`,
    })
    .onConflictDoUpdate({
      target: [dataSourceChannelState.kind, dataSourceChannelState.channelKey],
      set: {
        metadata: sql`jsonb_set(COALESCE(${dataSourceChannelState.metadata}, '{}'::jsonb), '{reddit}', ${json}::jsonb, true)`,
        updatedAt: new Date(),
      },
    });
}

/** Convenience: clear the Reddit sub-state (used when a widen forces a fresh deep
 *  walk). Resets the cursor + completion + the running count. */
export async function resetRedditBackfillState(
  kind: RedditSourceKind,
  channelKey: string,
  dbCtx: DbOrTx = db,
): Promise<void> {
  await writeRedditBackfillState(kind, channelKey, { ...EMPTY }, dbCtx);
}

/** Read the Reddit backfill sub-state directly by kind + channelKey (one SELECT). */
export async function getRedditBackfillState(
  kind: RedditSourceKind,
  channelKey: string,
  dbCtx: DbOrTx = db,
): Promise<RedditBackfillState> {
  const rows = await dbCtx
    .select({ metadata: dataSourceChannelState.metadata })
    .from(dataSourceChannelState)
    .where(
      and(eq(dataSourceChannelState.kind, kind), eq(dataSourceChannelState.channelKey, channelKey)),
    )
    .limit(1);
  return readRedditBackfillState(
    rows[0] ? ({ metadata: rows[0].metadata } as ChannelStateRow) : undefined,
  );
}
