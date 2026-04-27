import type { PageServerLoad } from "./$types";

/**
 * /keys/steam loader — list the caller's Steam Web API keys (Plan 02-10).
 *
 * D-13 (multi-key): the response is an array of zero or more keys; the UI
 * renders the same list+form layout for every length (the empty branch
 * shows the EmptyState above the form; the populated branch shows the
 * list above the "Add another" form). NEVER ciphertext — every row goes
 * through `toApiKeySteamDto` server-side (D-39).
 */
export const load: PageServerLoad = async ({ fetch, parent }) => {
  const { user } = await parent();
  if (!user) return { keys: [] };

  const res = await fetch("/api/api-keys/steam");
  if (!res.ok) return { keys: [] };
  return { keys: (await res.json()) as Array<unknown> };
};
