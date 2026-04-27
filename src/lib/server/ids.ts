import { uuidv7 as _uuidv7 } from "uuidv7";

/**
 * RFC 9562 UUIDv7 — time-sortable, enumeration-safe (D-06).
 *
 * Every primary key in the schema (users, sessions, audit_logs, and every
 * Phase-2+ table) is generated through this helper so the time-prefix
 * ordering invariant holds across the codebase. Indexes behave like int
 * (good locality on inserts) and IDs cannot be enumerated to leak row
 * counts.
 */
export function uuidv7(): string {
  return _uuidv7();
}
