// Events HTTP routes (Plan 02-08, extended in Plan 02.1-06).
//
// Routes (Phase 2.1 unified-events shape):
//   POST   /api/events                         — createEvent (free-form; D-09 /events/new)
//   GET    /api/events                         — listFeedPage (FEED-01 chronological pool)
//   GET    /api/events/:id                     — getEventById
//   PATCH  /api/events/:id                     — updateEvent
//   DELETE /api/events/:id                     — softDeleteEvent
//   PATCH  /api/events/:id/attach              — attachToGame (GAMES-04a)
//   PATCH  /api/events/:id/dismiss-inbox       — dismissFromInbox (INBOX-01)
//
// `/api/games/:gameId/events` and `/api/games/:gameId/timeline` retired here:
//   - The per-game curated view now lives on /api/games/:gameId/events in
//     `routes/games.ts` calling `listEventsForGame` (replaces the Phase 2
//     timeline merge — events table is unified per Plan 02.1-01/05).
//   - `/api/games/:gameId/timeline` is REMOVED (Phase 2 D-37 timeline merge
//     retired with `listTimelineForGame`).
//
// `kind` mirrors the unified-events pgEnum (eventKindEnum from
// src/lib/server/db/schema/events.ts) — `youtube_video` / `reddit_post` are
// added (formerly tracked_youtube_videos rows). Service-layer
// `assertValidKind` is the second layer (defense-in-depth).
//
// AppError code mapping is automatic via `mapErr`:
//   - createEvent / updateEvent kind mismatch → AppError 'validation_failed' 422
//   - createEvent gameId cross-tenant → NotFoundError 404 (Pitfall 4)
//   - dismissFromInbox on attached event → AppError 'not_in_inbox' 422
//   - attachToGame cross-tenant gameId → NotFoundError 404
//   - cross-tenant /:id access → NotFoundError 404 (PRIV-01)

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  createEvent,
  getEventById,
  updateEvent,
  softDeleteEvent,
  listFeedPage,
  attachToGame,
  dismissFromInbox,
} from "../../services/events.js";
import { toEventDto } from "../../dto.js";
import { getAuditContext } from "../middleware/audit-ip.js";
import { mapErr, type RouteVars } from "./_shared.js";

const eventKindEnum = z.enum([
  "youtube_video",
  "reddit_post",
  "twitter_post",
  "telegram_post",
  "discord_drop",
  "conference",
  "talk",
  "press",
  "other",
]);

const createEventSchema = z.object({
  gameId: z.string().min(1).nullable().optional(),
  kind: eventKindEnum,
  occurredAt: z.string().datetime(),
  title: z.string().min(1).max(500),
  url: z.string().url().nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
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

// Feed query schema (RESEARCH §3.2 verbatim). Booleans arrive as the strings
// "true"|"false" because URL query params are stringly-typed; we coerce to
// real booleans before calling listFeedPage.
const feedQuerySchema = z.object({
  cursor: z.string().optional(),
  source: z.string().min(1).optional(),
  kind: eventKindEnum.optional(),
  game: z.string().min(1).optional(),
  attached: z.enum(["true", "false"]).optional(),
  authorIsMe: z.enum(["true", "false"]).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

const attachSchema = z.object({
  gameId: z.string().min(1).nullable(),
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
      const ev = await createEvent(
        ctx.userId,
        c.req.valid("json"),
        ctx.ipAddress,
        ctx.userAgent ?? undefined,
      );
      return c.json(toEventDto(ev), 201);
    } catch (err) {
      return mapErr(c, err, "POST /api/events");
    }
  },
);

eventsRoutes.get(
  "/events",
  zValidator("query", feedQuerySchema, (r, c) => {
    if (!r.success) {
      return c.json({ error: "validation_failed", details: r.error.issues }, 422);
    }
  }),
  async (c) => {
    const q = c.req.valid("query");
    try {
      const page = await listFeedPage(
        c.var.userId,
        {
          source: q.source,
          kind: q.kind,
          game: q.game,
          attached:
            q.attached === "true" ? true : q.attached === "false" ? false : undefined,
          authorIsMe:
            q.authorIsMe === "true"
              ? true
              : q.authorIsMe === "false"
                ? false
                : undefined,
          from: q.from ? new Date(q.from) : undefined,
          to: q.to ? new Date(q.to) : undefined,
        },
        q.cursor ?? null,
      );
      return c.json({
        rows: page.rows.map(toEventDto),
        nextCursor: page.nextCursor,
      });
    } catch (err) {
      return mapErr(c, err, "GET /api/events");
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
        ctx.userAgent ?? undefined,
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
    await softDeleteEvent(
      ctx.userId,
      c.req.param("id"),
      ctx.ipAddress,
      ctx.userAgent ?? undefined,
    );
    return c.body(null, 204);
  } catch (err) {
    return mapErr(c, err, "DELETE /api/events/:id");
  }
});

eventsRoutes.patch(
  "/events/:id/attach",
  zValidator("json", attachSchema, (r, c) => {
    if (!r.success) {
      return c.json({ error: "validation_failed", details: r.error.issues }, 422);
    }
  }),
  async (c) => {
    const ctx = getAuditContext(c);
    const body = c.req.valid("json");
    try {
      const ev = await attachToGame(
        ctx.userId,
        c.req.param("id"),
        body.gameId,
        ctx.ipAddress,
        ctx.userAgent ?? undefined,
      );
      return c.json(toEventDto(ev));
    } catch (err) {
      return mapErr(c, err, "PATCH /api/events/:id/attach");
    }
  },
);

eventsRoutes.patch("/events/:id/dismiss-inbox", async (c) => {
  const ctx = getAuditContext(c);
  try {
    const ev = await dismissFromInbox(
      ctx.userId,
      c.req.param("id"),
      ctx.ipAddress,
      ctx.userAgent ?? undefined,
    );
    return c.json(toEventDto(ev));
  } catch (err) {
    return mapErr(c, err, "PATCH /api/events/:id/dismiss-inbox");
  }
});
