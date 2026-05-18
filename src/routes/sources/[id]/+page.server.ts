// /sources/[id] loader. Renders one source's detail page just enough to
// host the RefreshContentButton.
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
import { loadSourceDetailPage } from "$lib/server/services/sources-page-read.js";
import { NotFoundError } from "$lib/server/services/errors.js";

export const load: PageServerLoad = async ({ params, locals }) => {
  const userId = locals.user?.id;
  if (userId == null) {
    error(401);
  }
  try {
    return await loadSourceDetailPage(userId, params.id);
  } catch (err) {
    if (err instanceof NotFoundError) {
      error(404);
    }
    throw err;
  }
};
