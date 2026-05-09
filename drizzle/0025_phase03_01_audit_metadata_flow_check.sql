-- Phase 03.0.1 (post-review Issue 5) — defense-in-depth CHECK constraint
-- pinning audit_log.metadata->>'flow' to the AuditFlow enum defined in
-- src/lib/server/audit.ts. TypeScript catches typos at compile time; this
-- constraint catches them at INSERT time (defends against raw SQL writes
-- and accidental drift if AuditMetadata.[extra] index signature is abused).
--
-- Allowed values match `type AuditFlow` in audit.ts:
--   'initial'        — onboarding channel-context-backfill
--   'incremental'    — default refresh-content (catch-up newer events)
--   'historical'    — refresh-content with explicit older boundary
--   'stats_refresh'  — refresh-poll endpoint (Refresh now button)
--   'auto_passive'   — daily auto-backfill cron pick
--
-- Rows without a `flow` key (the vast majority — Phase 02.x audit verbs:
-- session.signin, event.created, etc.) pass the constraint regardless,
-- because the predicate only fires on rows that explicitly set `flow`.
--
-- Adding a new flow value requires updating BOTH:
--   1. AuditFlow union in src/lib/server/audit.ts
--   2. The IN (...) list below — with a new migration that DROP+ADD the
--      constraint (PostgreSQL has no "edit constraint" syntax).
ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_metadata_flow_valid CHECK (
    metadata IS NULL
    OR NOT (metadata ? 'flow')
    OR metadata->>'flow' IN ('initial','incremental','historical','stats_refresh','auto_passive')
  );
