// Shared resolver: ADMIN_EMAIL_ALLOWLIST[0] → user.id (or null).
//
// Reddit cron + worker handlers emit `reddit.queue_drained` /
// `reddit.deletion_propagated` audit rows under the operator's user_id
// because audit_log.user_id is NOT NULL (migration 0011 dropped the
// FK precisely so audit rows survive user purges, but the column itself
// still requires a value). The operator is identified by the first
// entry in ADMIN_EMAIL_ALLOWLIST.
//
// Single source of truth — earlier the function lived in three places
// (http.ts 403-burst audit, worker-tick.ts queue_drained audit,
// deletion-propagation-cron.ts) with three independent caches. Drift
// risks: one caller could pick up the user id and another could
// silently skip the audit if its cache wasn't yet warm.
//
// Caching: module-scope `undefined` = not resolved; `null` = resolved
// to empty allowlist; string = found. Once resolved, stays cached for
// the process lifetime — matches the env caching model (allowlist
// changes require a process restart). Test code can call
// `__resetOperatorIdCacheForTest` to clear between cases.

import { sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";

let cachedOperatorId: string | null | undefined = undefined;

/**
 * Resolve the operator user_id used for system-emitted audit rows
 * (cron + worker). Returns null when ADMIN_EMAIL_ALLOWLIST is empty
 * OR no user with that email exists. Callers MUST handle null —
 * the strict-audit path skips the row in that case.
 */
export async function resolveOperatorUserId(): Promise<string | null> {
  if (cachedOperatorId !== undefined) return cachedOperatorId;
  const { env } = await import("$lib/server/config/env.js");
  const allowlist = [...env.ADMIN_EMAIL_ALLOWLIST];
  if (allowlist.length === 0) {
    cachedOperatorId = null;
    return null;
  }
  const { user } = await import("$lib/server/db/schema/auth.js");
  const rows = await db
    .select({ id: user.id })
    .from(user)
    .where(sql`lower(${user.email}) = ${allowlist[0]}`)
    .limit(1);
  cachedOperatorId = rows[0]?.id ?? null;
  return cachedOperatorId;
}

/** Test-only — reset cache between specs. Not exported through any
 *  barrel; importers reach for this directly. */
export function __resetOperatorIdCacheForTest(): void {
  cachedOperatorId = undefined;
}
