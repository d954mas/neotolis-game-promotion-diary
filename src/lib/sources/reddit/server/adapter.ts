// Reddit per-source adapter CORE — the public-`.json` model.
//
// `redditAdapterCore` is the polling slice of DataSourceAdapter composed
// into the full `redditAdapter` in ./index.ts (mirrors YouTube's
// adapter.ts → index.ts barrel pattern).
//
// Polling is QUEUE-DRIVEN, not synchronous fetch. The 8-tick worker
// (handlers/worker-tick.ts) owns the actual HTTP. pollContent and
// pollStats ENQUEUE rows into reddit_refresh_queue and return
// placeholder shapes; the worker drains the queue at 8 req/min
// effective ceiling and writes real data via the type-specific
// handlers (sub-poll, author-poll, post-batch, post-single).
//
// pollStatsByVideoId returns an empty array — Reddit doesn't use
// per-video polling (listing endpoints return inline stats; post_batch
// refreshes stats by post_id directly).
//
// canRefreshPoll claims `reddit_post` only. parseUrl / parseSourceUrl
// are exposed for the cross-source URL router (parseAnyUrl) and the
// /sources/new auto-detect.

import { db } from "$lib/server/db/client.js";
import type {
  DataSourceAdapter,
  EventKind,
  ParsedSourceUrl,
  ParsedUrl,
  PollableEvent,
  PollableSource,
  RawEvent,
  StatsSnapshot,
} from "$lib/sources/adapter.js";
import { redditParsePostUrl, redditParseSourceUrl } from "./url.js";
import { redditRefreshQueue } from "./schema/index.js";
import { redditObservability } from "./observability.js";

type RedditAdapterCore = Pick<
  DataSourceAdapter,
  | "kind"
  | "parseUrl"
  | "parseSourceUrl"
  | "pollContent"
  | "pollStats"
  | "pollStatsByVideoId"
  | "canRefreshPoll"
  | "observability"
>;

interface RedditSourceMetadata {
  username?: string;
  subreddit?: string;
}

/** Reddit adapter polling core.
 *
 *  pollContent / pollStats enqueue work into reddit_refresh_queue rather
 *  than firing HTTP synchronously. The 8-tick worker (handlers/worker-tick.ts)
 *  drains the queue and writes events + snapshots via the type-specific
 *  handlers. From the cross-source code's view this is a normal adapter;
 *  it never sees the deferred-fetch semantics.
 *
 *  Same adapter instance handles BOTH reddit_account and reddit_subreddit
 *  source kinds — the registry (registry.ts) wires both keys to one
 *  redditAdapter instance and the adapter dispatches on source.metadata
 *  (username present → author_poll; subreddit present → sub_poll). */
export const redditAdapterCore: RedditAdapterCore = {
  // Declared kind matches the "primary" Reddit source kind; the registry
  // wires reddit_subreddit to the same instance. Cross-source code only
  // reads this field for diagnostic logs (e.g. worker-bootstrap's
  // in-process-rate-limiter audit).
  kind: "reddit_account",

  parseUrl(input: string): ParsedUrl | null {
    return redditParsePostUrl(input);
  },

  parseSourceUrl(input: string): ParsedSourceUrl | null {
    return redditParseSourceUrl(input);
  },

  /** Enqueue an author_poll (reddit_account) or sub_poll (reddit_subreddit)
   *  row into reddit_refresh_queue. Returns empty events — the worker
   *  populates the events table out-of-band when it drains the queue.
   *
   *  Origin maps to queue lane:
   *    origin='user' → user_source (cap-counted via redditRefreshQueue)
   *    origin='cron' → service_source (user_id NULL; cron-exempt)
   *
   *  Priority 1 for user-driven (jumps ahead of service-cron rows on the
   *  same lane); 0 for cron-driven (FIFO). The 8-tick worker's slot
   *  mapping (REDDIT_SLOT_MAPPING) handles cross-lane fairness; priority
   *  is the in-lane tiebreaker.
   *
   *  Since `since` is the worker's polling boundary — Reddit's listing
   *  endpoints don't support `since` filtering server-side (the listing
   *  walker stops at the first known post via DB lookup), so we pass it
   *  through metadata for the worker to consult opportunistically. */
  async pollContent(
    source: PollableSource,
    _since: Date,
    ctx?: { origin?: "cron" | "user"; walkStop?: "depth" | "overlap" },
  ): Promise<{ events: RawEvent[]; unitsUsed: number; endOfPlaylist?: boolean }> {
    const md = (source.metadata ?? {}) as RedditSourceMetadata;
    const isAccount = typeof md.username === "string" && md.username.length > 0;
    const isSub = typeof md.subreddit === "string" && md.subreddit.length > 0;
    if (!isAccount && !isSub) {
      // No identifier in metadata — nothing to enqueue. Caller's
      // backfill_complete bookkeeping continues unchanged.
      return { events: [], unitsUsed: 0 };
    }

    const isUser = ctx?.origin === "user";
    const queueName = isUser ? "user_source" : "service_source";
    const type = isAccount ? "author_poll" : "sub_poll";
    const payload = isAccount ? { handle: md.username! } : { sub: md.subreddit! };

    await db.insert(redditRefreshQueue).values({
      queueName,
      type,
      payload,
      // service-cron rows MUST have user_id NULL — that's the in-lane
      // cron-exemption sentinel the per-user cap counter (quota.ts)
      // filters on. Cap-counter correctness depends on this contract.
      userId: isUser ? source.userId : null,
      priority: isUser ? 1 : 0,
    });
    return { events: [], unitsUsed: 0 };
  },

  /** Enqueue a post_batch row (≤100 ids per row) for stats refresh.
   *  Returns placeholder snapshots with status='ok' and empty metrics —
   *  the worker writes the real reddit_post_snapshots rows out-of-band.
   *
   *  Caller (services/refresh-poll.ts) treats the returned snapshots as
   *  "queued — real data will appear after the next worker drain". The
   *  refresh-poll flow's stats UI surfaces "polling…" until the worker
   *  catches up; the cron post_batch eligibility query keeps the lane
   *  honest for any stragglers. */
  async pollStats(
    events: PollableEvent[],
    source: { id: string; userId: string } | null,
  ): Promise<StatsSnapshot[]> {
    if (events.length === 0) return [];

    // Strip the t3_ prefix if present so the worker handler receives the
    // bare id form. handlePostBatch normalizes both shapes but consistent
    // payloads are easier to inspect operationally.
    const postIds = events.map((e) =>
      e.externalId.startsWith("t3_") ? e.externalId.slice(3) : e.externalId,
    );

    const userId = source?.userId ?? events[0]?.userId ?? null;

    await db.insert(redditRefreshQueue).values({
      queueName: "user_post",
      type: "post_batch",
      payload: { post_ids: postIds },
      userId,
      priority: 1,
    });

    const now = new Date();
    return events.map((e) => ({
      eventId: e.id,
      polledAt: now,
      status: "ok" as const,
      metrics: {},
    }));
  },

  /** Reddit doesn't use per-video polling — listings inline stats and
   *  post_batch refreshes by post_id directly. Cross-source poll-cron
   *  handlers never call this for Reddit kinds (the scheduler uses
   *  Reddit's own cron schedules via redditAdapter.scheduleCronTicks). */
  async pollStatsByVideoId(): Promise<StatsSnapshot[]> {
    return [];
  },

  /** True only for reddit_post events. Cross-source refresh-poll
   *  (services/refresh-poll.ts) dispatches via this hint — Reddit
   *  refreshes get enqueued through pollStats above. */
  canRefreshPoll(eventKind: EventKind): boolean {
    return eventKind === "reddit_post";
  },

  observability: redditObservability,
};
