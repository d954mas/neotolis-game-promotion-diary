import { describe, it } from "vitest";

// Phase 02.2 Wave 0 placeholder — closed by Plan 02.2-03 (in-app account
// export / soft-delete / restore per CONTEXT D-16). Each it.skip name starts
// with `Plan 02.2-03:` so the executor agent for that plan greps + flips to
// live tests without scaffolding rounds.
//
// Cross-tenant invariant for these routes lives in
// tests/integration/tenant-scope.test.ts (separate placeholder block) per
// AGENTS.md §2 (the cross-tenant 404 contract is centralised, not duplicated
// per route file).

describe("account export / soft-delete / restore (Phase 02.2)", () => {
  it.skip("Plan 02.2-03: GET /api/me/export returns JSON envelope with all 7 documented top-level keys", () => {});
  it.skip("Plan 02.2-03: GET /api/me/export sends Content-Disposition attachment with diary-export-YYYY-MM-DD.json filename", () => {});
  it.skip("Plan 02.2-03: GET /api/me/export envelope strips ciphertext columns (no secret_ct, wrapped_dek, kek_version, googleSub, refresh_token)", () => {});
  it.skip("Plan 02.2-03: GET /api/me/export writes account.exported audit event", () => {});
  it.skip("Plan 02.2-03: DELETE /api/me/account soft-cascades to games, game_steam_listings, data_sources, events, api_keys_steam (NOT audit_log)", () => {});
  it.skip("Plan 02.2-03: DELETE /api/me/account hard-deletes all session rows for that user", () => {});
  it.skip("Plan 02.2-03: DELETE /api/me/account writes account.deleted audit event with retentionDays metadata", () => {});
  it.skip("Plan 02.2-03: POST /api/me/account/restore reverses ONLY children whose deleted_at === user.deleted_at", () => {});
  it.skip("Plan 02.2-03: POST /api/me/account/restore writes account.restored audit event", () => {});
  it.skip("Plan 02.2-03: POST /api/me/account/restore returns 410 Gone when called past RETENTION_DAYS", () => {});
  it.skip("Plan 02.2-03: cross-tenant: User A's export does not contain User B's rows", () => {});
});
