import { describe, it } from "vitest";

describe("POST /api/sources/:id/refresh-content — Phase 03.0.1 D-NEW (Wave 0 scaffold; Plan 10 flips live)", () => {
  it.skip("authenticated + own source returns 202 with body { enqueued: true, queue: 'youtube.backfill.user', jobId: <string|null> } — flips live in Plan 10");
  it.skip("anonymous returns 401 (anonymous-401 sweep + per-route assertion) — flips live in Plan 10");
  it.skip("authenticated + cross-tenant source returns 404 with body NOT containing 'forbidden' or 'permission' (PRIV-01 / AGENTS.md invariant 2) — flips live in Plan 10");
  it.skip("authenticated + non-existent source id returns 404 — flips live in Plan 10");
  it.skip("authenticated + soft-deleted source returns 404 — flips live in Plan 10");
  it.skip("authenticated + unsupported source kind (reddit_account placeholder) returns 422 — flips live in Plan 10 (note: reddit_account adapter doesn't exist in 03.0.1)");
  it.skip("audit log records 'source.refresh_content_requested' with metadata.source_id, metadata.kind, metadata.queue, metadata.job_id — flips live in Plan 10");
});
