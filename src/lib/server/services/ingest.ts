// Ingest orchestrator — paste-box backend (Phase 2.1 unified events refactor).
//
// Phase 2.1 reframe: the YouTube paste path no longer writes to a separate
// `tracked_youtube_videos` table — it writes ONE row into the unified `events`
// table via `events.createEventFromPaste` (kind=youtube_video). The
// `tracked_youtube_videos` table is gone (Plan 02.1-01 baseline collapse) and
// the `items-youtube.ts` service is deleted (this plan, Plan 02.1-05).
//
// Twitter and Telegram paste paths still go through createEvent directly —
// they're free-form social posts (no oEmbed-driven dedup / source attachment),
// and the orchestrator wires the platform-specific oEmbed call before INSERT.
//
// Reddit URLs return AppError 'reddit_pending_phase3' (422). CONTEXT DV-7:
// Reddit ingest lands in Phase 3 alongside the poll.reddit adapter.
//
// Validate-first invariant (D-19; INGEST-04 / AGENTS.md "validate-first
// INGEST" anti-pattern): URL parsing + oEmbed call run BEFORE any INSERT.
// On 422 / 502 the database is provably untouched.
//
// Result is a discriminated union the route handler (Plan 02.1-06) maps to:
//   { kind: 'event_created', eventId } → 201 + projected DTO
//   { kind: 'reddit_deferred' }         → kept only for backwards-compat with
//                                         Phase 2 callers; new code throws
//                                         AppError 'reddit_pending_phase3'.
// Throws AppError 422 (unsupported_url / youtube_unavailable /
// reddit_pending_phase3) or AppError 502 (youtube_oembed_unreachable) for the
// failure modes.

import { parseIngestUrl } from "./url-parser.js";
import { fetchTwitterOembed } from "../integrations/twitter-oembed.js";
import { createEvent, createEventFromPaste } from "./events.js";
import { AppError } from "./errors.js";

export type IngestResult = { kind: "event_created"; eventId: string };

/**
 * parsePasteAndCreate — the orchestrator the route layer (Plan 02.1-06) calls.
 *
 * Phase 2.1 contract (vs Phase 2):
 *   - youtube_video → events.createEventFromPaste (NOT items-youtube anymore;
 *     ONE events row carries everything, no separate tracked_youtube_videos
 *     row). source_id and author_is_me are inherited from the user's
 *     registered data_source on author_url match.
 *   - twitter_post / telegram_post → createEvent directly (free-form social
 *     posts; oEmbed best-effort for Twitter, URL-derived placeholder title
 *     for Telegram).
 *   - reddit_post → AppError 'reddit_pending_phase3' (422). CONTEXT DV-7.
 *   - unsupported → AppError 'unsupported_url' (422).
 *
 * gameId is OPTIONAL (nullable) per Phase 2.1 — manual paste with no game
 * lands in the inbox (events.game_id IS NULL).
 *
 * The user's gameId is asserted by the underlying createEvent /
 * createEventFromPaste calls (cross-tenant 404 BEFORE INSERT — Pitfall 4).
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

  if (parsed.kind === "reddit_deferred") {
    // CONTEXT DV-7: Reddit ingest lands in Phase 3 with poll.reddit. The route
    // layer (Plan 02.1-06) maps this to a friendly inline-info body.
    throw new AppError("Reddit ingest arrives in Phase 3", "reddit_pending_phase3", 422);
  }

  // Plan 02.1-28 (M:N migration): the underlying createEvent /
  // createEventFromPaste services accept gameIds[] (M:N junction); the
  // legacy singular gameId is normalized to a single-element array (or
  // empty array on null) before the call.
  const gameIds = gameId === null ? [] : [gameId];

  if (parsed.kind === "youtube_video") {
    const event = await createEventFromPaste(userId, { url: input, gameIds }, ipAddress, userAgent);
    return { kind: "event_created", eventId: event.id };
  }

  if (parsed.kind === "twitter_post") {
    // Twitter oEmbed is best-effort (Pitfall 8 / D-29). Failure is non-fatal —
    // event row still created with a URL-derived placeholder title.
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
