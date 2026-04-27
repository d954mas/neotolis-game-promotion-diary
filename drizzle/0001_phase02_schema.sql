CREATE TYPE "public"."audit_action" AS ENUM('session.signin', 'session.signout', 'session.signout_all', 'user.signup', 'key.add', 'key.rotate', 'key.remove', 'game.created', 'game.deleted', 'game.restored', 'item.created', 'item.deleted', 'event.created', 'event.edited', 'event.deleted', 'theme.changed');--> statement-breakpoint
CREATE TYPE "public"."event_kind" AS ENUM('conference', 'talk', 'twitter_post', 'telegram_post', 'discord_drop', 'press', 'other');--> statement-breakpoint
CREATE TABLE "api_keys_steam" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"label" text NOT NULL,
	"last4" text NOT NULL,
	"secret_ct" "bytea" NOT NULL,
	"secret_iv" "bytea" NOT NULL,
	"secret_tag" "bytea" NOT NULL,
	"wrapped_dek" "bytea" NOT NULL,
	"dek_iv" "bytea" NOT NULL,
	"dek_tag" "bytea" NOT NULL,
	"kek_version" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"game_id" text NOT NULL,
	"kind" "event_kind" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"title" text NOT NULL,
	"url" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "game_steam_listings" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"game_id" text NOT NULL,
	"app_id" integer NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"cover_url" text,
	"release_date" text,
	"coming_soon" text,
	"steam_genres" text[] DEFAULT '{}' NOT NULL,
	"steam_categories" text[] DEFAULT '{}' NOT NULL,
	"raw_appdetails" jsonb,
	"api_key_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "game_steam_listings_game_app_id_unq" UNIQUE("game_id","app_id"),
	CONSTRAINT "game_steam_listings_user_app_id_unq" UNIQUE("user_id","app_id")
);
--> statement-breakpoint
CREATE TABLE "game_youtube_channels" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"game_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "game_youtube_channels_game_channel_unq" UNIQUE("game_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "games" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"cover_url" text,
	"release_date" date,
	"release_tba" boolean DEFAULT false NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tracked_youtube_videos" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"game_id" text NOT NULL,
	"video_id" text NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"channel_id" text,
	"author_url" text,
	"is_own" boolean DEFAULT false NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_polled_at" timestamp with time zone,
	"last_poll_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "tracked_youtube_videos_user_video_id_unq" UNIQUE("user_id","video_id")
);
--> statement-breakpoint
CREATE TABLE "youtube_channels" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"handle_url" text NOT NULL,
	"channel_id" text,
	"display_name" text,
	"is_own" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "youtube_channels_user_handle_unq" UNIQUE("user_id","handle_url")
);
--> statement-breakpoint
ALTER TABLE "audit_log" ALTER COLUMN "action" SET DATA TYPE "public"."audit_action" USING "action"::"public"."audit_action";--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "theme_preference" text DEFAULT 'system' NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys_steam" ADD CONSTRAINT "api_keys_steam_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_steam_listings" ADD CONSTRAINT "game_steam_listings_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_steam_listings" ADD CONSTRAINT "game_steam_listings_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_steam_listings" ADD CONSTRAINT "game_steam_listings_api_key_id_api_keys_steam_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys_steam"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_youtube_channels" ADD CONSTRAINT "game_youtube_channels_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_youtube_channels" ADD CONSTRAINT "game_youtube_channels_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_youtube_channels" ADD CONSTRAINT "game_youtube_channels_channel_id_youtube_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."youtube_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_youtube_videos" ADD CONSTRAINT "tracked_youtube_videos_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_youtube_videos" ADD CONSTRAINT "tracked_youtube_videos_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "youtube_channels" ADD CONSTRAINT "youtube_channels_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_steam_user_id_idx" ON "api_keys_steam" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_steam_user_label_unq" ON "api_keys_steam" USING btree ("user_id","label");--> statement-breakpoint
CREATE INDEX "events_user_id_idx" ON "events" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "events_user_id_game_id_occurred_at_idx" ON "events" USING btree ("user_id","game_id","occurred_at");--> statement-breakpoint
CREATE INDEX "game_steam_listings_user_id_idx" ON "game_steam_listings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "game_steam_listings_game_id_idx" ON "game_steam_listings" USING btree ("game_id");--> statement-breakpoint
CREATE INDEX "game_youtube_channels_user_id_idx" ON "game_youtube_channels" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "game_youtube_channels_game_id_idx" ON "game_youtube_channels" USING btree ("game_id");--> statement-breakpoint
CREATE INDEX "games_user_id_idx" ON "games" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "games_user_id_created_at_idx" ON "games" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "games_user_id_deleted_at_idx" ON "games" USING btree ("user_id","deleted_at");--> statement-breakpoint
CREATE INDEX "tracked_youtube_videos_user_id_idx" ON "tracked_youtube_videos" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "tracked_youtube_videos_user_id_game_id_idx" ON "tracked_youtube_videos" USING btree ("user_id","game_id");--> statement-breakpoint
CREATE INDEX "youtube_channels_user_id_idx" ON "youtube_channels" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_log_user_id_action_created_at_idx" ON "audit_log" USING btree ("user_id","action","created_at");