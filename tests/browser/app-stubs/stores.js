// Inert $app/stores stub for the vitest browser project (legacy store API).
// See vitest.config.ts $appAlias.

import { readable } from "svelte/store";

const noopPage = {
  url: new URL("http://localhost/"),
  params: {},
  route: { id: null },
  status: 200,
  error: null,
  data: {},
  form: null,
  state: {},
};

export const page = readable(noopPage);
export const navigating = readable(null);
export const updated = { subscribe: readable(false).subscribe, check: () => Promise.resolve(false) };
export function getStores() {
  return { page, navigating, updated };
}
