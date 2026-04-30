// Game-Steam-listings HTTP routes (Plan 02-08).
//
// Routes:
//   POST   /api/games/:gameId/listings                       — addSteamListing
//   GET    /api/games/:gameId/listings                       — listListings
//   DELETE /api/games/:gameId/listings/:listingId            — removeSteamListing
//   POST   /api/games/:gameId/listings/:listingId/restore    — restoreListing (Plan 02.1-39 round-6 #12)
//   PATCH  /api/games/:gameId/listings/:listingId/key        — attachKeyToListing
//
// All routes inherit tenantScope; cross-tenant gameId / listingId surfaces as
// NotFoundError (404) from the service layer. Service rejects on non-existent
// gameId BEFORE INSERT (defense-in-depth).
//
// Plan 02.1-39 round-6 polish #12 (UAT-NOTES.md §5.8 follow-up #12):
// `POST /api/games/:gameId/listings/:listingId/restore` exposes the new
// `restoreListing` service function so the per-game RecoveryDialog can
// flip soft-deleted listings back to active. Mirrors the pattern of
// `POST /api/sources/:id/restore` (sources.ts) — same shape, same 404
// semantics, same DTO projection.

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  addSteamListing,
  listListings,
  removeSteamListing,
  restoreListing,
  attachKeyToListing,
  updateListing,
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

// Plan 02.1-39 round-6 polish #14c (UAT-NOTES.md §5.8 follow-up #14,
// 2026-04-30): per-listing field edit. Today only `label` is mutable;
// the schema is shaped to accept future fields without a breaking
// rename of the route. `label` is `string` not `string.optional()`-only
// because Zod's `.optional()` on a single property leaves the body
// type as `{ label?: string }` — that's the contract we want.
const updateListingSchema = z.object({
  label: z.string().max(100).optional(),
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

// Plan 02.1-39 round-6 polish #14c (UAT-NOTES.md §5.8 follow-up #14):
// per-listing label edit. PATCH /api/games/:gameId/listings/:listingId
// accepts { label?: string }. Cross-tenant gameId/listingId surfaces
// as 404 (PRIV-01: 404, not 403). Future fields hang off the same
// route shape via the updateListingSchema extension.
gameListingsRoutes.patch(
  "/games/:gameId/listings/:listingId",
  zValidator("json", updateListingSchema, (r, c) => {
    if (!r.success) {
      return c.json({ error: "validation_failed", details: r.error.issues }, 422);
    }
  }),
  async (c) => {
    const body = c.req.valid("json");
    try {
      const listing = await updateListing(
        c.var.userId,
        c.req.param("gameId"),
        c.req.param("listingId"),
        body,
      );
      return c.json(toGameSteamListingDto(listing));
    } catch (err) {
      return mapErr(c, err, "PATCH /api/games/:gameId/listings/:listingId");
    }
  },
);

gameListingsRoutes.delete("/games/:gameId/listings/:listingId", async (c) => {
  const ctx = getAuditContext(c);
  try {
    await removeSteamListing(ctx.userId, c.req.param("listingId"), ctx.ipAddress);
    return c.body(null, 204);
  } catch (err) {
    return mapErr(c, err, "DELETE /api/games/:gameId/listings/:listingId");
  }
});

// Plan 02.1-39 round-6 polish #12 (UAT-NOTES.md §5.8 follow-up #12,
// 2026-04-30): per-game listing restore. Returns the restored listing
// DTO on 200 so the client can update the active list without a separate
// GET roundtrip (matches the Sources restore endpoint contract).
gameListingsRoutes.post(
  "/games/:gameId/listings/:listingId/restore",
  async (c) => {
    const ctx = getAuditContext(c);
    try {
      const listing = await restoreListing(
        ctx.userId,
        c.req.param("gameId"),
        c.req.param("listingId"),
        ctx.ipAddress,
      );
      return c.json(toGameSteamListingDto(listing));
    } catch (err) {
      return mapErr(c, err, "POST /api/games/:gameId/listings/:listingId/restore");
    }
  },
);

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
