import type { PageServerLoad } from "./$types";
import { listAuditPage, type AuditActionFilter } from "$lib/server/services/audit-read.js";
import { AUDIT_ACTIONS } from "$lib/server/audit/actions.js";
import { toAuditEntryDto } from "$lib/server/dto.js";
import { AppError } from "$lib/server/services/errors.js";

/**
 * /audit loader — paginated audit-log read (Plan 02-10).
 *
 * The cursor and action filter are URL query parameters so the browser's
 * back/forward stack reflects pagination state.
 *
 * Direct service call (NOT fetch('/api/...')): the API and the page
 * render in the same Node process, so an HTTP roundtrip back to Hono
 * would deadlock SvelteKit's internal_fetch (Hono routes don't live in
 * SvelteKit's route tree — see post-execution P0 fix in SUMMARY).
 *
 * Defense-in-depth: validate `action` against AUDIT_ACTIONS BEFORE the
 * service call — the route layer's zod schema used to be the first line;
 * the service's `assertValidActionFilter` is the second. Without the HTTP
 * layer, validation here keeps the surface exactly as wide as before
 * (invalid → empty page, never a 422 surfaced to the user since this is
 * a forgiving GET-style loader).
 */
const VALID_ACTIONS: ReadonlySet<string> = new Set(["all", ...AUDIT_ACTIONS]);

export const load: PageServerLoad = async ({ locals, url }) => {
  if (!locals.user) {
    return { rows: [], nextCursor: null, action: "all", cursor: null };
  }

  const cursor = url.searchParams.get("cursor");
  const rawAction = url.searchParams.get("action") ?? "all";
  const action: AuditActionFilter = VALID_ACTIONS.has(rawAction)
    ? (rawAction as AuditActionFilter)
    : "all";

  try {
    const page = await listAuditPage(locals.user.id, cursor, action);
    return {
      rows: page.rows.map(toAuditEntryDto),
      nextCursor: page.nextCursor,
      action,
      cursor,
    };
  } catch (err) {
    // A bad cursor (forged / hand-edited URL) raises AppError 422 —
    // surface as an empty page rather than a noisy 500. Any other
    // service error also degrades to empty, matching the previous
    // fetch-based contract that swallowed non-2xx responses.
    if (err instanceof AppError) {
      return { rows: [], nextCursor: null, action, cursor };
    }
    return { rows: [], nextCursor: null, action, cursor };
  }
};
