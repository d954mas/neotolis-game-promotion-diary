import type { PageServerLoad } from "./$types";
import { listAuditPage } from "$lib/server/services/audit-read.js";
import { AUDIT_ACTIONS, type AuditAction } from "$lib/server/audit/actions.js";
import { toAuditEntryDto } from "$lib/server/dto.js";
import { AppError } from "$lib/server/services/errors.js";

/**
 * /audit loader — paginated audit-log read (Plan 02-10; reshaped Plan 02.1-20;
 * extended Plan 02.1-21 with date-range filter).
 *
 * Plan 02.1-20: action filter switches from single-select (?action=A) to
 * multi-select (?action=A&action=B repeated params), mirroring /feed's
 * convention from Plan 02.1-15. Empty array = "all" semantics (default).
 *
 * Plan 02.1-21: date-range filter mirrors /feed's URL contract
 * (?from=YYYY-MM-DD&to=YYYY-MM-DD). UAT-NOTES.md §9.2-bug user quote:
 * "В окне аудита нет возможности выбрать дату как в feed". UNLIKE /feed,
 * /audit does NOT default to last-30-days — auditing is investigative;
 * the default is "no date filter, show every row".
 *
 * URL contract change (Plan 02.1-20) is destructive: the previous
 * `?action=key.add` single value is no longer interpreted as a sentinel-
 * needing field; the same URL still works because
 * url.searchParams.getAll('action') returns ['key.add'] which the new
 * single-element array branch handles via eq(). Pre-launch (CONTEXT D-04:
 * zero self-host deployments) so any older bookmark with `?action=all`
 * literal falls through forgiving-GET (filtered out by VALID_ACTIONS) and
 * the page renders the no-filter default. No leak.
 *
 * The cursor and filter params are URL query parameters so the browser's
 * back/forward stack reflects pagination state.
 *
 * Direct service call (NOT fetch('/api/...')): the API and the page
 * render in the same Node process; an HTTP roundtrip back to Hono would
 * deadlock SvelteKit's internal_fetch (D-31 + Plan 02-10 P0 fix).
 *
 * Forgiving-GET: invalid action entries are dropped silently rather than
 * surfacing 422 to the user. Invalid date strings short-circuit to
 * undefined (same pattern as /feed). The defense-in-depth in
 * listAuditPage catches anything that bypasses this filter.
 *
 * Privacy review (Plan 02.1-21):
 *   - if (!locals.user) early-return — anonymous-401 surface (no /api/* route).
 *   - listAuditPage(userId, ...) is userId-scoped — tenant-scope ESLint rule passes.
 *   - DTO projection (toAuditEntryDto) strips userId by construction.
 *   - Cross-tenant 404 not 403 — listAuditPage's userId WHERE clause prunes
 *     BEFORE the date / action filters narrow; integration test asserts.
 *   - No new env reads; no new audit verbs; no schema changes.
 */
const VALID_ACTIONS: ReadonlySet<string> = new Set(AUDIT_ACTIONS);

export const load: PageServerLoad = async ({ locals, url }) => {
  if (!locals.user) {
    return {
      rows: [],
      nextCursor: null,
      actionFilter: [] as AuditAction[],
      cursor: null,
      from: undefined as string | undefined,
      to: undefined as string | undefined,
    };
  }

  const cursor = url.searchParams.get("cursor");
  const rawActions = url.searchParams.getAll("action");
  // Forgiving-GET: drop invalid entries silently rather than 422 the page.
  const actionFilter = rawActions.filter(
    (a): a is AuditAction => VALID_ACTIONS.has(a),
  );

  // Plan 02.1-21: date-range parsing mirrors /feed's pattern — date-only
  // YYYY-MM-DD inputs are inclusive on both ends. `from` becomes 00:00:00
  // UTC of that day; `to` becomes 23:59:59.999 UTC so picking
  // from=to=2026-04-26 matches every row on the 26th.
  // Unlike /feed, NO default 30-day window — auditing is investigative.
  const fromParam = url.searchParams.get("from") ?? undefined;
  const toParam = url.searchParams.get("to") ?? undefined;
  const fromDate = fromParam ? new Date(`${fromParam}T00:00:00.000Z`) : undefined;
  const toDate = toParam ? new Date(`${toParam}T23:59:59.999Z`) : undefined;
  const fromValid = fromDate && !Number.isNaN(fromDate.getTime()) ? fromDate : undefined;
  const toValid = toDate && !Number.isNaN(toDate.getTime()) ? toDate : undefined;

  try {
    const page = await listAuditPage(locals.user.id, cursor, actionFilter, {
      from: fromValid,
      to: toValid,
    });
    return {
      rows: page.rows.map(toAuditEntryDto),
      nextCursor: page.nextCursor,
      actionFilter,
      cursor,
      // ISO date strings (YYYY-MM-DD) for the page's <DateRangeControl>.
      from: fromValid ? fromValid.toISOString().slice(0, 10) : undefined,
      to: toValid ? toValid.toISOString().slice(0, 10) : undefined,
    };
  } catch (err) {
    // A bad cursor (forged / hand-edited URL) raises AppError 422 —
    // surface as an empty page rather than a noisy 500. Any other
    // service error also degrades to empty, matching the previous
    // fetch-based contract that swallowed non-2xx responses.
    if (err instanceof AppError) {
      return {
        rows: [],
        nextCursor: null,
        actionFilter,
        cursor,
        from: fromValid ? fromValid.toISOString().slice(0, 10) : undefined,
        to: toValid ? toValid.toISOString().slice(0, 10) : undefined,
      };
    }
    return {
      rows: [],
      nextCursor: null,
      actionFilter,
      cursor,
      from: fromValid ? fromValid.toISOString().slice(0, 10) : undefined,
      to: toValid ? toValid.toISOString().slice(0, 10) : undefined,
    };
  }
};
