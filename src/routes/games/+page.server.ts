import type { PageServerLoad } from "./$types";

/**
 * /games loader — list the caller's games (Plan 02-10).
 *
 * Uses SvelteKit's `fetch` so the request's session cookie forwards to
 * `/api/games` automatically (no manual cookie threading). Returns both the
 * active list and the count of soft-deleted rows so the UI can render the
 * "Show N deleted games" toggle without a second SSR round-trip.
 *
 * Soft-deleted-count technique: GET /api/games?includeSoftDeleted=true and
 * filter client-side. Two fetches in parallel is acceptable here because
 * the soft-deleted set is bounded by the user's lifetime games (small) and
 * the listing route is itself a thin SELECT against a tenant-scoped table.
 *
 * Errors: a 5xx from the API surfaces as a SvelteKit `error()`; a 4xx
 * (which should be unreachable for a logged-in user — the route is
 * tenant-scoped) returns an empty list rather than crashing the page.
 */
export const load: PageServerLoad = async ({ fetch, parent }) => {
  const { user } = await parent();
  if (!user) return { games: [], softDeleted: [] };

  const [activeRes, allRes] = await Promise.all([
    fetch("/api/games"),
    fetch("/api/games?includeSoftDeleted=true"),
  ]);

  const games = activeRes.ok ? ((await activeRes.json()) as Array<unknown>) : [];
  const all = allRes.ok ? ((await allRes.json()) as Array<{ deletedAt: string | null }>) : [];
  const softDeleted = all.filter((g) => g.deletedAt !== null);

  return { games, softDeleted };
};
