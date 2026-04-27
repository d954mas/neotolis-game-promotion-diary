import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";

// Seed env BEFORE importing the module under test (matches the established
// unit-test pattern in tests/unit/proxy-trust.test.ts). audit.ts has a
// value-import on `db` from db/client.js, which loads env.ts at module
// init — so unit tests must hand it a complete, well-formed env shape.
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
process.env.BETTER_AUTH_SECRET ??= "x".repeat(40);
process.env.OAUTH_CLIENT_ID ??= "test";
process.env.OAUTH_CLIENT_SECRET ??= "test";
process.env.APP_KEK_BASE64 ??= randomBytes(32).toString("base64");

const auditModule = await import("../../src/lib/server/audit.js");

/**
 * Audit module export-shape invariant (PITFALL P19).
 *
 * `src/lib/server/audit.ts` is INSERT-only by design: it exports `writeAudit`
 * and the `AuditEntry` interface, NOTHING ELSE. A future plan that
 * accidentally adds an `updateAudit` / `deleteAudit` / `purgeAudit` /
 * `clearAudit` / `removeAudit` / `setAction` / `amendAudit` export trips
 * this test loudly — the structural assertion is intentionally broad so
 * verb-shape drift (whatever an attacker thought to add) gets caught.
 *
 * Wave 0 placeholder names PRESERVED (`02-08: writeAudit module exports no
 * update path` / `02-08: writeAudit module exports no delete path`) — the
 * `02-08:` annotation is intentional (Plan 08 surfaces audit at the route
 * layer; the invariant is plan-08 scoped). Plan 02-07 lights it up early
 * because the test depends ONLY on audit.ts (Phase 1) — no need to wait.
 */
describe("audit module export shape (P19)", () => {
  it("02-08: writeAudit module exports no update path", () => {
    const keys = Object.keys(auditModule);
    for (const k of keys) {
      expect(k).not.toMatch(/^update/i);
      expect(k).not.toMatch(/setAction|setIp|amend|patch|edit/i);
    }
  });

  it("02-08: writeAudit module exports no delete path", () => {
    const keys = Object.keys(auditModule);
    for (const k of keys) {
      expect(k).not.toMatch(/^delete/i);
      expect(k).not.toMatch(/^purge/i);
      expect(k).not.toMatch(/^clear/i);
      expect(k).not.toMatch(/^remove/i);
    }
  });
});
