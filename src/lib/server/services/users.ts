// User-level helpers built on top of the Better Auth canonical schema.
//
// `signOutAllDevices` powers the "sign out from all devices" settings
// button: it deletes every session row for the current user,
// invalidating every cookie that points to one of those rows on the
// very next request. This is the free security win that DB-backed
// sessions unlock.
//
// `getUserById` is the read-side helper `/api/me` calls.

import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { user, session } from "../db/schema/auth.js";

/**
 * Read-side user lookup. Returns `null` (not throws) for missing ids so
 * callers can produce a 404 / re-auth flow without try/catch.
 */
export async function getUserById(userId: string) {
  const rows = await db.select().from(user).where(eq(user.id, userId)).limit(1);
  return rows[0] ?? null;
}

/**
 * Delete every session row for the given user.
 *
 * Returns the number of rows deleted so the audit-log writer can record
 * "user signed out N devices" without an extra read. The count is also
 * useful in tests.
 */
export async function signOutAllDevices(userId: string): Promise<{ deletedCount: number }> {
  const result = await db
    .delete(session)
    .where(eq(session.userId, userId))
    .returning({ id: session.id });
  return { deletedCount: result.length };
}
