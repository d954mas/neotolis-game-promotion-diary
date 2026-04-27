// /api/me/theme HTTP route — UX-01 server side (Plan 02-08).
//
// POST /api/me/theme
//   body: {theme: 'light'|'dark'|'system'}
//   200:  {theme, from}
//   side-effects: updates user.theme_preference; writes theme.changed audit;
//                 sets `__theme` cookie (Path=/, SameSite=Lax, Max-Age=1y, NO HttpOnly).
//
// Pitfall 5 (UI-SPEC): the cookie is INTENTIONALLY NOT HttpOnly. The theme
// must be readable from `document.cookie` so SvelteKit's hooks.server.ts can
// honor it on the very first SSR render of every subsequent navigation
// without round-tripping to the DB. Theme is not a security secret.
//
// Env discipline (CLAUDE.md / AGENTS.md hard rule): this file MUST NOT read
// `process.env`. The Secure cookie flag is derived from `env.NODE_ENV` via
// the SOLE env-reader module `src/lib/server/config/env.ts`. ESLint
// no-restricted-properties enforces the boundary.

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { updateUserTheme } from "../../services/me.js";
import { env } from "../../config/env.js";
import { getAuditContext } from "../middleware/audit-ip.js";
import { mapErr, type RouteVars } from "./_shared.js";

const themeSchema = z.object({
  theme: z.enum(["light", "dark", "system"]),
});

export const meThemeRoutes = new Hono<RouteVars>();

meThemeRoutes.post(
  "/me/theme",
  zValidator("json", themeSchema, (r, c) => {
    if (!r.success) {
      return c.json({ error: "validation_failed", details: r.error.issues }, 422);
    }
  }),
  async (c) => {
    const ctx = getAuditContext(c);
    const { theme } = c.req.valid("json");
    try {
      const result = await updateUserTheme(ctx.userId, theme, ctx.ipAddress);
      // Cookie attributes:
      //   Path=/       — site-wide
      //   SameSite=Lax — protected against most CSRF; theme is non-sensitive
      //   Max-Age=1y   — survives session expiry (theme is preference, not auth)
      //   NO HttpOnly  — Pitfall 5 (UI-SPEC): SvelteKit's client-side runtime
      //                  reads document.cookie to flip CSS classes pre-paint
      //   Secure       — only when NODE_ENV === "production". Local dev runs
      //                  over plain HTTP; smoke tests do too. Behind a TLS-
      //                  terminating proxy in production this is set.
      const secureFlag = env.NODE_ENV === "production" ? "; Secure" : "";
      c.header(
        "set-cookie",
        `__theme=${result.theme}; Path=/; SameSite=Lax; Max-Age=31536000${secureFlag}`,
      );
      return c.json({ theme: result.theme, from: result.from }, 200);
    } catch (err) {
      return mapErr(c, err, "POST /api/me/theme");
    }
  },
);
