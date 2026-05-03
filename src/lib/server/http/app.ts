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
import { accountState } from "./middleware/account-state.js";
import { meRoutes } from "./routes/me.js";
import { sessionRoutes } from "./routes/sessions.js";
// Phase 2 (Plan 02-08) sub-routers — every Phase 2 service surface gets
// a Hono sub-router mounted under /api/* so it inherits tenantScope.
import { gamesRoutes } from "./routes/games.js";
import { gameListingsRoutes } from "./routes/game-listings.js";
import { sourcesRoutes } from "./routes/sources.js";
import { apiKeysSteamRoutes } from "./routes/api-keys-steam.js";
import { eventsRoutes } from "./routes/events.js";
import { auditRoutes } from "./routes/audit.js";
import { meThemeRoutes } from "./routes/me-theme.js";
// Phase 02.2 (Plan 02.2-03) — in-app account export / soft-delete / restore.
import { accountRoutes } from "./routes/account.js";
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

  // Account-state guard (Phase 02.2 — Codex P1.2 fix): a soft-deleted account
  // (user.deleted_at IS NOT NULL) can sign back in via Google OAuth during the
  // grace window. Block all writes from that session except restore / export /
  // sign-out / read-self. See middleware/account-state.ts for the allowlist.
  app.use("/api/*", accountState);

  // /api routes — Phase 1 + Phase 2 + Phase 2.1 (Plan 02.1-06).
  app.route("/api", meRoutes);
  app.route("/api", sessionRoutes);
  // Phase 2: order matters minimally — `/api/games/*` parameterized routes
  // (game-listings, per-game events) are registered AFTER the bare
  // gamesRoutes so Hono's path-matching does not shadow `/api/games/:id`
  // with `/api/games/:gameId/listings`. The per-game events sub-route lives
  // on `gamesRoutes` itself (Plan 02.1-06 — replaces Phase 2's events.ts
  // mount of `/api/games/:gameId/events`).
  app.route("/api", gamesRoutes);
  app.route("/api", gameListingsRoutes);
  // Phase 2.1: data_sources sub-router replaces the Phase 2 per-platform
  // channel + tracked-video route groups (their underlying services were
  // retired in Plan 02.1-04 and 02.1-05; the route files are gone in Plan
  // 02.1-06).
  app.route("/api", sourcesRoutes);
  app.route("/api", apiKeysSteamRoutes);
  app.route("/api", eventsRoutes);
  app.route("/api", auditRoutes);
  app.route("/api", meThemeRoutes);
  // Phase 02.2 — /api/me/export, DELETE /api/me/account, POST /api/me/account/restore
  app.route("/api", accountRoutes);

  return app;
}
