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
//     attached_to_game and dismissed_from_inbox are NEW)
//   - source.* (Phase 2.1 NEW: replaces channel.*)
//   - theme.changed (Phase 2)
//
// REMOVED in Phase 2.1 (CONTEXT D-03 baseline collapse — destructive baseline
// per pre-launch / zero self-host deployments): channel.added, channel.removed,
// channel.attached, channel.detached, item.created, item.deleted.

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
  "event.dismissed_from_inbox",
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
