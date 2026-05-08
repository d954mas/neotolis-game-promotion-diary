// Phase 3.0 Plan 13 + post-build review (2026-05-08) — admin shell loader.
//
// Originally this layout was gate-less and relied on the child page's API
// call to /api/admin/* returning 404 for non-allowlisted users (single
// source of truth = adminAllowlist middleware). Reviewer caught the leak:
// SvelteKit renders a parent layout AROUND a child error page, so the
// "Admin mode" breadcrumb chrome (+layout.svelte) appeared on top of the
// 404 page for non-allowlisted users — confirming /admin/* is "a real
// area" instead of treating it as URL-not-found.
//
// The fix is a layout-level deny: throw error(404) here when the caller
// isn't in env.ADMIN_EMAIL_ALLOWLIST. The check now lives in TWO places
// (this loader + adminAllowlist middleware on /api/admin/*), but they
// read the SAME source of truth (env.ADMIN_EMAIL_ALLOWLIST), so there is
// no policy drift — one allowlist set, two consumers. Self-host parity
// holds by construction: empty allowlist → 404 for everyone in both.

import type { LayoutServerLoad } from "./$types";
import { error, redirect } from "@sveltejs/kit";
import { env } from "$lib/server/config/env.js";

export const load: LayoutServerLoad = async ({ locals, url }) => {
  if (!locals.user) {
    throw redirect(303, `/login?next=${encodeURIComponent(url.pathname)}`);
  }
  const email = locals.user.email.toLowerCase();
  if (!env.ADMIN_EMAIL_ALLOWLIST.has(email)) {
    // 404 not 403 — same shape as the API-layer adminAllowlist response
    // (AGENTS.md Privacy invariant 2: tenant-owned cross-tenant access
    // returns 404; for /admin/* the existence of the area itself is the
    // secret). The error boundary renders the standard 404 page WITHOUT
    // the admin breadcrumb chrome (since this layout's load threw).
    throw error(404, "Not Found");
  }
  return {};
};
