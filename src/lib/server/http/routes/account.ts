// Phase 02.2 D-16: in-app GDPR baseline — export, soft-delete, restore.
//
// Tenant-scope contract: routes operate on c.var.userId only — there is
// NO :userId path parameter. Cross-tenant access impossible by construction
// (AGENTS.md §2: 404 not 403; here that's by-construction-not-via-error).
//
// All 3 routes are added to MUST_BE_PROTECTED in tests/integration/anonymous-401.test.ts.

import { Hono } from "hono";
import {
  softDeleteAccount,
  restoreAccount,
  exportAccountJson,
} from "../../services/account.js";
import { mapErr, type RouteVars } from "./_shared.js";

export const accountRoutes = new Hono<RouteVars>();

accountRoutes.get("/me/export", async (c) => {
  const userId = c.var.userId;
  const ipAddress = c.var.clientIp;
  try {
    const envelope = await exportAccountJson(userId, ipAddress);
    const filename = `diary-export-${envelope.exported_at.slice(0, 10)}.json`;
    c.header("Content-Disposition", `attachment; filename="${filename}"`);
    c.header("Content-Type", "application/json; charset=utf-8");
    return c.json(envelope);
  } catch (err) {
    return mapErr(c, err, "GET /api/me/export");
  }
});

accountRoutes.delete("/me/account", async (c) => {
  const userId = c.var.userId;
  const ipAddress = c.var.clientIp;
  try {
    await softDeleteAccount(userId, ipAddress);
    return c.json({ ok: true });
  } catch (err) {
    return mapErr(c, err, "DELETE /api/me/account");
  }
});

accountRoutes.post("/me/account/restore", async (c) => {
  const userId = c.var.userId;
  const ipAddress = c.var.clientIp;
  try {
    await restoreAccount(userId, ipAddress);
    return c.json({ ok: true });
  } catch (err) {
    return mapErr(c, err, "POST /api/me/account/restore");
  }
});
