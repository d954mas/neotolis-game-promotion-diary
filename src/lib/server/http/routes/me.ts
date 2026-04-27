// GET /api/me handler (Plan 01-07 — Wave 4).
//
// Phase 1's only authenticated /api/* route. Phase 2 adds /api/games and
// expands the surface; the error-translation pattern below (AppError →
// status code + `{error: code}` body) is what every later route reuses.
//
// PRIV-01: this route is mounted UNDER tenantScope (see src/lib/server/http/app.ts),
// so anonymous requests never reach this handler — they're intercepted by the
// middleware and returned 401. The handler body assumes `c.var.userId` is set.

import { Hono } from "hono";
import { getMe } from "../../services/me.js";
import { NotFoundError, AppError } from "../../services/errors.js";
import { logger } from "../../logger.js";

export const meRoutes = new Hono<{
  Variables: { userId: string; sessionId: string };
}>();

meRoutes.get("/me", async (c) => {
  const userId = c.var.userId;
  try {
    const me = await getMe(userId);
    return c.json(me);
  } catch (err) {
    if (err instanceof NotFoundError) {
      // PRIV-01: cross-tenant / vanished-row → 404 with `not_found` code.
      // Body NEVER contains "forbidden" or "permission" (P1 invariant).
      return c.json({ error: "not_found" }, 404);
    }
    if (err instanceof AppError) {
      return c.json(
        { error: err.code },
        err.status as 400 | 401 | 403 | 404 | 500,
      );
    }
    logger.error({ err, userId }, "/api/me unhandled error");
    return c.json({ error: "internal_server_error" }, 500);
  }
});
