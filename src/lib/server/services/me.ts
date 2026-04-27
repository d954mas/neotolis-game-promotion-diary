// /api/me service function (Plan 01-07 — Wave 4).
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

import { getUserById } from "./users.js";
import { toUserDto, type UserDto } from "../dto.js";
import { NotFoundError } from "./errors.js";

/** Return the DTO for the authenticated user. Throws NotFoundError if missing. */
export async function getMe(userId: string): Promise<UserDto> {
  const u = await getUserById(userId);
  if (!u) throw new NotFoundError();
  return toUserDto(u);
}
