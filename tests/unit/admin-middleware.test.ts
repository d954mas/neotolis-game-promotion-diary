// Phase 3.0 Plan 07 — admin middleware live tests (Wave 0 placeholder activated).
//
// Covers the env-allowlist gate's NotFoundError contract:
//   - empty ADMIN_EMAIL_ALLOWLIST → 404 for any authenticated user
//   - allowlisted email → next() called (route reached)
//   - allowlist match is case-insensitive (env reader lowercases at boot)
//   - non-allowlisted email → NotFoundError → 404
//
// 404 not 403: AGENTS.md "Privacy & multi-tenancy" invariant 2 + AP-4. The
// existence of /admin/* must NOT leak to non-allowlisted callers; returning
// 403 would distinguish "you're not in the allowlist" from "this route does
// not exist", which is the leak we explicitly forbid.
//
// Pattern (matches tests/unit/env.test.ts): seed required env BEFORE
// dynamic import; vi.resetModules() between cases so each test sees a fresh
// parse of process.env.

import { describe, it, expect, vi, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { Hono } from "hono";

// Required env values so env.ts zod schema parses on each fresh import.
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
process.env.BETTER_AUTH_SECRET ??= "x".repeat(40);
process.env.OAUTH_CLIENT_ID ??= "test";
process.env.OAUTH_CLIENT_SECRET ??= "test";
process.env.APP_KEK_BASE64 ??= randomBytes(32).toString("base64");

async function buildHarnessApp(opts: {
  allowlist: string;
  userEmail: string | null;
}): Promise<Hono> {
  // Re-parse env.ts with the desired allowlist value.
  const saved: Record<string, string | undefined> = {
    ADMIN_EMAIL_ALLOWLIST: process.env.ADMIN_EMAIL_ALLOWLIST,
  };
  process.env.ADMIN_EMAIL_ALLOWLIST = opts.allowlist;
  vi.resetModules();
  // env.ts scrubs APP_KEK_BASE64 via scrubKekFromEnv on prior boots; re-seed
  // before each fresh import so zod's required-string check passes.
  process.env.APP_KEK_BASE64 ??= randomBytes(32).toString("base64");

  const { adminAllowlist } = await import(
    "../../src/lib/server/http/middleware/admin.js"
  );
  const { NotFoundError } = await import("../../src/lib/server/services/errors.js");

  const app = new Hono();
  // Synthetic tenantScope-equivalent that sets userEmail without going through
  // Better Auth (the unit under test is the allowlist gate; the
  // tenantScope→adminAllowlist composition is exercised in the integration
  // test against the real createApp()).
  app.use("*", async (c, next) => {
    if (opts.userEmail !== null) c.set("userEmail", opts.userEmail);
    return next();
  });
  app.use("*", adminAllowlist);
  app.get("/", (c) => c.json({ ok: true }));
  app.onError((err, c) => {
    if (err instanceof NotFoundError) {
      return c.json({ error: "not_found" }, 404);
    }
    return c.json({ error: "internal_server_error" }, 500);
  });

  // Restore the saved env after the harness's bound import is captured.
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  return app;
}

describe("admin-middleware (Plan 03.0-07)", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("empty ADMIN_EMAIL_ALLOWLIST → 404 for any authenticated user — Plan 03.0-07", async () => {
    const app = await buildHarnessApp({
      allowlist: "",
      userEmail: "anyone@example.com",
    });
    const res = await app.request("/");
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "not_found" });
    // AGENTS.md AP-4: response body MUST NOT leak "forbidden" / "permission".
    const txt = JSON.stringify(body);
    expect(txt).not.toMatch(/forbidden/i);
    expect(txt).not.toMatch(/permission/i);
  });

  it("user email NOT in allowlist → 404 — Plan 03.0-07", async () => {
    const app = await buildHarnessApp({
      allowlist: "admin@example.com",
      userEmail: "other@example.com",
    });
    const res = await app.request("/");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("user email in allowlist (exact match) → calls next() — Plan 03.0-07", async () => {
    const app = await buildHarnessApp({
      allowlist: "admin@example.com",
      userEmail: "admin@example.com",
    });
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("user email in allowlist (case-insensitive — uppercase caller) → calls next() — Plan 03.0-07", async () => {
    // The env reader lowercases entries at boot; the middleware lowercases
    // the caller's email on every request. Mixed-case input on either side
    // resolves to the same key.
    const app = await buildHarnessApp({
      allowlist: "admin@example.com",
      userEmail: "ADMIN@EXAMPLE.COM",
    });
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("user email in allowlist (mixed-case env entry) → calls next() — Plan 03.0-07", async () => {
    // Mirror image of the previous test: the env entry uses mixed case
    // (operator typo in .env) but the reader normalizes at boot.
    const app = await buildHarnessApp({
      allowlist: "Admin@Example.com",
      userEmail: "admin@example.com",
    });
    const res = await app.request("/");
    expect(res.status).toBe(200);
  });

  it("multi-entry allowlist + caller in second slot → calls next() — Plan 03.0-07", async () => {
    const app = await buildHarnessApp({
      allowlist: "first@example.com,second@example.com",
      userEmail: "second@example.com",
    });
    const res = await app.request("/");
    expect(res.status).toBe(200);
  });

  it("missing userEmail (defensive — tenantScope MUST set it) → 404 — Plan 03.0-07", async () => {
    // tenantScope always sets c.var.userEmail before adminAllowlist runs in
    // production (the auth gate fires before the allowlist gate). This test
    // pins the defensive fallback: an undefined userEmail string is treated
    // the same as a non-allowlisted caller (404).
    const app = await buildHarnessApp({
      allowlist: "admin@example.com",
      userEmail: null,
    });
    const res = await app.request("/");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});
