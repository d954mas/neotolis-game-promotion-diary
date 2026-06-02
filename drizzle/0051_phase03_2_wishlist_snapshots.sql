CREATE TABLE "wishlist_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"listing_id" text NOT NULL,
	"date" date NOT NULL,
	"adds" integer,
	"deletes" integer,
	"purchases_and_activations" integer,
	"gifts" integer,
	"balance" integer NOT NULL,
	"source" text DEFAULT 'csv' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wishlist_snapshots" ADD CONSTRAINT "wishlist_snapshots_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wishlist_snapshots" ADD CONSTRAINT "wishlist_snapshots_listing_id_game_steam_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."game_steam_listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wishlist_snapshots_user_id_idx" ON "wishlist_snapshots" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wishlist_snapshots_listing_date_unq" ON "wishlist_snapshots" USING btree ("listing_id","date");