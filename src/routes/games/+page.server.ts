import type { PageServerLoad } from "./$types";
import {
  listGames,
  listSoftDeletedGames,
  deriveReleaseInfoForGames,
} from "$lib/server/services/games.js";
import { countEventsByGameIds } from "$lib/server/services/events.js";
import { toGameDto } from "$lib/server/dto.js";

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
export const load: PageServerLoad = async ({ locals, url }) => {
  const view = url.searchParams.get("view") === "trash" ? "trash" : "feed" as const;
  if (!locals.user) return { view, games: [], softDeleted: [] };

  const [activeRows, softDeletedRows] = await Promise.all([
    listGames(locals.user.id),
    listSoftDeletedGames(locals.user.id),
  ]);

  // Per-game event count for the list view via the events service.
  // Routes call services per AGENTS.md — the prior inline JOIN +
  // ESLint disable was a routes-call-services violation flagged in
  // the self-review audit.
  const activeIds = activeRows.map((r) => r.id);
  const eventCountByGameId = await countEventsByGameIds(locals.user.id, activeIds);

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
    view,
    games,
    softDeleted: softDeletedRows.map((r) =>
      toGameDto(r, softDeletedRelease.get(r.id) ?? { releaseDate: null, releaseTba: false }),
    ),
  };
};
