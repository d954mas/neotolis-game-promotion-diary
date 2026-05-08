// Append-only audit log table.
//
// PITFALL P19 mitigation — every row is scoped to a `user_id` and the only
// efficient pagination cursor is `(user_id, created_at)`. Listing my audit
// log can NEVER observe another tenant's row IDs by construction, because
// the index supports no other lookup pattern.
//
// The application role MUST NOT have UPDATE/DELETE grants on this table —
// enforce in the deploy procedure (Phase 6). The writer in
// src/lib/server/audit.ts is INSERT-only by design; even if grants leaked,
// the writer never offers an update or delete path.
//
// `metadata` is jsonb and intentionally untyped: callers pass only their
// OWN tenant's data. We do not introspect — that would create a different
// kind of leak (a sanitizer ruleset that sees other tenants' identifiers).
//
// Phase 2 (D-32): the `action` column is now typed as the `audit_action`
// pgEnum defined in src/lib/server/audit/actions.ts (the single source of
// truth for the vocabulary). A new (user_id, action, created_at) index
// powers the action-filter dropdown in the audit UI.
//
// Phase 3.0 Plan 05 (migration 0011): the user_id → user(id) FK was
// DROPPED. audit_log.user_id is now a plain text column whose value
// outlives the user row it references. Required for the purge worker
// (PRIV-04 / GDPR Art. 17 60-day-grace): without dropping the FK, the
// purge.completed audit row was either cascade-deleted with the user
// (write-before-tx) or rejected by FK-violation (write-after-tx). Either
// outcome violates AGENTS.md §4 "audit is INSERT-only" for this verb.
// Open Question 4 in 03.0-RESEARCH.md formalizes the contract: the purge
// audit row is scoped to the purged user_id and remains queryable by
// admins through the /admin/quota cross-tenant aggregation. P19 cursor
// invariant is unchanged — the (user_id, created_at) and (user_id, action,
// created_at) indexes still support tenant-relative pagination only.

import { pgTable, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { auditActionEnum } from "../../audit/actions.js";
import { uuidv7 } from "../../ids.js";

// Re-export so drizzle-kit's schema scan (glob: ./src/lib/server/db/schema/*.ts)
// picks up the audit_action pgEnum even though its source of truth lives in
// src/lib/server/audit/actions.ts (D-32). Without this re-export drizzle-kit
// silently drops the CREATE TYPE statement (drizzle-team/drizzle-orm#5174)
// and the generated migration's ALTER COLUMN ... TYPE audit_action fails
// because the enum doesn't exist yet.
export { auditActionEnum };

export const auditLog = pgTable(
  "audit_log",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    // Phase 3.0 Plan 05 (migration 0011): no FK to user(id). The purge
    // worker hard-DELETEs user rows and the audit row must survive the
    // delete (Open Question 4 — AGENTS.md §4 INSERT-only invariant).
    userId: text("user_id").notNull(),
    // Typed pgEnum as of Phase 2 D-32 — values defined in
    // src/lib/server/audit/actions.ts (AUDIT_ACTIONS const).
    action: auditActionEnum("action").notNull(),
    // Resolved by Plan 06 trusted-proxy middleware (D-19). Phase 1 records
    // real IPs from day one — a stub would be a bug, not a feature.
    ipAddress: text("ip_address").notNull(),
    userAgent: text("user_agent"),
    // Sanitized; never includes other tenants' identifiers (P19). See file
    // header for the convention contract.
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Tenant-relative cursor: `(user_id, created_at)` covers list-my-audit
    // pagination without ever needing a global index that could leak cross-
    // tenant ordering (PITFALL P19).
    userIdx: index("audit_log_user_id_idx").on(t.userId),
    userCreatedIdx: index("audit_log_user_id_created_at_idx").on(t.userId, t.createdAt),
    // Phase 2 D-32: action-filter dropdown — `WHERE user_id = ? AND action = ?
    // ORDER BY created_at DESC` uses this composite index.
    userActionCreatedIdx: index("audit_log_user_id_action_created_at_idx").on(
      t.userId,
      t.action,
      t.createdAt,
    ),
  }),
);
