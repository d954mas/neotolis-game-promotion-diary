import type { PageServerLoad } from "./$types";
import { listAuditPage } from "$lib/server/services/audit-read.js";
import { loadUserQuota } from "$lib/server/services/quota-read.js";
import { AUDIT_ACTIONS, type AuditAction } from "$lib/server/audit/actions.js";
import { toAuditEntryDto } from "$lib/server/dto.js";
import { AppError } from "$lib/server/services/errors.js";

/**
 * /audit loader — paginated audit-log read.
 *
 * Action filter is multi-select (?action=A&action=B repeated params),
 * mirroring /feed's convention. Empty array = "all" semantics (default).
 *
 * Date-range filter mirrors /feed's URL contract
 * (?from=YYYY-MM-DD&to=YYYY-MM-DD). UNLIKE /feed, /audit does NOT default
 * to last-30-days — auditing is investigative; the default is "no date
 * filter, show every row".
 *
 * The cursor and filter params are URL query parameters so the browser's
 * back/forward stack reflects pagination state.
 *
 * Direct service call (NOT fetch('/api/...')): the API and the page
 * render in the same Node process; an HTTP roundtrip back to Hono would
 * deadlock SvelteKit's internal_fetch.
 *
 * Forgiving-GET: invalid action entries are dropped silently rather than
 * surfacing 422 to the user. Invalid date strings short-circuit to
 * undefined (same pattern as /feed). The defense-in-depth in
 * listAuditPage catches anything that bypasses this filter.
 *
 * Privacy review:
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
      // Uniform return shape with the authenticated branch (matches the
      // /sources anonymous-branch convention). The QuotaStatusBanner
      // renders nothing for an anonymous (never-reached) view.
      quotaPlatforms: [],
      redditQuota: { isOperatorConfigured: false as const },
    };
  }

  const cursor = url.searchParams.get("cursor");
  const rawActions = url.searchParams.getAll("action");
  // Forgiving-GET: drop invalid entries silently rather than 422 the page.
  const actionFilter = rawActions.filter((a): a is AuditAction => VALID_ACTIONS.has(a));

  // Date-range parsing mirrors /feed's pattern — date-only
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

  // Per-user quota for the banner at the top of /audit. Same shared read
  // /sources uses (D-03) — the two surfaces can never drift.
  const { quotaPlatforms, redditQuota } = await loadUserQuota(locals.user.id);

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
      quotaPlatforms,
      redditQuota,
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
        quotaPlatforms,
        redditQuota,
      };
    }
    return {
      rows: [],
      nextCursor: null,
      actionFilter,
      cursor,
      from: fromValid ? fromValid.toISOString().slice(0, 10) : undefined,
      to: toValid ? toValid.toISOString().slice(0, 10) : undefined,
      quotaPlatforms,
      redditQuota,
    };
  }
};
