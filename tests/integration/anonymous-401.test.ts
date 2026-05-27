import { describe, it, expect } from "vitest";
import { createApp } from "../../src/lib/server/http/app.js";

// Anonymous-401 invariant + no-public-route.
// Vacuous-pass guard with MUST_BE_PROTECTED allowlist + non-empty
// assertion. The sweep is COMPLEMENT to (not REPLACEMENT for) explicit
// per-route assertions — if no /api/* routes exist in the future, the
// sweep would silently pass. The allowlist forces it to fail loudly when
// expected routes disappear, and the explicit /api/me checks below assert
// the concrete behavior on the canonical route.
describe("anonymous-401 sweep", () => {
  const app = createApp();

  // Whitelist of endpoints that are intentionally unauthenticated.
  // /healthz and /readyz are pure liveness — excluded from "every
  // endpoint refuses anonymous".
  const PUBLIC_PATHS = ["/healthz", "/readyz", "/metrics"];

  // Auth handler routes are managed by Better Auth and have their own auth model
  // (OAuth callbacks must accept anonymous requests by definition).
  const AUTH_HANDLER_PREFIX = "/api/auth";

  // Hardcoded allowlist: these routes MUST be in the swept set (vacuous-pass guard).
  // The sweep above is a COMPLEMENT to (not a REPLACEMENT for) explicit per-route
  // assertions — if no /api/* routes exist in the future, the sweep would silently
  // pass. The allowlist forces the sweep to fail loudly when expected routes
  // disappear.
  //
  // MUST_BE_PROTECTED covers every route at the PARAMETERIZED level
  // (/api/games/:id, not /api/games/<concrete-id>). The strings here are
  // the literal route patterns Hono registers when sub-routers are
  // mounted — drift between this list and the actual mounts trips the
  // toContain guard below.
  const MUST_BE_PROTECTED = [
    // session
    "/api/me",
    "/api/me/sessions/all",
    "/api/me/theme",
    // games
    "/api/games",
    "/api/games/:id",
    "/api/games/:id/restore",
    // game-listings
    "/api/games/:gameId/listings",
    "/api/games/:gameId/listings/:listingId",
    "/api/games/:gameId/listings/:listingId/key",
    // per-game listing restore — same shape as /api/sources/:id/restore.
    "/api/games/:gameId/listings/:listingId/restore",
    // api keys (steam)
    "/api/api-keys/steam",
    "/api/api-keys/steam/:id",
    // data_sources
    "/api/sources",
    "/api/sources/:id",
    "/api/sources/:id/restore",
    // refresh-content endpoint ("Pull new content" button on
    // /sources/[id]). Dispatches via registry to per-kind
    // backfillSource; YouTube enqueues into youtube.backfill.channel.
    "/api/sources/:id/refresh-content",
    // events
    "/api/events",
    "/api/events/deleted",
    "/api/events/preview-url",
    "/api/events/:id",
    "/api/events/:id/attach",
    "/api/events/:id/dismiss-inbox",
    "/api/events/:id/restore",
    "/api/games/:gameId/events",
    // audit
    "/api/audit",
    // account export / soft-delete / restore. The string list here is
    // the path-only pattern Hono registers when mounting the sub-router;
    // the per-route 401 assertions below cover the method-specific
    // behaviour.
    "/api/me/export",
    "/api/me/account",
    "/api/me/account/restore",
    // refresh-poll + account/purge:
    "/api/events/:id/refresh-poll",
    "/api/me/account/purge",
    // admin /quota route mounted under /api/admin/* (env-allowlist
    // gated; auth gate fires first so anonymous → 401 before allowlist
    // sees it).
    "/api/admin/quota",
    // /events/new "Get from YouTube" button calls this. Authenticated
    // only; anonymous → 401 from tenantScope before the videos.list
    // lookup ever fires.
    "/api/youtube/fetch-metadata",
    // /events/new "Get from Reddit" button (same pattern as YouTube
    // above). Phase 03.1 adapter.registerRoutes mounts this; the
    // tenantScope middleware fires before redditFetch ever reaches
    // the Reddit servers, so anonymous probes never burn a unit.
    "/api/reddit/fetch-metadata",
    // Phase 3.4 design-v2-ux — bulk endpoints (PATCH + DELETE on the
    // same /api/events/bulk path). Wave 2 Plan 06 mounted the Hono
    // route; the path participates in the load-bearing toContain guard
    // below and in the per-method explicit anonymous-401 assertions at
    // the bottom of this file.
    "/api/events/bulk",
  ];

  it("every /api/* route except /api/auth/* refuses anonymous with 401", async () => {
    // Hono exposes app.routes (array of {path, method, handler}).
    const routes = (app as unknown as { routes: Array<{ path: string; method: string }> }).routes;
    const protectedRoutes = routes.filter((r) => {
      if (!r.path.startsWith("/api/")) return false;
      if (r.path.startsWith(AUTH_HANDLER_PREFIX)) return false;
      if (PUBLIC_PATHS.some((p) => r.path === p)) return false;
      return true;
    });
    const protectedPaths = protectedRoutes.map((r) => r.path);

    // Vacuous-pass guard 1: must contain every allowlisted route.
    for (const required of MUST_BE_PROTECTED) {
      expect(protectedPaths).toContain(required);
    }
    // Vacuous-pass guard 2: must be non-empty.
    expect(protectedRoutes.length).toBeGreaterThanOrEqual(1);

    for (const r of protectedRoutes) {
      // Substitute :param placeholders with sentinel value.
      const path = r.path.replace(/:[A-Za-z_]+/g, "fixture-id");
      const method = r.method === "ALL" ? "GET" : r.method;
      const res = await app.request(path, { method });
      expect.soft(res.status, `${method} ${path} should be 401`).toBe(401);
    }
  });

  it("no public dashboard / share-link / read-only viewer route exists", async () => {
    // Invariant: no public routes anywhere.
    const routes = (app as unknown as { routes: Array<{ path: string }> }).routes;
    for (const r of routes) {
      // No route may live under '/share', '/public', '/embed'.
      expect(r.path).not.toMatch(/^\/(share|public|embed)\//);
    }
  });

  it('AUTH-01: /api/me with no cookie returns 401 + {error:"unauthorized"}', async () => {
    const res = await app.request("/api/me");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "unauthorized" });
  });

  // Explicit per-route anonymous-401 assertions for the unified-events
  // HTTP surface. The sweep above is the vacuous-pass guard; these
  // assertions are the load-bearing explicit checks (AGENTS.md Privacy
  // invariant 3 requires both layers).
  it("anonymous POST /api/sources returns 401 unauthorized", async () => {
    const res = await app.request("/api/sources", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "youtube_channel",
        handleUrl: "https://www.youtube.com/@x",
      }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("anonymous GET /api/sources returns 401 unauthorized", async () => {
    const res = await app.request("/api/sources");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("anonymous GET /api/sources/:id returns 401 unauthorized", async () => {
    const res = await app.request("/api/sources/fixture-id");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("anonymous PATCH /api/sources/:id returns 401 unauthorized", async () => {
    const res = await app.request("/api/sources/fixture-id", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ autoImport: false }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("anonymous DELETE /api/sources/:id returns 401 unauthorized", async () => {
    const res = await app.request("/api/sources/fixture-id", { method: "DELETE" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("anonymous POST /api/sources/:id/restore returns 401 unauthorized", async () => {
    const res = await app.request("/api/sources/fixture-id/restore", {
      method: "POST",
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("anonymous POST /api/sources/:id/refresh-content returns 401 unauthorized", async () => {
    const res = await app.request("/api/sources/fixture-id/refresh-content", {
      method: "POST",
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("anonymous GET /api/events (feed) returns 401 unauthorized", async () => {
    const res = await app.request("/api/events");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("anonymous PATCH /api/events/:id/attach returns 401 unauthorized", async () => {
    const res = await app.request("/api/events/fixture-id/attach", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gameId: null }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("anonymous PATCH /api/events/:id/dismiss-inbox returns 401 unauthorized", async () => {
    const res = await app.request("/api/events/fixture-id/dismiss-inbox", {
      method: "PATCH",
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("anonymous GET /api/events/deleted returns 401 unauthorized", async () => {
    const res = await app.request("/api/events/deleted");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("anonymous PATCH /api/events/:id/restore returns 401 unauthorized", async () => {
    const res = await app.request("/api/events/fixture-id/restore", {
      method: "PATCH",
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  // Explicit per-route anonymous-401 assertions for the /api/me/*
  // account-export-delete-restore surface (AGENTS.md §3 — vacuous-pass
  // sweep + explicit per-route assertions, both layers required).
  it("anonymous GET /api/me/export returns 401 unauthorized", async () => {
    const res = await app.request("/api/me/export");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("anonymous DELETE /api/me/account returns 401 unauthorized", async () => {
    const res = await app.request("/api/me/account", { method: "DELETE" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("anonymous POST /api/me/account/restore returns 401 unauthorized", async () => {
    const res = await app.request("/api/me/account/restore", { method: "POST" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  // Refresh-poll + account/purge anonymous-401 assertions. The
  // vacuous-pass sweep above carries the bulk of the contract via the
  // MUST_BE_PROTECTED allowlist; these explicit assertions are the
  // load-bearing per-route checks (AGENTS.md §3 — both layers required).
  it("anonymous POST /api/events/:id/refresh-poll returns 401 unauthorized", async () => {
    const res = await app.request("/api/events/fixture-id/refresh-poll", {
      method: "POST",
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("anonymous DELETE /api/me/account/purge returns 401 unauthorized", async () => {
    const res = await app.request("/api/me/account/purge", { method: "DELETE" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  // Admin-quota anonymous-401. The auth gate (tenantScope mounted on
  // /api/* globally) fires BEFORE the allowlist gate (adminAllowlist
  // mounted on /api/admin/*), so an anonymous request gets 401 from
  // tenantScope and never reaches the allowlist check. The sweep above
  // also covers the path; this explicit assertion is the load-bearing
  // per-route check (AGENTS.md §3 both layers).
  it("anonymous GET /api/admin/quota returns 401 (auth gate fires before allowlist gate)", async () => {
    const res = await app.request("/api/admin/quota");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  // Phase 3.4 design-v2-ux — bulk endpoints anonymous-401.
  //
  // Wave 2 Plan 06 mounted /api/events/bulk (PATCH + DELETE +
  // DELETE?force=true). The auth gate (tenantScope on /api/*) fires before
  // the route handler ever sees the body, so anonymous probes return 401
  // before any validator or service code runs. The
  // MUST_BE_PROTECTED entry above carries the load-bearing toContain
  // guard; these explicit per-method checks are the second layer.
  it("anonymous PATCH /api/events/bulk returns 401 unauthorized", async () => {
    const res = await app.request("/api/events/bulk", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: ["ev_anon"], gameStates: {}, offTopicState: "mixed" }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "unauthorized" });
  });

  it("anonymous DELETE /api/events/bulk returns 401 unauthorized", async () => {
    const res = await app.request("/api/events/bulk", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: ["ev_anon"] }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "unauthorized" });
  });

  it("anonymous DELETE /api/events/bulk?force=true returns 401 unauthorized", async () => {
    const res = await app.request("/api/events/bulk?force=true", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: ["ev_anon"] }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "unauthorized" });
  });

  // /api/youtube/fetch-metadata gate.
  // Powers the "Get from YouTube" button on /events/new; tenantScope
  // must refuse anonymous BEFORE the videos.list lookup ever fires.
  it("anonymous POST /api/youtube/fetch-metadata returns 401 unauthorized", async () => {
    const res = await app.request("/api/youtube/fetch-metadata", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://www.youtube.com/watch?v=jNQXAC9IVRw" }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("AUTH-01: /api/me with valid session returns 200 + UserDto", async () => {
    const { seedUserDirectly } = await import("./helpers.js");
    const seeded = await seedUserDirectly({ email: "priv@test.local", name: "Priv Tester" });
    const res = await app.request("/api/me", {
      headers: { cookie: `neotolis.session_token=${seeded.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe(seeded.id);
    expect(body.email).toBe("priv@test.local");
    expect(body.name).toBe("Priv Tester");
    // P3: DTO must NOT contain provider tokens or google_sub.
    expect(body).not.toHaveProperty("googleSub");
    expect(body).not.toHaveProperty("refreshToken");
    expect(body).not.toHaveProperty("accessToken");
    expect(body).not.toHaveProperty("idToken");
  });
});
