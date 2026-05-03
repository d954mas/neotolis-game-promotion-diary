import type { PageServerLoad } from "./$types";
import { env } from "$lib/server/config/env.js";

// Phase 02.2 Plan 02.2-05 — public Terms of Service route (D-10, D-11, D-S4).
//
// SUPPORT_EMAIL + per-user limits (LIMIT_GAMES_PER_USER /
// LIMIT_SOURCES_PER_USER / LIMIT_EVENTS_PER_DAY) injected from
// server-side load so the rendered ToS reflects the running instance's
// actual quotas (a self-hoster who raises LIMIT_GAMES_PER_USER in .env
// gets the new number in ToS without code changes — D-31 self-host parity).

export const load: PageServerLoad = () => {
  return {
    supportEmail: env.SUPPORT_EMAIL,
    gamesLimit: env.LIMIT_GAMES_PER_USER,
    sourcesLimit: env.LIMIT_SOURCES_PER_USER,
    eventsLimit: env.LIMIT_EVENTS_PER_DAY,
    lastUpdated: "2026-05-01",
  };
};
