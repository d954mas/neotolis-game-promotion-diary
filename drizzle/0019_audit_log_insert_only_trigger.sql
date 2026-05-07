-- Phase 3.0 post-build review (2026-05-07) — enforce AGENTS.md §4
-- "audit_log is INSERT-only" structurally at the DB layer.
--
-- Background: AGENTS.md §4 declares that the application database role
-- MUST NOT have UPDATE / DELETE grants on audit_log. Until this migration
-- the invariant was only programmatic (src/lib/server/audit.ts exports
-- only writeAudit; no update / delete path exists). A future bug could
-- bypass that — Drizzle / TypeScript / ESLint do not catch a stray
-- `db.delete(auditLog)...`, and the row would silently disappear.
--
-- A plain REVOKE UPDATE, DELETE ON audit_log FROM <role> would be a
-- no-op in our deployment: the connecting role IS the table owner
-- (docker-compose.prod.yml + selfhost.yml both run as POSTGRES_USER=postgres,
-- which is also the migration runner that created the schema). Postgres
-- rule: an owner has implicit privileges that cannot be revoked. Only
-- splitting into a separate non-owner app role would make REVOKE bite —
-- a much larger infra change than warranted.
--
-- Triggers fire regardless of role (including owner / superuser), so a
-- BEFORE UPDATE + BEFORE DELETE trigger that raises an exception
-- enforces the invariant at the DB boundary for every connection. Any
-- attempt rolls back the surrounding transaction. INSERT is unaffected.
--
-- Cascade interaction: audit_log.user_id has no FK (migration 0011
-- dropped it precisely so audit rows can outlive the user they
-- reference). No cascade path can reach audit_log, so this trigger
-- never fires on legitimate user-purge flows.
--
-- Forward-only. Idempotent via DROP IF EXISTS — a partially-applied
-- retry must succeed, not raise "trigger already exists".

DROP TRIGGER IF EXISTS audit_log_no_update ON "audit_log";--> statement-breakpoint
DROP TRIGGER IF EXISTS audit_log_no_delete ON "audit_log";--> statement-breakpoint
DROP FUNCTION IF EXISTS audit_log_insert_only();--> statement-breakpoint

CREATE FUNCTION audit_log_insert_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is INSERT-only (AGENTS.md §4) — UPDATE/DELETE is forbidden';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON "audit_log"
  FOR EACH ROW
  EXECUTE FUNCTION audit_log_insert_only();--> statement-breakpoint

CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON "audit_log"
  FOR EACH ROW
  EXECUTE FUNCTION audit_log_insert_only();
