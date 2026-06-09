// Telegram operator-id resolver: ADMIN_EMAIL_ALLOWLIST[0] → user.id (or null).
//
// The telegram lane worker emits `telegram.queue_drained` audit rows under the
// operator's user_id because audit_log.user_id is NOT NULL (migration 0011
// dropped the FK so audit rows survive user purges, but the column still
// requires a value). The operator is identified by the first entry in
// ADMIN_EMAIL_ALLOWLIST.
//
// Mirrors reddit/operator-resolver.ts (the established per-adapter pattern —
// each adapter owns a module-scoped cache so the resolver lives next to its
// only caller). Caching: `undefined` = not resolved; `null` = resolved to an
// empty allowlist / no matching user; string = found. Cached for the process
// lifetime (allowlist changes require a restart, matching the env caching
// model). Test code calls `__resetTelegramOperatorIdCacheForTest` to clear
// between cases.

import { sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { env } from "$lib/server/config/env.js";
import { user } from "$lib/server/db/schema/auth.js";

let cachedOperatorId: string | null | undefined = undefined;

/**
 * Resolve the operator user_id used for system-emitted telegram audit rows.
 * Returns null when ADMIN_EMAIL_ALLOWLIST is empty OR no user with that email
 * exists. Callers MUST handle null — the audit emit skips the row in that case.
 */
export async function resolveTelegramOperatorUserId(): Promise<string | null> {
  if (cachedOperatorId !== undefined) return cachedOperatorId;
  const allowlist = [...env.ADMIN_EMAIL_ALLOWLIST];
  if (allowlist.length === 0) {
    cachedOperatorId = null;
    return null;
  }
  const rows = await db
    .select({ id: user.id })
    .from(user)
    .where(sql`lower(${user.email}) = ${allowlist[0]}`)
    .limit(1);
  cachedOperatorId = rows[0]?.id ?? null;
  return cachedOperatorId;
}

/** Test-only — reset cache between specs. */
export function __resetTelegramOperatorIdCacheForTest(): void {
  cachedOperatorId = undefined;
}
