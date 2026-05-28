// Hono global error-handler test.
//
// honoErrorHandler is wired via app.onError in app.ts. Verifies that a
// throw escaping a route handler is (1) logged via Pino as level 50 and
// (2) returned to the client as the uniform {error:'internal_server_error'}
// 500 envelope — same shape mapErr produces, so the wire contract is
// identical whether an error was caught per-route or escaped to the global
// handler.

import { describe, it, expect, vi, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { Hono } from "hono";

process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
process.env.BETTER_AUTH_SECRET ??= "x".repeat(40);
process.env.OAUTH_CLIENT_ID ??= "test";
process.env.OAUTH_CLIENT_SECRET ??= "test";
process.env.APP_KEK_BASE64 ??= randomBytes(32).toString("base64");

const { honoErrorHandler } = await import("../../src/lib/server/http/routes/_shared.js");
const { logger } = await import("../../src/lib/server/logger.js");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("honoErrorHandler (app.onError)", () => {
  it("logs the escaped error and returns a 500 internal_server_error envelope", async () => {
    const errorLog = vi.spyOn(logger, "error").mockImplementation(() => {});

    const app = new Hono();
    app.onError(honoErrorHandler);
    app.get("/boom", () => {
      throw new Error("kaboom");
    });

    const res = await app.request("/boom");

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_server_error" });
    expect(errorLog).toHaveBeenCalledTimes(1);
    const call = errorLog.mock.calls[0]!;
    const payload = call[0] as { path: string; method: string; err: unknown };
    expect(call[1]).toBe("unhandled hono error");
    expect(payload).toMatchObject({ path: "/boom", method: "GET" });
    expect(payload.err).toBeInstanceOf(Error);
  });
});
