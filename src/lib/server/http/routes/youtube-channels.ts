// YouTube channels HTTP routes (Plan 02-08).
//
// Routes:
//   GET    /api/youtube-channels                              — listChannels
//   POST   /api/youtube-channels                              — createChannel
//   PATCH  /api/youtube-channels/:id                          — toggleIsOwn
//   DELETE /api/youtube-channels/:id                          — (none yet — Phase 2 scope)
//   GET    /api/games/:gameId/youtube-channels                — listChannelsForGame
//   POST   /api/games/:gameId/youtube-channels                — attachToGame
//   DELETE /api/games/:gameId/youtube-channels/:channelId     — detachFromGame
//
// Channels live at user level (NOT game-bound) per D-24. The M:N attach/detach
// routes operate on `game_youtube_channels` link rows; the underlying
// `youtube_channels` row is unaffected by detach.
//
// `DELETE /api/youtube-channels/:id` is intentionally NOT shipped in Phase 2 —
// the service layer has no `removeChannel` and the UI's "remove channel" flow
// (Plan 02-10) detaches from each game instead. If a future plan needs
// channel-level deletion, it lands the service function first.

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  createChannel,
  listChannels,
  attachToGame,
  detachFromGame,
  listChannelsForGame,
  toggleIsOwn,
} from "../../services/youtube-channels.js";
import { toYoutubeChannelDto } from "../../dto.js";
import { mapErr, type RouteVars } from "./_shared.js";

const createChannelSchema = z.object({
  handleUrl: z.string().url(),
  isOwn: z.boolean().optional(),
  displayName: z.string().max(200).optional(),
});

const toggleIsOwnSchema = z.object({
  isOwn: z.boolean(),
});

const attachChannelSchema = z.object({
  channelId: z.string().min(1),
});

export const youtubeChannelsRoutes = new Hono<RouteVars>();

youtubeChannelsRoutes.get("/youtube-channels", async (c) => {
  try {
    const list = await listChannels(c.var.userId);
    return c.json(list.map(toYoutubeChannelDto));
  } catch (err) {
    return mapErr(c, err, "GET /api/youtube-channels");
  }
});

youtubeChannelsRoutes.post(
  "/youtube-channels",
  zValidator("json", createChannelSchema, (r, c) => {
    if (!r.success) {
      return c.json({ error: "validation_failed", details: r.error.issues }, 422);
    }
  }),
  async (c) => {
    const body = c.req.valid("json");
    try {
      const channel = await createChannel(c.var.userId, {
        handleUrl: body.handleUrl,
        isOwn: body.isOwn,
        displayName: body.displayName ?? null,
      });
      return c.json(toYoutubeChannelDto(channel), 201);
    } catch (err) {
      return mapErr(c, err, "POST /api/youtube-channels");
    }
  },
);

youtubeChannelsRoutes.patch(
  "/youtube-channels/:id",
  zValidator("json", toggleIsOwnSchema, (r, c) => {
    if (!r.success) {
      return c.json({ error: "validation_failed", details: r.error.issues }, 422);
    }
  }),
  async (c) => {
    const { isOwn } = c.req.valid("json");
    try {
      const channel = await toggleIsOwn(c.var.userId, c.req.param("id"), isOwn);
      return c.json(toYoutubeChannelDto(channel));
    } catch (err) {
      return mapErr(c, err, "PATCH /api/youtube-channels/:id");
    }
  },
);

youtubeChannelsRoutes.get("/games/:gameId/youtube-channels", async (c) => {
  try {
    const list = await listChannelsForGame(c.var.userId, c.req.param("gameId"));
    return c.json(list.map(toYoutubeChannelDto));
  } catch (err) {
    return mapErr(c, err, "GET /api/games/:gameId/youtube-channels");
  }
});

youtubeChannelsRoutes.post(
  "/games/:gameId/youtube-channels",
  zValidator("json", attachChannelSchema, (r, c) => {
    if (!r.success) {
      return c.json({ error: "validation_failed", details: r.error.issues }, 422);
    }
  }),
  async (c) => {
    const { channelId } = c.req.valid("json");
    try {
      await attachToGame(c.var.userId, c.req.param("gameId"), channelId);
      return c.body(null, 204);
    } catch (err) {
      return mapErr(c, err, "POST /api/games/:gameId/youtube-channels");
    }
  },
);

youtubeChannelsRoutes.delete("/games/:gameId/youtube-channels/:channelId", async (c) => {
  try {
    await detachFromGame(
      c.var.userId,
      c.req.param("gameId"),
      c.req.param("channelId"),
    );
    return c.body(null, 204);
  } catch (err) {
    return mapErr(c, err, "DELETE /api/games/:gameId/youtube-channels/:channelId");
  }
});
