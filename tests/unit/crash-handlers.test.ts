// Process crash-handler tests.
//
// Verifies the log + exit contract of handleUncaught / handleRejection:
// both emit a Pino `fatal` (level 60 → visible to the Grafana error panel)
// and exit(1) so Docker restarts a clean process. The injectable `exit`
// keeps the test from killing the runner.
//
// Pattern (matches admin-middleware.test.ts): seed required env BEFORE the
// dynamic import so env.ts zod parse succeeds and logger.ts initializes.

import { describe, it, expect, vi, afterEach } from "vitest";
import { randomBytes } from "node:crypto";

process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
process.env.BETTER_AUTH_SECRET ??= "x".repeat(40);
process.env.OAUTH_CLIENT_ID ??= "test";
process.env.OAUTH_CLIENT_SECRET ??= "test";
process.env.APP_KEK_BASE64 ??= randomBytes(32).toString("base64");

const { handleUncaught, handleRejection } = await import(
  "../../src/lib/server/crash-handlers.js"
);
const { logger } = await import("../../src/lib/server/logger.js");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("crash handlers", () => {
  it("handleUncaught logs fatal with the error and exits 1", () => {
    const fatal = vi.spyOn(logger, "fatal").mockImplementation(() => {});
    const exit = vi.fn();
    const err = new Error("boom");

    handleUncaught(err, exit);

    expect(fatal).toHaveBeenCalledTimes(1);
    expect(fatal).toHaveBeenCalledWith({ err }, "uncaughtException");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("handleRejection logs fatal with the reason and exits 1", () => {
    const fatal = vi.spyOn(logger, "fatal").mockImplementation(() => {});
    const exit = vi.fn();
    const reason = new Error("rejected");

    handleRejection(reason, exit);

    expect(fatal).toHaveBeenCalledTimes(1);
    expect(fatal).toHaveBeenCalledWith({ err: reason }, "unhandledRejection");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("handleRejection tolerates a non-Error reason (string/undefined)", () => {
    const fatal = vi.spyOn(logger, "fatal").mockImplementation(() => {});
    const exit = vi.fn();

    handleRejection("plain string reason", exit);

    expect(fatal).toHaveBeenCalledWith({ err: "plain string reason" }, "unhandledRejection");
    expect(exit).toHaveBeenCalledWith(1);
  });
});
