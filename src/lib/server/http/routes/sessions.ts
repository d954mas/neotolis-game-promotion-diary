// Session-management routes.
//
// `POST /api/me/sessions/all` — implements the "Sign out from all devices"
// settings action. Behind tenantScope (mounted under /api/* in
// src/lib/server/http/app.ts), so anonymous requests are 401'd before
// reaching this handler. Authenticated requests delete every session row for
// `c.var.userId` via the `signOutAllDevices` service helper, including the
// caller's current session — the next request from any device sees a stale
// cookie that no longer maps to a session row and lands on the login page.
//
// With database-backed sessions the server can invalidate all of a user's
// sessions instantly. This is the free security win that JWE cookies
// cannot offer.

import { Hono } from "hono";
import { signOutAllDevices } from "../../services/users.js";
import { deleteSessionById } from "../../services/sessions.js";
import { logger } from "../../logger.js";
import { mapErr } from "./_shared.js";

export const sessionRoutes = new Hono<{
  Variables: { userId: string; sessionId: string };
}>();

sessionRoutes.post("/me/sessions/all", async (c) => {
  const userId = c.var.userId;
  const result = await signOutAllDevices(userId);
  logger.info({ userId, deletedCount: result.deletedCount }, "user signed out of all devices");
  return c.json(result);
});

// Single-session sign-out from /settings active-sessions list.
// Cross-tenant deletion attempts surface as 404 (404, never 403).
// Idempotent (second DELETE on the same id also returns 404).
sessionRoutes.delete("/sessions/:id", async (c) => {
  const userId = c.var.userId;
  const sessionId = c.req.param("id");
  try {
    await deleteSessionById(userId, sessionId);
    return c.body(null, 204);
  } catch (err) {
    return mapErr(c, err, "DELETE /api/sessions/:id");
  }
});
