import { error } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { getGameById, listGames } from "$lib/server/services/games.js";
import { listListings, listSoftDeletedListings } from "$lib/server/services/game-steam-listings.js";
import { listEventsForGame } from "$lib/server/services/events.js";
import { listSources } from "$lib/server/services/data-sources.js";
import {
  toGameDto,
  toGameSteamListingDto,
  mapEventsToDtos,
  toDataSourceDto,
} from "$lib/server/dto.js";
import { allAdapters } from "$lib/sources/registry.js";
import { NotFoundError } from "$lib/server/services/errors.js";
import { enrichDataSourceDtosWithYoutubeChannelTitles } from "$lib/server/services/sources-page-read.js";

/**
 * /games/[gameId] loader — unified-events curated layout.
 *
 * Header / store-listings / events. The unified `events` table carries
 * youtube_video rows attached to the game, and the per-user `data_sources`
 * registry replaces any per-game channel M:N.
 *
 * Direct service calls (NOT fetch('/api/...')): the Hono API and the page
 * render in the same Node process, so an HTTP roundtrip back to Hono would
 * deadlock SvelteKit's internal_fetch (Hono routes don't live in
 * SvelteKit's route tree).
 *
 * Loader returns:
 *   - game        : GameDto (userId stripped)
 *   - listings    : GameSteamListingDto[]
 *   - events      : EventDto[] (per-game curated, sorted DESC by occurredAt)
 *   - games       : GameDto[] (used by FeedCard to render attached game chips)
 *   - sources     : DataSourceDto[] (for source-chip resolution on FeedRow)
 *
 * Cross-tenant gameId surfaces as 404 (never 403). Child fetches are
 * best-effort: a service throw on any of them returns an empty array so
 * the rest of the page still renders. The parent fetch is load-bearing —
 * `getGameById` short-circuits cross-tenant access first.
 */
export const load: PageServerLoad = async ({ locals, params }) => {
  if (!locals.user) {
    throw error(401, "Sign in required");
  }
  const userId = locals.user.id;
  const gameId = params.gameId;

  let game;
  try {
    game = await getGameById(userId, gameId);
  } catch (err) {
    if (err instanceof NotFoundError) throw error(404, "Game not found");
    throw error(500, "Failed to load game");
  }

  // Soft-deleted listings load alongside active ones so /games/[gameId]
  // can mount <RecoveryDialog> with entityType="store". Same defensive
  // best-effort pattern as the other child fetches — a service throw
  // returns empty so the rest of the page still renders.
  const [listings, deletedListings, events, gamesAll, sources] = await Promise.all([
    listListings(userId, gameId).catch(() => []),
    listSoftDeletedListings(userId, gameId).catch(() => []),
    listEventsForGame(userId, gameId).catch(() => []),
    listGames(userId).catch(() => []),
    listSources(userId).catch(() => []),
  ]);

  // Per-game events list carries gameIds[] on each row via the batch
  // junction loader. Multi-game events surface their full attachment set;
  // the rendering page can show "also attached to X, Y".
  const eventDtos = await mapEventsToDtos(userId, events);
  // Adapter-driven feed enrichment for the per-game curated view. Same
  // loop as /feed SSR + GET /api/events.
  for (const adapter of allAdapters) {
    if (adapter.enrichFeedDtos) {
      await adapter.enrichFeedDtos(userId, eventDtos);
    }
  }

  // Populate source.channelTitle from youtube_channels cache, mirroring
  // /feed/+page.server.ts. Without this enrichment, FeedCard's
  // `channelLabel` chain falls from event.channelTitle (null when
  // youtube_videos cache lacks the row) through source.channelTitle
  // (always null per toDataSourceDto default) to source.handleUrl
  // (the raw URL) — visually inconsistent with /feed for the same event.
  const sourceDtos = sources.map(toDataSourceDto);
  await enrichDataSourceDtosWithYoutubeChannelTitles(sourceDtos);

  return {
    game: toGameDto(game),
    listings: listings.map(toGameSteamListingDto),
    deletedListings: deletedListings.map(toGameSteamListingDto),
    events: eventDtos,
    games: gamesAll.map(toGameDto),
    sources: sourceDtos,
  };
};
