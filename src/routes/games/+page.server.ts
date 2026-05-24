import type { PageServerLoad } from "./$types";
import {
  listGames,
  listSoftDeletedGames,
  deriveReleaseInfoForGames,
} from "$lib/server/services/games.js";
import { toGameDto } from "$lib/server/dto.js";
import { db } from "$lib/server/db/client.js";
import { eventGames, events } from "$lib/server/db/schema/index.js";
import { and, eq, isNull, sql, inArray } from "drizzle-orm";

/**
 * /games loader — list the caller's games.
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

  // Per-game event count for the list view. Counts non-deleted events
  // attached via the event_games junction. Single GROUP BY query — N
  // games + 1 query (not N+1).
  const eventCountByGameId = new Map<string, number>();
  const activeIds = activeRows.map((r) => r.id);
  if (activeIds.length > 0) {
    // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- userId filter on both joined tables; ESLint can't span the AND chain
    const rows = await db
      .select({
        gameId: eventGames.gameId,
        count: sql<string>`count(*)`,
      })
      .from(eventGames)
      .innerJoin(events, eq(events.id, eventGames.eventId))
      .where(
        and(
          eq(eventGames.userId, locals.user.id),
          eq(events.userId, locals.user.id),
          isNull(events.deletedAt),
          inArray(eventGames.gameId, activeIds),
        ),
      )
      .groupBy(eventGames.gameId);
    for (const r of rows) eventCountByGameId.set(r.gameId, Number(r.count));
  }

  // Derive releaseDate / releaseTba from game_steam_listings — the
  // games row no longer carries these columns. See
  // services/games.ts deriveReleaseInfoForGames header and
  // denormalization-audit-2.md V-2 for rationale.
  const releaseByGameId = await deriveReleaseInfoForGames(locals.user.id, activeIds);

  const games = activeRows.map((r) => ({
    ...toGameDto(r, releaseByGameId.get(r.id) ?? { releaseDate: null, releaseTba: false }),
    eventCount: eventCountByGameId.get(r.id) ?? 0,
  }));

  // Soft-deleted games get the same JOIN-derived release info so the
  // recovery dialog and any future trash-list rendering see consistent
  // values. The deriveReleaseInfoForGames query filters by
  // `isNull(deletedAt)` on listings only — soft-deleted listings are
  // intentionally excluded from the derivation regardless of the
  // parent's state. A soft-deleted game whose listings were cascaded
  // gets `{ releaseDate: null, releaseTba: false }`, which matches the
  // dialog's read-only summary surface.
  const softDeletedIds = softDeletedRows.map((r) => r.id);
  const softDeletedRelease = await deriveReleaseInfoForGames(locals.user.id, softDeletedIds);

  return {
    games,
    softDeleted: softDeletedRows.map((r) =>
      toGameDto(r, softDeletedRelease.get(r.id) ?? { releaseDate: null, releaseTba: false }),
    ),
  };
};
