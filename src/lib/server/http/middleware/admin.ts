// Phase 3.0 Plan 07 — admin allowlist gate (D-16).
//
// Reads `env.ADMIN_EMAIL_ALLOWLIST` (Set<string>, lowercased + trimmed at boot
// via src/lib/server/config/env.ts). Throws `NotFoundError` (→ 404 via
// routes/_shared.ts mapErr) when the caller's email is NOT in the set.
//
// 404 not 403 — AGENTS.md "Privacy & multi-tenancy" invariant 2 + AP-4. The
// body MUST NOT contain the literal strings "forbidden" / "permission" — see
// tests/integration/admin-quota.test.ts. The 403-class error type is reserved
// for Phase 6+ admin endpoints where the caller IS authorized to know the
// resource exists; here the existence of /admin/* itself is the secret.
//
// Self-host parity by construction: empty allowlist Set ⇒ membership check
// fails for every authenticated user ⇒ all `/api/admin/*` returns 404. Self-
// host operators who never set ADMIN_EMAIL_ALLOWLIST simply have no admin
// surface — same shape as the SaaS instance for a non-admin user.
//
// Mount AFTER `tenantScope` (so c.var.userEmail is populated). app.ts wires:
//   app.use('/api/admin/*', tenantScope);
//   app.use('/api/admin/*', adminAllowlist);
//   app.route('/api/admin', adminQuotaRouter);
//
// Note: the existing tenantScope middleware (Phase 1) sets c.var.userId +
// c.var.sessionId only — NOT userEmail. Plan 03.0-07 extends tenantScope to
// also set userEmail (the Better Auth session result already carries it via
// `result.user.email`); this lets admin-allowlist look up against it without
// a second DB round-trip.

import type { MiddlewareHandler } from "hono";
import { env } from "../../config/env.js";

export const adminAllowlist: MiddlewareHandler<{
  Variables: { userId: string; sessionId: string; userEmail: string };
}> = async (c, next) => {
  const email = (c.var.userEmail ?? "").toLowerCase();
  if (!env.ADMIN_EMAIL_ALLOWLIST.has(email)) {
    // Pattern matches tenantScope (401) and accountState (423): respond
    // directly from the middleware rather than throwing. Direct response
    // avoids needing a global Hono onError handler — per-route mapErr
    // handles NotFoundError thrown FROM service code, not from middleware.
    //
    // The literal body shape ({error: 'not_found'}) is identical to what
    // mapErr emits for NotFoundError so callers cannot distinguish "the
    // route doesn't exist for me (allowlist gate)" from "the row I asked
    // about doesn't exist for me (cross-tenant)" — that's the AGENTS.md
    // AP-4 contract for admin paths.
    return c.json({ error: "not_found" }, 404);
  }
  return next();
};
