import type { PageServerLoad } from "./$types";
import { error, redirect } from "@sveltejs/kit";
import { getEventById } from "$lib/server/services/events.js";
import { listGames } from "$lib/server/services/games.js";
import { toEventDto, toGameDto } from "$lib/server/dto.js";
import { NotFoundError } from "$lib/server/services/errors.js";

/**
 * /events/[id]/edit loader (Plan 02.1-18 — new route).
 *
 * Privacy invariants:
 *   - Anonymous → redirect(303, /login?next=...) — page-route gate
 *     (Plan 02.1-09 precedent; the anonymous-401 sweep covers /api/*).
 *   - Cross-tenant → 404 via NotFoundError → throw error(404)
 *     (PRIV-01: 404, never 403). The PATCH /api/events/:id endpoint
 *     consumed by the form's submit is also tenant-scoped (Plan 02.1-06
 *     MUST_BE_PROTECTED entry).
 *   - Soft-deleted rows are NOT shown on the edit form — Restore lives
 *     on /events/[id] only. getEventById's default (no opts) throws
 *     NotFoundError on soft-deleted rows; that's the correct behavior
 *     here.
 *   - toEventDto strips userId by construction; no ciphertext columns
 *     exist on events.
 */
export const load: PageServerLoad = async ({ locals, params, url }) => {
  if (!locals.user) {
    throw redirect(303, `/login?next=${encodeURIComponent(url.pathname)}`);
  }
  try {
    const row = await getEventById(locals.user.id, params.id);
    const games = await listGames(locals.user.id);
    return {
      event: toEventDto(row),
      games: games.map(toGameDto),
    };
  } catch (err) {
    if (err instanceof NotFoundError) throw error(404, "Event not found");
    throw error(500, "Failed to load event");
  }
};
