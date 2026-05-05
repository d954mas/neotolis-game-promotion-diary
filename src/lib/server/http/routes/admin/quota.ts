// Phase 3.0 Plan 07 — GET /api/admin/quota.
//
// Allowlist-gated operator dashboard endpoint. Auth (tenantScope) +
// allowlist (adminAllowlist) are mounted in app.ts BEFORE this router so
// every request reaching here is already (a) authenticated and (b) in the
// ADMIN_EMAIL_ALLOWLIST. The handler does no further auth — just reads the
// service layer.
//
// Returns:
//   {
//     today: 'YYYY-MM-DD',         // America/Los_Angeles (Google's quota boundary)
//     keys: QuotaKeyRow[],         // today's per-API-key usage rows + status pill
//     audit: ServiceAuditEntry[],  // last 50 service-level audit rows (cross-tenant)
//   }
//
// CROSS-TENANT BY DESIGN: the audit aggregation across tenants is the
// operator signal pane (D-16 / DV-3). The security property is the
// allowlist gate, not row-level userId scoping. See admin-quota-read.ts for
// the AGENTS.md-compliant eslint-disable justification on the underlying
// query.

import { Hono } from "hono";
import { mapErr, type RouteVars } from "../_shared.js";
import { loadAdminQuotaPage } from "../../../services/admin-quota-read.js";

export const adminQuotaRouter = new Hono<RouteVars>();

adminQuotaRouter.get("/quota", async (c) => {
  try {
    const data = await loadAdminQuotaPage();
    return c.json(data);
  } catch (err) {
    return mapErr(c, err, "GET /api/admin/quota");
  }
});
