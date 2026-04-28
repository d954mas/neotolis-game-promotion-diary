import type { PageServerLoad } from "./$types";
import { error } from "@sveltejs/kit";
import { getEventById } from "$lib/server/services/events.js";
import { toEventDto } from "$lib/server/dto.js";
import { NotFoundError } from "$lib/server/services/errors.js";

/**
 * /events/[id] loader (Plan 02.1-09; CONTEXT D-07).
 *
 * Phase-4 stub: VIZ-01 (LayerChart-driven event detail with view-count
 * history) lands in Phase 4. Phase 2.1 ships this stub so the FeedRow's
 * "Open" button has a destination — UI-SPEC FLAG: "honest, sets
 * expectations, avoids a 404".
 *
 * Cross-tenant access surfaces as 404 (PRIV-01: 404, never 403).
 * Soft-deleted rows count as missing.
 */
export const load: PageServerLoad = async ({ locals, params }) => {
  if (!locals.user) {
    throw error(401, "Sign in required");
  }
  try {
    const row = await getEventById(locals.user.id, params.id);
    return { event: toEventDto(row) };
  } catch (err) {
    if (err instanceof NotFoundError) throw error(404, "Event not found");
    throw error(500, "Failed to load event");
  }
};
