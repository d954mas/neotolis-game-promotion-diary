ALTER TABLE "wishlist_snapshots" ALTER COLUMN "adds" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "wishlist_snapshots" ALTER COLUMN "deletes" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "wishlist_snapshots" ALTER COLUMN "purchases_and_activations" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "wishlist_snapshots" ALTER COLUMN "gifts" SET NOT NULL;