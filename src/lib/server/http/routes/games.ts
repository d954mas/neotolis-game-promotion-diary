// Games HTTP routes (Plan 02-08).
//
// CRUD + soft-delete + restore for `games`. Mounted under `/api/*` in app.ts so
// every handler runs after the tenantScope middleware (Plan 01-07): anonymous
// requests are 401'd before reaching this file. Cross-tenant access surfaces
// as NotFoundError from the service layer → 404 here (PRIV-01: 404, never 403).
//
// Error mapping is uniform via `mapErr`:
//   - NotFoundError    → 404 {error: 'not_found'}
//   - AppError         → status + {error: code}
//   - zod ValidationError (via zValidator hook) → 422 {error: 'validation_failed', details}
//   - everything else  → 500 {error: 'internal_server_error'} (logged loudly)

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  createGame,
  listGames,
  getGameById,
  updateGame,
  softDeleteGame,
  restoreGame,
} from "../../services/games.js";
import { listEventsForGame } from "../../services/events.js";
import { toGameDto, mapEventsToDtos } from "../../dto.js";
import { getAuditContext } from "../middleware/audit-ip.js";
import { mapErr, type RouteVars } from "./_shared.js";

const createGameSchema = z.object({
  title: z.string().min(1).max(200),
  notes: z.string().max(5000).optional(),
});

const updateGameSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  notes: z.string().max(5000).optional(),
  tags: z.array(z.string().max(50)).max(50).optional(),
  releaseTba: z.boolean().optional(),
  releaseDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  coverUrl: z.string().url().nullable().optional(),
});

export const gamesRoutes = new Hono<RouteVars>();

gamesRoutes.post(
  "/games",
  zValidator("json", createGameSchema, (r, c) => {
    if (!r.success) {
      return c.json({ error: "validation_failed", details: r.error.issues }, 422);
    }
  }),
  async (c) => {
    const ctx = getAuditContext(c);
    try {
      const game = await createGame(ctx.userId, c.req.valid("json"), ctx.ipAddress);
      return c.json(toGameDto(game), 201);
    } catch (err) {
      return mapErr(c, err, "POST /api/games");
    }
  },
);

gamesRoutes.get("/games", async (c) => {
  const includeSoftDeleted = c.req.query("includeSoftDeleted") === "true";
  try {
    const list = await listGames(c.var.userId, { includeSoftDeleted });
    return c.json(list.map(toGameDto));
  } catch (err) {
    return mapErr(c, err, "GET /api/games");
  }
});

gamesRoutes.get("/games/:id", async (c) => {
  try {
    const g = await getGameById(c.var.userId, c.req.param("id"));
    return c.json(toGameDto(g));
  } catch (err) {
    return mapErr(c, err, "GET /api/games/:id");
  }
});

gamesRoutes.patch(
  "/games/:id",
  zValidator("json", updateGameSchema, (r, c) => {
    if (!r.success) {
      return c.json({ error: "validation_failed", details: r.error.issues }, 422);
    }
  }),
  async (c) => {
    try {
      const g = await updateGame(c.var.userId, c.req.param("id"), c.req.valid("json"));
      return c.json(toGameDto(g));
    } catch (err) {
      return mapErr(c, err, "PATCH /api/games/:id");
    }
  },
);

gamesRoutes.delete("/games/:id", async (c) => {
  const ctx = getAuditContext(c);
  try {
    await softDeleteGame(ctx.userId, c.req.param("id"), ctx.ipAddress);
    return c.body(null, 204);
  } catch (err) {
    return mapErr(c, err, "DELETE /api/games/:id");
  }
});

gamesRoutes.post("/games/:id/restore", async (c) => {
  const ctx = getAuditContext(c);
  try {
    await restoreGame(ctx.userId, c.req.param("id"), ctx.ipAddress);
    return c.body(null, 204);
  } catch (err) {
    return mapErr(c, err, "POST /api/games/:id/restore");
  }
});

// Per-game curated events list (Phase 2.1 — replaces Phase 2's
// `/api/games/:gameId/timeline` JS-merge over events + tracked_youtube_videos).
// The unified events table now holds every per-game artifact regardless of
// platform; the JS merge is gone, replaced by a single tenant-scoped query
// in `listEventsForGame`. Cross-tenant gameId surfaces as 404 (PRIV-01)
// because `listEventsForGame` calls `assertGameOwnedByUser` first.
gamesRoutes.get("/games/:gameId/events", async (c) => {
  try {
    const list = await listEventsForGame(c.var.userId, c.req.param("gameId"));
    // Plan 02.1-28: batch-load junction rows so each EventDto carries its
    // gameIds[] array. The list-of-events itself is already filtered to
    // the requested game by listEventsForGame's INNER JOIN; the gameIds
    // array on the response surfaces ALL games each event is attached to
    // (multi-game events render with their full attachment set).
    const dtos = await mapEventsToDtos(c.var.userId, list);
    return c.json(dtos);
  } catch (err) {
    return mapErr(c, err, "GET /api/games/:gameId/events");
  }
});
