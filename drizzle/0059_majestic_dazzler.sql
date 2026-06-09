ALTER TABLE "telegram_posts" ADD COLUMN "reactions_top" jsonb;--> statement-breakpoint
ALTER TABLE "telegram_post_snapshots" ADD COLUMN "reactions_total" bigint;