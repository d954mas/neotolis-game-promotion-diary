import type { PageServerLoad } from "./$types";
import { redirect } from "@sveltejs/kit";

/**
 * /settings/account loader (Plan 02.2-04).
 *
 * Hosts the Export + Delete UI for D-15 / D-16 (account portability +
 * soft-delete with 60-day grace). The endpoint surface itself ships in
 * Plan 02.2-03; this loader is a pure pass-through over the parent layout's
 * shared data — `user` (with the new `deletedAt` projection from
 * toUserDto) and `retentionDays` (sourced from env.RETENTION_DAYS via the
 * root +layout.server.ts pass-through).
 *
 * env-discipline (CLAUDE.md / AGENTS.md): only src/lib/server/config/env.ts
 * may read process.env. RETENTION_DAYS comes from the layout pass-through;
 * this loader does NOT read env directly.
 */
export const load: PageServerLoad = async ({ parent, locals, url }) => {
  if (!locals.user) {
    throw redirect(303, `/login?next=${encodeURIComponent(url.pathname)}`);
  }
  const { user, theme, retentionDays } = await parent();
  return {
    user,
    theme,
    retentionDays,
  };
};
