import { describe, it, expect } from "vitest";
import { createApp } from "../../src/lib/server/http/app.js";

// Plan 01-07 (Wave 4) — VALIDATION 5/6 (anonymous-401 invariant + no-public-route).
// Revision 1 BLOCKER 2 fix: vacuous-pass guard with MUST_BE_PROTECTED allowlist
// + non-empty assertion. The sweep is COMPLEMENT to (not REPLACEMENT for)
// explicit per-route assertions — if no /api/* routes exist in the future, the
// sweep would silently pass. The allowlist forces it to fail loudly when
// expected routes disappear, and the explicit /api/me checks below assert the
// concrete behavior on the canonical Phase 1 route.
describe("anonymous-401 sweep (PRIV-01, VALIDATION 5/6)", () => {
  const app = createApp();

  // Whitelist of endpoints that are intentionally unauthenticated.
  // /healthz and /readyz are pure liveness — CONTEXT.md deferred section
  // explicitly excludes them from "every endpoint refuses anonymous".
  const PUBLIC_PATHS = ["/healthz", "/readyz"];

  // Auth handler routes are managed by Better Auth and have their own auth model
  // (OAuth callbacks must accept anonymous requests by definition).
  const AUTH_HANDLER_PREFIX = "/api/auth";

  // Hardcoded allowlist: these routes MUST be in the swept set (vacuous-pass guard).
  // The sweep above is a COMPLEMENT to (not a REPLACEMENT for) explicit per-route
  // assertions — if no /api/* routes exist in the future, the sweep would silently
  // pass. The allowlist forces the sweep to fail loudly when expected routes
  // disappear.
  //
  // Plan 02-08 extends MUST_BE_PROTECTED to cover every D-37 Phase 2 route at the
  // PARAMETERIZED level (/api/games/:id, not /api/games/<concrete-id>). The
  // strings here are the literal route patterns Hono registered when sub-routers
  // were mounted — drift between this list and the actual mounts trips the
  // toContain guard below.
  //
  // Plan 02.1-06: REMOVED `/api/youtube-channels*`, `/api/items/youtube*`, and
  // `/api/games/:gameId/youtube-channels*`, `/api/games/:gameId/items`,
  // `/api/games/:gameId/timeline` (their routes are gone — the underlying
  // services were retired in Plans 02.1-04 and 02.1-05). ADDED `/api/sources`,
  // `/api/sources/:id`, `/api/sources/:id/restore`, `/api/events/:id/attach`,
  // `/api/events/:id/dismiss-inbox` (the new unified-events HTTP surface).
  const MUST_BE_PROTECTED = [
    // Phase 1
    "/api/me",
    "/api/me/sessions/all",
    // Phase 2 (Plan 02-08; UX-01)
    "/api/me/theme",
    // Phase 2 — games
    "/api/games",
    "/api/games/:id",
    "/api/games/:id/restore",
    // Phase 2 — game-listings
    "/api/games/:gameId/listings",
    "/api/games/:gameId/listings/:listingId",
    "/api/games/:gameId/listings/:listingId/key",
    // Phase 2 — api keys (steam)
    "/api/api-keys/steam",
    "/api/api-keys/steam/:id",
    // Phase 2.1 — data_sources (replaces Phase 2 /api/youtube-channels*)
    "/api/sources",
    "/api/sources/:id",
    "/api/sources/:id/restore",
    // Phase 2 + 2.1 — events (extended with feed + attach + dismiss-inbox +
    // Plan 02.1-14 gap closure: restore + deleted-list)
    "/api/events",
    "/api/events/deleted",
    "/api/events/:id",
    "/api/events/:id/attach",
    "/api/events/:id/dismiss-inbox",
    "/api/events/:id/restore",
    "/api/games/:gameId/events",
    // Phase 2 — audit
    "/api/audit",
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

  it("VALIDATION 6: no public dashboard / share-link / read-only viewer route exists", async () => {
    // Phase 1 invariant: PRIV-01 — no public routes anywhere (PITFALL P18).
    const routes = (app as unknown as { routes: Array<{ path: string }> }).routes;
    for (const r of routes) {
      // No route may live under '/share', '/public', '/embed'.
      expect(r.path).not.toMatch(/^\/(share|public|embed)\//);
    }
  });

  it('AUTH-01: /api/me with no cookie returns 401 + {error:"unauthorized"} (Pattern 3)', async () => {
    const res = await app.request("/api/me");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "unauthorized" });
  });

  // Plan 02.1-06 — explicit per-route anonymous-401 assertions for the new
  // unified-events HTTP surface. The sweep above is the vacuous-pass guard;
  // these assertions are the load-bearing explicit checks (AGENTS.md Privacy
  // invariant 3 requires both layers).
  it("Plan 02.1-06: anonymous POST /api/sources returns 401 unauthorized", async () => {
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

  it("Plan 02.1-06: anonymous GET /api/sources returns 401 unauthorized", async () => {
    const res = await app.request("/api/sources");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("Plan 02.1-06: anonymous GET /api/sources/:id returns 401 unauthorized", async () => {
    const res = await app.request("/api/sources/fixture-id");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("Plan 02.1-06: anonymous PATCH /api/sources/:id returns 401 unauthorized", async () => {
    const res = await app.request("/api/sources/fixture-id", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ autoImport: false }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("Plan 02.1-06: anonymous DELETE /api/sources/:id returns 401 unauthorized", async () => {
    const res = await app.request("/api/sources/fixture-id", { method: "DELETE" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("Plan 02.1-06: anonymous POST /api/sources/:id/restore returns 401 unauthorized", async () => {
    const res = await app.request("/api/sources/fixture-id/restore", {
      method: "POST",
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("Plan 02.1-06: anonymous GET /api/events (feed) returns 401 unauthorized", async () => {
    const res = await app.request("/api/events");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("Plan 02.1-06: anonymous PATCH /api/events/:id/attach returns 401 unauthorized", async () => {
    const res = await app.request("/api/events/fixture-id/attach", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gameId: null }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("Plan 02.1-06: anonymous PATCH /api/events/:id/dismiss-inbox returns 401 unauthorized", async () => {
    const res = await app.request("/api/events/fixture-id/dismiss-inbox", {
      method: "PATCH",
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("Plan 02.1-14: anonymous GET /api/events/deleted returns 401 unauthorized", async () => {
    const res = await app.request("/api/events/deleted");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("Plan 02.1-14: anonymous PATCH /api/events/:id/restore returns 401 unauthorized", async () => {
    const res = await app.request("/api/events/fixture-id/restore", {
      method: "PATCH",
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
