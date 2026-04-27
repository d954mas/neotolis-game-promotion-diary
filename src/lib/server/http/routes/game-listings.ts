// Game-Steam-listings HTTP routes (Plan 02-08).
//
// Routes:
//   POST   /api/games/:gameId/listings                       — addSteamListing
//   GET    /api/games/:gameId/listings                       — listListings
//   DELETE /api/games/:gameId/listings/:listingId            — removeSteamListing
//   PATCH  /api/games/:gameId/listings/:listingId/key        — attachKeyToListing
//
// All routes inherit tenantScope; cross-tenant gameId / listingId surfaces as
// NotFoundError (404) from the service layer. Service rejects on non-existent
// gameId BEFORE INSERT (defense-in-depth).

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  addSteamListing,
  listListings,
  removeSteamListing,
  attachKeyToListing,
} from "../../services/game-steam-listings.js";
import { toGameSteamListingDto } from "../../dto.js";
import { getAuditContext } from "../middleware/audit-ip.js";
import { mapErr, type RouteVars } from "./_shared.js";

const addListingSchema = z.object({
  appId: z.number().int().positive(),
  label: z.string().max(100).optional(),
});

const attachKeySchema = z.object({
  apiKeyId: z.string().min(1).nullable(),
});

export const gameListingsRoutes = new Hono<RouteVars>();

gameListingsRoutes.post(
  "/games/:gameId/listings",
  zValidator("json", addListingSchema, (r, c) => {
    if (!r.success) {
      return c.json({ error: "validation_failed", details: r.error.issues }, 422);
    }
  }),
  async (c) => {
    const ctx = getAuditContext(c);
    const body = c.req.valid("json");
    try {
      const listing = await addSteamListing(
        ctx.userId,
        { gameId: c.req.param("gameId"), appId: body.appId, label: body.label },
        ctx.ipAddress,
      );
      return c.json(toGameSteamListingDto(listing), 201);
    } catch (err) {
      return mapErr(c, err, "POST /api/games/:gameId/listings");
    }
  },
);

gameListingsRoutes.get("/games/:gameId/listings", async (c) => {
  try {
    const list = await listListings(c.var.userId, c.req.param("gameId"));
    return c.json(list.map(toGameSteamListingDto));
  } catch (err) {
    return mapErr(c, err, "GET /api/games/:gameId/listings");
  }
});

gameListingsRoutes.delete("/games/:gameId/listings/:listingId", async (c) => {
  const ctx = getAuditContext(c);
  try {
    await removeSteamListing(ctx.userId, c.req.param("listingId"), ctx.ipAddress);
    return c.body(null, 204);
  } catch (err) {
    return mapErr(c, err, "DELETE /api/games/:gameId/listings/:listingId");
  }
});

gameListingsRoutes.patch(
  "/games/:gameId/listings/:listingId/key",
  zValidator("json", attachKeySchema, (r, c) => {
    if (!r.success) {
      return c.json({ error: "validation_failed", details: r.error.issues }, 422);
    }
  }),
  async (c) => {
    const { apiKeyId } = c.req.valid("json");
    try {
      const listing = await attachKeyToListing(
        c.var.userId,
        c.req.param("listingId"),
        apiKeyId,
      );
      return c.json(toGameSteamListingDto(listing));
    } catch (err) {
      return mapErr(c, err, "PATCH /api/games/:gameId/listings/:listingId/key");
    }
  },
);
