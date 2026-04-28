import type { PageServerLoad } from "./$types";
import { listSteamKeys } from "$lib/server/services/api-keys-steam.js";
import { toApiKeySteamDto } from "$lib/server/dto.js";

/**
 * /keys/steam loader — list the caller's Steam Web API keys (Plan 02-10).
 *
 * D-13 (multi-key): the response is an array of zero or more keys; the UI
 * renders the same list+form layout for every length (the empty branch
 * shows the EmptyState above the form; the populated branch shows the
 * list above the "Add another" form). NEVER ciphertext — every row goes
 * through `toApiKeySteamDto` server-side (D-39).
 *
 * Direct service call (NOT fetch('/api/...')): the API and the page render
 * in the same Node process, so an HTTP roundtrip back to Hono would
 * deadlock SvelteKit's internal_fetch (Hono routes don't live in
 * SvelteKit's route tree — see post-execution P0 fix in SUMMARY).
 * `listSteamKeys` enforces the same `userId` scoping the HTTP route does;
 * `toApiKeySteamDto` is the load-bearing ciphertext stripper.
 */
export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) return { keys: [] };
  const rows = await listSteamKeys(locals.user.id);
  return { keys: rows.map(toApiKeySteamDto) };
};
