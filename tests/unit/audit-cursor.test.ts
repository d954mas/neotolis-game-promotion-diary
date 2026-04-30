import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";

// Seed env BEFORE importing the module under test (matches the established
// unit-test pattern in tests/unit/proxy-trust.test.ts). audit-read.ts has a
// value-import on `db` from db/client.js, which loads env.ts at module
// init — so unit tests must hand it a complete, well-formed env shape.
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
process.env.BETTER_AUTH_SECRET ??= "x".repeat(40);
process.env.OAUTH_CLIENT_ID ??= "test";
process.env.OAUTH_CLIENT_SECRET ??= "test";
process.env.APP_KEK_BASE64 ??= randomBytes(32).toString("base64");

const { encodeCursor, decodeCursor } = await import("../../src/lib/server/services/audit-read.js");
const { AppError } = await import("../../src/lib/server/services/errors.js");

/**
 * Plan 02-07 — cursor encode/decode unit tests (D-31 cursor format).
 *
 * Wave 0 placeholder names PRESERVED (`02-07: encodeCursor + decodeCursor
 * round-trip` and `02-07: cursor decode rejects malformed input`) so the
 * Nyquist invariant holds — every later task ships into a test that already
 * exists.
 */
describe("audit cursor encode/decode", () => {
  it("02-07: encodeCursor + decodeCursor round-trip", () => {
    // Non-zero millisecond fraction guards against truncation in the
    // ISO/Date conversion — toISOString() preserves ms; new Date(ISO)
    // restores ms.
    const at = new Date("2026-04-27T18:30:00.123Z");
    const id = "01923456-7890-7abc-def0-123456789012";
    const c = encodeCursor(at, id);
    const decoded = decodeCursor(c);
    expect(decoded.at.toISOString()).toBe(at.toISOString());
    expect(decoded.id).toBe(id);
  });

  it("02-07: cursor decode rejects malformed input", () => {
    // Three malformed shapes: not base64url, valid base64url of `{}` (no
    // fields), and JSON with only `at`. All must throw AppError 422 so the
    // route layer (Plan 02-08) can map cleanly to invalid_cursor.
    expect(() => decodeCursor("not-base64!@#$")).toThrow(AppError);
    expect(() => decodeCursor(Buffer.from("{}").toString("base64url"))).toThrow(AppError);
    expect(() => decodeCursor(Buffer.from('{"at":"x"}').toString("base64url"))).toThrow(AppError);
  });
});
