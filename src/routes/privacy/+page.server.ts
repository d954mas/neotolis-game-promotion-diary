import type { PageServerLoad } from "./$types";
import { env } from "$lib/server/config/env.js";

// Public Privacy Policy route.
//
// SUPPORT_EMAIL + RETENTION_DAYS injected from server-side load so a
// self-host operator can override via .env without forking the template
// (SaaS-leak grep tripwire — no hardcoded `neotolis.games@gmail.com`
// in the route file itself; the literal lives only in the operator's
// `.env` and is rendered at request time via {data.supportEmail}).
//
// `lastUpdated` is a hardcoded ISO date — bump on material changes
// (the date is the legal-compliance audit point, not an env override).

export const load: PageServerLoad = () => {
  return {
    supportEmail: env.SUPPORT_EMAIL,
    retentionDays: env.RETENTION_DAYS,
    worstCaseDays: env.RETENTION_DAYS + 30,
    lastUpdated: "2026-05-01",
  };
};
