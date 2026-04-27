// Events HTTP routes (Plan 02-08).
//
// Routes:
//   POST   /api/events                         — createEvent
//   GET    /api/events/:id                     — getEventById
//   PATCH  /api/events/:id                     — updateEvent
//   DELETE /api/events/:id                     — softDeleteEvent
//   GET    /api/games/:gameId/events           — listEventsForGame
//   GET    /api/games/:gameId/timeline         — listTimelineForGame (events + items merged)
//
// `kind` is a closed picklist (D-28); zod schema mirrors the eventKindEnum
// from src/lib/server/db/schema/events.ts. Service-layer validation is the
// second layer (defense-in-depth) — both layers reject the same set.

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  createEvent,
  listEventsForGame,
  getEventById,
  updateEvent,
  softDeleteEvent,
  listTimelineForGame,
} from "../../services/events.js";
import { toEventDto } from "../../dto.js";
import { getAuditContext } from "../middleware/audit-ip.js";
import { mapErr, type RouteVars } from "./_shared.js";

const eventKindEnum = z.enum([
  "conference",
  "talk",
  "twitter_post",
  "telegram_post",
  "discord_drop",
  "press",
  "other",
]);

const createEventSchema = z.object({
  gameId: z.string().min(1),
  kind: eventKindEnum,
  occurredAt: z.string().datetime(),
  title: z.string().min(1).max(500),
  url: z.string().url().nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});

const updateEventSchema = z
  .object({
    kind: eventKindEnum.optional(),
    occurredAt: z.string().datetime().optional(),
    title: z.string().min(1).max(500).optional(),
    url: z.string().url().nullable().optional(),
    notes: z.string().max(5000).nullable().optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, {
    message: "at least one field must be supplied",
  });

export const eventsRoutes = new Hono<RouteVars>();

eventsRoutes.post(
  "/events",
  zValidator("json", createEventSchema, (r, c) => {
    if (!r.success) {
      return c.json({ error: "validation_failed", details: r.error.issues }, 422);
    }
  }),
  async (c) => {
    const ctx = getAuditContext(c);
    try {
      const ev = await createEvent(ctx.userId, c.req.valid("json"), ctx.ipAddress);
      return c.json(toEventDto(ev), 201);
    } catch (err) {
      return mapErr(c, err, "POST /api/events");
    }
  },
);

eventsRoutes.get("/events/:id", async (c) => {
  try {
    const ev = await getEventById(c.var.userId, c.req.param("id"));
    return c.json(toEventDto(ev));
  } catch (err) {
    return mapErr(c, err, "GET /api/events/:id");
  }
});

eventsRoutes.patch(
  "/events/:id",
  zValidator("json", updateEventSchema, (r, c) => {
    if (!r.success) {
      return c.json({ error: "validation_failed", details: r.error.issues }, 422);
    }
  }),
  async (c) => {
    const ctx = getAuditContext(c);
    try {
      const ev = await updateEvent(
        ctx.userId,
        c.req.param("id"),
        c.req.valid("json"),
        ctx.ipAddress,
      );
      return c.json(toEventDto(ev));
    } catch (err) {
      return mapErr(c, err, "PATCH /api/events/:id");
    }
  },
);

eventsRoutes.delete("/events/:id", async (c) => {
  const ctx = getAuditContext(c);
  try {
    await softDeleteEvent(ctx.userId, c.req.param("id"), ctx.ipAddress);
    return c.body(null, 204);
  } catch (err) {
    return mapErr(c, err, "DELETE /api/events/:id");
  }
});

eventsRoutes.get("/games/:gameId/events", async (c) => {
  try {
    const list = await listEventsForGame(c.var.userId, c.req.param("gameId"));
    return c.json(list.map(toEventDto));
  } catch (err) {
    return mapErr(c, err, "GET /api/games/:gameId/events");
  }
});

eventsRoutes.get("/games/:gameId/timeline", async (c) => {
  try {
    const timeline = await listTimelineForGame(c.var.userId, c.req.param("gameId"));
    // TimelineRow is already a DTO-shaped discriminated union with no userId
    // field — see services/events.ts. No projection function needed.
    return c.json(timeline);
  } catch (err) {
    return mapErr(c, err, "GET /api/games/:gameId/timeline");
  }
});
