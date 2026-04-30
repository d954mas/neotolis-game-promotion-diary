CREATE TYPE "public"."audit_action" AS ENUM('session.signin', 'session.signout', 'session.signout_all', 'user.signup', 'key.add', 'key.rotate', 'key.remove', 'game.created', 'game.deleted', 'game.restored', 'event.created', 'event.edited', 'event.deleted', 'event.attached_to_game', 'event.dismissed_from_inbox', 'source.added', 'source.removed', 'source.toggled_auto_import', 'theme.changed');--> statement-breakpoint
CREATE TYPE "public"."source_kind" AS ENUM('youtube_channel', 'reddit_account', 'twitter_account', 'telegram_channel', 'discord_server');--> statement-breakpoint
CREATE TYPE "public"."event_kind" AS ENUM('youtube_video', 'reddit_post', 'twitter_post', 'telegram_post', 'discord_drop', 'conference', 'talk', 'press', 'other');--> statement-breakpoint
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
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"action" "audit_action" NOT NULL,
	"ip_address" text NOT NULL,
	"user_agent" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"name" text NOT NULL,
	"image" text,
	"theme_preference" text DEFAULT 'system' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "data_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" "source_kind" NOT NULL,
	"handle_url" text NOT NULL,
	"channel_id" text,
	"display_name" text,
	"is_owned_by_me" boolean DEFAULT true NOT NULL,
	"auto_import" boolean DEFAULT true NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"game_id" text,
	"source_id" text,
	"kind" "event_kind" NOT NULL,
	"author_is_me" boolean DEFAULT false NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"title" text NOT NULL,
	"url" text,
	"notes" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"external_id" text,
	"last_polled_at" timestamp with time zone,
	"last_poll_status" text,
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
ALTER TABLE "api_keys_steam" ADD CONSTRAINT "api_keys_steam_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_sources" ADD CONSTRAINT "data_sources_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_source_id_data_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."data_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_steam_listings" ADD CONSTRAINT "game_steam_listings_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_steam_listings" ADD CONSTRAINT "game_steam_listings_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_steam_listings" ADD CONSTRAINT "game_steam_listings_api_key_id_api_keys_steam_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys_steam"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_steam_user_id_idx" ON "api_keys_steam" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_steam_user_label_unq" ON "api_keys_steam" USING btree ("user_id","label");--> statement-breakpoint
CREATE INDEX "audit_log_user_id_idx" ON "audit_log" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_log_user_id_created_at_idx" ON "audit_log" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_user_id_action_created_at_idx" ON "audit_log" USING btree ("user_id","action","created_at");--> statement-breakpoint
CREATE INDEX "data_sources_user_id_idx" ON "data_sources" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "data_sources_user_kind_idx" ON "data_sources" USING btree ("user_id","kind");--> statement-breakpoint
CREATE INDEX "data_sources_user_deleted_at_idx" ON "data_sources" USING btree ("user_id","deleted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "data_sources_user_handle_active_unq" ON "data_sources" USING btree ("user_id","handle_url") WHERE "data_sources"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "events_user_id_idx" ON "events" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "events_user_id_game_id_occurred_at_idx" ON "events" USING btree ("user_id","game_id","occurred_at");--> statement-breakpoint
CREATE INDEX "events_user_occurred_at_idx" ON "events" USING btree ("user_id","occurred_at" DESC,"id" DESC);--> statement-breakpoint
CREATE INDEX "events_user_source_idx" ON "events" USING btree ("user_id","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "events_user_kind_source_ext_unq" ON "events" USING btree ("user_id","kind","source_id","external_id") WHERE "events"."source_id" IS NOT NULL AND "events"."external_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "game_steam_listings_user_id_idx" ON "game_steam_listings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "game_steam_listings_game_id_idx" ON "game_steam_listings" USING btree ("game_id");--> statement-breakpoint
CREATE INDEX "games_user_id_idx" ON "games" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "games_user_id_created_at_idx" ON "games" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "games_user_id_deleted_at_idx" ON "games" USING btree ("user_id","deleted_at");