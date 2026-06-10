-- Repair migration: re-apply the effects of 0042 + 0043, which were SILENTLY
-- SKIPPED on the long-lived production DB.
--
-- Cause: 0039/0040 carry hand-edited future-dated `when` values (2026-05-27/28)
-- that are LATER than 0042 (2026-05-21) and 0043 (2026-05-25). drizzle's migrator
-- applies a migration only when its `when` exceeds the max already-applied `when`;
-- once a prod deploy ran 0039/0040 it raised that watermark past 0042/0043, so
-- they never executed on prod. A fresh-from-zero DB has an empty ledger (no
-- watermark) and runs every migration in file order, so CI / dev / a brand-new
-- self-host install were unaffected — which is exactly why this stayed invisible.
-- Effect on prod: audit_action lacked the 4 verbs below (-> "audit write failed"
-- on bulk edits) and events kept the legacy `metadata.triage.standalone` key
-- (invisible to the off-topic feed filter, which reads `triage.offTopic`).
--
-- This migration's `when` is current (> the prod watermark), so it applies on the
-- next prod deploy. It is FULLY IDEMPOTENT: ADD VALUE IF NOT EXISTS is a no-op
-- where the value already exists, and the two UPDATEs filter on the legacy key so
-- they touch zero rows once migrated -- a no-op on every DB that already ran
-- 0042/0043 (fresh installs, CI, dev).

-- 0042_phase34_audit_verbs -- the four audit_action verbs.
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'events.bulk_edit';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'events.bulk_delete';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'events.delete_forever';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'events.purge_stale';--> statement-breakpoint

-- 0043_unify_offtopic_field -- move triage.standalone -> triage.offTopic, drop the legacy key.
UPDATE events
SET metadata = jsonb_set(metadata, '{triage,offTopic}', metadata->'triage'->'standalone', true)
WHERE metadata->'triage' ? 'standalone';--> statement-breakpoint
UPDATE events
SET metadata = metadata #- '{triage,standalone}'
WHERE metadata->'triage' ? 'standalone';
