// Single source of truth for audit action vocabulary.
//
// The Postgres enum (`auditActionEnum`) is defined here; the schema
// table file (audit-log.ts) imports it. This keeps the writable list
// and the UI dropdown labels in lock-step — adding an action requires
// touching ONE file, not three.
//
// New action checklist: TS const update + forward-only ALTER TYPE
// migration + Paraglide keys (en.json) + LABELS entry in
// $lib/audit-labels.ts (TypeScript guarantees completeness for that
// one).

import { pgEnum } from "drizzle-orm/pg-core";

export const AUDIT_ACTIONS = [
  "session.signin",
  "session.signout",
  "session.signout_all",
  "user.signup",
  "key.add",
  "key.rotate",
  "key.remove",
  "game.created",
  "game.deleted",
  "game.restored",
  "event.created",
  "event.edited",
  "event.deleted",
  "event.attached_to_game",
  "event.detached_from_game",
  "event.dismissed_from_inbox",
  "event.restored",
  "event.marked_standalone",
  "event.unmarked_standalone",
  "source.added",
  "source.removed",
  "source.toggled_auto_import",
  "theme.changed",
  // In-app account export, soft-delete, restore + per-user abuse-quota
  // tripwire.
  "account.deleted",
  "account.restored",
  "account.exported",
  "quota.limit_hit",
  // Polling pipeline + purge worker + auto-import verbs.
  //
  //   - quota.service_throttled — operator-side YouTube quota tripped.
  //     Admin-only signal.
  //   - purge.completed         — purgeAccount worker finished
  //     hard-deleting a soft-deleted user; written with the purged
  //     user's own user_id (cursor invariant).
  //   - auto_import.deferred    — adapter declined an auto-import tick
  //     (e.g. quota near ceiling, source disabled mid-tick, channel
  //     cache miss queued for backfill).
  //   - poll.failed             — refresh-poll attempt errored
  //     (transient 5xx, 401 from rotated key, etc.). last_poll_status
  //     carries the human-facing label; this audit row carries the
  //     metadata.
  //   - event.poll_refreshed    — refresh-poll succeeded, snapshot row
  //     written, events.last_polled_at advanced.
  "quota.service_throttled",
  "purge.completed",
  "auto_import.deferred",
  "poll.failed",
  "event.poll_refreshed",
  // POST /api/sources/:id/refresh-content endpoint ("Pull new content"
  // button on /sources/[id]). Metadata payload:
  // { source_id, kind, queue, job_id }.
  "source.refresh_content_requested",
  // Phase 03.1 Reddit (DV-RDT-7 — public-`.json` adapter). Audit verbs:
  //   - reddit.queue_drained         — worker tick completed >0 entries.
  //     metadata: { queue_name, entries_processed, duration_ms }.
  //   - reddit.deletion_propagated   — daily @05:00 UTC cron purged author
  //     fields for N posts past 48h since deletion-detect.
  //     metadata: { posts_purged }.
  //   - reddit.cap_exhausted         — user hit 1/5min source cap OR
  //     25/5min post cap. metadata: { cap_type: 'source'|'post',
  //     window_minutes, cap, reset_in_seconds }.
  //   - reddit.adapter_degraded      — burst of 403s detected; adapter
  //     health flagged. metadata: { burst_count, since }.
  "reddit.queue_drained",
  "reddit.deletion_propagated",
  "reddit.cap_exhausted",
  "reddit.adapter_degraded",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

// EXPORTED — drizzle-kit silently drops non-exported pgEnums (#5174).
export const auditActionEnum = pgEnum("audit_action", AUDIT_ACTIONS);
