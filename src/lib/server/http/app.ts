// Hono app composition (Plan 01-06 — Wave 3).
//
// Mounts:
//   - proxyTrust + secureHeaders for every route (defense-in-depth, Q5)
//   - GET /healthz   → 200 always once process is up (D-21 liveness, unauth by design)
//   - GET /readyz    → 200 only when migrations applied AND DB ping succeeds
//   - GET|POST /api/auth/* → Better Auth handler (Plan 05)
//   - GET /api/me    → 401 placeholder; Plan 07 replaces with the real handler under tenantScope
//   - everything else → SvelteKit handler (mounted by src/roles/app.ts in production)
//
// Plan 07 adds tenantScope under /api/* (NOT under /api/auth/*).
// Plan 05's `auth.handler` is the Better Auth web-standard handler that
// receives a Request (Hono's c.req.raw) and returns a Response.

import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { proxyTrust } from "./middleware/proxy-trust.js";
import { tenantScope } from "./middleware/tenant.js";
import { meRoutes } from "./routes/me.js";
import { sessionRoutes } from "./routes/sessions.js";
import { auth } from "../../auth.js";
import { migrationsApplied } from "../db/migrate.js";
import { pool } from "../db/client.js";
import { logger } from "../logger.js";

export type AppContext = {
  Variables: {
    clientIp: string;
    clientProto: "http" | "https";
    userId?: string;
    sessionId?: string;
  };
};

export function createApp(): Hono<AppContext> {
  const app = new Hono<AppContext>();

  // First: resolve client IP behind any proxy (Plan 01-06 Task 1).
  app.use("*", proxyTrust);

  // Defense-in-depth headers (Open Question Q5).
  app.use(
    "*",
    secureHeaders({
      strictTransportSecurity: "max-age=63072000; includeSubDomains",
      // SvelteKit's adapter sets the page CSP — leave Hono's CSP off so we
      // don't double-emit conflicting policies.
      contentSecurityPolicy: undefined,
      xFrameOptions: "DENY",
      xContentTypeOptions: "nosniff",
      referrerPolicy: "strict-origin-when-cross-origin",
    }),
  );

  // Health endpoints — UNAUTHENTICATED BY DESIGN (CONTEXT.md deferred section:
  // "Health/ready endpoint authn — `/healthz` and `/readyz` are unauthenticated
  // by design (PRIV-01 explicitly excludes them from 'every endpoint refuses
  // anonymous')").
  app.get("/healthz", (c) => c.text("ok"));

  app.get("/readyz", async (c) => {
    if (!migrationsApplied.current) {
      return c.json({ ok: false, reason: "migrations not yet applied" }, 503);
    }
    try {
      await pool.query("SELECT 1");
      return c.json({ ok: true });
    } catch (err) {
      logger.warn({ err }, "readyz db ping failed");
      return c.json({ ok: false, reason: "db unreachable" }, 503);
    }
  });

  // Better Auth mount (Plan 05). Handles login / callback / signout / getSession.
  // MUST be mounted BEFORE the /api/* tenant-scope guard so OAuth callbacks
  // (which arrive anonymously by definition) are not blocked.
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  // Tenant scope (Plan 07): every /api/* (except /api/auth/* above) requires
  // a valid Better Auth session. Anonymous requests get 401 + {error:'unauthorized'};
  // authenticated requests land on the route handler with c.var.userId and
  // c.var.sessionId set. Pattern 3 (404 not 403) is enforced one layer deeper
  // by service functions (see src/lib/server/services/errors.ts).
  app.use("/api/*", tenantScope);

  // /api routes (Phase 1: /api/me + /api/me/sessions/all; Phase 2 adds /api/games, etc.).
  app.route("/api", meRoutes);
  app.route("/api", sessionRoutes);

  return app;
}
