// Single source of truth for audit action vocabulary (D-32).
//
// The Postgres enum (`auditActionEnum`) is defined here; the schema
// table file (audit-log.ts) imports it. This keeps the writable list
// and the UI dropdown labels in lock-step — adding an action requires
// touching ONE file, not three.
//
// Phase 1 contributed: session.signin, session.signout,
// session.signout_all, user.signup. Phase 2 adds the rest per D-32.
// Future phases (3 / 6) extend by ALTER TYPE ADD VALUE — Postgres
// enum value REMOVAL is not first-class, so additions only.

import { pgEnum } from "drizzle-orm/pg-core";

export const AUDIT_ACTIONS = [
  // Phase 1
  "session.signin",
  "session.signout",
  "session.signout_all",
  "user.signup",
  // Phase 2 (D-32)
  "key.add",
  "key.rotate",
  "key.remove",
  "game.created",
  "game.deleted",
  "game.restored",
  "item.created",
  "item.deleted",
  "event.created",
  "event.edited",
  "event.deleted",
  "theme.changed",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

// EXPORTED — drizzle-kit silently drops non-exported pgEnums (#5174).
export const auditActionEnum = pgEnum("audit_action", AUDIT_ACTIONS);
