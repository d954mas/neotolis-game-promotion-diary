// Account-state middleware (Phase 02.2 review — Codex P1.2 fix).
//
// Mount on '/api/*' AFTER tenantScope so c.var.userId is set. Queries the
// authoritative user.deleted_at from the DB (NOT via Better Auth getSession —
// see Codex P1.1: adapter projection behaviour is fragile) and gates writes
// when the account is soft-deleted.
//
// Why this exists:
//   softDeleteAccount hard-deletes existing sessions, so the deleted user is
//   logged out immediately. But they can sign back in via Google OAuth at any
//   time during the RETENTION_DAYS grace window — Better Auth creates a fresh
//   session row regardless of user.deleted_at. Without this guard, the freshly
//   re-authed deleted user could call POST /api/games and create rows that
//   neither carry the marker timestamp (so restoreAccount won't reverse them)
//   nor get hard-purged by the Phase 3 worker (which keys off user.deleted_at,
//   not on per-row timestamps for newly-inserted rows). That orphans data.
//
// Allowlist when deleted:
//   - POST   /api/me/account/restore  — the whole point of the grace window
//   - GET    /api/me/export           — GDPR Article 15 right of access during
//                                       grace
//   - POST   /api/me/sessions/all     — let the user sign out from everywhere
//   - GET    /api/me                  — read self so the layout banner can
//                                       compute days-remaining
//
// Anything else returns 423 Locked with {error: "account_pending_deletion",
// deletedAt: <iso>}. 423 is RFC 4918 Locked — semantically the right code for
// "resource exists but is locked due to user state". 403 is AGENTS.md-reserved
// for admin; 404 would lie about the route's existence.

import type { MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { user } from "../../db/schema/auth.js";
import { logger } from "../../logger.js";

const ALLOWED_WHEN_DELETED = new Set<string>([
  "POST /api/me/account/restore",
  "GET /api/me/export",
  "POST /api/me/sessions/all",
  "GET /api/me",
]);

export const accountState: MiddlewareHandler<{
  Variables: { userId: string; sessionId: string; accountDeletedAt: Date | null };
}> = async (c, next) => {
  const userId = c.var.userId;
  const [row] = await db
    .select({ deletedAt: user.deletedAt })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  const deletedAt = row?.deletedAt ?? null;
  c.set("accountDeletedAt", deletedAt);

  if (deletedAt === null) {
    return next();
  }

  const key = `${c.req.method} ${c.req.path}`;
  if (ALLOWED_WHEN_DELETED.has(key)) {
    return next();
  }

  logger.info(
    { userId, route: key, deletedAt: deletedAt.toISOString() },
    "account-state: blocked write while account pending deletion",
  );
  return c.json(
    {
      error: "account_pending_deletion",
      deletedAt: deletedAt.toISOString(),
    },
    423,
  );
};
