// Phase 3.0 Plan 13 + post-build review (2026-05-08, fourth pass) —
// admin shell loader.
//
// Originally this layout was gate-less and relied on the child page's API
// call to /api/admin/* returning 404 for non-allowlisted users. The third
// review caught the chrome leak (SvelteKit renders a parent layout
// AROUND a child error page, so non-allowlisted users saw the "Admin
// mode" breadcrumb on top of the 404). The fix moved the deny to this
// layout — but kept a redirect-to-login for anonymous callers, which the
// fourth review noted ALSO leaks the area's existence (the redirect
// shape "/admin → /login?next=/admin" tells an unauthenticated probe
// that /admin is a real route).
//
// Both anonymous and authenticated-non-allowlisted now get 404. The
// existence of /admin/* is the secret — see AGENTS.md Privacy invariant
// 2 + AP-4. A real operator who hits 404 by mistake just signs in; the
// page link in the operator's mental model is private to the operator.
//
// The check lives in TWO places (this loader + adminAllowlist middleware
// on /api/admin/*) reading ONE source of truth (env.ADMIN_EMAIL_ALLOWLIST),
// so there is no policy drift. Self-host parity holds by construction:
// empty allowlist → 404 for everyone in both layers.

import type { LayoutServerLoad } from "./$types";
import { error } from "@sveltejs/kit";
import { env } from "$lib/server/config/env.js";

export const load: LayoutServerLoad = async ({ locals }) => {
  // Anonymous → 404 (same as authenticated-non-allowlisted). Redirecting
  // to /login here would confirm /admin/* exists; an unauthenticated
  // probe MUST receive the same response shape as the URL-not-found
  // case. The API-layer adminAllowlist middleware on /api/admin/*
  // independently returns 401 for anonymous (auth boundary), which is a
  // different concern from "does this URL even resolve."
  if (!locals.user) {
    throw error(404, "Not Found");
  }
  const email = locals.user.email.toLowerCase();
  if (!env.ADMIN_EMAIL_ALLOWLIST.has(email)) {
    throw error(404, "Not Found");
  }
  return {};
};
