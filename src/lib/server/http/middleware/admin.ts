// Admin allowlist gate.
//
// Reads `env.ADMIN_EMAIL_ALLOWLIST` (Set<string>, lowercased + trimmed at
// boot via src/lib/server/config/env.ts). Returns 404 when the caller's
// email is NOT in the set.
//
// 404 not 403 — AGENTS.md "Privacy & multi-tenancy" invariant 2. The body
// MUST NOT contain the literal strings "forbidden" / "permission" — see
// tests/integration/admin-quota.test.ts. The 403-class error type is
// reserved for admin endpoints where the caller IS authorized to know the
// resource exists; here the existence of /admin/* itself is the secret.
//
// Self-host parity by construction: empty allowlist Set ⇒ membership check
// fails for every authenticated user ⇒ all `/api/admin/*` returns 404.
// Self-host operators who never set ADMIN_EMAIL_ALLOWLIST simply have no
// admin surface — same shape as the SaaS instance for a non-admin user.
//
// Mount AFTER `tenantScope` (so c.var.userEmail is populated). app.ts wires:
//   app.use('/api/admin/*', tenantScope);
//   app.use('/api/admin/*', adminAllowlist);
//   app.route('/api/admin', adminQuotaRouter);
//
// tenantScope sets c.var.userId + c.var.sessionId + c.var.userEmail (the
// Better Auth session result carries email via `result.user.email`); this
// lets admin-allowlist look up against it without a second DB round-trip.

import type { MiddlewareHandler } from "hono";
import { env } from "../../config/env.js";

export const adminAllowlist: MiddlewareHandler<{
  Variables: { userId: string; sessionId: string; userEmail: string };
}> = async (c, next) => {
  const email = (c.var.userEmail ?? "").toLowerCase();
  if (!env.ADMIN_EMAIL_ALLOWLIST.has(email)) {
    // Pattern matches tenantScope (401) and accountState (423): respond
    // directly from the middleware rather than throwing, so the exact status
    // code is preserved. A global app.onError (app.ts) now exists as a
    // safety net, but it generalizes any escaped throw to 500 — middleware
    // that needs a specific status (401/404/423) must still return directly
    // rather than rely on it. Per-route mapErr handles NotFoundError thrown
    // FROM service code.
    //
    // The literal body shape ({error: 'not_found'}) is identical to what
    // mapErr emits for NotFoundError so callers cannot distinguish "the
    // route doesn't exist for me (allowlist gate)" from "the row I asked
    // about doesn't exist for me (cross-tenant)" — that's the AGENTS.md
    // contract for admin paths.
    return c.json({ error: "not_found" }, 404);
  }
  return next();
};
