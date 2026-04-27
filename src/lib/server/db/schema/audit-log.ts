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

import { pgTable, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { user } from "./auth.js";
import { uuidv7 } from "../../ids.js";

export const auditLog = pgTable(
  "audit_log",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // e.g. 'session.signin', 'session.signout', 'session.signout_all',
    // 'user.signup', 'key.add', 'key.rotate', 'key.remove' (last three Phase 2).
    action: text("action").notNull(),
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
  }),
);
