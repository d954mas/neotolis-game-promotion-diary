// Phase 3.0 Wave 0 placeholder — assertions activate in Plan 03.0-07.
// admin middleware is an env-allowlist gate that returns NotFoundError
// (404) for any non-allowlisted user — including unauthenticated callers
// who passed the auth gate (impossible by construction, but the test
// pins the contract). 404 not 403 because /admin/* leaking even its
// existence to non-allowlisted tenants is a privacy floor violation.
import { describe, it } from "vitest";

describe("admin-middleware (Plan 03.0-07)", () => {
  it.skip("empty ADMIN_EMAIL_ALLOWLIST → throws NotFoundError for any user — activated in Plan 03.0-07", () => {});
  it.skip("user email NOT in allowlist → throws NotFoundError — activated in Plan 03.0-07", () => {});
  it.skip("user email in allowlist (case-insensitive) → calls next() — activated in Plan 03.0-07", () => {});
});
