import type { PageServerLoad } from "./$types";
import { listSources } from "$lib/server/services/data-sources.js";
import { toDataSourceDto } from "$lib/server/dto.js";

/**
 * /sources loader — list the caller's data_sources, partitioned active vs
 * soft-deleted (Phase 2.1 SOURCES-01 / SOURCES-02).
 *
 * Replaces the retired Phase 2 per-platform accounts loader (the Phase 2 youtube-channels
 * service was retired in Plan 02.1-04). Returns BOTH the active list and the
 * soft-deleted list so the page can render the "Show N deleted source(s)"
 * toggle (UI-SPEC §"/sources page layout") without a second SSR roundtrip.
 *
 * Direct service call (NOT fetch('/api/...')): the API and the page render
 * in the same Node process, so an HTTP roundtrip back to Hono would
 * deadlock SvelteKit's internal_fetch (Plan 02-10 P0 precedent).
 * `listSources` enforces tenant scope; `toDataSourceDto` strips `userId`
 * per P3 discipline.
 */
export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) return { active: [], deleted: [] };
  const all = await listSources(locals.user.id, { includeDeleted: true });
  const dtos = all.map(toDataSourceDto);
  return {
    active: dtos.filter((s) => s.deletedAt === null),
    deleted: dtos.filter((s) => s.deletedAt !== null),
  };
};
