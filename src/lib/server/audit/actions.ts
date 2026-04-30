// Single source of truth for audit action vocabulary (D-32 + Phase 2.1 §4.4).
//
// The Postgres enum (`auditActionEnum`) is defined here; the schema table file
// (audit-log.ts) imports it. This keeps the writable list and the UI dropdown
// labels in lock-step — adding an action requires touching ONE file, not three.
//
// Phase 2.1 vocabulary (per RESEARCH.md §4.4 + CONTEXT D-03/D-04):
//   - session.* (Phase 1)
//   - user.signup (Phase 1)
//   - key.* (Phase 2)
//   - game.* (Phase 2)
//   - event.* (Phase 2.1: edited / deleted carry forward; created carries forward;
//     attached_to_game and dismissed_from_inbox are NEW; restored is added by
//     Plan 02.1-14 gap closure — VERIFICATION.md Gap 2)
//   - source.* (Phase 2.1 NEW: replaces channel.*)
//   - theme.changed (Phase 2)
//
// REMOVED in Phase 2.1 (CONTEXT D-03 baseline collapse — destructive baseline
// per pre-launch / zero self-host deployments): channel.added, channel.removed,
// channel.attached, channel.detached, item.created, item.deleted.
//
// Plan 02.1-14 (gap closure) extends with `event.restored` — the soft-delete
// recovery path the user-facing copy in confirm_event_delete already promises.
// Forward-only migration `0002_add_event_restored_audit_action.sql` lands the
// pgEnum addition.
//
// Plan 02.1-24 (round-3 gap closure — UAT-NOTES.md §6.1-redesign) extends with
// `event.marked_standalone` and `event.unmarked_standalone` — the two new
// triage verbs introduced when a user explicitly marks an inbox event "not
// related to any game". Forward-only migration
// `0003_add_event_standalone_audit_actions.sql` lands the pgEnum addition.
// Pitfall 6 mirror: TS const update + ALTER TYPE migration + Paraglide keys
// + AuditRow/FilterChips/FiltersSheet switch cases all in lock-step.
//
// Plan 02.1-27 (round-4 gap closure — UAT-NOTES.md §4.24.G) extends with
// `event.detached_from_game` — the symmetric inverse of
// `event.attached_to_game` for the new M:N event_games junction. Forward-only
// migration `0006_add_event_detached_from_game_audit_action.sql` lands the
// pgEnum addition (split from 0005 per Pitfall 1 + Plan 02.1-12 precedent —
// one ALTER TYPE per migration file).

import { pgEnum } from "drizzle-orm/pg-core";

export const AUDIT_ACTIONS = [
  // Phase 1
  "session.signin",
  "session.signout",
  "session.signout_all",
  "user.signup",
  // Phase 2
  "key.add",
  "key.rotate",
  "key.remove",
  "game.created",
  "game.deleted",
  "game.restored",
  // Phase 2.1: unified events vocabulary
  "event.created",
  "event.edited",
  "event.deleted",
  "event.attached_to_game",
  "event.detached_from_game",
  "event.dismissed_from_inbox",
  "event.restored",
  "event.marked_standalone",
  "event.unmarked_standalone",
  // Phase 2.1: data_sources vocabulary (replaces channel.*)
  "source.added",
  "source.removed",
  "source.toggled_auto_import",
  // Phase 2
  "theme.changed",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

// EXPORTED — drizzle-kit silently drops non-exported pgEnums (#5174).
export const auditActionEnum = pgEnum("audit_action", AUDIT_ACTIONS);
