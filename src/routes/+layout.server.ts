import type { LayoutServerLoad } from './$types';

// Pass the DTO-projected user from event.locals (populated by
// src/hooks.server.ts) to every page so layouts and pages can render
// auth-aware UI without re-querying the session.
export const load: LayoutServerLoad = ({ locals }) => ({
  user: locals.user ?? null,
});
