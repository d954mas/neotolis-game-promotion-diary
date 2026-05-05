// Phase 3.0 Plan 13 — admin shell loader.
//
// Allowlist enforcement happens at the /api/admin/* middleware chain
// (Plan 03.0-07 — adminAllowlist responds 404 directly to non-allowlisted
// callers). This layout itself does NOT do its own check — child pages
// fetch /api/admin/* and hit 404 if the user isn't allowlisted; SvelteKit's
// error boundary then renders the standard 404 page. The result is
// indistinguishable from URL-not-found per UI-SPEC error states (D-16
// self-host parity by construction — empty allowlist = 404 for everyone).
//
// Leaving the allowlist gate to the API layer means there is exactly one
// place that decides who sees /admin/*: env.ADMIN_EMAIL_ALLOWLIST + the
// adminAllowlist middleware. No second source of truth here.

import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async () => ({});
