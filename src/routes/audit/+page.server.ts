import type { PageServerLoad } from "./$types";
import { listAuditPage } from "$lib/server/services/audit-read.js";
import { AUDIT_ACTIONS, type AuditAction } from "$lib/server/audit/actions.js";
import { toAuditEntryDto } from "$lib/server/dto.js";
import { AppError } from "$lib/server/services/errors.js";

/**
 * /audit loader — paginated audit-log read (Plan 02-10; reshaped Plan 02.1-20).
 *
 * Plan 02.1-20: action filter switches from single-select (?action=A) to
 * multi-select (?action=A&action=B repeated params), mirroring /feed's
 * convention from Plan 02.1-15. Empty array = "all" semantics (default).
 *
 * URL contract change is destructive: the previous `?action=key.add` single
 * value is no longer interpreted as a sentinel-needing field; the same URL
 * still works because url.searchParams.getAll('action') returns ['key.add']
 * which the new single-element array branch handles via eq(). Pre-launch
 * (CONTEXT D-04: zero self-host deployments) so any older bookmark with
 * `?action=all` literal falls through forgiving-GET (filtered out by
 * VALID_ACTIONS) and the page renders the no-filter default. No leak.
 *
 * The cursor and action filters are URL query parameters so the browser's
 * back/forward stack reflects pagination state.
 *
 * Direct service call (NOT fetch('/api/...')): the API and the page
 * render in the same Node process; an HTTP roundtrip back to Hono would
 * deadlock SvelteKit's internal_fetch (D-31 + Plan 02-10 P0 fix).
 *
 * Forgiving-GET: invalid action entries are dropped silently rather than
 * surfacing 422 to the user. The defense-in-depth in listAuditPage
 * catches anything that bypasses this filter.
 *
 * Privacy review (Plan 02.1-20):
 *   - if (!locals.user) early-return — anonymous-401 surface (no /api/* route).
 *   - listAuditPage(userId, ...) is userId-scoped — tenant-scope ESLint rule passes.
 *   - DTO projection (toAuditEntryDto) strips userId by construction.
 *   - Cross-tenant 404 not 403 — listAuditPage's userId WHERE clause prunes
 *     BEFORE the action filter narrows; integration test asserts.
 *   - No new env reads; no new audit verbs; no schema changes.
 */
const VALID_ACTIONS: ReadonlySet<string> = new Set(AUDIT_ACTIONS);

export const load: PageServerLoad = async ({ locals, url }) => {
  if (!locals.user) {
    return { rows: [], nextCursor: null, actionFilter: [] as AuditAction[], cursor: null };
  }

  const cursor = url.searchParams.get("cursor");
  const rawActions = url.searchParams.getAll("action");
  // Forgiving-GET: drop invalid entries silently rather than 422 the page.
  const actionFilter = rawActions.filter(
    (a): a is AuditAction => VALID_ACTIONS.has(a),
  );

  try {
    const page = await listAuditPage(locals.user.id, cursor, actionFilter);
    return {
      rows: page.rows.map(toAuditEntryDto),
      nextCursor: page.nextCursor,
      actionFilter,
      cursor,
    };
  } catch (err) {
    // A bad cursor (forged / hand-edited URL) raises AppError 422 —
    // surface as an empty page rather than a noisy 500. Any other
    // service error also degrades to empty, matching the previous
    // fetch-based contract that swallowed non-2xx responses.
    if (err instanceof AppError) {
      return { rows: [], nextCursor: null, actionFilter, cursor };
    }
    return { rows: [], nextCursor: null, actionFilter, cursor };
  }
};
