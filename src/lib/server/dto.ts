// PITFALL P3 (DTO discipline) — every response that includes user or session
// data MUST go through these projections. The point: adding a column to the
// schema (a new OAuth-token column or the Google subject identifier on
// `account.account_id`) does NOT auto-leak it to the browser, because the
// projection is hand-written and only includes the fields the client should
// know about.
//
// Phase 1 establishes this pattern; every later phase inherits it.

import type { user, session } from "./db/schema/auth.js";

type User = typeof user.$inferSelect;
type Session = typeof session.$inferSelect;

/**
 * UserDto — what we send to authenticated clients.
 *
 * INTENTIONALLY OMITTED (per PITFALL P3):
 *   - the OAuth provider subject id (lives on `account.account_id` — that
 *     column carries the Google "sub" claim). Leaking it would let an
 *     attacker pivot to other services using the same login.
 *   - all OAuth tokens (lives on the `account` table only); never returned
 *     to the browser under any circumstance.
 *   - `emailVerified` — PII reveal that has no client-side use in MVP.
 *   - `createdAt` / `updatedAt` — timing reveal (account-age fingerprinting).
 */
export interface UserDto {
  id: string;
  email: string;
  name: string;
  image: string | null;
}

export function toUserDto(u: User): UserDto {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    image: u.image,
  };
}

/**
 * SessionDto — what we send when listing the user's active sessions
 * (Phase 2 / settings UI). Phase 1 establishes the shape; the read endpoint
 * lands later.
 *
 * INTENTIONALLY OMITTED:
 *   - `token` — the session-cookie value. Returning it would defeat HTTP-only.
 *   - `userId` — the caller already knows it (their own session); echoing it
 *     adds nothing and risks accidentally surfacing OTHER users' sessions in
 *     a buggy admin context.
 */
export interface SessionDto {
  id: string;
  expiresAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
}

export function toSessionDto(s: Session): SessionDto {
  return {
    id: s.id,
    expiresAt: s.expiresAt,
    ipAddress: s.ipAddress,
    userAgent: s.userAgent,
    createdAt: s.createdAt,
  };
}
