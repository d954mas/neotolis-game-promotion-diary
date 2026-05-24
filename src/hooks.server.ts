// SvelteKit server-side hook.
//
// Composes two handles via `sequence`:
//
//   authHandle  — reads the Better Auth session via auth.api.getSession({ headers })
//                 and populates event.locals.user / event.locals.session with the
//                 DTO-projected shape (never put raw DB rows on locals).
//                 Pages and load functions read from event.locals only.
//
//   themeHandle — reads the `__theme` cookie BEFORE the page renders and
//                 writes the value into event.locals.theme. Then
//                 transformPageChunk replaces the literal `%theme%`
//                 placeholder inside `<html data-theme="%theme%">`
//                 (src/app.html) so the first byte the browser sees
//                 already carries the right attribute — no FOUC, no
//                 theme flash.
//
// Why two handles instead of one: SvelteKit's `sequence` makes the composition
// explicit and lets the theme hook be evolved (e.g. add A/B-test cookie reads
// later) without touching the auth lookup. Keeping the slices orthogonal
// also keeps each hook readable.
//
// transformPageChunk fires for every chunk SvelteKit streams; replacing on each
// chunk is correct because `%theme%` appears exactly once at the very top of
// app.html (the opening <html> tag) and any sane HTML response will carry that
// chunk first. The replace is a no-op on every later chunk.

// Side-effect import: sets DNS IPv4-first resolution at module load.
// Mirrors src/server.ts so the SvelteKit `vite preview` / `vite dev` /
// production `node` entrypoints all hit the same single-shot call.
// Node's module cache dedupes — second import is a no-op.
import "./lib/server/integrations/dns-bootstrap.js";
import { sequence } from "@sveltejs/kit/hooks";
import type { Handle } from "@sveltejs/kit";
import { auth } from "./lib/auth.js";
import { toUserDto, toSessionDto } from "./lib/server/dto.js";

const VALID_THEMES = new Set(["light", "dark", "system"]);

// Exported for the theme integration test (tests/integration/theme.test.ts)
// — the SSR no-flash assertion calls themeHandle directly with a synthetic
// event so it can inspect transformPageChunk's replacement without booting
// the full SvelteKit handler. Production code path always composes via
// `handle = sequence(authHandle, themeHandle)`.
export const authHandle: Handle = async ({ event, resolve }) => {
  const result = await auth.api.getSession({ headers: event.request.headers });
  if (result) {
    // toUserDto / toSessionDto strip secret-shaped fields and apply the
    // tenant-scope projection.
    event.locals.user = toUserDto(result.user as Parameters<typeof toUserDto>[0]);
    event.locals.session = toSessionDto(result.session as Parameters<typeof toSessionDto>[0]);
  }
  return resolve(event);
};

export const themeHandle: Handle = async ({ event, resolve }) => {
  const cookieValue = event.cookies.get("__theme");
  const theme: "light" | "dark" | "system" =
    cookieValue && VALID_THEMES.has(cookieValue)
      ? (cookieValue as "light" | "dark" | "system")
      : "system";
  event.locals.theme = theme;
  return resolve(event, {
    transformPageChunk: ({ html }) => html.replace("%theme%", theme),
  });
};

export const handle: Handle = sequence(authHandle, themeHandle);
