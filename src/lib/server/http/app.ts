// Hono app composition.
//
// Mounts:
//   - proxyTrust + secureHeaders for every route (defense-in-depth)
//   - GET /healthz   → 200 always once process is up (liveness, unauth by design)
//   - GET /readyz    → 200 only when migrations applied AND DB ping succeeds
//   - GET|POST /api/auth/* → Better Auth handler
//   - everything else → SvelteKit handler (mounted by src/roles/app.ts in production)
//
// tenantScope guards /api/* (NOT /api/auth/*). `auth.handler` is the
// Better Auth web-standard handler that receives a Request (Hono's
// c.req.raw) and returns a Response.

import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { proxyTrust } from "./middleware/proxy-trust.js";
import { tenantScope } from "./middleware/tenant.js";
import { accountState } from "./middleware/account-state.js";
import { adminAllowlist } from "./middleware/admin.js";
import { honoErrorHandler } from "./routes/_shared.js";
import { meRoutes } from "./routes/me.js";
import { sessionRoutes } from "./routes/sessions.js";
// Sub-routers — every service surface gets a Hono sub-router mounted
// under /api/* so it inherits tenantScope.
import { gamesRoutes } from "./routes/games.js";
import { gameListingsRoutes } from "./routes/game-listings.js";
import { sourcesRoutes } from "./routes/sources.js";
import { apiKeysSteamRoutes } from "./routes/api-keys-steam.js";
import { eventsRoutes } from "./routes/events.js";
import { auditRoutes } from "./routes/audit.js";
import { meThemeRoutes } from "./routes/me-theme.js";
// In-app account export / soft-delete / restore.
import { accountRoutes } from "./routes/account.js";
// Admin /quota dashboard endpoint (env-allowlist gated).
import { adminQuotaRouter } from "./routes/admin/quota.js";
// Adapters mount their own routes via `adapter.registerRoutes(app)`.
// Adding a new source's preview endpoint means implementing
// registerRoutes on the new adapter.
import { allAdapters } from "$lib/sources/registry.js";
import { auth } from "../../auth.js";
import { env } from "../config/env.js";
import { migrationsApplied } from "../db/migrate.js";
import { pool } from "../db/client.js";
import { logger } from "../logger.js";
import {
  register,
  httpRequestDuration,
  httpRequestTotal,
  queueDepth,
  collectQueueDepths,
  collectAdapterStats,
} from "../metrics.js";

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

  // Global error handler — any throw escaping a route's mapErr or thrown
  // from middleware lands here as structured Pino JSON instead of a raw
  // node-server stack trace. Applies to every route, including the
  // SvelteKit catch-all mounted later in roles/app.ts.
  app.onError(honoErrorHandler);

  // First: resolve client IP behind any proxy.
  app.use("*", proxyTrust);

  // Defense-in-depth headers.
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

  // Skip infra endpoints from recording — /healthz, /readyz, /metrics
  // are high-frequency (Docker healthcheck, Prometheus scrape) and would
  // pollute RPS/latency dashboards with self-referencing noise.
  // "unmatched" fallback caps cardinality for scanner/bot 404s.
  const SKIP_METRICS = new Set(["/healthz", "/readyz", "/metrics"]);
  app.use("*", async (c, next) => {
    if (SKIP_METRICS.has(c.req.path)) {
      await next();
      return;
    }
    const end = httpRequestDuration.startTimer();
    try {
      await next();
    } finally {
      const route = c.req.routePath || "unmatched";
      const labels = {
        method: c.req.method,
        route,
        status_code: String(c.res.status),
      };
      end(labels);
      httpRequestTotal.inc(labels);
    }
  });

  // Health endpoints — UNAUTHENTICATED BY DESIGN. `/healthz` and
  // `/readyz` are explicitly excluded from the "every endpoint refuses
  // anonymous" invariant.
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

  // /metrics is gated by METRICS_BEARER_TOKEN. Empty token (default) =
  // 404 for everyone — safe for bare-port self-host. Operators who enable
  // monitoring set a token and configure Prometheus bearer_token to match.
  app.get("/metrics", async (c) => {
    const token = env.METRICS_BEARER_TOKEN;
    if (!token) {
      return c.notFound();
    }
    const expected = Buffer.from(`Bearer ${token}`);
    const received = Buffer.from(c.req.header("authorization") ?? "");
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      return c.notFound();
    }

    try {
      const queues = await collectQueueDepths(pool);
      queueDepth.reset();
      for (const [name, counts] of Object.entries(queues)) {
        queueDepth.set({ queue: name, state: "queued" }, counts.queued);
        queueDepth.set({ queue: name, state: "active" }, counts.active);
      }
    } catch {
      // pgboss schema may not exist yet — skip queue metrics silently.
    }

    try {
      await collectAdapterStats(pool);
    } catch {
      // adapter tables may not exist yet — skip adapter metrics silently.
    }

    const metrics = await register.metrics();
    return c.text(metrics, 200, {
      "Content-Type": register.contentType,
    });
  });

  // Better Auth mount. Handles login / callback / signout / getSession.
  // MUST be mounted BEFORE the /api/* tenant-scope guard so OAuth
  // callbacks (which arrive anonymously by definition) are not blocked.
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  // Tenant scope: every /api/* (except /api/auth/* above) requires a
  // valid Better Auth session. Anonymous requests get 401 +
  // {error:'unauthorized'}; authenticated requests land on the route
  // handler with c.var.userId and c.var.sessionId set. 404 (not 403)
  // for cross-tenant access is enforced one layer deeper by service
  // functions (see src/lib/server/services/errors.ts).
  app.use("/api/*", tenantScope);

  // Account-state guard: a soft-deleted account (user.deleted_at IS NOT
  // NULL) can sign back in via Google OAuth during the grace window.
  // Block all writes from that session except restore / export /
  // sign-out / read-self. See middleware/account-state.ts for the
  // allowlist.
  app.use("/api/*", accountState);

  // /api routes.
  app.route("/api", meRoutes);
  app.route("/api", sessionRoutes);
  // Order matters minimally — `/api/games/*` parameterized routes
  // (game-listings, per-game events) are registered AFTER the bare
  // gamesRoutes so Hono's path-matching does not shadow `/api/games/:id`
  // with `/api/games/:gameId/listings`. The per-game events sub-route
  // lives on `gamesRoutes` itself.
  app.route("/api", gamesRoutes);
  app.route("/api", gameListingsRoutes);
  app.route("/api", sourcesRoutes);
  app.route("/api", apiKeysSteamRoutes);
  app.route("/api", eventsRoutes);
  app.route("/api", auditRoutes);
  app.route("/api", meThemeRoutes);
  // /api/me/export, DELETE /api/me/account, POST /api/me/account/restore
  app.route("/api", accountRoutes);

  // Adapter-driven HTTP routes. Each adapter mounts its own routes via
  // registerRoutes(app). YouTube: POST /api/youtube/fetch-metadata
  // (preview button on /events/new — cache-first, 1 quota unit on miss).
  // Future source kinds mount via the same hook — no edit here.
  for (const adapter of allAdapters) {
    adapter.registerRoutes?.(app);
  }

  // Admin allowlist gate. Order matters: tenantScope (auth) is already
  // mounted globally on /api/* above, then adminAllowlist
  // (env-allowlist) here on /api/admin/*, then the route group.
  // Anonymous → 401 from tenantScope (auth gate fires first);
  // non-allowlisted authenticated → 404 from adminAllowlist (NOT 403 —
  // AGENTS.md tenant-scope invariant); allowlisted → adminQuotaRouter
  // handler runs.
  app.use("/api/admin/*", adminAllowlist);
  app.route("/api/admin", adminQuotaRouter);

  return app;
}
