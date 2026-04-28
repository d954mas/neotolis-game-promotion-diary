import { describe, it } from "vitest";
// Phase 2.1 Wave 0 placeholder — Plan 02.1-04 (services) + Plan 02.1-06 (routes) flip these to live.

describe("SOURCES-01: register data sources via POST /api/sources", () => {
  it.skip("Plan 02.1-06: POST /api/sources kind=youtube_channel returns 201 + DataSourceDto with userId stripped");
  it.skip("Plan 02.1-06: POST /api/sources kind=reddit_account returns 422 'kind_not_yet_functional' with metadata.phase");
  it.skip("Plan 02.1-06: POST /api/sources kind=twitter_account / telegram_channel / discord_server returns 422 'kind_not_yet_functional'");
  it.skip("Plan 02.1-06: POST /api/sources missing handle_url returns 422 'validation_failed'");
  it.skip("Plan 02.1-06: POST /api/sources duplicate (user_id, handle_url) returns 422 'duplicate_source' (translated from PG 23505)");
  it.skip("Plan 02.1-06: POST /api/sources writes audit_action='source.added' with ipAddress + userAgent");
  it.skip("Plan 02.1-06: GET /api/sources returns user's active (non-soft-deleted) sources only");
  it.skip("Plan 02.1-06: GET /api/sources/:id returns 404 not_found for cross-tenant id (NotFoundError → 404, never 403)");
});

describe("SOURCES-02: soft-delete + retention + auto_import toggle + audit", () => {
  it.skip("Plan 02.1-06: DELETE /api/sources/:id sets deleted_at, returns 200 with retention badge fields");
  it.skip("Plan 02.1-06: DELETE /api/sources/:id second call (already-deleted) returns 404 not_found");
  it.skip("Plan 02.1-06: PATCH /api/sources/:id/restore clears deleted_at when within RETENTION_DAYS window");
  it.skip("Plan 02.1-06: PATCH /api/sources/:id { autoImport: false } toggles + writes audit_action='source.toggled_auto_import'");
  it.skip("Plan 02.1-06: DELETE writes audit_action='source.removed' BEFORE the soft-delete update (D-32 forensics order)");
  it.skip("Plan 02.1-06: cross-tenant DELETE returns 404 not_found (NotFoundError)");
  it.skip("Plan 02.1-06: events with source_id pointing at a soft-deleted data_source are NOT cascaded — they keep source_id; /feed source-filter chip dropdown excludes the deleted source (per Pitfall 5)");
});
