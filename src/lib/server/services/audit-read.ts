// Audit log READ surface (PRIV-02 — Plan 02-07; widened Plan 02.1-20 + 21).
//
// Phase 1 shipped the WRITE side (`src/lib/server/audit.ts` writeAudit only,
// PITFALL P19 append-only). This service lights up the user-visible read:
// tuple-comparison cursor pagination, the action filter (single source of
// truth: `AUDIT_ACTIONS` from src/lib/server/audit/actions.ts), and the DTO
// projection (toAuditEntryDto in dto.ts).
//
// Plan 02.1-20: actionFilter widens from single ("all" | AuditAction) to
// AuditAction[] (empty array = "all" semantics; 1-element uses eq; 2+ uses
// inArray). The "all" sentinel is gone — callers pass [] for the no-filter
// branch. /audit loader passes url.searchParams.getAll("action") directly.
//
// Plan 02.1-21: dateRange filter added to mirror /feed (UAT §9.2-bug — user
// quote: "В окне аудита нет возможности выбрать дату как в feed"). The userId
// WHERE clause stays FIRST in `and(...)` per P19 / privacy invariant 1; the
// dateRange clauses are independent of userId and append to filterParts.
//
// Pattern 1 (tenant scope): listAuditPage takes `userId: string` first; the
// SELECT's WHERE clause begins with `eq(auditLog.userId, userId)`. The custom
// ESLint rule `tenant-scope/no-unfiltered-tenant-query` (Plan 02-02) fires on
// any query against tenant-owned tables that omits this filter — so the
// absence of warnings on this file is a load-bearing assertion, not stylistic
// preference. Disable comments are NOT allowed.
//
// PITFALL P19 mitigation by construction: the userId filter is INDEPENDENT of
// the cursor AND the action filter. Even if an attacker forges a cursor
// encoding another tenant's (created_at, id) coordinates and a multi-action
// filter, the userId WHERE clause filters to the caller's rows only. The
// cross-tenant test in tests/integration/audit.test.ts is the runtime
// assertion (Plan 02.1-20 extends it to multi-action filters).
//
// Cursor format (D-31): base64url(JSON.stringify({at: ISO, id})). Tuple
// comparison `(created_at, id) < ($1, $2)` is stable under same-millisecond
// ties: id is UUIDv7 so the (created_at, id) ordering is deterministic and
// strictly decreasing.

import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { AUDIT_ACTIONS, type AuditAction } from "../audit/actions.js";
import { AppError } from "./errors.js";

export type AuditEntryRow = typeof auditLog.$inferSelect;

export interface AuditPage {
  rows: AuditEntryRow[];
  nextCursor: string | null;
}

// Plan 02.1-20: collapse the "all" sentinel — empty array = "all" semantics.
// Callers pass AuditAction[] directly. The previous "all" | AuditAction
// union is gone; all imports updated accordingly (loader passes [], not "all").
export type AuditActionFilter = AuditAction;

// Plan 02.1-21: optional date-range filter (mirrors /feed). Both ends are
// inclusive — the loader applies the end-of-day shift on `to` so a calendar-
// day URL param yields the same row count as a /feed query for the same day.
export interface AuditDateRange {
  from?: Date;
  to?: Date;
}

export const PAGE_SIZE = 50;

/**
 * Encode (created_at, id) tuple into the wire-format cursor.
 *
 * The cursor is opaque to the client but its construction is deterministic:
 * base64url(JSON.stringify({at: ISO, id})). The opacity is NOT the security
 * property — the userId WHERE clause is. P19 mitigation is by construction.
 */
export function encodeCursor(at: Date, id: string): string {
  return Buffer.from(JSON.stringify({ at: at.toISOString(), id })).toString("base64url");
}

/**
 * Decode a cursor string back into the tuple. Throws AppError(422) on any
 * malformed input — empty, not base64url, not JSON, missing fields, wrong
 * field types. The route layer (Plan 02-08) maps this to a clean 422 +
 * Paraglide-keyed error code.
 */
export function decodeCursor(s: string): { at: Date; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    if (typeof parsed?.at !== "string" || typeof parsed?.id !== "string") {
      throw new AppError("invalid cursor", "invalid_cursor", 422);
    }
    // Codex review (round-19 P2): `new Date("not-a-date")` returns an
    // Invalid Date sentinel that flows into Drizzle and surfaces as a
    // generic 500 instead of the documented 422 `invalid_cursor`. Reject
    // here so a forged cursor never reaches the query builder.
    const at = new Date(parsed.at);
    if (Number.isNaN(at.getTime())) {
      throw new AppError("invalid cursor", "invalid_cursor", 422);
    }
    return { at, id: parsed.id };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("invalid cursor", "invalid_cursor", 422);
  }
}

/**
 * Defense-in-depth: validate every entry against AUDIT_ACTIONS (single source
 * of truth, D-32). The /audit loader (Plan 02.1-20) drops invalid entries
 * silently before reaching here, but a forensic / smoke caller could pass a
 * forged value directly. Fail closed.
 */
function assertValidActionFilter(filter: string): asserts filter is AuditAction {
  if ((AUDIT_ACTIONS as readonly string[]).includes(filter)) return;
  throw new AppError("invalid action filter", "validation_failed", 422);
}

/**
 * Page through the caller's audit log. Returns up to PAGE_SIZE rows ordered
 * by (created_at desc, id desc) plus a `nextCursor` if more rows exist.
 *
 * Cursor semantics: when present, returns rows STRICTLY OLDER than the
 * cursor's (createdAt, id) tuple. The userId filter is independent of the
 * cursor, so a forged cross-tenant cursor returns zero of the other tenant's
 * rows by construction (P19 mitigation).
 *
 * actionFilter semantics (Plan 02.1-20):
 *   - [] (default) — no action filter; lists every action (the "all" branch).
 *   - [a] — filters to that single action; uses eq + the (user_id, action,
 *     created_at) composite index added by Plan 02-03.
 *   - [a, b, ...] — filters to the OR of the listed actions; uses inArray.
 *
 * dateRange semantics (Plan 02.1-21):
 *   - undefined (default) — no date filter; lists every row.
 *   - { from } — inclusive lower bound on createdAt.
 *   - { to } — inclusive upper bound on createdAt (loader shifts to
 *     23:59:59.999Z so a calendar-day URL param matches all rows on that day).
 *   - { from, to } — inclusive window.
 *   The userId WHERE clause stays FIRST in `and(...)` (PRIVACY INVARIANT 1);
 *   the dateRange clauses are independent of userId, so cross-tenant 404
 *   (P19) holds by construction even with a forged cursor + date filter.
 */
export async function listAuditPage(
  userId: string,
  cursor: string | null,
  actionFilter: AuditActionFilter[] = [],
  dateRange?: AuditDateRange,
): Promise<AuditPage> {
  // Defense-in-depth: validate every entry in the array. Plan 02-08's
  // route layer is gone (Plan 02-10 went direct-service); the loader
  // now drops invalid entries before reaching here, but a forensic /
  // smoke caller could pass a forged value. Fail closed.
  for (const a of actionFilter) assertValidActionFilter(a);

  // Decode the cursor ONCE so the SQL builder doesn't re-parse the same
  // string twice (a pure refinement of RESEARCH.md §"Cursor pagination" —
  // the snippet there decoded inside both halves of the ternary).
  let parsedCursor: { at: Date; id: string } | null = null;
  if (cursor) parsedCursor = decodeCursor(cursor);

  const cursorClause = parsedCursor
    ? sql`(${auditLog.createdAt}, ${auditLog.id}) < (${parsedCursor.at}, ${parsedCursor.id})`
    : sql`true`;

  // Action-filter clause: 0 = no clause, 1 = eq (cheaper, uses the
  // (user_id, action, created_at) composite index added by Plan 02-03),
  // 2+ = inArray (Postgres optimizer flattens to IN(...)).
  let actionClause;
  if (actionFilter.length === 0) {
    actionClause = sql`true`;
  } else if (actionFilter.length === 1) {
    actionClause = eq(auditLog.action, actionFilter[0]!);
  } else {
    actionClause = inArray(auditLog.action, actionFilter);
  }

  // Plan 02.1-21: optional date-range clauses. Independent of userId.
  // Pushed to filterParts so the WHERE structure stays:
  //   and(eq(userId), cursorClause, actionClause, ...filterParts)
  // — userId remains the FIRST clause for ESLint tenant-scope structural
  // matching and PRIVACY INVARIANT 1.
  const filterParts: Array<ReturnType<typeof gte>> = [];
  if (dateRange?.from !== undefined) {
    filterParts.push(gte(auditLog.createdAt, dateRange.from));
  }
  if (dateRange?.to !== undefined) {
    filterParts.push(lte(auditLog.createdAt, dateRange.to));
  }

  // userId filter is FIRST in `and(...)` — load-bearing for the
  // tenant-scope ESLint rule's structural match and for query-plan
  // intuition (the index leads with user_id). PRIVACY INVARIANT
  // (CLAUDE.md item 1) preserved by construction.
  const rows = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.userId, userId), cursorClause, actionClause, ...filterParts))
    .orderBy(sql`${auditLog.createdAt} desc, ${auditLog.id} desc`)
    .limit(PAGE_SIZE + 1);

  const hasMore = rows.length > PAGE_SIZE;
  const page = rows.slice(0, PAGE_SIZE);
  const last = page[page.length - 1];
  return {
    rows: page,
    nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}
