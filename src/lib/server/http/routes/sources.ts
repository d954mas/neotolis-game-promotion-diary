// Data Sources HTTP routes (Plan 02.1-06 — Wave 2).
//
// Replaces the Phase 2 per-platform channel route group with a unified
// per-tenant data_source registry over kinds youtube_channel /
// reddit_account / twitter_account / telegram_channel / discord_server.
// In Phase 2.1 only youtube_channel is wired; non-functional kinds reject at
// the service boundary with AppError 'kind_not_yet_functional' (422) which
// flows through `mapErr` automatically.
//
// Routes:
//   POST   /api/sources                — createSource
//   GET    /api/sources                — listSources (?includeDeleted=true)
//   GET    /api/sources/:id            — getSourceById
//   PATCH  /api/sources/:id            — updateSource
//   DELETE /api/sources/:id            — softDeleteSource (returns soft-deleted row)
//   POST   /api/sources/:id/restore    — restoreSource (422 retention_expired beyond RETENTION_DAYS)
//
// Every handler runs after the `/api/*` tenantScope middleware (anonymous → 401)
// and after Plan 06's proxy-trust middleware (clientIp + userAgent for audit).
// Cross-tenant access surfaces as NotFoundError → 404 (PRIV-01: never 403).

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  createSource,
  listSources,
  getSourceById,
  updateSource,
  softDeleteSource,
  restoreSource,
} from "../../services/data-sources.js";
import { toDataSourceDto } from "../../dto.js";
import { getAuditContext } from "../middleware/audit-ip.js";
import { mapErr, type RouteVars } from "./_shared.js";

const sourceKindEnum = z.enum([
  "youtube_channel",
  "reddit_account",
  "twitter_account",
  "telegram_channel",
  "discord_server",
]);

const createSourceSchema = z.object({
  kind: sourceKindEnum,
  handleUrl: z.string().url(),
  displayName: z.string().min(1).max(120).nullable().optional(),
  channelId: z.string().min(1).max(64).nullable().optional(),
  isOwnedByMe: z.boolean().optional(),
  autoImport: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const updateSourceSchema = z
  .object({
    displayName: z.string().min(1).max(120).nullable().optional(),
    autoImport: z.boolean().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, {
    message: "at least one field must be supplied",
  });

const listQuerySchema = z.object({
  includeDeleted: z.enum(["true", "false"]).optional(),
});

export const sourcesRoutes = new Hono<RouteVars>();

sourcesRoutes.post(
  "/sources",
  zValidator("json", createSourceSchema, (r, c) => {
    if (!r.success) {
      return c.json({ error: "validation_failed", details: r.error.issues }, 422);
    }
  }),
  async (c) => {
    const ctx = getAuditContext(c);
    const body = c.req.valid("json");
    try {
      const row = await createSource(
        ctx.userId,
        body,
        ctx.ipAddress,
        ctx.userAgent ?? undefined,
      );
      return c.json(toDataSourceDto(row), 201);
    } catch (err) {
      return mapErr(c, err, "POST /api/sources");
    }
  },
);

sourcesRoutes.get(
  "/sources",
  zValidator("query", listQuerySchema, (r, c) => {
    if (!r.success) {
      return c.json({ error: "validation_failed", details: r.error.issues }, 422);
    }
  }),
  async (c) => {
    const includeDeleted = c.req.valid("query").includeDeleted === "true";
    try {
      const rows = await listSources(c.var.userId, { includeDeleted });
      return c.json(rows.map(toDataSourceDto));
    } catch (err) {
      return mapErr(c, err, "GET /api/sources");
    }
  },
);

sourcesRoutes.get("/sources/:id", async (c) => {
  try {
    const row = await getSourceById(c.var.userId, c.req.param("id"));
    return c.json(toDataSourceDto(row));
  } catch (err) {
    return mapErr(c, err, "GET /api/sources/:id");
  }
});

sourcesRoutes.patch(
  "/sources/:id",
  zValidator("json", updateSourceSchema, (r, c) => {
    if (!r.success) {
      return c.json({ error: "validation_failed", details: r.error.issues }, 422);
    }
  }),
  async (c) => {
    const ctx = getAuditContext(c);
    try {
      const row = await updateSource(
        ctx.userId,
        c.req.param("id"),
        c.req.valid("json"),
        ctx.ipAddress,
        ctx.userAgent ?? undefined,
      );
      return c.json(toDataSourceDto(row));
    } catch (err) {
      return mapErr(c, err, "PATCH /api/sources/:id");
    }
  },
);

sourcesRoutes.delete("/sources/:id", async (c) => {
  const ctx = getAuditContext(c);
  try {
    const row = await softDeleteSource(
      ctx.userId,
      c.req.param("id"),
      ctx.ipAddress,
      ctx.userAgent ?? undefined,
    );
    return c.json(toDataSourceDto(row));
  } catch (err) {
    return mapErr(c, err, "DELETE /api/sources/:id");
  }
});

sourcesRoutes.post("/sources/:id/restore", async (c) => {
  const ctx = getAuditContext(c);
  try {
    const row = await restoreSource(
      ctx.userId,
      c.req.param("id"),
      ctx.ipAddress,
      ctx.userAgent ?? undefined,
    );
    return c.json(toDataSourceDto(row));
  } catch (err) {
    return mapErr(c, err, "POST /api/sources/:id/restore");
  }
});
