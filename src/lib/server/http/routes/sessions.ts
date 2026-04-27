// Session-management routes (Plan 01-07 surface, D-08 wiring).
//
// `POST /api/me/sessions/all` — implements the "Sign out from all devices"
// settings action. Behind tenantScope (mounted under /api/* in
// src/lib/server/http/app.ts), so anonymous requests are 401'd before
// reaching this handler. Authenticated requests delete every session row for
// `c.var.userId` via the `signOutAllDevices` service helper, including the
// caller's current session — the next request from any device sees a stale
// cookie that no longer maps to a session row and lands on the login page.
//
// D-08 rationale (CONTEXT.md): with database-backed sessions (D-05) the
// server can invalidate all of a user's sessions instantly. This is the free
// security win that JWE cookies cannot offer.

import { Hono } from "hono";
import { signOutAllDevices } from "../../services/users.js";
import { logger } from "../../logger.js";

export const sessionRoutes = new Hono<{
  Variables: { userId: string; sessionId: string };
}>();

sessionRoutes.post("/me/sessions/all", async (c) => {
  const userId = c.var.userId;
  const result = await signOutAllDevices(userId);
  logger.info({ userId, deletedCount: result.deletedCount }, "user signed out of all devices");
  return c.json(result);
});
