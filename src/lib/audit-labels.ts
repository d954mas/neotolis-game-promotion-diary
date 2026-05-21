// Audit-action display labels — single source of truth.
//
// Three Svelte components (AuditRow, FilterChips, FiltersSheet) previously
// carried independent switch statements mapping each AUDIT_ACTIONS value
// to a Paraglide message — 80+ duplicated lines per file plus a manual
// mirror array in FiltersSheet. CI caught drift twice when new actions
// were added (chip showed raw enum string in /audit; FiltersSheet
// rendered N-1 checkboxes). The lock-step contract was empirically
// brittle.
//
// This file collapses the three switches into one `Record<AuditAction, ...>`.
// TypeScript guarantees completeness at compile time — adding a value to
// AUDIT_ACTIONS without an entry here fails `pnpm exec tsc --noEmit`.
//
// New audit verb checklist (was 6+ lock-step touch points; now 4 with
// compile-time enforcement on the most error-prone one):
//   1. AUDIT_ACTIONS const         — actions.ts
//   2. PG enum migration           — drizzle/00xx_…sql
//   3. en.json key                 — messages/en.json
//   4. LABELS entry below          — this file (TYPESCRIPT GUARANTEED)
//
// The Svelte components (AuditRow / FilterChips / FiltersSheet) and the
// FiltersSheet checkbox roster simply call `auditActionLabel(action)` /
// iterate `AUDIT_ACTIONS` directly — no per-component duplication.

import { m } from "$lib/paraglide/messages.js";
import type { AuditAction } from "$lib/server/audit/actions.js";

// Record<AuditAction, ...> — TypeScript fails the build if any
// AUDIT_ACTIONS value lacks a label. This is the compile-time
// contract that replaces the runtime CI catch.
const LABELS: Record<AuditAction, () => string> = {
  "session.signin": () => m.audit_action_session_signin(),
  "session.signout": () => m.audit_action_session_signout(),
  "session.signout_all": () => m.audit_action_session_signout_all(),
  "user.signup": () => m.audit_action_user_signup(),
  "key.add": () => m.audit_action_key_add(),
  "key.rotate": () => m.audit_action_key_rotate(),
  "key.remove": () => m.audit_action_key_remove(),
  "game.created": () => m.audit_action_game_created(),
  "game.deleted": () => m.audit_action_game_deleted(),
  "game.restored": () => m.audit_action_game_restored(),
  "event.created": () => m.audit_action_event_created(),
  "event.edited": () => m.audit_action_event_edited(),
  "event.deleted": () => m.audit_action_event_deleted(),
  "event.attached_to_game": () => m.audit_action_event_attached_to_game(),
  "event.detached_from_game": () => m.audit_action_event_detached_from_game(),
  "event.dismissed_from_inbox": () => m.audit_action_event_dismissed_from_inbox(),
  "event.restored": () => m.audit_action_event_restored(),
  "event.marked_standalone": () => m.audit_action_event_marked_standalone(),
  "event.unmarked_standalone": () => m.audit_action_event_unmarked_standalone(),
  "source.added": () => m.audit_action_source_added(),
  "source.removed": () => m.audit_action_source_removed(),
  "source.toggled_auto_import": () => m.audit_action_source_toggled_auto_import(),
  "source.refresh_content_requested": () => m.audit_action_source_refresh_content_requested(),
  "theme.changed": () => m.audit_action_theme_changed(),
  "account.deleted": () => m.audit_action_account_deleted(),
  "account.restored": () => m.audit_action_account_restored(),
  "account.exported": () => m.audit_action_account_exported(),
  "quota.limit_hit": () => m.audit_action_quota_limit_hit(),
  "quota.service_throttled": () => m.audit_action_quota_service_throttled(),
  "purge.completed": () => m.audit_action_purge_completed(),
  "auto_import.deferred": () => m.audit_action_auto_import_deferred(),
  "poll.failed": () => m.audit_action_poll_failed(),
  "event.poll_refreshed": () => m.audit_action_event_poll_refreshed(),
  // Phase 03.1 Reddit — adapter audit verbs. Worker-emitted (queue
  // drained / deletion propagated) + cap enforcement (cap exhausted) +
  // health flag (adapter degraded).
  "reddit.queue_drained": () => m.audit_action_reddit_queue_drained(),
  "reddit.deletion_propagated": () => m.audit_action_reddit_deletion_propagated(),
  "reddit.cap_exhausted": () => m.audit_action_reddit_cap_exhausted(),
  "reddit.adapter_degraded": () => m.audit_action_reddit_adapter_degraded(),
  // Phase 03.4 design-v2-ux — bulk + trash + purge verbs. PG enum
  // extension in drizzle/0042_phase34_audit_verbs.sql; en.json keys land
  // in lock-step (audit_action_events_*).
  "events.bulk_edit": () => m.audit_action_events_bulk_edit(),
  "events.bulk_delete": () => m.audit_action_events_bulk_delete(),
  "events.delete_forever": () => m.audit_action_events_delete_forever(),
  "events.purge_stale": () => m.audit_action_events_purge_stale(),
};

/**
 * Resolve an audit action string to its human-readable Paraglide label.
 * Unknown values (forward-compatibility — new server verb without a UI
 * deploy yet) fall back to the raw action string. Existing tests pin
 * "every AUDIT_ACTIONS value resolves to a non-fallback label", so the
 * fallback is purely a safety net for the deployment-skew window.
 */
export function auditActionLabel(action: string): string {
  const fn = LABELS[action as AuditAction];
  return fn !== undefined ? fn() : action;
}

/**
 * Client-safe roster of audit actions, derived from the LABELS Record above.
 * Equivalent to `AUDIT_ACTIONS` from `$lib/server/audit/actions.js` but
 * importable from client-side Svelte components without dragging drizzle's
 * `pgEnum` into the browser bundle.
 *
 * Order matches LABELS' insertion order, which mirrors AUDIT_ACTIONS (the
 * Record literal is hand-aligned with the const above; the test in
 * tests/unit/audit-labels.test.ts pins this alignment).
 */
export const AUDIT_ACTION_LIST: ReadonlyArray<AuditAction> = Object.keys(LABELS) as AuditAction[];
