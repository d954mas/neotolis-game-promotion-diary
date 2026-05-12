import type { PageServerLoad } from "./$types";
import { error, redirect } from "@sveltejs/kit";
import { getEventById } from "$lib/server/services/events.js";
import { listGames } from "$lib/server/services/games.js";
import {
  toEventDto,
  toGameDto,
  loadGameIdsForEvent,
  loadVideoDataForEvents,
} from "$lib/server/dto.js";
import { NotFoundError } from "$lib/server/services/errors.js";

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
    const games = await listGames(locals.user.id);
    // Load attached gameIds via the M:N junction. The page surfaces the
    // FIRST attached game as the "primary" (legacy single-game UI
    // affordance preserved).
    const gameIds = await loadGameIdsForEvent(locals.user.id, row.id);
    // Load polling state from youtube_videos for kind=youtube_video events.
    // PollingBadge consumes publishedAt + lastPollStatus + lastPolledAt via
    // the EventDto.
    const videoMap = await loadVideoDataForEvents(locals.user.id, [row]);
    const videoData = row.externalId ? (videoMap.get(row.externalId) ?? null) : null;
    const primaryGame =
      gameIds.length > 0 ? (games.find((g) => g.id === gameIds[0]) ?? null) : null;
    return {
      event: toEventDto(row, gameIds, videoData),
      games: games.map(toGameDto),
      game: primaryGame ? toGameDto(primaryGame) : null,
    };
  } catch (err) {
    if (err instanceof NotFoundError) throw error(404, "Event not found");
    throw error(500, "Failed to load event");
  }
};
