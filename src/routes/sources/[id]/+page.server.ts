// /sources/[id] loader — Phase 03.0.1 Plan 10. Renders one source's detail
// page just enough to host the RefreshContentButton (the user-facing payoff
// of the Wave 0-8 source-plugin refactor).
//
// AGENTS.md invariants:
//   1. Tenant scoping — getSourceById(userId, params.id) is the only DB
//      read; cross-tenant access throws NotFoundError → SvelteKit error(404).
//   2. Cross-tenant 404 not 403 — error(404) carries the literal "Not
//      Found"; the SvelteKit error layout never emits "forbidden" /
//      "permission" text for tenant-owned resources.
//   5. DTO discipline — toDataSourceDto strips userId at projection time.
//      The page renders only fields surfaced by the DTO.
//
// Soft-deleted rows surface as 404 (matches GET /api/sources/:id pattern:
// the tombstone is invisible to detail navigation; users see them only on
// /sources via the Recently-deleted dialog).

import type { PageServerLoad } from "./$types.js";
import { error } from "@sveltejs/kit";
import { getSourceById } from "$lib/server/services/data-sources.js";
import { toDataSourceDto } from "$lib/server/dto.js";
import { NotFoundError } from "$lib/server/services/errors.js";

export const load: PageServerLoad = async ({ params, locals }) => {
  const userId = locals.user?.id;
  if (userId == null) {
    error(401);
  }
  try {
    const row = await getSourceById(userId, params.id);
    if (row.deletedAt !== null) {
      error(404);
    }
    return { source: toDataSourceDto(row) };
  } catch (err) {
    if (err instanceof NotFoundError) {
      error(404);
    }
    throw err;
  }
};
