// Ingest orchestrator — paste-box backend (D-18 routing + D-19 validate-first).
//
// The "single most-used widget on the game detail page" (UI-SPEC §"<PasteBox>
// interaction contract"). The user pastes a URL; we parse → fetch oEmbed →
// INSERT only on success, all-or-nothing (D-19; INGEST-04).
//
// Validate-first invariant (D-19; PITFALL Pitfall 1): for the youtube_video
// branch, fetchYoutubeOembed runs BEFORE any INSERT. There is no try/catch
// AROUND the INSERT to "clean up" a half-write — the validation IS the gate.
// On 422 / 502 the database is provably untouched (the integration tests in
// Plan 02-06 Task 3 assert zero rows after every failure).
//
// Result is a discriminated union the route handler (Plan 02-08) maps to:
//   { kind: 'youtube_video_created', itemId } → 201 + projected DTO
//   { kind: 'event_created', eventId }         → 201 + projected DTO
//   { kind: 'reddit_deferred' }                → 200 + friendly info body (D-18)
// Throws AppError 422 (unsupported_url / youtube_unavailable) or AppError
// 502 (youtube_oembed_unreachable) for the failure modes.

import { parseIngestUrl } from "./url-parser.js";
import { fetchYoutubeOembed } from "../integrations/youtube-oembed.js";
import type { YoutubeOembedResult } from "../integrations/youtube-oembed.js";
import { fetchTwitterOembed } from "../integrations/twitter-oembed.js";
import { createTrackedYoutubeVideo } from "./items-youtube.js";
import { createEvent } from "./events.js";
import { AppError } from "./errors.js";

export type IngestResult =
  | { kind: "youtube_video_created"; itemId: string }
  | { kind: "event_created"; eventId: string }
  | { kind: "reddit_deferred" };

/**
 * parsePasteAndCreate — the orchestrator the route layer (Plan 02-08) calls.
 *
 * Branch table (5 ParsedUrl kinds → IngestResult / AppError):
 *   - unsupported    → throw AppError("URL not yet supported", "unsupported_url", 422)
 *   - reddit_deferred → return { kind: "reddit_deferred" } (200 + info)
 *   - youtube_video  → fetchYoutubeOembed → switch on YoutubeOembedResult.kind:
 *                        ok          → createTrackedYoutubeVideo → { youtube_video_created }
 *                        unavailable → throw AppError(422, code='youtube_unavailable', metadata.reason='unavailable')
 *                        private     → throw AppError(422, code='youtube_unavailable', metadata.reason='private')
 *                      Thrown error (5xx/network/abort) → catch + rethrow as
 *                      AppError(502, code='youtube_oembed_unreachable')
 *   - twitter_post   → fetchTwitterOembed (best-effort, null OK) → createEvent kind='twitter_post'
 *   - telegram_post  → no oEmbed → createEvent kind='telegram_post' with URL-derived placeholder
 *
 * The user's gameId is asserted by the underlying createTrackedYoutubeVideo /
 * createEvent calls (both pre-flight `getGameById` for cross-tenant defense).
 */
export async function parsePasteAndCreate(
  userId: string,
  gameId: string,
  input: string,
  ipAddress: string,
): Promise<IngestResult> {
  const parsed = parseIngestUrl(input);

  if (parsed.kind === "unsupported") {
    throw new AppError("URL not yet supported", "unsupported_url", 422);
  }

  if (parsed.kind === "reddit_deferred") {
    // D-18 friendly message — no DB write. Plan 02-08 maps to 200 + info body.
    return { kind: "reddit_deferred" };
  }

  if (parsed.kind === "youtube_video") {
    let oembed: YoutubeOembedResult;
    try {
      oembed = await fetchYoutubeOembed(parsed.canonicalUrl);
    } catch (err) {
      // 5xx / network / abort — translate to a single 502 code so Plan 02-08
      // can map without parsing message strings.
      throw new AppError(
        "youtube oembed unreachable",
        "youtube_oembed_unreachable",
        502,
        { cause: String((err as Error)?.message ?? err) },
      );
    }
    if (oembed.kind === "private") {
      throw new AppError("video is private", "youtube_unavailable", 422, {
        reason: "private",
      });
    }
    if (oembed.kind === "unavailable") {
      throw new AppError("video unavailable", "youtube_unavailable", 422, {
        reason: "unavailable",
      });
    }
    // oembed.kind === "ok" — INSERT only after validate succeeds (D-19; INGEST-04).
    const item = await createTrackedYoutubeVideo(
      userId,
      {
        gameId,
        videoId: parsed.videoId,
        url: parsed.canonicalUrl,
        title: oembed.data.title || null,
        // Pitfall 3 Option C: keep channel_id null in Phase 2; INGEST-03's
        // own/blogger lookup uses author_url instead.
        channelId: null,
        authorUrl: oembed.data.authorUrl || null,
      },
      ipAddress,
    );
    return { kind: "youtube_video_created", itemId: item.id };
  }

  if (parsed.kind === "twitter_post") {
    // Twitter oEmbed is best-effort (Pitfall 8 / D-29). Failure is non-fatal —
    // events row still created with a URL-derived placeholder title. We catch
    // here too in case the integration's own catch ever changes shape.
    const oembed = await fetchTwitterOembed(parsed.canonicalUrl).catch(() => null);
    const title = oembed?.authorName
      ? `Tweet by ${oembed.authorName}`
      : `Tweet at ${new URL(parsed.canonicalUrl).pathname}`;
    const event = await createEvent(
      userId,
      {
        gameId,
        kind: "twitter_post",
        occurredAt: new Date(),
        title,
        url: parsed.canonicalUrl,
        notes: oembed?.html ?? null,
      },
      ipAddress,
    );
    return { kind: "event_created", eventId: event.id };
  }

  // parsed.kind === "telegram_post" — no public oEmbed, store URL-derived
  // placeholder title; user can edit later via updateEvent.
  const event = await createEvent(
    userId,
    {
      gameId,
      kind: "telegram_post",
      occurredAt: new Date(),
      title: `Telegram post at ${new URL(parsed.canonicalUrl).pathname}`,
      url: parsed.canonicalUrl,
      notes: null,
    },
    ipAddress,
  );
  return { kind: "event_created", eventId: event.id };
}
