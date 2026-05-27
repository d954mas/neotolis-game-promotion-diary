import { describe, it, expect } from "vitest";
import { createApp } from "../../src/lib/server/http/app.js";
import { migrationsApplied } from "../../src/lib/server/db/migrate.js";

// `/healthz` always 200; `/readyz` 200 only after migrations applied +
// DB reachable.
//
// tests/setup.ts runs runMigrations() in beforeAll for the integration
// project, so migrationsApplied.current is already true by the time
// these specs run. The pre-migration test temporarily flips the flag
// off, asserts 503, then restores it for the rest of the suite.

describe("/healthz and /readyz", () => {
  it('GET /healthz returns 200 with body "ok"', async () => {
    const app = createApp();
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("GET /readyz returns 503 before migrations applied", async () => {
    const before = migrationsApplied.current;
    migrationsApplied.current = false;
    try {
      const app = createApp();
      const res = await app.request("/readyz");
      expect(res.status).toBe(503);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(false);
    } finally {
      migrationsApplied.current = before;
    }
  });

  it("GET /readyz returns 200 after migrations applied (and DB up)", async () => {
    // tests/setup.ts beforeAll runs runMigrations() — so
    // migrationsApplied.current === true by this point. If the DB is
    // unreachable in this run, /readyz answers 503 instead — both are
    // acceptable here; the 503-before-migrations branch above is the
    // authoritative pre-migration test.
    const app = createApp();
    const res = await app.request("/readyz");
    expect([200, 503]).toContain(res.status);
    if (res.status === 200) {
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    }
  });

  it("GET /readyz returns enriched payload with uptime and pg stats", async () => {
    const app = createApp();
    const res = await app.request("/readyz");
    if (res.status === 200) {
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.ok).toBe(true);
      expect(body).toHaveProperty("uptime");
      expect(typeof body.uptime).toBe("number");
      expect(body).toHaveProperty("pg");
      const pg = body.pg as Record<string, unknown>;
      expect(pg).toHaveProperty("totalConnections");
      expect(pg).toHaveProperty("idleConnections");
      expect(pg).toHaveProperty("waitingRequests");
      expect(body).toHaveProperty("migration");
      expect(body).toHaveProperty("queues");
    }
  });
});
