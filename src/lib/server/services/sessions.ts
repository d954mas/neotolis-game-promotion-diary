// Session helpers used by Plan 01-06's hook (sign-out flow) and Plan 01-07's
// tenant-scope middleware. AUTH-02 specifically requires server-side session
// invalidation — we DELETE the row instead of marking it expired so the same
// cookie value can never resurrect a session.

import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { session } from "../db/schema/auth.js";

/**
 * AUTH-02: delete a single session row. Used by sign-out flows.
 *
 * Idempotent: deleting a session id that no longer exists is a no-op (DELETE
 * with no matching rows is success). Safe to call from a hook that fires
 * after Better Auth has already removed the cookie.
 */
export async function invalidateSession(sessionId: string): Promise<void> {
  await db.delete(session).where(eq(session.id, sessionId));
}
