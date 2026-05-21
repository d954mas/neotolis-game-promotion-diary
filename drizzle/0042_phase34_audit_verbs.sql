ALTER TYPE "public"."audit_action" ADD VALUE 'events.bulk_edit';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'events.bulk_delete';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'events.delete_forever';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'events.purge_stale';