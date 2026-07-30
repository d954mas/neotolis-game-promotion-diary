// Append-only audit writer.
//
// `writeAudit` performs only INSERTs; the module intentionally exports no
// update or delete path. The application's database role MUST NOT have
// UPDATE/DELETE grants on `audit_log`; that grant is enforced in deploy
// docs but the writer never even offers the mechanism.
//
// Metadata sanitization convention: callers pass ONLY their own tenant's
// data. We do not introspect - that would require a sanitizer that sees
// other tenants' identifiers, creating a different leak. The convention is
// enforced by code review; field-shape patterns are caught by Pino redact
// at log time.
//
// Failure mode: an audit failure must not break the user-facing request,
// because retrying a sign-in is more disruptive than missing one row. But
// silent audit drops are a risk, so we log loudly. Operators wire alerts
// on `audit write failed` log lines.

import { db, type Tx } from "./db/client.js";
import { auditLog } from "./db/schema/audit-log.js";
import type { AuditAction } from "./audit/actions.js";
import { logger } from "./logger.js";

/**
 * `metadata.flow` discriminates which cap pool a job counts toward
 * (services/quota.ts:getUserQuotaUsedToday filters on these values).
 *
 * Capped (counted in user fair-share cap query):
 *   - 'initial' - onboarding channel-context-backfill. User-initiated
 *                        (they explicitly added the source); API budget burned
 *                        under their identity. MUST count.
 *   - 'incremental' - refresh-content default (catch-up newer events)
 *   - 'historical' - refresh-content with explicit older boundary
 *   - 'stats_refresh' - refresh-poll endpoint (Refresh now button)
 *
 * Excluded (uses operator cron pool, not user pool):
 *   - 'auto_passive' - daily auto-backfill cron pick (cron-driven,
 *                        operator cron pool).
 *
 * Adding a new flow value requires (a) extending this union AND (b) adding
 * to the audit_log CHECK constraint migration. Both steps land in the
 * same migration to keep type + DB in lockstep.
 */
export type AuditFlow = "initial" | "incremental" | "historical" | "stats_refresh" | "auto_passive";

export interface AuditMetadata {
  flow?: AuditFlow;
  /** Bytes/units consumed by an upstream API call attributed to this audit row. */
  requests_used?: number;
  /** Number of rows inserted by the action (per-user cap counter axis). */
  events_inserted?: number;
  /**
   * Per-user fair-share cap query (services/quota.ts:getUserQuotaUsedToday)
   * scopes by source-kind to separate per-platform cap windows. ALL audit
   * verbs that contribute to capped flows MUST set this field to the source
   * kind (`'youtube_channel'` etc.) regardless of whether `metadata.kind`
   * carries event-kind or source-kind in the action's domain convention.
   *
   * Why a dedicated field: when `event.poll_refreshed` rows wrote
   * `metadata.kind = event.kind` (e.g. `'youtube_video'`) while the cap
   * query passed `'youtube_channel'` they never matched and were never
   * counted. Splitting `platform` from domain `kind` keeps each field's
   * semantics clean and the cap counter accurate.
   */
  platform?: string;
  // Open shape - callers may pass additional bag fields (source_id, kind,
  // job_id, etc.). Only `flow` carries a closed enum; everything else is
  // free-form per audit-action convention.
  [extra: string]: unknown;
}

export interface AuditEntry {
  userId: string;
  // Typed against the AUDIT_ACTIONS const list (single source of truth)
  // so a stray string fails at the type check, not at INSERT.
  action: AuditAction;
  // Resolved by trusted-proxy middleware. Required.
  ipAddress: string;
  userAgent?: string;
  metadata?: AuditMetadata;
}

/**
 * Append a row to audit_log. INSERT-only by design.
 *
 * Never throws - audit failures are logged and swallowed so a transient DB
 * error cannot cascade into a failed login or 500 response. The trade-off
 * accepts silent loss as preferable to cascade failure.
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
    // But log loudly - silent audit drops are a risk.
    logger.error({ err, action: entry.action, userId: entry.userId }, "audit write failed");
  }
}

/**
 * Strict variant of writeAudit - propagates errors instead of swallowing.
 *
 * Use when the audit-row-per-action invariant is load-bearing for the
 * request semantics - i.e. a side effect that's already happened (queue
 * enqueue, irreversible DB write) MUST have an accompanying audit row,
 * and a failed audit should surface as 5xx so the caller knows to retry.
 * Idempotent side effects (singletonKey-deduped queue sends; conditional
 * UPDATEs) recover correctly on retry.
 *
 * The default `writeAudit` swallows errors because the inverse trade-off
 * fits the login flow: a missing audit row is less disruptive than a failed
 * sign-in. For action-pin contracts and compliance-critical actions the
 * trade-off flips - use this strict form.
 */
export async function writeAuditStrict(entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    userId: entry.userId,
    action: entry.action,
    ipAddress: entry.ipAddress,
    userAgent: entry.userAgent ?? null,
    metadata: entry.metadata ?? null,
  });
}

/**
 * Transaction-scoped variant of `writeAuditStrict` — INSERTs on the SUPPLIED tx
 * connection instead of the module-level `db`.
 *
 * Use when the audit row MUST be atomic with a state change already happening
 * inside a caller's transaction — e.g. the Reddit deletion-propagation purge that
 * NULLs author* and audits the purge in ONE tx. Routing that write through the
 * db-bound `writeAudit`/`writeAuditStrict` from inside a tx would acquire a SECOND
 * pool connection while the tx still holds its first (the pool-deadlock pattern);
 * reusing the caller's `tx` sidesteps it. This keeps audit writes flowing through
 * audit.ts (AGENTS.md: audit writes only via audit.ts) rather than open-coding
 * `tx.insert(auditLog)` at the call site.
 *
 * Strict (propagates errors): the audit is compliance-critical and must commit or
 * roll back together with the state change — a failed INSERT should abort the whole
 * transaction, not be swallowed.
 */
export async function writeAuditTx(tx: Tx, entry: AuditEntry): Promise<void> {
  await tx.insert(auditLog).values({
    userId: entry.userId,
    action: entry.action,
    ipAddress: entry.ipAddress,
    userAgent: entry.userAgent ?? null,
    metadata: entry.metadata ?? null,
  });
}
