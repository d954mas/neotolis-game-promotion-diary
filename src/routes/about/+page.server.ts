import type { PageServerLoad } from "./$types";
import { env } from "$lib/server/config/env.js";

// Phase 02.2 Plan 02.2-05 — public /about route (D-S4).
//
// SUPPORT_EMAIL + DOMAIN injected from server-side load. DOMAIN gates
// the canonical-instance link — empty in self-host / CI / dev so the
// link only appears on the canonical author-instance.

export const load: PageServerLoad = () => {
  return {
    supportEmail: env.SUPPORT_EMAIL,
    domain: env.DOMAIN,
  };
};
