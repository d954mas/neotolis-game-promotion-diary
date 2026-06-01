// Game-Steam-listings HTTP routes.
//
// Routes:
//   POST   /api/games/:gameId/listings                       — addSteamListing
//   GET    /api/games/:gameId/listings                       — listListings
//   DELETE /api/games/:gameId/listings/:listingId            — removeSteamListing
//   DELETE /api/games/:gameId/listings/:listingId?force=true — hardDeleteListing
//   POST   /api/games/:gameId/listings/:listingId/restore    — restoreListing
//   PATCH  /api/games/:gameId/listings/:listingId/key        — attachKeyToListing
//
// All routes inherit tenantScope; cross-tenant gameId / listingId surfaces as
// NotFoundError (404) from the service layer. Service rejects on non-existent
// gameId BEFORE INSERT (defense-in-depth).
//
// `POST /api/games/:gameId/listings/:listingId/restore` exposes
// `restoreListing` so the per-game RecoveryDialog can flip soft-deleted
// listings back to active. Mirrors the pattern of
// `POST /api/sources/:id/restore` (sources.ts) — same shape, same 404
// semantics, same DTO projection.

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  addSteamListing,
  listListings,
  removeSteamListing,
  restoreListing,
  hardDeleteListing,
  attachKeyToListing,
  updateListing,
} from "../../services/game-steam-listings.js";
import { importWishlistCsv } from "../../services/wishlist-snapshots.js";
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

// Per-listing field edit. Today only `label` is mutable; the schema is
// shaped to accept future fields without a breaking rename of the route.
// `label` is `string` not `string.optional()`-only because Zod's
// `.optional()` on a single property leaves the body type as
// `{ label?: string }` — that's the contract we want.
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

// Per-listing label edit. PATCH /api/games/:gameId/listings/:listingId
// accepts { label?: string }. Cross-tenant gameId/listingId surfaces
// as 404 (not 403). Future fields hang off the same route shape via
// the updateListingSchema extension.
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

// `?force=true` switches from soft-delete (removeSteamListing) to hard
// purge from the trash view (hardDeleteListing) — same force-flag idiom
// the games + events bulk-delete routes use. Both paths return 204; both
// surface cross-tenant gameId/listingId as 404. hardDeleteListing only
// purges an already-soft-deleted row (else 404), so the trash view is the
// only surface that calls it.
gameListingsRoutes.delete("/games/:gameId/listings/:listingId", async (c) => {
  const ctx = getAuditContext(c);
  const force = c.req.query("force") === "true";
  try {
    if (force) {
      await hardDeleteListing(ctx.userId, c.req.param("gameId"), c.req.param("listingId"));
    } else {
      await removeSteamListing(ctx.userId, c.req.param("listingId"), ctx.ipAddress);
    }
    return c.body(null, 204);
  } catch (err) {
    return mapErr(c, err, "DELETE /api/games/:gameId/listings/:listingId");
  }
});

// Per-game listing restore. Returns the restored listing DTO on 200 so
// the client can update the active list without a separate GET
// roundtrip (matches the Sources restore endpoint contract).
gameListingsRoutes.post("/games/:gameId/listings/:listingId/restore", async (c) => {
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
      const listing = await attachKeyToListing(c.var.userId, c.req.param("listingId"), apiKeyId);
      return c.json(toGameSteamListingDto(listing));
    } catch (err) {
      return mapErr(c, err, "PATCH /api/games/:gameId/listings/:listingId/key");
    }
  },
);

// Wishlist CSV import — the repo's first multipart file-upload route.
//
// A Hono route (NOT a SvelteKit form action) so it inherits tenantScope +
// accountState + metrics + mapErr by mount (RESEARCH.md Pattern 3 — a form
// action bypasses all four). bodyLimit caps the payload BEFORE we read the
// body into memory; years of daily rows are < 100 KB, so 2 MiB is generous.
// We do NOT gate on `file.type` (RESEARCH.md Pitfall 6 — browsers send
// inconsistent MIME for .csv); the parser's header-shape check is the real
// contract. Cross-tenant gameId/listingId surfaces as 404 from the service.
gameListingsRoutes.post(
  "/games/:gameId/listings/:listingId/wishlist-import",
  bodyLimit({
    maxSize: 2 * 1024 * 1024,
    onError: (c) => c.json({ error: "wishlist_csv_too_large" }, 413),
  }),
  async (c) => {
    const ctx = getAuditContext(c);
    const body = await c.req.parseBody();
    const file = body["file"];
    if (!(file instanceof File)) {
      return c.json({ error: "wishlist_csv_missing_file" }, 422);
    }
    const csvText = await file.text();
    try {
      const result = await importWishlistCsv(
        ctx.userId,
        c.req.param("gameId"),
        c.req.param("listingId"),
        csvText,
        ctx.ipAddress,
        file.name,
      );
      return c.json(result, 200);
    } catch (err) {
      return mapErr(c, err, "POST /api/games/:gameId/listings/:listingId/wishlist-import");
    }
  },
);
