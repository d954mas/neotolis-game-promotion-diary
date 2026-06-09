// Telegram per-source server barrel — the FREE t.me/s scrape adapter (no
// secret, no OAuth, no provider key).
//
// Cross-source code imports ONLY from this file: it sees `telegramAdapter` (the
// SourceAdapter implementation). The internal modules (adapter, http, parse,
// url, schema, handlers, pacer, snapshots, observability, readers) wire together
// inside this folder.
//
// Per-kind queue topology (Reddit DV-RDT-7 "cron enqueues, lane fetches" model):
//   telegram.poll.cron  — ONE pg-boss cron queue carrying THREE tier schedules
//     via boss.schedule({key}): active (6h listing), cold (daily), warm (hourly
//     per-post producer). The cron handler reads job.data.tier and dispatches:
//       tier='warm'          → handleTelegramWarmRefresh (BEFORE the listing
//                              picker — it is a DIFFERENT op: per-post, not page-1)
//       tier='active'|'cold' → enqueue a service_source listing_poll lane row per
//                              subscribed channel. ZERO t.me HTTP in the cron —
//                              it only INSERTs adapter_refresh_queue rows.
//   The Telegram lane batch-worker (workQueue.scheduledWorkers, bootstrapped by
//   src/worker/index.ts) drains those rows through the global pacer.
//
// NO quota_reset queue (free, no daily cap) and NO separate backfill pg-boss
// queue (the walker drains via adapter_refresh_queue lane rows). ONE pg-boss
// cron queue only.
//
// isOperatorConfigured / isEnabled are ALWAYS true: Telegram needs no secret to
// function (the structural contrast with Reddit's REDDIT_USER_AGENT gate and
// IG's provider-key gate).

import type {
  AdapterContext,
  BackfillWindow,
  EventKind,
  EventPreviewMetadata,
  MinimalBoss,
  NormalizeSourceInput,
  NormalizeSourceResult,
  PollableSource,
  SourceAdapter,
  SourceCreatedHookSource,
} from "$lib/sources/adapter.js";
import { and, eq, isNull, sql } from "drizzle-orm";
import { QUEUES } from "$lib/server/queues.js";
import { db, type DbOrTx, type Tx } from "$lib/server/db/client.js";
import { dataSources } from "$lib/server/db/schema/data-sources.js";
import { adapterRefreshQueue } from "$lib/server/db/schema/index.js";
import { adapterRefreshQueueLabel } from "$lib/server/services/adapter-lane-worker.js";
import { logger } from "$lib/server/logger.js";
import { AppError } from "$lib/server/services/errors.js";
import { AdapterError } from "$lib/sources/errors.js";
import { telegramChannelAdapterCore } from "./adapter.js";
import { telegramObservability } from "./observability.js";
import { telegramParsePostUrl, telegramParseSourceUrl } from "./url.js";
import { fetchTelegramPost } from "./http.js";
import { parseTelegramPost } from "./parse.js";
import { writeTelegramSnapshot } from "./snapshots.js";
import { getTelegramWalkState, resetTelegramWalkState } from "./walker-state.js";
import { handleTelegramWarmRefresh } from "./handlers/warm-refresh.js";
import {
  telegramWorkerTick,
  TELEGRAM_SLOT_MAPPING,
  FALLTHROUGH_ORDER,
} from "./handlers/worker-tick.js";

const TELEGRAM_BASE = "https://t.me";

const KIND = "telegram_channel" as const;

interface TelegramSourceMetadata {
  channel?: string;
}

/** Resolve the channel slug from a source's metadata (the URL-intrinsic handle
 *  injected by normalizeSourceOnCreate — the safe-denorm provider key). Falls
 *  back to source.id only for a malformed row (defensive; createSource always
 *  sets metadata.channel). */
function channelOf(source: { id: string; metadata: Record<string, unknown> }): string | null {
  const md = (source.metadata ?? {}) as TelegramSourceMetadata;
  return typeof md.channel === "string" && md.channel !== "" ? md.channel : null;
}

/** registerQueues — create the single telegram.poll.cron pg-boss queue + its
 *  tier-dispatching work handler. The cron handler does ZERO t.me HTTP: warm
 *  enqueues per-post service_post rows; active/cold enqueue per-channel
 *  service_source listing_poll rows. The lane batch-worker (workQueue) drains
 *  them through the pacer.
 *
 *  batchSize=2 lets the active/cold/warm ticks drain without head-of-line
 *  blocking (mirrors the IG poll.cron). */
async function registerQueues(boss: MinimalBoss): Promise<void> {
  await boss.createQueue(QUEUES.TELEGRAM_POLL_CRON);

  await boss.work(QUEUES.TELEGRAM_POLL_CRON, { batchSize: 2 }, async (jobs) => {
    for (const job of jobs) {
      await handleTelegramPollCron(job as { id?: string; data: { tier: "active" | "cold" | "warm" } });
    }
  });
}

/** poll.cron handler — dispatches on job.data.tier. ZERO t.me HTTP. */
async function handleTelegramPollCron(job: {
  id?: string;
  data: { tier: "active" | "cold" | "warm" };
}): Promise<void> {
  const tier = job.data.tier;

  // Warm runs FIRST and is a DIFFERENT operation (per-post ?embed=1 producer,
  // NOT the page-1 listing walk), so it branches before the listing picker.
  if (tier === "warm") {
    await handleTelegramWarmRefresh({ id: job.id });
    return;
  }

  // active / cold: enqueue one service_source listing_poll lane row per
  // subscribed channel. The picker selects DISTINCT channels from
  // auto-import-enabled, non-deleted telegram_channel sources. Cron does ZERO
  // t.me HTTP — it only INSERTs lane rows; the lane worker fetches.
  await enqueueServiceListingPolls(tier, job.id);
}

/** Picker + enqueue: one service_source listing_poll row per distinct channel
 *  with an active auto-import telegram_channel source. user_id=NULL → cron-pool
 *  (cap-exempt). Skip-if-pending dedup keeps a channel from piling up if the
 *  prior tick's row hasn't drained. */
async function enqueueServiceListingPolls(
  tier: "active" | "cold",
  jobId: string | undefined,
): Promise<number> {
  // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- cron picker is service-wide: it enqueues ONE listing poll per channel across ALL tenants (one fetch serves every subscriber); the per-channel lane row is user_id=NULL cron-pool work.
  const sourceRows = await db
    .selectDistinct({ metadata: dataSources.metadata })
    .from(dataSources)
    .where(
      and(eq(dataSources.kind, KIND), eq(dataSources.autoImport, true), isNull(dataSources.deletedAt)),
    );
  const channels = [
    ...new Set(
      sourceRows
        .map((r) => channelOf({ id: "", metadata: (r.metadata ?? {}) as Record<string, unknown> }))
        .filter((c): c is string => c !== null),
    ),
  ];
  if (channels.length === 0) {
    logger.debug({ jobId, tier }, "telegram.poll.cron: no auto-import channels to enqueue");
    return 0;
  }

  let enqueued = 0;
  for (const channel of channels) {
    // Skip-if-pending dedup: don't stack a second listing_poll for a channel
    // whose prior row hasn't drained yet.
    // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- service_source lane scan: the cron picker writes user_id=NULL listing rows keyed by channel slug across ALL tenants (one fetch serves every subscriber); tenant scope does not apply.
    const existing = await db
      .select({ id: adapterRefreshQueue.id })
      .from(adapterRefreshQueue)
      .where(
        and(
          eq(adapterRefreshQueue.adapterKind, KIND),
          eq(adapterRefreshQueue.queueName, "service_source"),
          eq(adapterRefreshQueue.type, "listing_poll"),
          sql`${adapterRefreshQueue.status} IN ('pending','processing')`,
          sql`${adapterRefreshQueue.payload}->>'channel' = ${channel}`,
        ),
      )
      .limit(1);
    if (existing.length > 0) continue;
    await db.insert(adapterRefreshQueue).values({
      adapterKind: KIND,
      queueName: "service_source",
      type: "listing_poll",
      payload: { channel },
      userId: null,
      priority: 0,
    });
    enqueued += 1;
  }
  logger.info(
    { jobId, tier, channels: channels.length, enqueued },
    "telegram.poll.cron: service_source listing_poll rows enqueued",
  );
  return enqueued;
}

/** scheduleCronTicks — the 6h listing tick + daily cold tick + hourly warm
 *  producer. All on the single telegram.poll.cron queue via key-based schedules.
 *  NO quota_reset (free). */
async function scheduleCronTicks(boss: MinimalBoss): Promise<void> {
  // Active listing tick — every 6h (D-04). The page-1 walk re-stamps the newest
  // ~20 posts' view snapshots for free; the 12h warm staleness gate sits above
  // this interval so on-listing posts never enter the warm lane.
  await boss.schedule(QUEUES.TELEGRAM_POLL_CRON, "0 */6 * * *", { tier: "active" }, { key: "active" });
  // Cold listing tick — daily (same listing-poll path; the picker is identical,
  // the tier is informational for now since Telegram has no separate cold lane).
  await boss.schedule(QUEUES.TELEGRAM_POLL_CRON, "0 5 * * *", { tier: "cold" }, { key: "cold" });
  // Warm per-post producer — hourly. The 12h staleness gate self-paces a post to
  // ~1 refresh/12h regardless of the producer cadence; hourly just picks it up
  // promptly after it crosses the gate (skip-if-pending dedup prevents pile-up).
  await boss.schedule(QUEUES.TELEGRAM_POLL_CRON, "0 * * * *", { tier: "warm" }, { key: "warm" });
}

/** backfillSource — user-driven "Pull new content" / cron-driven initial fetch.
 *  INSERTs a backfill_page row into adapter_refresh_queue; the lane worker drains
 *  it one page per tick. Mirrors reddit backfillSource (direct insert, NOT
 *  pg-boss).
 *
 *  origin → lane mapping:
 *    'user' → user_source   (user_id SET, latency-prioritized slots)
 *    'cron' → service_source (user_id NULL, cap-exempt) */
async function backfillSource(
  source: PollableSource,
  ctx: AdapterContext,
): Promise<{ jobId: string | null; queue: string }> {
  const channel = channelOf(source);
  if (channel === null) {
    logger.warn(
      { sourceId: source.id },
      "telegram.backfillSource: metadata.channel missing; skipping enqueue",
    );
    return { jobId: null, queue: adapterRefreshQueueLabel(KIND, "noop") };
  }
  const isUser = ctx.origin === "user";
  const queueName = isUser ? "user_source" : "service_source";
  const dbCtx = ctx.tx ?? db;
  const [row] = await dbCtx
    .insert(adapterRefreshQueue)
    .values({
      adapterKind: KIND,
      queueName,
      // First page of a backfill walk — getTelegramWalkState returns
      // beforeCursor=null on a never-walked channel, so this fetches the newest
      // page and the walker's continuation rows drain the rest.
      type: "backfill_page",
      payload: { channel },
      userId: isUser ? ctx.userId : null,
      priority: isUser ? -10 : 0,
    })
    .returning({ id: adapterRefreshQueue.id });
  return {
    jobId: row ? String(row.id) : null,
    queue: adapterRefreshQueueLabel(KIND, queueName),
  };
}

/** normalizeSourceOnCreate — pure (no I/O). Parse the @handle / bare / t.me URL
 *  via telegramParseSourceUrl, canonicalize the handle_url, and inject
 *  metadata.channel = handle (the URL-intrinsic provider key — the safe-denorm
 *  carve-out, mirroring Reddit's metadata.username injection). The channel title
 *  is seeded LATER by the first listing poll (Telegram has no synchronous
 *  resolve that wouldn't burn a t.me call). Throws AppError 422 when
 *  unparseable. */
async function normalizeSourceOnCreate(input: NormalizeSourceInput): Promise<NormalizeSourceResult> {
  const parsed = telegramParseSourceUrl(input.handleUrl);
  if (parsed === null) {
    throw new AppError(
      "Paste a Telegram channel URL or @handle (e.g. https://t.me/<channel> or @<channel>).",
      "invalid_handle_url",
      422,
      { kind: input.kind, handleUrl: input.handleUrl },
    );
  }
  return {
    handleUrl: parsed.externalUrl,
    channelId: input.channelId ?? null,
    metadata: {
      ...(input.metadata ?? {}),
      channel: parsed.handle,
    },
  };
}

/** onSourceCreated — enqueue the initial backfill on createSource (inside the
 *  createSource transaction via the tx). Only fires when autoImport. The trigger
 *  is user-driven (they just registered the source), so the row lands on the
 *  user_source lane with origin="user" — matching Reddit's onboarding intent.
 *
 *  The chosen window is NOT threaded into the queue payload: createSource has
 *  already persisted it as the row's absolute `backfillTargetSince` (the source
 *  of truth) BEFORE this hook runs, and the walker
 *  (handlers/backfill-walker.ts resolveDeepestTargetSince) reads the deepest
 *  subscriber target straight off `data_sources` at walk time. That bounds the
 *  deep walk to the window (B1) — a multi-subscriber channel's cron continuation
 *  pages have no single window to carry in a payload, so the persisted column is
 *  the correct, denorm-free source. `opts.backfillWindow` is intentionally
 *  unused here for that reason. */
async function onSourceCreated(
  source: SourceCreatedHookSource,
  opts: { backfillWindow: BackfillWindow; tx: Tx },
): Promise<void> {
  if (!source.autoImport) return;
  void opts.backfillWindow; // honored via the persisted backfillTargetSince — see docstring
  await backfillSource(
    { id: source.id, userId: source.userId, metadata: source.metadata },
    { userId: source.userId, origin: "user", tx: opts.tx },
  );
}

/**
 * resetWalkerStateOnWidening — cross-source hook fired by updateSource when the
 * user widens backfillTargetSince past the prior value (G3). Telegram's walker
 * state lives on the cross-tenant data_source_channel_state row (one per slug);
 * mirrors reddit's reset (cache row + adapter_refresh_queue continuation):
 *   1. resetTelegramWalkState clears backfill_complete + drops the metadata
 *      cursor/collected so the next backfill_page re-enters page 1 and walks
 *      toward the new (deeper) deepest-subscriber target (the walker reads that
 *      target off data_sources at walk time — resolveDeepestTargetSince).
 *   2. Enqueue a user_source backfill_page row to kick the walk off immediately;
 *      the walker's continuation enqueue then drains the rest on the service lane.
 *
 * NO per-user cap gate (unlike reddit/IG): Telegram is FREE — there is no
 * operator budget or user fair-share to protect, so a widen costs nothing.
 *
 * No-op when: the source carries no metadata.channel (defensive — createSource
 * always sets it), OR the channel-state row wasn't in the complete state (an
 * incomplete walk already deepens on its own next tick; resetTelegramWalkState
 * returns 0). Runs inside the updateSource transaction.
 */
async function resetWalkerStateOnWidening(
  source: SourceCreatedHookSource,
  ctx: {
    previousTarget: Date | null;
    newTarget: Date;
    triggerUserId: string;
    ipAddress: string;
    tx: Tx;
  },
): Promise<void> {
  if (source.kind !== KIND) return;
  const channel = channelOf({
    id: source.id,
    metadata: (source.metadata ?? {}) as Record<string, unknown>,
  });
  if (channel === null) return;

  // Only re-open a genuinely COMPLETE walk whose frontier the new target crosses.
  // An incomplete walk continues deepening on its own next tick (no reset needed).
  const state = await getTelegramWalkState(channel, ctx.tx);
  if (!state.backfillComplete) return;
  if (
    state.backfillOldestAt !== null &&
    ctx.newTarget.getTime() >= state.backfillOldestAt.getTime()
  ) {
    // The widened target is still shallower-or-equal to what we already walked —
    // nothing deeper to fetch.
    return;
  }

  const resetCount = await resetTelegramWalkState(channel, ctx.tx);
  if (resetCount === 0) {
    logger.debug(
      { channel, triggerUserId: ctx.triggerUserId },
      "telegram.resetWalkerStateOnWidening: channel-state not in complete state; no-op",
    );
    return;
  }

  // Kick an immediate user_source backfill_page (origin="user") so the deep walk
  // restarts now; continuation pages drain on the service lane afterwards.
  await ctx.tx.insert(adapterRefreshQueue).values({
    adapterKind: KIND,
    queueName: "user_source",
    type: "backfill_page",
    payload: { channel },
    userId: ctx.triggerUserId,
    priority: -10,
  });
}

/** validateEventInput — a telegram_post event requires a t.me post URL. */
function validateEventInput(input: { kind: string; url?: string | null }): void {
  if (input.kind !== "telegram_post") return;
  if (!input.url) {
    throw new AppError("url is required when kind=telegram_post", "kind_url_inconsistent", 422, {
      reason: "telegram_post_requires_url",
    });
  }
  const parsed = telegramParsePostUrl(input.url);
  if (parsed === null || parsed.kind !== "telegram_post") {
    throw new AppError("url is not a recognized Telegram post URL", "kind_url_inconsistent", 422, {
      reason: "url_not_telegram_post",
    });
  }
}

/** Split "<channel>/<messageId>" → { channel, messageId }, or null when the
 *  shape is wrong. Telegram message ids are per-channel sequential and NOT
 *  globally unique (RESEARCH Q3), so the composite is the stable post id. */
function splitTelegramPostId(postId: string): { channel: string; messageId: string } | null {
  const slash = postId.indexOf("/");
  if (slash <= 0 || slash === postId.length - 1) return null;
  return { channel: postId.slice(0, slash), messageId: postId.slice(slash + 1) };
}

/** Shared single-post fetch core for the sync paste + preview paths. Issues ONE
 *  ?embed=1 GET through the DEFAULT "acquire" pacer (a sync user path owns its
 *  own slot — the lane worker's "already-acquired" is a worker-only contract),
 *  parses the embed widget, and UPSERTs telegram_posts + a snapshot via
 *  writeTelegramSnapshot so the saved event renders views immediately (mirrors
 *  the warm-lane handleWarmPostFetch + Reddit handlePostSingle / IG
 *  fetchPostByUrl→writeSnapshot). A null parse → a not_found snapshot (the
 *  telegram_posts row still stamps last_polled_at) and a null parsed result so
 *  the caller degrades. AdapterError propagates (the caller maps it to the
 *  graceful-degrade discriminator). */
async function fetchTelegramPostSingle(
  channel: string,
  messageId: string,
): Promise<import("./parse.js").ParsedTelegramPost | null> {
  const postId = `${channel}/${messageId}`;
  const externalUrl = `${TELEGRAM_BASE}/${postId}`;
  const html = await fetchTelegramPost(channel, messageId);
  const parsed = parseTelegramPost(html);
  if (parsed === null) {
    await writeTelegramSnapshot({ postId, externalUrl, viewCount: null, status: "not_found" });
    return null;
  }
  await writeTelegramSnapshot({
    postId,
    textSnippet: parsed.textSnippet,
    mediaKind: parsed.mediaKind,
    thumbnailUrl: parsed.thumbnailUrl,
    externalUrl,
    publishedAt: parsed.publishedAt,
    viewCount: parsed.viewCount,
    status: "ok",
  });
  return parsed;
}

/**
 * fetchEventPreviewMetadata — adapter wrapper for the Add Event "Fetch" button
 * (POST /api/events/preview-url). Mirrors Reddit's / IG's synchronous single-post
 * preview: ONE ?embed=1 t.me GET (free — no credit, no cap), then UPSERTs the
 * telegram_posts cache + a snapshot so the saved event renders views immediately
 * in /feed (exactly like Reddit's preview UPSERTs reddit_posts + a snapshot, and
 * IG's preview UPSERTs instagram_posts + a snapshot).
 *
 * The Telegram externalId IS URL-derivable ("<channel>/<messageId>" — RESEARCH
 * Q3) and matches telegram_posts.post_id directly, so this preview does NOT set
 * EventPreviewMetadata.externalId (the caller keeps the URL-parsed value, the
 * opposite of IG which must override with the non-URL media id). NO
 * resolveCachedExternalId is needed for the same reason.
 *
 * Graceful-degrade discriminators (mirrors Reddit's mapping):
 *   - URL not a t.me post  → unreachable(url_not_telegram_post)
 *   - null parse (deleted / private / nonexistent — t.me serves HTTP 200 with no
 *     widget block) → unavailable
 *   - AdapterError not-found → unavailable
 *   - AdapterError rate-limited (pacer denial / 403 / 429) → unreachable(rate_limited)
 *   - AdapterError transient/permanent (network, 5xx) → unreachable(cause)
 * A typed AppError propagates (none is thrown today; kept for parity with the
 * Reddit branch). Telegram is FREE so there is no cap-exhaustion soft path.
 */
async function fetchEventPreviewMetadata(
  canonicalUrl: string,
  _ctx: { userId: string; ipAddress: string },
): Promise<EventPreviewMetadata> {
  const parsed = telegramParsePostUrl(canonicalUrl);
  if (parsed === null) {
    return { kind: "unreachable", cause: "url_not_telegram_post" };
  }
  const { channel, messageId } = parsed.metadata as { channel: string; messageId: string };
  try {
    const post = await fetchTelegramPostSingle(channel, messageId);
    if (post === null) return { kind: "unavailable" };
    const snippet = post.textSnippet.trim();
    return {
      kind: "ok",
      // Title = the post's first text line (the user-meaningful label), falling
      // back to "Telegram post <channel>/<id>" so a media-only post still yields
      // a non-empty title (the Add Event form requires one) — mirrors
      // materializeTelegramEvents' title rule.
      title: snippet !== "" ? snippet.slice(0, 200) : `Telegram post ${parsed.externalId}`,
      // The channel handle is the author surface for a Telegram channel (no
      // per-post author, unlike a subreddit). authorUrl is the canonical channel
      // URL; the display TITLE stays on data_sources (no-denorm — never copied
      // onto the event).
      authorName: channel,
      authorUrl: `${TELEGRAM_BASE}/${channel}`,
      occurredAt: post.publishedAt ?? undefined,
      thumbnailUrl: post.thumbnailUrl ?? undefined,
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof AdapterError) {
      if (err.category === "not-found") return { kind: "unavailable" };
      if (err.category === "rate-limited") return { kind: "unreachable", cause: "rate_limited" };
      return { kind: "unreachable", cause: err.message };
    }
    return { kind: "unreachable", cause: String((err as Error)?.message ?? err) };
  }
}

/**
 * fetchSyncStats — synchronous stats fetch on POST /api/events so /feed shows the
 * view count immediately. Mirrors Reddit's syncStats.fetch: the cross-source
 * createEvent calls this AFTER the events INSERT, errors are logged-and-swallowed
 * by the caller. Covers the create-WITHOUT-preview path (a direct paste-save that
 * never clicked "Fetch") — the preview path already wrote the snapshot, and
 * writeTelegramSnapshot's per-minute ON CONFLICT DO NOTHING collapses a
 * preview+submit pair to one snapshot row.
 *
 * Telegram is VIEWS-ONLY (no likes/comments on the public t.me surface, D-04), so
 * likeCount/commentCount are constant 0 (the cross-source shape is preserved for
 * UI parity; per-kind feed enrichment reads telegram_post_snapshots for the
 * Telegram-specific view). No authorIsMe signal — a telegram_post has no per-post
 * author to match (author_is_me is inherited from the owned data_sources row at
 * source-create time, D-02). Returns null on fetch failure → the caller treats it
 * as "stats unavailable, cron/warm lane will pick it up".
 */
async function fetchSyncStats(
  externalId: string,
  _ctx: { userId: string; ipAddress?: string },
): Promise<{ viewCount: number; likeCount: number; commentCount: number } | null> {
  const ids = splitTelegramPostId(externalId);
  if (ids === null) return null;
  try {
    const post = await fetchTelegramPostSingle(ids.channel, ids.messageId);
    if (post === null) return null;
    return { viewCount: post.viewCount ?? 0, likeCount: 0, commentCount: 0 };
  } catch (err) {
    logger.warn(
      { externalId, err: String((err as Error)?.message ?? err) },
      "telegram syncStats.fetch failed; UI will rely on cron/warm polling",
    );
    return null;
  }
}

/** enqueueRefreshNow — the per-event Refresh-Now path. INSERTs ONE user_post row
 *  into adapter_refresh_queue; the lane worker fetches that post via ?embed=1 +
 *  writeTelegramSnapshot. INSERT via the passed tx (requestRefreshPoll calls this
 *  inside its tx). No skip-if-pending dedup — the 5-min cooldown in
 *  requestRefreshPoll is the dedup; a conscious Refresh always fetches fresh
 *  (mirrors Reddit/IG). post_id is the "<channel>/<messageId>" external id. */
async function enqueueRefreshNow(input: {
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

/**
 * telegramAdapter — composes the polling core (./adapter.ts) with the
 * infrastructure-touching methods (registerQueues / scheduleCronTicks /
 * backfillSource) and the create-time hooks (normalizeSourceOnCreate /
 * onSourceCreated / validateEventInput / refreshQueue / workQueue). The
 * `SourceAdapter & typeof telegramChannelAdapterCore` annotation fails the build
 * if any required contract method is missing from the spread — completeness
 * check by construction.
 *
 * NO canRun gate on refreshQueue and isEnabled ALWAYS true on the lane worker:
 * Telegram is free with no provider/credential to gate on (IG/Reddit gate on
 * config; Telegram never is unconfigured).
 */
export const telegramAdapter: SourceAdapter & typeof telegramChannelAdapterCore = {
  ...telegramChannelAdapterCore,
  observability: telegramObservability,
  registerQueues,
  scheduleCronTicks,
  backfillSource,
  normalizeSourceOnCreate,
  onSourceCreated,
  resetWalkerStateOnWidening,
  validateEventInput,
  fetchEventPreviewMetadata,
  // Telegram is FREE (no canRun gate, mirrors Reddit's gate-less syncStats).
  // Covers the create-without-preview path so a direct paste-save renders views
  // immediately; the preview path already wrote the snapshot (per-minute ON
  // CONFLICT DO NOTHING collapses the preview+submit pair to one row).
  syncStats: {
    fetch: fetchSyncStats,
  },
  refreshQueue: {
    canRefresh: (eventKind: EventKind): boolean => eventKind === "telegram_post",
    // NO canRun — free, always available (IG's canRun existed only to block on an
    // unconfigured provider, which Telegram never is).
    enqueue: enqueueRefreshNow,
  },
  workQueue: {
    scheduledWorkers: [
      {
        name: "telegram.refresh",
        intervalMs: 3000,
        replicaPolicy: "parallel",
        readyMessage: "telegram batch-worker ready",
        disabledMessage: "telegram batch-worker disabled",
        laneQueue: {
          strategy: "fixed-slot-round-robin",
          adapterKind: KIND,
          slots: TELEGRAM_SLOT_MAPPING,
          fallthrough: FALLTHROUGH_ORDER,
          batchScope: "global",
        },
        // ALWAYS enabled — free, no provider/credential to gate on (contrast
        // IG/Reddit which gate on config).
        isEnabled: () => true,
        tick: telegramWorkerTick,
      },
    ],
  },
};
