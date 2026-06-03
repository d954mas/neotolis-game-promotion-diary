import type { PageServerLoad } from "./$types";
import { error, redirect } from "@sveltejs/kit";
import { getEventById } from "$lib/server/services/events.js";
import { listGames, deriveReleaseInfoForGames } from "$lib/server/services/games.js";
import { listSources } from "$lib/server/services/data-sources.js";
import {
  toEventDto,
  toGameDto,
  toDataSourceDto,
  loadGameIdsForEvent,
  loadVideoDataForEvents,
} from "$lib/server/dto.js";
import { NotFoundError } from "$lib/server/services/errors.js";
import { allAdapters } from "$lib/sources/registry.js";
import { getEventMetricSeriesForRow } from "$lib/server/services/event-metric-series.js";
import { enrichDataSourceDtosWithYoutubeChannelTitles } from "$lib/server/services/sources-page-read.js";
import {
  loadRedditEventDetailPreview,
  type RedditEventDetailPreview,
} from "$lib/sources/reddit/server/index.js";

/**
 * /events/[id] loader — full detail surface.
 *
 * Privacy invariants:
 *   - Anonymous → redirect(303, /login?next=...) — page-route gate
 *     (the anonymous-401 sweep covers /api/*).
 *     `error(401)` is reserved for /api/*; pages route to /login.
 *   - Cross-tenant → 404 via NotFoundError → throw error(404)
 *     (404, never 403).
 *   - Soft-deleted rows are surfaced ONLY when ?deleted=1 is set, so
 *     the Restore button has a destination from DeletedEventsPanel.
 *     The opts.includeSoftDeleted flag does NOT relax tenant scope.
 *   - toEventDto strips userId by construction; no ciphertext columns
 *     exist on events.
 */
export const load: PageServerLoad = async ({ locals, params, url }) => {
  if (!locals.user) {
    throw redirect(303, `/login?next=${encodeURIComponent(url.pathname)}`);
  }
  const includeSoftDeleted = url.searchParams.get("deleted") === "1";
  try {
    const row = await getEventById(locals.user.id, params.id, { includeSoftDeleted });
    // Sources joined so the dual-render <EventDetailContent> resolves
    // sourceLabel for the event's byline (Plan 03.4-10 Task 3). The
    // route was previously single-event-only; Wave 3 extends it so
    // /events/[id] and /feed?event= render the same content with the
    // same data shape. includeDeleted preserves the source chip for
    // events whose parent source the user has removed (same rationale
    // as /feed/+page.server.ts).
    const [games, allSources] = await Promise.all([
      listGames(locals.user.id),
      listSources(locals.user.id, { includeDeleted: true }),
    ]);
    // Load attached gameIds via the M:N junction. The page surfaces the
    // FIRST attached game as the "primary" (legacy single-game UI
    // affordance preserved).
    const gameIds = await loadGameIdsForEvent(locals.user.id, row.id);
    // Adapter-driven poll-state overlay. Each adapter contributes its own
    // fetchPollStateMap (YouTube reads youtube_videos; Reddit reads
    // reddit_posts + MAX(reddit_post_snapshots.polled_at)); the merged
    // Map feeds publishedAt / lastPolledAt / lastPollStatus into the
    // EventDto, which in turn wakes the PollingBadge + RefreshNowButton.
    const pollMap = await loadVideoDataForEvents(locals.user.id, [row]);
    const pollData = row.externalId ? (pollMap.get(row.externalId) ?? null) : null;
    const primaryGame =
      gameIds.length > 0 ? (games.find((g) => g.id === gameIds[0]) ?? null) : null;
    const dto = toEventDto(row, gameIds, pollData);

    // Reddit-specific detail-page preview. The adapter owns the DB
    // query against `reddit_posts`; this loader stays at routes-call-
    // adapters granularity (no direct schema imports here).
    let redditPost: RedditEventDetailPreview | null = null;
    if (row.kind === "reddit_post" && row.externalId !== null) {
      redditPost = await loadRedditEventDetailPreview(row.externalId);
    }

    // Adapter-driven feed enrichment. Mirrors /feed loader's overlay so
    // Reddit's score / num_comments / subscribers / baseline land on the
    // event DTO before the page render — same data path the FeedCard
    // uses, no per-route adapter import.
    for (const adapter of allAdapters) {
      if (adapter.enrichFeedDtos === undefined) continue;
      await adapter.enrichFeedDtos(locals.user.id, [dto]);
    }

    // Adapter-driven per-event metric series for VIZ-01 (D-14). The adapter loop
    // lives in the service now (event-metric-series.ts), shared with the
    // GET /api/events/:id/metric-series route. `row` is already tenant-vetted
    // (getEventById above on locals.user.id), so the for-row entry point skips a
    // redundant re-SELECT and just runs each adapter's snapshot read. No
    // db.select() in the loader — the series come through the adapter.
    const metricSeries = await getEventMetricSeriesForRow(locals.user.id, {
      kind: row.kind,
      externalId: row.externalId,
    });

    // Enrich source DTOs with YouTube channel_title from cache — same
    // shape /feed loader returns, so <EventDetailContent>'s sourceLabel
    // derivation works identically on both surfaces (dual-render parity).
    const sourceDtos = allSources.map(toDataSourceDto);
    await enrichDataSourceDtosWithYoutubeChannelTitles(sourceDtos);

    // GameDto.releaseDate / .releaseTba derived via JOIN with
    // game_steam_listings — the games row no longer carries the
    // columns (denormalization-audit-2.md V-2).
    const releaseByGameId = await deriveReleaseInfoForGames(
      locals.user.id,
      games.map((g) => g.id),
    );

    return {
      event: dto,
      games: games.map((g) =>
        toGameDto(g, releaseByGameId.get(g.id) ?? { releaseDate: null, releaseTba: false }),
      ),
      game: primaryGame
        ? toGameDto(
            primaryGame,
            releaseByGameId.get(primaryGame.id) ?? { releaseDate: null, releaseTba: false },
          )
        : null,
      sources: sourceDtos,
      redditPost,
      metricSeries,
    };
  } catch (err) {
    if (err instanceof NotFoundError) throw error(404, "Event not found");
    throw error(500, "Failed to load event");
  }
};
