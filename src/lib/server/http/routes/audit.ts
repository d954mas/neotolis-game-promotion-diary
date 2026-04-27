// Audit log HTTP routes (Plan 02-08).
//
// Routes:
//   GET /api/audit?cursor=&action=  — listAuditPage
//
// The cursor is opaque to the client (display-only); the UI submits the
// `nextCursor` returned in the previous response unchanged. zod validates
// the query parameters; the service layer's `assertValidActionFilter` is
// the second defense-in-depth layer (it'll never fire here because zod
// catches invalid action values one layer up, but it's load-bearing for
// any future smoke / forensic call site that lands directly on the
// service).

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { listAuditPage } from "../../services/audit-read.js";
import { AUDIT_ACTIONS } from "../../audit/actions.js";
import { toAuditEntryDto } from "../../dto.js";
import { mapErr, type RouteVars } from "./_shared.js";

const ACTION_FILTER_VALUES = ["all", ...AUDIT_ACTIONS] as const;
const auditQuerySchema = z.object({
  cursor: z.string().optional(),
  action: z.enum(ACTION_FILTER_VALUES).optional(),
});

export const auditRoutes = new Hono<RouteVars>();

auditRoutes.get(
  "/audit",
  zValidator("query", auditQuerySchema, (r, c) => {
    if (!r.success) {
      return c.json({ error: "validation_failed", details: r.error.issues }, 422);
    }
  }),
  async (c) => {
    const { cursor, action } = c.req.valid("query");
    try {
      const page = await listAuditPage(c.var.userId, cursor ?? null, action ?? "all");
      return c.json({
        rows: page.rows.map(toAuditEntryDto),
        nextCursor: page.nextCursor,
      });
    } catch (err) {
      return mapErr(c, err, "GET /api/audit");
    }
  },
);
