// In-app GDPR baseline — export, soft-delete, restore.
// Permanent-delete-now CTA — DELETE /api/me/account/purge.
//
// Tenant-scope contract: routes operate on c.var.userId only — there is
// NO :userId path parameter. Cross-tenant access impossible by construction
// (AGENTS.md §2: 404 not 403; here that's by-construction-not-via-error).
//
// Routes are listed in MUST_BE_PROTECTED in tests/integration/anonymous-401.test.ts.
// The purge route is also in the account-state middleware ALLOWED_WHEN_DELETED
// allowlist — it MUST work for soft-deleted users (that's its primary
// audience: the AccountDeletedBanner CTA).

import { Hono } from "hono";
import { softDeleteAccount, restoreAccount, exportAccountJson } from "../../services/account.js";
import { purgeAccount } from "../../services/purge-account.js";
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

// Permanent-delete-now CTA. Calls purgeAccount({ignoreRetention: true}) —
// the CTA path bypasses the 60-day retention gate so the user can nuke
// their account immediately.
//
// On 200 the body is `{purged: true, rowCounts: {...}}`. The cascade DELETE
// in the same tx removes session rows, so any subsequent request with the
// pre-purge cookie returns 401 (intended logout). The SvelteKit client
// reads the 200 and redirects to /login.
//
// The route is exempted from the account-state 423 gate (see
// middleware/account-state.ts ALLOWED_WHEN_DELETED) because the CTA's
// primary audience IS the soft-deleted user pressing the button on the
// AccountDeletedBanner — an active user can also call it directly.
accountRoutes.delete("/me/account/purge", async (c) => {
  const userId = c.var.userId;
  const ipAddress = c.var.clientIp;
  try {
    const result = await purgeAccount(userId, { ignoreRetention: true, ipAddress });
    return c.json(result);
  } catch (err) {
    return mapErr(c, err, "DELETE /api/me/account/purge");
  }
});
