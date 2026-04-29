import type { PageServerLoad } from "./$types";
import { error, redirect } from "@sveltejs/kit";
import { getEventById } from "$lib/server/services/events.js";
import { listGames } from "$lib/server/services/games.js";
import { toEventDto, toGameDto } from "$lib/server/dto.js";
import { NotFoundError } from "$lib/server/services/errors.js";

/**
 * /events/[id] loader (Plan 02.1-18 — full detail rebuild).
 *
 * Phase-2.1 Plan 02.1-18 replaces the Phase-4 stub with a full event
 * detail surface. The Phase-4 LayerChart placeholder is now anchored
 * inline at the bottom (D-07 spirit preserved).
 *
 * Privacy invariants:
 *   - Anonymous → redirect(303, /login?next=...) — page-route gate
 *     (Plan 02.1-09 precedent; the anonymous-401 sweep covers /api/*).
 *     `error(401)` is reserved for /api/*; pages route to /login.
 *   - Cross-tenant → 404 via NotFoundError → throw error(404)
 *     (PRIV-01: 404, never 403).
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
    const games = await listGames(locals.user.id);
    const game = row.gameId ? (games.find((g) => g.id === row.gameId) ?? null) : null;
    return {
      event: toEventDto(row),
      games: games.map(toGameDto),
      game: game ? toGameDto(game) : null,
    };
  } catch (err) {
    if (err instanceof NotFoundError) throw error(404, "Event not found");
    throw error(500, "Failed to load event");
  }
};
