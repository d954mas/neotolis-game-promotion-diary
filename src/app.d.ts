// SvelteKit ambient types — populates App.Locals with the DTO shapes that
// `src/hooks.server.ts` writes after reading the Better Auth session.
//
// Plan 05 ships the actual UserDto / SessionDto definitions in
// $lib/server/dto.ts; this file only re-exports the type names into the
// global App namespace so every +page.server.ts and +layout.server.ts can
// reference `locals.user` with full type safety.

import type { UserDto, SessionDto } from "$lib/server/dto.js";

declare global {
  namespace App {
    interface Locals {
      user?: UserDto;
      session?: SessionDto;
    }
  }
}

export {};
