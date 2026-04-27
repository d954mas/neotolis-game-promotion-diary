// Items (YouTube) HTTP routes (Plan 02-08).
//
// Routes:
//   POST   /api/items/youtube                 — paste-orchestrator (D-18)
//   GET    /api/games/:gameId/items           — listItemsForGame
//   PATCH  /api/items/youtube/:id             — toggleIsOwn
//   DELETE /api/items/youtube/:id             — softDeleteItem
//
// The paste orchestrator (POST /api/items/youtube) is the single most-used
// widget on the game detail page (UI-SPEC §"<PasteBox> interaction contract").
// It returns a discriminated `IngestResult` that the UI consumes to drive
// success / friendly-deferred / error states:
//
//   { kind: "youtube_video_created", item: YoutubeVideoDto }   → 201
//   { kind: "event_created", event: EventDto }                  → 201 (twitter/telegram branches)
//   { kind: "reddit_deferred" }                                  → 200 (no DB write; D-18 friendly info)
//
// Validation order (D-19 / INGEST-04): the orchestrator runs URL parse +
// oEmbed BEFORE any INSERT. On failure (422 / 502) the database is provably
// untouched — there is no try/catch around the INSERT to "clean up" a
// half-write. The integration tests in Plan 02-06 assert this invariant.

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { parsePasteAndCreate } from "../../services/ingest.js";
import {
  listItemsForGame,
  getItemById,
  toggleIsOwn,
  softDeleteItem,
} from "../../services/items-youtube.js";
import { getEventById } from "../../services/events.js";
import { toYoutubeVideoDto, toEventDto } from "../../dto.js";
import { getAuditContext } from "../middleware/audit-ip.js";
import { mapErr, type RouteVars } from "./_shared.js";

const pasteSchema = z.object({
  gameId: z.string().min(1),
  urlInput: z.string().min(1).max(2000),
});

const toggleOwnSchema = z.object({
  isOwn: z.boolean(),
});

export const itemsYoutubeRoutes = new Hono<RouteVars>();

itemsYoutubeRoutes.post(
  "/items/youtube",
  zValidator("json", pasteSchema, (r, c) => {
    if (!r.success) {
      return c.json({ error: "validation_failed", details: r.error.issues }, 422);
    }
  }),
  async (c) => {
    const ctx = getAuditContext(c);
    const { gameId, urlInput } = c.req.valid("json");
    try {
      const result = await parsePasteAndCreate(ctx.userId, gameId, urlInput, ctx.ipAddress);
      if (result.kind === "reddit_deferred") {
        return c.json({ kind: "reddit_deferred" }, 200);
      }
      if (result.kind === "youtube_video_created") {
        const item = await getItemById(ctx.userId, result.itemId);
        return c.json(
          { kind: "youtube_video_created", item: toYoutubeVideoDto(item) },
          201,
        );
      }
      // result.kind === "event_created" (twitter / telegram branches)
      const ev = await getEventById(ctx.userId, result.eventId);
      return c.json({ kind: "event_created", event: toEventDto(ev) }, 201);
    } catch (err) {
      return mapErr(c, err, "POST /api/items/youtube");
    }
  },
);

itemsYoutubeRoutes.get("/games/:gameId/items", async (c) => {
  try {
    const list = await listItemsForGame(c.var.userId, c.req.param("gameId"));
    return c.json(list.map(toYoutubeVideoDto));
  } catch (err) {
    return mapErr(c, err, "GET /api/games/:gameId/items");
  }
});

itemsYoutubeRoutes.patch(
  "/items/youtube/:id",
  zValidator("json", toggleOwnSchema, (r, c) => {
    if (!r.success) {
      return c.json({ error: "validation_failed", details: r.error.issues }, 422);
    }
  }),
  async (c) => {
    const { isOwn } = c.req.valid("json");
    try {
      const item = await toggleIsOwn(c.var.userId, c.req.param("id"), isOwn);
      return c.json(toYoutubeVideoDto(item));
    } catch (err) {
      return mapErr(c, err, "PATCH /api/items/youtube/:id");
    }
  },
);

itemsYoutubeRoutes.delete("/items/youtube/:id", async (c) => {
  const ctx = getAuditContext(c);
  try {
    await softDeleteItem(ctx.userId, c.req.param("id"), ctx.ipAddress);
    return c.body(null, 204);
  } catch (err) {
    return mapErr(c, err, "DELETE /api/items/youtube/:id");
  }
});
