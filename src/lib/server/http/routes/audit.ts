// Audit log HTTP routes (Plan 02-08; widened Plan 02.1-20).
//
// Routes:
//   GET /api/audit?cursor=&action=A&action=B  — listAuditPage
//
// Plan 02.1-20: action filter switches from single-select (?action=A) to
// multi-select (?action=A&action=B repeated params), mirroring /feed's
// convention from Plan 02.1-15. Empty array = "all" semantics (default).
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
import { AUDIT_ACTIONS, type AuditAction } from "../../audit/actions.js";
import { toAuditEntryDto } from "../../dto.js";
import { mapErr, type RouteVars } from "./_shared.js";

// Plan 02.1-20: drop the "all" sentinel; valid values are AUDIT_ACTIONS only.
// The empty-array branch is the new "all" semantics. Cursor still uses zod
// for the query schema; multi-action is parsed via c.req.queries('action').
const auditQuerySchema = z.object({
  cursor: z.string().optional(),
});
const ACTION_VALUES: ReadonlySet<string> = new Set(AUDIT_ACTIONS);

export const auditRoutes = new Hono<RouteVars>();

auditRoutes.get(
  "/audit",
  zValidator("query", auditQuerySchema, (r, c) => {
    if (!r.success) {
      return c.json({ error: "validation_failed", details: r.error.issues }, 422);
    }
  }),
  async (c) => {
    const { cursor } = c.req.valid("query");
    // Hono's c.req.queries('action') returns string[] for repeated params
    // (?action=A&action=B → ['A', 'B']). Forgiving-GET: drop any entry not
    // in AUDIT_ACTIONS rather than 422 the request — the service layer's
    // assertValidActionFilter still catches forged values directly.
    const rawActions = c.req.queries("action") ?? [];
    const actionFilter = rawActions.filter((a): a is AuditAction => ACTION_VALUES.has(a));
    try {
      const page = await listAuditPage(c.var.userId, cursor ?? null, actionFilter);
      return c.json({
        rows: page.rows.map(toAuditEntryDto),
        nextCursor: page.nextCursor,
      });
    } catch (err) {
      return mapErr(c, err, "GET /api/audit");
    }
  },
);
