-- Phase 03.0.1 Plan 10 — Add 'source.refresh_content_requested' to audit_action enum.
--
-- Forward-only. Records a new audit verb fired by the
-- POST /api/sources/:id/refresh-content endpoint when a tenant clicks the
-- "Pull new content" button on /sources/[id]. Metadata payload carries
-- { source_id, kind, queue, job_id }. The verb itself is the load-bearing
-- security signal — even if the enqueue races against pg-boss / DB hiccups,
-- the audit row pins "user X requested refresh on source Y at time T" so
-- forensics can reconstruct the click stream.
--
-- ALTER TYPE ADD VALUE is forward-only safe: Postgres requires the new value
-- to be transaction-committed before use, so this migration MUST run in its
-- own file (not bundled with statements that immediately consume the new
-- value). Future migrations CAN read the value freely.
--
-- IF NOT EXISTS makes the migration idempotent across re-runs (Plan 02.1-12
-- precedent — Postgres 12+ supports this syntax for ALTER TYPE).

ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'source.refresh_content_requested';
