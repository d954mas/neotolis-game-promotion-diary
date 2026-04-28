import { error } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { getGameById } from "$lib/server/services/games.js";
import { listListings } from "$lib/server/services/game-steam-listings.js";
import { listChannelsForGame } from "$lib/server/services/youtube-channels.js";
import { listItemsForGame } from "$lib/server/services/items-youtube.js";
import { listEventsForGame } from "$lib/server/services/events.js";
import {
  toGameDto,
  toGameSteamListingDto,
  toYoutubeChannelDto,
  toYoutubeVideoDto,
  toEventDto,
} from "$lib/server/dto.js";
import { NotFoundError } from "$lib/server/services/errors.js";

/**
 * /games/[gameId] loader — fetch the game + its 4 child collections in
 * parallel (Plan 02-10).
 *
 * Calls the service layer directly (NOT fetch('/api/...')): the API and
 * the page render in the same Node process, so an HTTP roundtrip back to
 * Hono would deadlock SvelteKit's internal_fetch (Hono routes don't live
 * in SvelteKit's route tree — see post-execution P0 fix in SUMMARY).
 *
 * The parent fetch is load-bearing — `getGameById` throws NotFoundError
 * on missing OR cross-tenant access (PRIV-01: 404, never 403). We surface
 * SvelteKit's `error(404)` so the framework renders +error.svelte instead
 * of an empty page. Child fetches are best-effort: a service throw on any
 * of them returns an empty array so the rest of the page still renders
 * (matches the previous fetch-based contract — listings/channels/items/events
 * services would also throw NotFoundError on a soft-deleted parent because
 * they pre-flight `getGameById` for cross-tenant defense, but the parent
 * fetch above already short-circuits on 404).
 *
 * DTO projection (P3) preserves the exact same wire shape the +page.svelte
 * expects (id, title, coverUrl, releaseDate, releaseTba, tags, notes for
 * the game; id, appId, label, coverUrl, releaseDate, apiKeyId for listings;
 * etc.). No client-side change required.
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

  const [listings, channels, items, events] = await Promise.all([
    listListings(userId, gameId).catch(() => []),
    listChannelsForGame(userId, gameId).catch(() => []),
    listItemsForGame(userId, gameId).catch(() => []),
    listEventsForGame(userId, gameId).catch(() => []),
  ]);

  return {
    game: toGameDto(game),
    listings: listings.map(toGameSteamListingDto),
    channels: channels.map(toYoutubeChannelDto),
    items: items.map(toYoutubeVideoDto),
    events: events.map(toEventDto),
  };
};
