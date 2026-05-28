// SvelteKit handleError hook test.
//
// handleError fires for UNEXPECTED server-render/load errors (5xx). Verifies
// it logs via Pino (level 50 → visible to the Grafana error panel) with
// path/method/status context, and returns the safe client payload (no stack
// leak — Pino captured it, redacted).

import { describe, it, expect, vi, afterEach } from "vitest";
import { randomBytes } from "node:crypto";

process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
process.env.BETTER_AUTH_SECRET ??= "x".repeat(40);
process.env.OAUTH_CLIENT_ID ??= "test";
process.env.OAUTH_CLIENT_SECRET ??= "test";
process.env.APP_KEK_BASE64 ??= randomBytes(32).toString("base64");

const { handleError } = await import("../../src/hooks.server.js");
const { logger } = await import("../../src/lib/server/logger.js");

afterEach(() => {
  vi.restoreAllMocks();
});

function fakeEvent(pathname: string, method: string) {
  return {
    url: new URL(`http://localhost${pathname}`),
    request: new Request(`http://localhost${pathname}`, { method }),
  };
}

describe("handleError (SvelteKit)", () => {
  it("logs the render error with context and returns a safe message", () => {
    const errorLog = vi.spyOn(logger, "error").mockImplementation(() => {});
    const error = new Error("loader exploded");

    // @ts-expect-error — synthetic event carries only the fields handleError reads.
    const result = handleError({ error, event: fakeEvent("/feed", "GET"), status: 500, message: "Internal Error" });

    expect(result).toEqual({ message: "Internal Error" });
    expect(errorLog).toHaveBeenCalledTimes(1);
    const call = errorLog.mock.calls[0]!;
    const payload = call[0] as { status: number; path: string; method: string; err: unknown };
    expect(call[1]).toBe("sveltekit unhandled error");
    expect(payload).toMatchObject({ status: 500, path: "/feed", method: "GET" });
    expect(payload.err).toBe(error);
  });
});
