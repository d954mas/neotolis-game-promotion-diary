import type { PageServerLoad } from "./$types";
import { listGames, listSoftDeletedGames } from "$lib/server/services/games.js";
import { toGameDto } from "$lib/server/dto.js";

/**
 * /games loader — list the caller's games (Plan 02-10).
 *
 * Returns both the active list and the soft-deleted list so the UI can
 * render the "Show N deleted games" toggle without a second SSR
 * round-trip. Two service calls in parallel via Promise.all is acceptable
 * here because the soft-deleted set is bounded by the user's lifetime
 * games (small) and listGames is a thin SELECT against a tenant-scoped
 * table.
 *
 * Direct service calls (NOT fetch('/api/...')): the API and the page
 * render in the same Node process, so an HTTP roundtrip back to Hono
 * would deadlock SvelteKit's internal_fetch (Hono routes don't live in
 * SvelteKit's route tree — see post-execution P0 fix in SUMMARY). Both
 * service functions enforce `userId` scoping; every row goes through
 * `toGameDto` which strips `userId` (P3 discipline).
 */
export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) return { games: [], softDeleted: [] };

  const [activeRows, softDeletedRows] = await Promise.all([
    listGames(locals.user.id),
    listSoftDeletedGames(locals.user.id),
  ]);

  return {
    games: activeRows.map(toGameDto),
    softDeleted: softDeletedRows.map(toGameDto),
  };
};
