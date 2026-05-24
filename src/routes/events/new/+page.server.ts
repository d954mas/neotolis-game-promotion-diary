import type { PageServerLoad } from "./$types";
import { redirect } from "@sveltejs/kit";
import { listGames, deriveReleaseInfoForGames } from "$lib/server/services/games.js";
import { toGameDto } from "$lib/server/dto.js";

/**
 * /events/new loader.
 *
 * Free-form event creation — full-page form with the 9-kind picker +
 * game attach (optional) + occurredAt + title + url + notes. /events/new
 * is the only canonical entry point for free-form events; the paste flow
 * on /games/[id] (and the /feed paste affordance) handles pollable
 * kinds (youtube_video / future reddit_post).
 *
 * The kind picker enables ALL 9 kinds — pollable kinds (youtube_video /
 * reddit_post) are not disabled because the service accepts them; the
 * paste flow is the FAST path while free-form is the FALLBACK.
 *
 * Anonymous → /login (defense-in-depth; +layout.server.ts also gates).
 */
export const load: PageServerLoad = async ({ locals, url }) => {
  if (!locals.user) {
    throw redirect(303, `/login?next=${encodeURIComponent(url.pathname)}`);
  }
  const userId = locals.user.id;
  const gameRows = await listGames(userId);
  // Derive releaseDate / releaseTba from game_steam_listings — the
  // games row no longer carries the columns
  // (denormalization-audit-2.md V-2).
  const releaseByGameId = await deriveReleaseInfoForGames(
    userId,
    gameRows.map((g) => g.id),
  );
  return {
    games: gameRows.map((g) =>
      toGameDto(g, releaseByGameId.get(g.id) ?? { releaseDate: null, releaseTba: false }),
    ),
  };
};
