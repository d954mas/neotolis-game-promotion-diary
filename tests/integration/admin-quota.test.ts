// Phase 3.0 Wave 0 placeholder — assertions activate in Plan 03.0-07.
// GET /api/admin/quota returns today's per-key quota usage rows + the
// last 50 service-level audit entries (cross-tenant; this is the ONE
// place admins can see operator-wide signal — the rest of the app is
// tenant-scoped by construction). Empty ADMIN_EMAIL_ALLOWLIST or
// non-allowlisted user → 404 not 403 (CLAUDE.md §Privacy invariant 2:
// even the existence of /admin/* must not leak to non-admins).
import { describe, it } from "vitest";

describe("admin /quota route (Plan 03.0-07)", () => {
  it.skip("GET /api/admin/quota with empty ADMIN_EMAIL_ALLOWLIST → 404 — activated in Plan 03.0-07", () => {});
  it.skip("GET /api/admin/quota with allowlisted user → 200 + today's quota rows + last 50 audit entries — activated in Plan 03.0-07", () => {});
  it.skip("GET /api/admin/quota with non-allowlisted user → 404 — activated in Plan 03.0-07", () => {});
  it.skip("anonymous → 401 — activated in Plan 03.0-07", () => {});
});
