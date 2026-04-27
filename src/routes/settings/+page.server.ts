import type { PageServerLoad } from "./$types";

/**
 * /settings loader (Plan 02-10).
 *
 * Reads `retentionDays` from the layout-server pass-through (NOT the Node
 * env directly — only `src/lib/server/config/env.ts` may read it per
 * CLAUDE.md / AGENTS.md hard rule). The +layout.server.ts surfaces
 * `env.RETENTION_DAYS` on every page load; this loader just forwards it.
 *
 * Theme is also surfaced via the layout (resolved by themeHandle in
 * src/hooks.server.ts and reconciled in +layout.server.ts), so this loader
 * has nothing to fetch — the page reads everything from `parent()` data.
 */
export const load: PageServerLoad = async ({ parent }) => {
  const { user, theme, retentionDays } = await parent();
  return { user, theme, retentionDays };
};
