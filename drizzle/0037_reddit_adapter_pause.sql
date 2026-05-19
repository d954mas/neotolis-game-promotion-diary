-- Reddit adapter pause state.
--
-- `reddit_pacer` is the single DB-backed gate for every Reddit HTTP path.
-- When Reddit returns real upstream 403/429 responses, the adapter records
-- an escalating degraded pause here so worker/user paths stop sending more
-- public `.json` traffic for a conservative window instead of retrying every
-- tick. The application code still allows local URL/event/source creation;
-- only remote Reddit sync is paused.

ALTER TABLE "reddit_pacer"
  ADD COLUMN IF NOT EXISTS "paused_until" timestamptz;--> statement-breakpoint

ALTER TABLE "reddit_pacer"
  ADD COLUMN IF NOT EXISTS "pause_level" smallint NOT NULL DEFAULT 0
  CHECK ("pause_level" >= 0 AND "pause_level" <= 3);--> statement-breakpoint

ALTER TABLE "reddit_pacer"
  ADD COLUMN IF NOT EXISTS "last_pause_reason" text;--> statement-breakpoint

ALTER TABLE "reddit_pacer"
  ADD COLUMN IF NOT EXISTS "last_paused_at" timestamptz;
