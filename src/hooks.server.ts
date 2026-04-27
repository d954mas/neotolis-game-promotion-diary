// SvelteKit server-side hook (Plan 01-06 — Wave 3).
//
// Reads the Better Auth session via `auth.api.getSession({ headers })` and
// populates `event.locals.user` and `event.locals.session` with the
// DTO-projected shape (P3 discipline — never put raw DB rows on locals).
// Pages and load functions read from `event.locals` only; downstream code
// never touches Better Auth's internal types directly.
//
// When the app runs under Hono in production, the Hono middleware also has
// access to the same call. Duplication is fine because Better Auth caches
// the lookup per-request; the cost is one DB round-trip at most.

import type { Handle } from "@sveltejs/kit";
import { auth } from "$lib/auth.js";
import { toUserDto, toSessionDto } from "$lib/server/dto.js";

export const handle: Handle = async ({ event, resolve }) => {
  const result = await auth.api.getSession({ headers: event.request.headers });
  if (result) {
    // toUserDto / toSessionDto strip secret-shaped fields and apply the
    // tenant-scope projection (Plan 05 / 07).
    event.locals.user = toUserDto(result.user as Parameters<typeof toUserDto>[0]);
    event.locals.session = toSessionDto(result.session as Parameters<typeof toSessionDto>[0]);
  }
  return resolve(event);
};
