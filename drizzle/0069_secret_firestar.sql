-- Cache TikTok cover image bytes at poll time so the thumbnail proxy serves
-- expiry-proof bytes instead of re-fetching the (hours-short) signed CDN URL,
-- which caused the steady prod 502 rate on /api/tiktok/thumbnail.
-- Rollback: ALTER TABLE "tiktok_posts" DROP COLUMN "thumbnail_bytes", DROP COLUMN "thumbnail_content_type";
ALTER TABLE "tiktok_posts" ADD COLUMN "thumbnail_bytes" "bytea";--> statement-breakpoint
ALTER TABLE "tiktok_posts" ADD COLUMN "thumbnail_content_type" text;