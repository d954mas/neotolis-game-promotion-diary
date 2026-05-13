// Append-only audit log table.
//
// Every row is scoped to a `user_id` and the only efficient pagination
// cursor is `(user_id, created_at)`. Listing my audit log can NEVER
// observe another tenant's row IDs by construction, because the index
// supports no other lookup pattern.
//
// The application role MUST NOT have UPDATE/DELETE grants on this table —
// enforce in the deploy procedure. The writer in
// src/lib/server/audit.ts is INSERT-only by design; even if grants leaked,
// the writer never offers an update or delete path.
//
// `metadata` is jsonb and intentionally untyped: callers pass only their
// OWN tenant's data. We do not introspect — that would create a different
// kind of leak (a sanitizer ruleset that sees other tenants' identifiers).
//
// The `action` column is typed as the `audit_action` pgEnum defined in
// src/lib/server/audit/actions.ts (the single source of truth for the
// vocabulary). A (user_id, action, created_at) index powers the
// action-filter dropdown in the audit UI.
//
// The user_id → user(id) FK was DROPPED. audit_log.user_id is a plain
// text column whose value outlives the user row it references. Required
// for the purge worker (GDPR Art. 17 60-day-grace): without dropping the
// FK, the purge.completed audit row was either cascade-deleted with the
// user (write-before-tx) or rejected by FK-violation (write-after-tx).
// Either outcome violates AGENTS.md §4 "audit is INSERT-only" for this
// verb. The purge audit row is scoped to the purged user_id and remains
// queryable by admins through the /admin/quota cross-tenant aggregation.
// The cursor invariant is unchanged — the (user_id, created_at) and
// (user_id, action, created_at) indexes still support tenant-relative
// pagination only.

import { pgTable, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { auditActionEnum } from "../../audit/actions.js";
import { uuidv7 } from "../../ids.js";

// Re-export so drizzle-kit's schema scan (glob: ./src/lib/server/db/schema/*.ts)
// picks up the audit_action pgEnum even though its source of truth lives in
// src/lib/server/audit/actions.ts. Without this re-export drizzle-kit
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
    // No FK to user(id). The purge worker hard-DELETEs user rows and
    // the audit row must survive the delete (AGENTS.md §4 INSERT-only
    // invariant).
    userId: text("user_id").notNull(),
    // Typed pgEnum — values defined in src/lib/server/audit/actions.ts
    // (AUDIT_ACTIONS const).
    action: auditActionEnum("action").notNull(),
    // Resolved by trusted-proxy middleware. Records real IPs from day
    // one — a stub would be a bug, not a feature.
    ipAddress: text("ip_address").notNull(),
    userAgent: text("user_agent"),
    // Sanitized; never includes other tenants' identifiers. See file
    // header for the convention contract.
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Tenant-relative cursor: `(user_id, created_at)` covers list-my-audit
    // pagination without ever needing a global index that could leak cross-
    // tenant ordering.
    userIdx: index("audit_log_user_id_idx").on(t.userId),
    userCreatedIdx: index("audit_log_user_id_created_at_idx").on(t.userId, t.createdAt),
    // Action-filter dropdown — `WHERE user_id = ? AND action = ?
    // ORDER BY created_at DESC` uses this composite index.
    userActionCreatedIdx: index("audit_log_user_id_action_created_at_idx").on(
      t.userId,
      t.action,
      t.createdAt,
    ),
  }),
);
