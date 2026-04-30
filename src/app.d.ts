// SvelteKit ambient types — populates App.Locals with the DTO shapes that
// `src/hooks.server.ts` writes after reading the Better Auth session, plus
// the resolved theme (Plan 02-09, UX-01).
//
// Plan 05 ships the actual UserDto / SessionDto definitions in
// $lib/server/dto.ts; this file only re-exports the type names into the
// global App namespace so every +page.server.ts and +layout.server.ts can
// reference `locals.user` with full type safety.
//
// `theme` is non-optional — themeHandle in src/hooks.server.ts always
// resolves it to one of the three valid values (cookie wins; falls back to
// "system" when missing or invalid).

import type { UserDto, SessionDto } from "$lib/server/dto.js";

declare global {
  namespace App {
    interface Locals {
      user?: UserDto;
      session?: SessionDto;
      theme: "light" | "dark" | "system";
    }
  }
}

export {};
