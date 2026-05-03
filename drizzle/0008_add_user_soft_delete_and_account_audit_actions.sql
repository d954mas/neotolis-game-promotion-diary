-- Phase 02.2 baseline: open-signup public-SaaS surface (D-11, D-16).
-- Adds soft-delete column to Better Auth user table and 4 new audit verbs.
-- Forward-only; no down migration; runs under advisory lock per Phase 1 D-23.
--
-- One ALTER TYPE … ADD VALUE per statement, IF NOT EXISTS guard, isolated
-- in this migration (Pitfall 1 + Plan 02.1-12 / 02.1-27 precedent — Postgres
-- 16 ALTER TYPE rules: cannot run inside a transaction block alongside other
-- DDL).

ALTER TABLE "user" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'account.deleted';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'account.restored';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'account.exported';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'quota.limit_hit';--> statement-breakpoint
