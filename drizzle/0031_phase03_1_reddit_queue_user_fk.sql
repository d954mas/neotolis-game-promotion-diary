-- Phase 03.1 follow-up: add ON DELETE CASCADE FK to reddit_refresh_queue.user_id.
--
-- Plan 02's schema migration (0030) declared reddit_refresh_queue.user_id as
-- a plain `text` column (NULL for service-cron entries, set for user-driven
-- entries). The account-purge cascade-contract test
-- (tests/integration/account-purge.test.ts) requires every public.<table>.user_id
-- column to either have ON DELETE CASCADE to user(id) OR be in the SURVIVES_PURGE
-- allowlist (audit_log only). Without this FK, purging a user would leave
-- orphan rows in reddit_refresh_queue referencing a deleted user_id — a
-- privacy violation by allowlist contract.
--
-- Choice: CASCADE (not SET NULL). Queue rows are ephemeral by design — they
-- carry transient work payloads, not historical records. Deleting them with
-- the user matches the privacy posture (no orphan PII via user_id) and the
-- queue's intent (drop pending work for purged accounts immediately).
--
-- Re-runs prevented by the drizzle migrations journal (each migration
-- name executes at most once per DB). Postgres has no `ADD CONSTRAINT
-- IF NOT EXISTS` for FKs — re-applying this SQL directly would fail.
-- Forward-only invariant + journal guard make that path unreachable in
-- the supported deploy flow (`drizzle-orm migrate` only).

ALTER TABLE "reddit_refresh_queue"
  ADD CONSTRAINT "reddit_refresh_queue_user_id_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;
