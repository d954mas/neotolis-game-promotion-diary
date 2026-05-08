// Phase 3.0 Plan 13 — /admin page loader. (Originally /admin/quota; flattened
// to /admin per post-build feedback — single page with all admin tools.)
//
// Fetches /api/admin/quota via SvelteKit's `fetch` helper. The API
// middleware chain (Plan 03.0-07) gates the route:
//   - anonymous → 401 (handled by tenantScope BEFORE adminAllowlist)
//   - non-allowlisted authenticated → 404 (adminAllowlist)
//   - allowlisted → 200 with { today, keys, audit }
//
// On 404 we throw SvelteKit's `error(404)`, which renders the standard 404
// page — UI-SPEC error state §"/admin SvelteKit loader receives 404":
// admin-deny is intentionally indistinguishable from an unknown URL (D-16).
// On 5xx we throw 500 — consumed by the page boundary if/when one is
// rendered (the existing app's default error page suffices).
//
// Why fetch (not direct service call)?
//   The /sources +page.server.ts pattern uses direct service imports because
//   that loader runs in the same Node process as the API. Here we deliberately
//   route through HTTP because the auth + allowlist gates live in Hono
//   middleware — calling `loadAdminQuotaPage()` directly would bypass them
//   and require re-implementing the gate at the SvelteKit layer. Single
//   source of truth: the gate is at /api/admin/* in app.ts, full stop.

import { error } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import type { QuotaKeyRow, ServiceAuditEntry } from "$lib/server/services/admin-quota-read.js";

interface AdminQuotaResponse {
  today: string;
  keys: QuotaKeyRow[];
  audit: ServiceAuditEntry[];
}

export const load: PageServerLoad = async ({ fetch }) => {
  const resp = await fetch("/api/admin/quota");
  // 401 (anonymous) and 404 (authenticated-not-allowlisted) both render as
  // 404 — admin existence is the secret (D-16 self-host parity). Anonymous
  // browsing of /admin must NOT distinguish "you need to log in" from "this
  // URL doesn't exist for you" — same shape as the deny-after-auth case.
  if (resp.status === 401 || resp.status === 404) {
    throw error(404, "Not Found");
  }
  if (!resp.ok) {
    throw error(500, "admin quota load failed");
  }
  return (await resp.json()) as AdminQuotaResponse;
};
