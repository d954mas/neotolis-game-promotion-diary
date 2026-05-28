// SvelteKit handleError hook test.
//
// handleError fires for unexpected 5xx throws AND unmatched-route 404s.
// Verifies the three branches:
//   - status >= 500 → logged at error (level 50 → Grafana error panel) with
//     the err object; returns the safe client payload (stack stays in Pino).
//   - scanner/external-referer 404 → NOT logged (keeps the error panel clean).
//   - internal-referer 404 → logged at warn (broken link), referer PATH only
//     (query string stripped — no private filter state leaks).

import { describe, it, expect, vi, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { RequestEvent } from "@sveltejs/kit";

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

// handleError only reads event.url.{origin,pathname} and event.request
// (method + Referer header); the rest of RequestEvent is irrelevant here, so
// cast a minimal synthetic event rather than fabricate cookies/locals/fetch.
// A typed cast (rather than a suppression directive) keeps the typing robust
// against formatter reflows. `referer` simulates the incoming Referer header.
function fakeEvent(pathname: string, method: string, referer?: string): RequestEvent {
  const headers = new Headers();
  if (referer) headers.set("referer", referer);
  return {
    url: new URL(`http://localhost${pathname}`),
    request: new Request(`http://localhost${pathname}`, { method, headers }),
  } as unknown as RequestEvent;
}

describe("handleError (SvelteKit)", () => {
  it("logs a 500 unexpected crash at error level with context", () => {
    const errorLog = vi.spyOn(logger, "error").mockImplementation(() => {});
    const error = new Error("loader exploded");

    const result = handleError({
      error,
      event: fakeEvent("/feed", "GET"),
      status: 500,
      message: "Internal Error",
    });

    expect(result).toEqual({ message: "Internal Error" });
    expect(errorLog).toHaveBeenCalledTimes(1);
    const call = errorLog.mock.calls[0]!;
    const payload = call[0] as { status: number; path: string; method: string; err: unknown };
    expect(call[1]).toBe("sveltekit unhandled error");
    expect(payload).toMatchObject({ status: 500, path: "/feed", method: "GET" });
    expect(payload.err).toBe(error);
  });

  it("does NOT log a scanner 404 (no/external referer) — keeps the error panel clean", () => {
    const errorLog = vi.spyOn(logger, "error").mockImplementation(() => {});
    const warnLog = vi.spyOn(logger, "warn").mockImplementation(() => {});

    // No referer (typical scanner probe).
    handleError({
      error: new Error("Not found: /wp-admin/install.php"),
      event: fakeEvent("/wp-admin/install.php", "GET"),
      status: 404,
      message: "Not Found",
    });
    // External referer must also be treated as not-ours.
    handleError({
      error: new Error("Not found: /wp-login.php"),
      event: fakeEvent("/wp-login.php", "GET", "https://evil.example.com/scan"),
      status: 404,
      message: "Not Found",
    });
    // Same host but DIFFERENT scheme/port than the canonical origin
    // (BETTER_AUTH_URL=http://localhost:3000) is NOT internal — guards the
    // scheme/port-sensitivity of the origin comparison.
    handleError({
      error: new Error("Not found: /x"),
      event: fakeEvent("/x", "GET", "https://localhost:3000/feed"),
      status: 404,
      message: "Not Found",
    });

    expect(errorLog).not.toHaveBeenCalled();
    expect(warnLog).not.toHaveBeenCalled();
  });

  it("logs an internal-referer 404 at warn (broken link), with referer PATH only", () => {
    const errorLog = vi.spyOn(logger, "error").mockImplementation(() => {});
    const warnLog = vi.spyOn(logger, "warn").mockImplementation(() => {});

    handleError({
      error: new Error("Not found: /feeed"),
      // Referer is our own canonical origin (BETTER_AUTH_URL=http://localhost:3000),
      // with a query string that must NOT be logged.
      event: fakeEvent("/feeed", "GET", "http://localhost:3000/feed?filter=secret"),
      status: 404,
      message: "Not Found",
    });

    expect(errorLog).not.toHaveBeenCalled();
    expect(warnLog).toHaveBeenCalledTimes(1);
    const call = warnLog.mock.calls[0]!;
    const payload = call[0] as { status: number; path: string; referer: string };
    expect(call[1]).toBe("internal 404 (broken link)");
    expect(payload).toMatchObject({ status: 404, path: "/feeed", referer: "/feed" });
    // The referer query string is dropped — no private filter state leaks.
    expect(payload.referer).not.toContain("secret");
  });
});
