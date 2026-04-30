// Steam API keys HTTP routes (Plan 02-08).
//
// Routes:
//   POST   /api/api-keys/steam        — createSteamKey
//   GET    /api/api-keys/steam        — listSteamKeys (DTO array, NEVER ciphertext)
//   GET    /api/api-keys/steam/:id    — getSteamKeyById (single DTO)
//   PATCH  /api/api-keys/steam/:id    — rotateSteamKey (D-13 multi-key Replace flow)
//   DELETE /api/api-keys/steam/:id    — removeSteamKey
//
// Every response goes through `toApiKeySteamDto`. The DTO strips every
// ciphertext column at runtime (D-39). TypeScript erases at runtime — the
// projection function is the load-bearing security barrier.
//
// AppError code mapping is automatic via `mapErr`:
//   - createSteamKey throws AppError(422, 'steam_key_label_exists') on dup label → 422
//   - probeSteamKey throws AppError(422, 'validation_failed') on Steam 4xx     → 422
//   - probeSteamKey throws AppError(502, 'steam_api_unavailable') on Steam 5xx → 502
//   - cross-tenant access throws NotFoundError                                  → 404

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  createSteamKey,
  listSteamKeys,
  getSteamKeyById,
  rotateSteamKey,
  removeSteamKey,
} from "../../services/api-keys-steam.js";
import { toApiKeySteamDto } from "../../dto.js";
import { getAuditContext } from "../middleware/audit-ip.js";
import { mapErr, type RouteVars } from "./_shared.js";

const createKeySchema = z.object({
  label: z.string().min(1).max(100),
  plaintext: z.string().min(1).max(2000),
});

const rotateKeySchema = z.object({
  plaintext: z.string().min(1).max(2000),
});

export const apiKeysSteamRoutes = new Hono<RouteVars>();

apiKeysSteamRoutes.post(
  "/api-keys/steam",
  zValidator("json", createKeySchema, (r, c) => {
    if (!r.success) {
      return c.json({ error: "validation_failed", details: r.error.issues }, 422);
    }
  }),
  async (c) => {
    const ctx = getAuditContext(c);
    try {
      const row = await createSteamKey(ctx.userId, c.req.valid("json"), ctx.ipAddress);
      return c.json(toApiKeySteamDto(row), 201);
    } catch (err) {
      return mapErr(c, err, "POST /api/api-keys/steam");
    }
  },
);

apiKeysSteamRoutes.get("/api-keys/steam", async (c) => {
  try {
    const list = await listSteamKeys(c.var.userId);
    return c.json(list.map(toApiKeySteamDto));
  } catch (err) {
    return mapErr(c, err, "GET /api/api-keys/steam");
  }
});

apiKeysSteamRoutes.get("/api-keys/steam/:id", async (c) => {
  try {
    const row = await getSteamKeyById(c.var.userId, c.req.param("id"));
    return c.json(toApiKeySteamDto(row));
  } catch (err) {
    return mapErr(c, err, "GET /api/api-keys/steam/:id");
  }
});

apiKeysSteamRoutes.patch(
  "/api-keys/steam/:id",
  zValidator("json", rotateKeySchema, (r, c) => {
    if (!r.success) {
      return c.json({ error: "validation_failed", details: r.error.issues }, 422);
    }
  }),
  async (c) => {
    const ctx = getAuditContext(c);
    try {
      const row = await rotateSteamKey(
        ctx.userId,
        c.req.param("id"),
        c.req.valid("json"),
        ctx.ipAddress,
      );
      return c.json(toApiKeySteamDto(row));
    } catch (err) {
      return mapErr(c, err, "PATCH /api/api-keys/steam/:id");
    }
  },
);

apiKeysSteamRoutes.delete("/api-keys/steam/:id", async (c) => {
  const ctx = getAuditContext(c);
  try {
    await removeSteamKey(ctx.userId, c.req.param("id"), ctx.ipAddress);
    return c.body(null, 204);
  } catch (err) {
    return mapErr(c, err, "DELETE /api/api-keys/steam/:id");
  }
});
