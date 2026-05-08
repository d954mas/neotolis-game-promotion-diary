CREATE TABLE "youtube_videos" (
	"video_id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"channel_id" text,
	"channel_title" text,
	"published_at" timestamp with time zone,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
