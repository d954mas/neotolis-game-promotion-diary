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
import { NotFoundError } from "$lib/server/services/errors.js";

/**
 * /games/[gameId] loader — Phase 2.1 Plan 02.1-09 rebuild.
 *
 * Replaces the Phase 2 multi-panel layout (header / store-listings /
 * youtube-channels / tracked-items / events) with the unified-events
 * curated layout (header / store-listings / events). The YouTube channels
 * and tracked items panels are GONE per UI-SPEC §"/games/[id] rebuild" —
 * the unified `events` table now carries youtube_video rows attached to
 * the game, and the per-user `data_sources` registry replaces the per-game
 * youtube-channels M:N (Plan 02.1-01 retired both).
 *
 * Direct service calls (NOT fetch('/api/...')): the Hono API and the page
 * render in the same Node process, so an HTTP roundtrip back to Hono would
 * deadlock SvelteKit's internal_fetch (Hono routes don't live in
 * SvelteKit's route tree — Phase 2 P0 fix precedent).
 *
 * Loader returns:
 *   - game        : GameDto (P3 projection — userId stripped)
 *   - listings    : GameSteamListingDto[]
 *   - events      : EventDto[] (per-game curated, sorted DESC by occurredAt)
 *   - games       : GameDto[] (for AttachToGamePicker on FeedRow / Plan 07)
 *   - sources     : DataSourceDto[] (for source-chip resolution on FeedRow)
 *
 * Cross-tenant gameId surfaces as 404 (PRIV-01: 404, never 403). Child
 * fetches are best-effort: a service throw on any of them returns an empty
 * array so the rest of the page still renders. The parent fetch is
 * load-bearing — `getGameById` short-circuits cross-tenant access first.
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

  // Plan 02.1-39 round-6 polish #12 (UAT-NOTES.md §5.8 follow-up #12):
  // soft-deleted listings load alongside active ones so /games/[gameId]
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

  // Plan 02.1-28: per-game events list now carries gameIds[] on each row
  // via the batch junction loader. Multi-game events surface their full
  // attachment set; the rendering page can show "also attached to X, Y".
  const eventDtos = await mapEventsToDtos(userId, events);

  return {
    game: toGameDto(game),
    listings: listings.map(toGameSteamListingDto),
    deletedListings: deletedListings.map(toGameSteamListingDto),
    events: eventDtos,
    games: gamesAll.map(toGameDto),
    sources: sources.map(toDataSourceDto),
  };
};
