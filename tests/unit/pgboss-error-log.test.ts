// pg-boss error-handler log-level classification.
//
// Connection-lifecycle SQLSTATEs (57P01 admin_shutdown / 57P03
// cannot_connect_now) happen on every deploy when the container gets SIGTERM
// and Postgres closes pg-boss's backend. They are NOT application bugs, so
// logPgBossError downgrades them to `warn`; any other pg-boss fault stays at
// `error`. This keeps the Grafana level>=50 panel from flooding on each deploy.

import { describe, it, expect, vi, afterEach } from "vitest";
import { randomBytes } from "node:crypto";

process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
process.env.BETTER_AUTH_SECRET ??= "x".repeat(40);
process.env.OAUTH_CLIENT_ID ??= "test";
process.env.OAUTH_CLIENT_SECRET ??= "test";
process.env.APP_KEK_BASE64 ??= randomBytes(32).toString("base64");

const { logPgBossError } = await import("../../src/lib/server/queue-client.js");
const { logger } = await import("../../src/lib/server/logger.js");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logPgBossError", () => {
  it("downgrades 57P01 (admin_shutdown) to warn, not error", () => {
    const errorLog = vi.spyOn(logger, "error").mockImplementation(() => {});
    const warnLog = vi.spyOn(logger, "warn").mockImplementation(() => {});

    logPgBossError(
      Object.assign(new Error("terminating connection due to administrator command"), {
        code: "57P01",
      }),
    );

    expect(errorLog).not.toHaveBeenCalled();
    expect(warnLog).toHaveBeenCalledTimes(1);
    expect(warnLog.mock.calls[0]![1]).toBe("pg-boss connection terminated (shutdown/restart)");
  });

  it("downgrades 57P03 (cannot_connect_now) to warn", () => {
    const errorLog = vi.spyOn(logger, "error").mockImplementation(() => {});
    const warnLog = vi.spyOn(logger, "warn").mockImplementation(() => {});

    logPgBossError(
      Object.assign(new Error("the database system is shutting down"), {
        code: "57P03",
      }),
    );

    expect(errorLog).not.toHaveBeenCalled();
    expect(warnLog).toHaveBeenCalledTimes(1);
  });

  it("logs a genuine pg-boss fault (other code) at error", () => {
    const errorLog = vi.spyOn(logger, "error").mockImplementation(() => {});
    const warnLog = vi.spyOn(logger, "warn").mockImplementation(() => {});

    logPgBossError(Object.assign(new Error("syntax error"), { code: "42601" }));

    expect(warnLog).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog.mock.calls[0]![1]).toBe("pg-boss error");
  });

  it("logs an error with no SQLSTATE code at error (default)", () => {
    const errorLog = vi.spyOn(logger, "error").mockImplementation(() => {});
    const warnLog = vi.spyOn(logger, "warn").mockImplementation(() => {});

    logPgBossError(new Error("connection reset"));

    expect(warnLog).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledTimes(1);
  });
});
