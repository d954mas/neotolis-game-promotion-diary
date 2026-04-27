// Audit log READ surface (PRIV-02 — Plan 02-07).
//
// Phase 1 shipped the WRITE side (`src/lib/server/audit.ts` writeAudit only,
// PITFALL P19 append-only). This service lights up the user-visible read:
// tuple-comparison cursor pagination, the action filter (single source of
// truth: `AUDIT_ACTIONS` from src/lib/server/audit/actions.ts), and the DTO
// projection (toAuditEntryDto in dto.ts).
//
// Pattern 1 (tenant scope): listAuditPage takes `userId: string` first; the
// SELECT's WHERE clause begins with `eq(auditLog.userId, userId)`. The custom
// ESLint rule `tenant-scope/no-unfiltered-tenant-query` (Plan 02-02) fires on
// any query against tenant-owned tables that omits this filter — so the
// absence of warnings on this file is a load-bearing assertion, not stylistic
// preference. Disable comments are NOT allowed.
//
// PITFALL P19 mitigation by construction: the userId filter is INDEPENDENT of
// the cursor. Even if an attacker forges a cursor encoding another tenant's
// (created_at, id) coordinates, the userId WHERE clause filters to the
// caller's rows only. The cross-tenant test in tests/integration/audit.test.ts
// is the runtime assertion.
//
// Cursor format (D-31): base64url(JSON.stringify({at: ISO, id})). Tuple
// comparison `(created_at, id) < ($1, $2)` is stable under same-millisecond
// ties: id is UUIDv7 so the (created_at, id) ordering is deterministic and
// strictly decreasing.

import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { AUDIT_ACTIONS, type AuditAction } from "../audit/actions.js";
import { AppError } from "./errors.js";

export type AuditEntryRow = typeof auditLog.$inferSelect;

export interface AuditPage {
  rows: AuditEntryRow[];
  nextCursor: string | null;
}

export type AuditActionFilter = "all" | AuditAction;

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
    return { at: new Date(parsed.at), id: parsed.id };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("invalid cursor", "invalid_cursor", 422);
  }
}

/**
 * Defense-in-depth: validate the actionFilter parameter against the
 * AUDIT_ACTIONS const list (single source of truth, D-32). Plan 02-08's
 * route layer also validates via zod against `['all', ...AUDIT_ACTIONS]` —
 * this is the second layer so even a direct service-level call (a future
 * smoke / forensic tool) cannot poison the WHERE clause with an unknown
 * action string.
 */
function assertValidActionFilter(filter: string): asserts filter is AuditActionFilter {
  if (filter === "all") return;
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
 * actionFilter='all' lists every action; actionFilter='key.add' (or any
 * AUDIT_ACTIONS member) filters to that single action — uses the
 * (user_id, action, created_at) composite index added by Plan 02-03.
 */
export async function listAuditPage(
  userId: string,
  cursor: string | null,
  actionFilter: AuditActionFilter = "all",
): Promise<AuditPage> {
  assertValidActionFilter(actionFilter);

  // Decode the cursor ONCE so the SQL builder doesn't re-parse the same
  // string twice (a pure refinement of RESEARCH.md §"Cursor pagination" —
  // the snippet there decoded inside both halves of the ternary).
  let parsedCursor: { at: Date; id: string } | null = null;
  if (cursor) parsedCursor = decodeCursor(cursor);

  const cursorClause = parsedCursor
    ? sql`(${auditLog.createdAt}, ${auditLog.id}) < (${parsedCursor.at}, ${parsedCursor.id})`
    : sql`true`;
  const filterClause =
    actionFilter === "all" ? sql`true` : eq(auditLog.action, actionFilter);

  // userId filter is FIRST in `and(...)` — load-bearing for the
  // tenant-scope ESLint rule's structural match and for query-plan
  // intuition (the index leads with user_id).
  const rows = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.userId, userId), cursorClause, filterClause))
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
