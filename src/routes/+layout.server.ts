import type { LayoutServerLoad } from "./$types";
import { redirect } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { user } from "$lib/server/db/schema/auth.js";
import { env } from "$lib/server/config/env.js";

/**
 * SvelteKit layout load (Plan 01-07 — Wave 4; Plan 02-10 — Wave 3).
 *
 *   1. Pass DTO-projected user (or null) to all pages so layouts can render
 *      auth-aware UI without re-querying the session (P3 discipline —
 *      `locals.user` is already projected by `src/hooks.server.ts`).
 *   2. Protected-paths redirect: anonymous requests to any path in
 *      `PROTECTED_PATHS` are redirected to `/login?next=<originalPath>`
 *      (PRIV-01).
 *   3. Theme cookie ↔ DB reconciliation (D-40 cookie-wins on signin).
 *      When an authenticated user has both a `__theme` cookie and a DB
 *      `themePreference` that disagree, COOKIE WINS — write the cookie value
 *      back to the DB. When the cookie is absent and the DB has a
 *      non-default value, hydrate the cookie from the DB so the next
 *      browser request hits the right `data-theme` on the first byte.
 *      The reconciliation is a sync (not a user action) so no audit row is
 *      written and no `AppError` ever bubbles out — the request continues
 *      regardless of the DB write outcome.
 *   4. Surface `RETENTION_DAYS` to every page via the layout pass-through.
 *      `+page.server.ts` files in this phase MUST NOT read env vars via the
 *      Node global directly (CLAUDE.md / AGENTS.md hard rule — only
 *      `src/lib/server/config/env.ts` may); they consume the value via
 *      `await parent()`.
 *
 * Phase 2 extends `PROTECTED_PATHS` from Phase 1's empty array to the six
 * authenticated-only top-level paths shipped by Plan 02-10.
 */
const PROTECTED_PATHS: string[] = [
  "/games",
  "/events",
  "/audit",
  "/accounts",
  "/keys",
  "/settings",
];

const VALID_THEMES = new Set(["light", "dark", "system"] as const);

export const load: LayoutServerLoad = async ({ locals, url, cookies, request }) => {
  const isProtected = PROTECTED_PATHS.some((p) => url.pathname.startsWith(p));
  if (isProtected && !locals.user) {
    throw redirect(303, `/login?next=${encodeURIComponent(url.pathname)}`);
  }

  // Reconcile cookie ↔ DB. Default to whatever themeHandle resolved (cookie
  // value if valid, "system" otherwise). Then, when authenticated, see
  // whether the DB disagrees.
  let theme: "light" | "dark" | "system" = locals.theme;

  if (locals.user) {
    const cookieTheme = cookies.get("__theme");
    const cookieThemeValid =
      cookieTheme !== undefined && (VALID_THEMES as Set<string>).has(cookieTheme);

    const [row] = await db
      .select({ themePreference: user.themePreference })
      .from(user)
      .where(eq(user.id, locals.user.id))
      .limit(1);
    const dbTheme = row?.themePreference ?? "system";

    if (cookieThemeValid && cookieTheme !== dbTheme) {
      // Cookie wins (D-40). Write the cookie value back to the DB so the
      // next signin from a different browser sees the user's most recent
      // intent. No audit (this is a sync, not a user action). Bump
      // updatedAt so admin tooling can spot the reconciliation moment.
      await db
        .update(user)
        .set({ themePreference: cookieTheme as string, updatedAt: new Date() })
        .where(eq(user.id, locals.user.id));
      theme = cookieTheme as "light" | "dark" | "system";
    } else if (!cookieThemeValid && dbTheme !== "system") {
      // No (or rogue) cookie + non-default DB value → hydrate the cookie
      // from the DB. Subsequent SSR renders read the cookie via
      // themeHandle and apply the right `data-theme` on the first byte.
      cookies.set("__theme", dbTheme, {
        path: "/",
        sameSite: "lax",
        httpOnly: false,
        maxAge: 60 * 60 * 24 * 365,
        secure: request.url.startsWith("https://"),
      });
      theme = dbTheme as "light" | "dark" | "system";
    }
  }

  return {
    user: locals.user ?? null,
    theme,
    retentionDays: env.RETENTION_DAYS,
  };
};
