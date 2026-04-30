import type { PageServerLoad } from "./$types";
import { redirect } from "@sveltejs/kit";
import { listSessions } from "$lib/server/services/sessions.js";
import { toSessionDto } from "$lib/server/dto.js";

/**
 * /settings loader (Plan 02.1-09 extension).
 *
 * Plan 02-10 baseline: surfaces user / theme / retentionDays from the layout
 * pass-through. Plan 02.1-09 ADDS the active-sessions list (UI-SPEC: new
 * section "Active sessions") + the current-session id so the SessionsList
 * component can mark the current row.
 *
 * env-discipline (CLAUDE.md / AGENTS.md): only src/lib/server/config/env.ts
 * may read process.env. RETENTION_DAYS comes from the layout pass-through;
 * this loader fetches sessions via the service layer (Pattern 1 tenant scope)
 * and reads the current sessionId from event.locals.session (set by
 * src/hooks.server.ts authHandle).
 */
export const load: PageServerLoad = async ({ parent, locals, url }) => {
  if (!locals.user) {
    throw redirect(303, `/login?next=${encodeURIComponent(url.pathname)}`);
  }
  const { user, theme, retentionDays } = await parent();
  const sessionRows = await listSessions(locals.user.id).catch(() => []);
  return {
    user,
    theme,
    retentionDays,
    sessions: sessionRows.map(toSessionDto),
    currentSessionId: locals.session?.id ?? "",
  };
};
