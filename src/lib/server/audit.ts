// Append-only audit writer.
//
// PITFALL P19 — `writeAudit` performs only INSERTs; the module intentionally
// exports no update or delete path. The application's database role MUST NOT
// have UPDATE/DELETE grants on `audit_log`; that grant is enforced in deploy
// docs (Phase 6) but the writer never even offers the mechanism.
//
// Metadata sanitization convention: callers pass ONLY their own tenant's
// data. We do not introspect — that would require a sanitizer that sees
// other tenants' identifiers, creating a different leak. The convention is
// enforced by code review; field-shape patterns are caught by Pino redact
// (D-24) at log time.
//
// Failure mode: an audit failure must not break the user-facing request,
// because retrying a sign-in is more disruptive than missing one row. But
// silent audit drops are a P19/P20 risk, so we log loudly. Operators wire
// alerts on `audit write failed` log lines (Phase 6).

import { db } from "./db/client.js";
import { auditLog } from "./db/schema/audit-log.js";
import { logger } from "./logger.js";

export interface AuditEntry {
  userId: string;
  // e.g. 'session.signin', 'session.signout', 'session.signout_all',
  // 'user.signup', 'key.add', 'key.rotate', 'key.remove' (last three Phase 2)
  action: string;
  // Resolved by Plan 06 trusted-proxy middleware (D-19). Required.
  ipAddress: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Append a row to audit_log. INSERT-only by design (P19).
 *
 * Never throws — audit failures are logged and swallowed so a transient DB
 * error cannot cascade into a failed login or 500 response. The trade-off
 * (silent loss vs. cascade failure) is documented in CONTEXT.md D-12.
 */
export async function writeAudit(entry: AuditEntry): Promise<void> {
  try {
    await db.insert(auditLog).values({
      userId: entry.userId,
      action: entry.action,
      ipAddress: entry.ipAddress,
      userAgent: entry.userAgent ?? null,
      metadata: entry.metadata ?? null,
    });
  } catch (err) {
    // Never let an audit failure break the user-facing request.
    // But log loudly — silent audit drops are a P19/P20 risk.
    logger.error({ err, action: entry.action, userId: entry.userId }, "audit write failed");
  }
}
