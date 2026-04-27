import type { LayoutServerLoad } from "./$types";
import { redirect } from "@sveltejs/kit";

/**
 * SvelteKit layout load (Plan 01-07 — Wave 4):
 *   - Pass DTO-projected user (or null) to all pages so layouts can render
 *     auth-aware UI without re-querying the session (P3 discipline — locals.user
 *     is already projected by src/hooks.server.ts).
 *   - Protected-paths redirect: anonymous requests to any path in
 *     `PROTECTED_PATHS` are redirected to /login?next=<originalPath> (PRIV-01).
 *
 * Phase 1 has only the dashboard route (`/`) which works for both anonymous
 * (shows "sign in") and authenticated (shows the empty dashboard) — there is
 * no protected page yet, so `PROTECTED_PATHS` is empty. Phase 2 will add
 * `/games` and `/settings` to this list. The pattern is in place so Phase 2
 * does not have to re-discover it.
 */
const PROTECTED_PATHS: string[] = [
  // Phase 2 will add: '/games', '/settings'
];

export const load: LayoutServerLoad = ({ locals, url }) => {
  const isProtected = PROTECTED_PATHS.some((p) =>
    url.pathname.startsWith(p),
  );
  if (isProtected && !locals.user) {
    throw redirect(303, `/login?next=${encodeURIComponent(url.pathname)}`);
  }
  return { user: locals.user ?? null };
};
