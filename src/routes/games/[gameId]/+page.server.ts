import { error } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

/**
 * /games/[gameId] loader — fetch the game + its 4 child collections in
 * parallel (Plan 02-10).
 *
 *   GET /api/games/:gameId
 *   GET /api/games/:gameId/listings
 *   GET /api/games/:gameId/youtube-channels
 *   GET /api/games/:gameId/items
 *   GET /api/games/:gameId/events
 *
 * The game fetch is load-bearing — a 404 here means cross-tenant access
 * (the service throws NotFoundError on missing OR cross-tenant) and we
 * surface SvelteKit's `error(404)` so the framework renders +error.svelte
 * instead of an empty page. Child fetches are best-effort: a 5xx on any
 * of them returns an empty array so the rest of the page still renders.
 */
export const load: PageServerLoad = async ({ fetch, params, parent }) => {
  const { user } = await parent();
  if (!user) {
    throw error(401, "Sign in required");
  }

  const gameRes = await fetch(`/api/games/${params.gameId}`);
  if (gameRes.status === 404) throw error(404, "Game not found");
  if (!gameRes.ok) throw error(500, "Failed to load game");
  const game = await gameRes.json();

  const [listingsRes, channelsRes, itemsRes, eventsRes] = await Promise.all([
    fetch(`/api/games/${params.gameId}/listings`),
    fetch(`/api/games/${params.gameId}/youtube-channels`),
    fetch(`/api/games/${params.gameId}/items`),
    fetch(`/api/games/${params.gameId}/events`),
  ]);

  return {
    game,
    listings: listingsRes.ok ? await listingsRes.json() : [],
    channels: channelsRes.ok ? await channelsRes.json() : [],
    items: itemsRes.ok ? await itemsRes.json() : [],
    events: eventsRes.ok ? await eventsRes.json() : [],
  };
};
