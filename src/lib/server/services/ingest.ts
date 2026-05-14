// Ingest orchestrator — paste-box backend.
//
// The YouTube paste path writes ONE row into the unified `events` table via
// `events.createEventFromPaste` (kind=youtube_video). No separate
// `tracked_youtube_videos` table.
//
// Twitter and Telegram paste paths go through createEvent directly — they're
// free-form social posts (no oEmbed-driven dedup / source attachment), and
// the orchestrator wires the platform-specific oEmbed call before INSERT.
//
// Reddit paste path (D-RDT-INGEST-REPLACE, plan 09):
//   1. Pre-flight: isRedditConfigured() — empty REDDIT_USER_AGENT returns
//      'reddit_not_configured' 422 (parity with YouTube empty-keys behavior).
//   2. Per-user cap: enforceRedditUserCap('post-refresh') burns one slot
//      against the 25/5min post-refreshes sliding window (D-RDT-CAP-POST)
//      via reddit_refresh_queue COUNT. On exhaustion: 429
//      `reddit_post_quota_exhausted` with retry_in_seconds metadata.
//   3. Synchronous fetch + UPSERT: handlePostSingle calls
//      /comments/<id>.json, UPSERTs reddit_posts + reddit_subreddits_cache
//      + reddit_users_cache, and writes one reddit_post_snapshots row.
//      Returns the parsed t3 fields (title, author, submittedAt, ...).
//   4. author_is_me inheritance: match parsed `author` against any owned
//      reddit_account data_source for this user (case-sensitive on
//      metadata.username) — sets events.author_is_me=true on match.
//   5. createEvent INSERT — kind='reddit_post', externalId='t3_<id>',
//      metadata.{subreddit, author}, occurredAt=submittedAt, title from
//      Reddit. Validate-first invariant honored: events INSERT only after
//      caches succeed.
//
// Validate-first invariant (AGENTS.md): URL parsing + per-kind validation
// (YouTube oEmbed / Reddit /comments/<id>.json) run BEFORE any INSERT. On
// 422 / 502 the database is provably untouched.
//
// Result is a discriminated union the route handler maps to:
//   { kind: 'event_created', eventId } → 201 + projected DTO
//
// Throws AppError 422 (unsupported_url / youtube_unavailable /
// reddit_not_configured) or 429 (reddit_post_quota_exhausted) or 502
// (youtube_oembed_unreachable) for the failure modes. AdapterError raised
// by handlePostSingle (rate-limited / not-found / permanent) propagates
// to the route layer which maps it to the structured response.
//
// Channel-context backfill trigger: after the youtube_video event row is
// created, if the URL's channel is NOT yet in `youtube_channels`, enqueue
// ONE YOUTUBE_CHANNEL_CONTEXT_BACKFILL job (idempotent via pg-boss
// singletonKey = the extracted channelId). The trigger is fire-and-forget:
// any error enqueueing is logged + swallowed so the user-facing paste
// still returns 201.

import { and, eq, isNull, or, sql } from "drizzle-orm";
import { parseIngestUrl } from "./url-parser.js";
import { fetchTwitterOembed } from "../integrations/twitter-oembed.js";
import { createEvent, createEventFromPaste } from "./events.js";
import { AppError } from "./errors.js";
import { enforceRedditUserCap } from "./quota.js";
import { db } from "../db/client.js";
import { youtubeChannels } from "../db/schema/index.js";
import { dataSources } from "../db/schema/data-sources.js";
import { QUEUES } from "../queues.js";
import { getBoss } from "../queue-client.js";
import { logger } from "../logger.js";
import { isRedditConfigured } from "$lib/sources/reddit/server/credentials.js";
import { handlePostSingle } from "$lib/sources/reddit/server/handlers/post-single.js";
import { getAdapter } from "$lib/sources/registry.js";

export type IngestResult = { kind: "event_created"; eventId: string };

/**
 * parsePasteAndCreate — the orchestrator the route layer calls.
 *
 *   - youtube_video → events.createEventFromPaste (ONE events row carries
 *     everything). source_id and author_is_me are inherited from the
 *     user's registered data_source on author_url match.
 *   - reddit_post → isRedditConfigured() pre-flight + enforceRedditUserCap
 *     (D-RDT-CAP-POST) + handlePostSingle synchronous fetch + UPSERT +
 *     author_is_me inheritance + createEvent INSERT. See file header.
 *   - twitter_post / telegram_post → createEvent directly (free-form
 *     social posts; oEmbed best-effort for Twitter, URL-derived
 *     placeholder title for Telegram).
 *   - unsupported → AppError 'unsupported_url' (422).
 *
 * gameId is OPTIONAL (nullable) — manual paste with no game lands in the
 * inbox (zero junction rows).
 *
 * The user's gameId is asserted by the underlying createEvent /
 * createEventFromPaste calls (cross-tenant 404 BEFORE INSERT).
 */
export async function parsePasteAndCreate(
  userId: string,
  gameId: string | null,
  input: string,
  ipAddress: string,
  userAgent?: string,
): Promise<IngestResult> {
  const parsed = parseIngestUrl(input);

  if (parsed.kind === "unsupported") {
    throw new AppError("URL not yet supported", "unsupported_url", 422);
  }

  // The underlying createEvent / createEventFromPaste services accept
  // gameIds[] (M:N junction); the legacy singular gameId is normalized to
  // a single-element array (or empty array on null) before the call.
  const gameIds = gameId === null ? [] : [gameId];

  if (parsed.kind === "reddit_post") {
    // 1) Operator credential pre-flight — empty REDDIT_USER_AGENT must
    //    short-circuit BEFORE the cap check so a self-host instance
    //    without Reddit configured returns a clean 422 (no audit row,
    //    no quota burn, no HTTP attempt). Mirrors YouTube's empty-key
    //    422 'youtube_not_configured' shape.
    if (!isRedditConfigured()) {
      throw new AppError(
        "Reddit ingest is not available — operator has not configured REDDIT_USER_AGENT.",
        "reddit_not_configured",
        422,
      );
    }

    // 2) Per-user post-refresh cap (D-RDT-CAP-POST, plan 06). Paste
    //    counts as a user_post action against the 25/5min sliding
    //    window. enforceRedditUserCap reads adapter.observability.
    //    userQuotaCap, writes the `reddit.cap_exhausted` audit row on
    //    exhaustion, and throws AppError 429 with code
    //    `reddit_post_quota_exhausted` + retry_in_seconds metadata.
    //    The redditAdapter is fetched via the registry; reddit_account
    //    and reddit_subreddit share one adapter instance so either
    //    kind retrieves the same observability declaration.
    const redditAdapter = getAdapter("reddit_account");
    await enforceRedditUserCap(db, redditAdapter, userId, ipAddress, "post-refresh");

    // 3) Synchronous fetch + UPSERT — validate-first invariant: events
    //    INSERT does NOT run until /comments/<id>.json succeeds and
    //    the caches populate. handlePostSingle throws AdapterError on
    //    not-found / permanent / rate-limited / operator-issue; those
    //    propagate to the route layer which maps to the structured
    //    response.
    const result = await handlePostSingle({
      postId: parsed.externalId,
      userId,
      paste: true,
    });

    // 4) author_is_me inheritance (D-RDT-AUTHOR-IS-ME-INHERITANCE) —
    //    match parsed author against an owned reddit_account source
    //    for this user. Case-sensitive on metadata.username. Reddit's
    //    "[deleted]" author has already been mapped to null in
    //    handlePostSingle, so the null-guard skips the lookup for
    //    deleted-author posts.
    const authorIsMe =
      result.author !== null ? await isAuthorOwned(userId, result.author) : false;

    // 5) events INSERT. createEvent enforces the cross-tenant gameId
    //    check and the events_per_day cap; either path throws BEFORE
    //    the INSERT runs. external_id encodes the t3_ prefix so the
    //    refresh-poll dedup index can match server-driven snapshots
    //    against the same row.
    const event = await createEvent(
      userId,
      {
        gameIds,
        kind: "reddit_post",
        occurredAt: result.submittedAt,
        title: result.title,
        url: result.permalink,
        externalId: result.postId, // already t3_<id> from handlePostSingle
        authorIsMe,
        metadata: { subreddit: result.subreddit, author: result.author },
      },
      ipAddress,
      userAgent,
    );
    return { kind: "event_created", eventId: event.id };
  }

  if (parsed.kind === "youtube_video") {
    const event = await createEventFromPaste(userId, { url: input, gameIds }, ipAddress, userAgent);

    // Channel-context backfill trigger.
    //
    // The event row's metadata.author_url was populated by enrichFromUrl
    // (events.ts) from the oEmbed response. We extract the YouTube
    // channelId and, if it's NOT already in youtube_channels, enqueue a
    // one-time YOUTUBE_CHANNEL_CONTEXT_BACKFILL job. pg-boss's
    // singletonKey dedups concurrent pastes from the same channel.
    //
    // Fire-and-forget: any failure here is logged and swallowed. The
    // backfill is a quality enhancement for the user's "compare with
    // other videos on the channel" use case — it must never block the
    // user-facing paste UX.
    const eventMeta = (event.metadata ?? {}) as { author_url?: unknown };
    const authorUrl = typeof eventMeta.author_url === "string" ? eventMeta.author_url : "";
    if (authorUrl !== "") {
      await maybeEnqueueChannelContextBackfill(userId, authorUrl);
    }

    return { kind: "event_created", eventId: event.id };
  }

  if (parsed.kind === "twitter_post") {
    // Twitter oEmbed is best-effort. Failure is non-fatal — event row
    // still created with a URL-derived placeholder title.
    const oembed = await fetchTwitterOembed(parsed.canonicalUrl).catch(() => null);
    const title = oembed?.authorName
      ? `Tweet by ${oembed.authorName}`
      : `Tweet at ${new URL(parsed.canonicalUrl).pathname}`;
    const event = await createEvent(
      userId,
      {
        gameIds,
        kind: "twitter_post",
        occurredAt: new Date(),
        title,
        url: parsed.canonicalUrl,
        notes: oembed?.html ?? null,
      },
      ipAddress,
      userAgent,
    );
    return { kind: "event_created", eventId: event.id };
  }

  // parsed.kind === "telegram_post" — no public oEmbed, store URL-derived
  // placeholder title; user can edit later via updateEvent.
  const event = await createEvent(
    userId,
    {
      gameIds,
      kind: "telegram_post",
      occurredAt: new Date(),
      title: `Telegram post at ${new URL(parsed.canonicalUrl).pathname}`,
      url: parsed.canonicalUrl,
      notes: null,
    },
    ipAddress,
    userAgent,
  );
  return { kind: "event_created", eventId: event.id };
}

/**
 * Extract a stable identifier from a YouTube oEmbed `author_url` and,
 * if the channel is not yet in `youtube_channels`, enqueue ONE
 * YOUTUBE_CHANNEL_CONTEXT_BACKFILL job. Idempotent across concurrent pastes
 * via pg-boss `singletonKey` = the extracted channelId.
 *
 * YouTube oEmbed `author_url` shapes observed in the wild:
 *   - https://www.youtube.com/channel/UCabcDEFghi…  (canonical UC channelId)
 *   - https://www.youtube.com/@handle               (handle URL — UC id resolved
 *                                                    server-side by the
 *                                                    backfill handler via
 *                                                    channels.list?forHandle=)
 *   - https://www.youtube.com/c/customname          (legacy custom URL — same
 *                                                    treatment as @handle)
 *
 * For the canonical /channel/UC… shape we extract the UC id directly and use
 * it as both the cache lookup key AND the singletonKey. For /@handle and /c/
 * shapes we cannot resolve the UC id without a Data API call — so we use the
 * full author_url as the singletonKey + cache lookup key. Cache misses on
 * /@handle URLs always fall through to the backfill handler, which resolves
 * the real channelId via `channels.list` + populates the cache. Subsequent
 * pastes of the same handle hit the cache and skip the enqueue.
 *
 * Fire-and-forget: pg-boss / DB errors are logged at WARN and swallowed. The
 * paste flow itself returns 201 regardless of backfill enqueue outcome.
 */
async function maybeEnqueueChannelContextBackfill(
  userId: string,
  authorUrl: string,
): Promise<void> {
  try {
    const parsed = extractChannelIdFromAuthorUrl(authorUrl);
    if (parsed === null) return;

    // Cache lookup against the public-data table (no user_id — see schema
    // module header). A row exists if a previous paste of any tenant's video
    // from this channel already triggered the backfill handler successfully.
    //
    // Extend the lookup with `= ANY(handle_aliases)` so handle/legacy URL
    // paste hits its UC row through the alias array. Backfill worker
    // writes the resolved-from URL into handle_aliases after
    // channels.list?forHandle returns the UC id; subsequent pastes of the
    // same handle URL find the row directly here, no enqueue, no quota.
    //
    // Lookup key is the parsed value regardless of kind: for channelId we
    // hit the PK; for handleUrl we hit the alias array.
    const cached = await db
      .select({ channelId: youtubeChannels.channelId })
      .from(youtubeChannels)
      .where(
        or(
          eq(youtubeChannels.channelId, parsed.value),
          sql`${parsed.value} = ANY(${youtubeChannels.handleAliases})`,
        ),
      )
      .limit(1);
    if (cached.length > 0) return;

    const boss = await getBoss();
    // Belt-and-suspenders: even with handle_aliases closing the steady-
    // state cache miss, a backfill that crashes BEFORE writing the alias
    // leaves no cache entry behind. Singleton dedup catches concurrent
    // re-pastes within the window. 24h applies to BOTH UC and handle URLs:
    // handle_aliases closes the steady-state cache miss for handle URLs
    // too, so a wider 30-day window for handle URLs would just black out
    // failed-backfill recovery for a month — operator visibility wins
    // over a paranoid quota safety net.
    //
    // Discriminated payload: @handle URLs go into job.data.handleUrl
    // (worker resolves via forHandle), UC ids go into job.data.channelId
    // (worker calls channels.list?id directly). Putting an @handle URL
    // into channelId would make the worker's
    // `if (!channelId && handleUrl)` resolution branch skip because
    // channelId would be the URL string (truthy), and channels.list?id=
    // <full URL> would return no items, silently failing.
    const payload =
      parsed.kind === "channelId"
        ? { channelId: parsed.value, userId }
        : { handleUrl: parsed.value, userId };
    await boss.send(QUEUES.YOUTUBE_CHANNEL_CONTEXT_BACKFILL, payload, {
      singletonKey: parsed.value,
      singletonSeconds: 86_400,
    });
  } catch (err) {
    logger.warn(
      { authorUrl, err: String((err as Error)?.message ?? err) },
      "channel-context-backfill enqueue failed; ignoring (non-blocking)",
    );
  }
}

/**
 * Extract a stable channel identifier from a YouTube oEmbed `author_url`.
 *
 * Returns a discriminated union so the caller routes the value into the
 * correct backfill-job field:
 *   - { kind: "channelId", value }: /channel/UC… URLs gave us the canonical
 *     24-char id; the backfill worker can call channels.list?id=<UC…> directly.
 *   - { kind: "handleUrl", value }: /@handle, /c/customname, /user/legacy —
 *     the worker must resolve handle→channelId via channels.list?forHandle
 *     before it can fetch uploads. value is the trimmed authorUrl itself
 *     (the worker re-parses it).
 *   - null: URL didn't match either shape — silent skip (backfill is best-
 *     effort).
 *
 * An earlier version of this function returned a single string and the
 * caller put it into the job's `channelId` field. For @handle URLs, that
 * meant `channelId = "https://www.youtube.com/@x"` — the worker's
 * resolution branch (`if (!channelId && handleUrl)`) would skip because
 * channelId was truthy, so it would call channels.list?id=<full URL>
 * which Google ignores, and every @handle backfill would silently fail.
 */
function extractChannelIdFromAuthorUrl(
  authorUrl: string,
): { kind: "channelId"; value: string } | { kind: "handleUrl"; value: string } | null {
  const m = /\/channel\/(UC[A-Za-z0-9_-]{20,})/.exec(authorUrl);
  if (m !== null) {
    const id = m[1];
    return id ? { kind: "channelId", value: id } : null;
  }
  // /@handle or /c/customname — let the worker resolve via forHandle.
  // Validate it's a YouTube URL with a non-empty path so we don't enqueue
  // backfill jobs for garbage author_urls.
  try {
    const u = new URL(authorUrl);
    if (u.hostname !== "www.youtube.com" && u.hostname !== "youtube.com") return null;
    if (u.pathname === "" || u.pathname === "/") return null;
    return { kind: "handleUrl", value: authorUrl };
  } catch {
    return null;
  }
}

/**
 * isAuthorOwned — D-RDT-AUTHOR-IS-ME-INHERITANCE.
 *
 * Looks up an active reddit_account data_source for `userId` whose
 * metadata.username matches the pasted post's `author` (case-sensitive,
 * matching Reddit's username case semantics). Soft-deleted sources
 * (deletedAt IS NOT NULL) are excluded so a re-registered handle
 * doesn't inherit author_is_me from a tombstoned predecessor.
 *
 * Returns true when ≥1 owned source matches; false otherwise. The cap
 * at LIMIT 1 short-circuits the lookup — we only need existence, not
 * the row.
 *
 * Tenant-scope contract: every Drizzle query against `data_sources`
 * filters `eq(dataSources.userId, userId)`. The custom ESLint rule
 * `tenant-scope/no-unfiltered-tenant-query` catches drift.
 *
 * The match shape mirrors the YouTube paste's handleUrl-based
 * inheritance (events.ts findActiveSourceByHandleUrl). YouTube matches
 * on full author_url; Reddit matches on `metadata.username` because the
 * t3 response carries only the bare handle (not a URL). Both yield the
 * same UX: "I pasted a post from my own channel → author_is_me=true".
 */
async function isAuthorOwned(userId: string, authorUsername: string): Promise<boolean> {
  const rows = await db
    .select({ id: dataSources.id })
    .from(dataSources)
    .where(
      and(
        eq(dataSources.userId, userId),
        eq(dataSources.kind, "reddit_account"),
        eq(dataSources.isOwnedByMe, true),
        isNull(dataSources.deletedAt),
        sql`${dataSources.metadata}->>'username' = ${authorUsername}`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}
