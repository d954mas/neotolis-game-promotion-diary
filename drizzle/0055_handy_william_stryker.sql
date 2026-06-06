ALTER TYPE "public"."audit_action" ADD VALUE 'social.provider_throttled';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'social.budget_exhausted';--> statement-breakpoint
ALTER TYPE "public"."source_kind" ADD VALUE 'instagram_account';--> statement-breakpoint
ALTER TYPE "public"."event_kind" ADD VALUE 'instagram_post';