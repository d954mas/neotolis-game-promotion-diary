// /api/me service functions (Plan 01-07 — Wave 4; Plan 02-08 — UX-01 theme).
//
// Established Pattern (CONTEXT.md): every service function takes `userId`
// first. This is the single most important convention in the codebase — it
// makes cross-tenant access impossible-by-construction at the call site,
// because every read must scope by the caller's id explicitly.
//
// `getMe(userId)` is the trivial case: the caller IS the resource. We still
// throw NotFoundError if the row vanished (e.g. account was deleted between
// session issue and this request) — that path becomes a 404 at the HTTP
// boundary, prompting the client to re-auth.
//
// `updateUserTheme` (Plan 02-08, UX-01): theme is part of the Better Auth
// `user` row (see schema/auth.ts `themePreference`). Better Auth tables are
// allowlisted by the Plan 02-02 tenant-scope ESLint rule — the rule does not
// fire on `user`/`session`/`account`/`verification` because those tables are
// owned by the auth lib and always scoped by `userId` from the session
// (the rule's STRUCTURAL match wouldn't be load-bearing). The substantive
// scoping is still here: the WHERE clause is `eq(user.id, userId)`, where
// `userId` comes from the actual session (resolved by tenantScope).

import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { user } from "../db/schema/auth.js";
import { getUserById } from "./users.js";
import { toUserDto, type UserDto } from "../dto.js";
import { writeAudit } from "../audit.js";
import { NotFoundError } from "./errors.js";

export type Theme = "light" | "dark" | "system";

/** Return the DTO for the authenticated user. Throws NotFoundError if missing. */
export async function getMe(userId: string): Promise<UserDto> {
  const u = await getUserById(userId);
  if (!u) throw new NotFoundError();
  return toUserDto(u);
}

/**
 * Update the caller's theme preference (Plan 02-08, UX-01).
 *
 * Reads the current `themePreference` first so the audit metadata can carry
 * the `from` value (forensic trail of who flipped from what). Writes the
 * new value, bumps `updatedAt`, then writes an audit row with action
 * `theme.changed` and metadata `{from, to}`.
 *
 * The route handler (src/lib/server/http/routes/me-theme.ts) sets the cookie
 * after this returns so cookie + DB stay in lock-step. Returns the new theme
 * + the previous theme so the route can confirm the cookie value.
 */
export async function updateUserTheme(
  userId: string,
  newTheme: Theme,
  ipAddress: string,
): Promise<{ theme: Theme; from: string }> {
  const [row] = await db
    .select({ themePreference: user.themePreference })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (!row) throw new NotFoundError();
  const fromTheme = row.themePreference;

  await db
    .update(user)
    .set({ themePreference: newTheme, updatedAt: new Date() })
    .where(eq(user.id, userId));

  await writeAudit({
    userId,
    action: "theme.changed",
    ipAddress,
    metadata: { from: fromTheme, to: newTheme },
  });

  return { theme: newTheme, from: fromTheme };
}
