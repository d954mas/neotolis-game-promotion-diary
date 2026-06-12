CREATE INDEX "idx_instagram_posts_account_published_at" ON "instagram_posts" USING btree ("account_id","published_at");--> statement-breakpoint
CREATE INDEX "idx_instagram_posts_permalink" ON "instagram_posts" USING btree ("permalink");--> statement-breakpoint
CREATE INDEX "idx_tiktok_posts_account_published_at" ON "tiktok_posts" USING btree ("account_id","published_at");--> statement-breakpoint
CREATE INDEX "idx_tiktok_posts_permalink" ON "tiktok_posts" USING btree ("permalink");