import { describe, it } from "vitest";

// Phase 02.2 Wave 0 placeholder — closed by Plan 02.2-02 (per-user abuse
// quotas per CONTEXT D-11). Each it.skip name starts with `Plan 02.2-02:` so
// the executor agent for that plan greps + flips to live tests without
// scaffolding rounds.

describe("per-user abuse quotas (Phase 02.2)", () => {
  it.skip("Plan 02.2-02: createGame throws AppError 429 quota_exceeded when active games count >= LIMIT_GAMES_PER_USER", () => {});
  it.skip("Plan 02.2-02: 429 body shape is {error:'quota_exceeded', metadata:{kind:'games', limit:50, current:50}}", () => {});
  it.skip("Plan 02.2-02: createSource throws 429 when active data_sources count >= LIMIT_SOURCES_PER_USER", () => {});
  it.skip("Plan 02.2-02: createEvent throws 429 when rolling-24h event count >= LIMIT_EVENTS_PER_DAY", () => {});
  it.skip("Plan 02.2-02: rolling-24h reset semantics: events older than 24h drop out of the count", () => {});
  it.skip("Plan 02.2-02: soft-deleted games / sources do NOT count toward the limit (deleted_at IS NOT NULL excluded)", () => {});
  it.skip("Plan 02.2-02: quota.limit_hit audit event written with metadata {kind, limit, current} when guard fires", () => {});
});
