// Session helpers used by the sign-out hook, the tenant-scope middleware,
// and the /settings active-sessions list. Server-side session
// invalidation is required: we DELETE the row instead of marking it
// expired so the same cookie value can never resurrect a session.

import { and, desc, eq, gt } from "drizzle-orm";
import { db } from "../db/client.js";
import { session } from "../db/schema/auth.js";
import { NotFoundError } from "./errors.js";

export type SessionRow = typeof session.$inferSelect;

/**
 * Delete a single session row. Used by sign-out flows.
 *
 * Idempotent: deleting a session id that no longer exists is a no-op (DELETE
 * with no matching rows is success). Safe to call from a hook that fires
 * after Better Auth has already removed the cookie.
 */
export async function invalidateSession(sessionId: string): Promise<void> {
  await db.delete(session).where(eq(session.id, sessionId));
}

/**
 * List active (non-expired) sessions for the caller.
 *
 * Tenant scope: filters on `userId`. Returns sessions where
 * `expiresAt > now()` so the UI doesn't render stale rows. Sorted DESC by
 * `createdAt` so the newest sign-in is at the top — matches the user's
 * mental model when reviewing "what's signed in".
 */
export async function listSessions(userId: string): Promise<SessionRow[]> {
  return db
    .select()
    .from(session)
    .where(and(eq(session.userId, userId), gt(session.expiresAt, new Date())))
    .orderBy(desc(session.createdAt));
}

/**
 * Delete a single session by id, scoped to the calling user.
 *
 * Cross-tenant deletion attempts surface as NotFoundError → 404 at the
 * HTTP boundary (404, never 403). Idempotency: if the row was already
 * deleted (e.g. concurrent sign-out from another tab), the second call
 * also throws NotFoundError so the UI can refresh and show the
 * up-to-date list.
 */
export async function deleteSessionById(userId: string, sessionId: string): Promise<void> {
  const result = await db
    .delete(session)
    .where(and(eq(session.userId, userId), eq(session.id, sessionId)))
    .returning({ id: session.id });
  if (result.length === 0) throw new NotFoundError();
}
