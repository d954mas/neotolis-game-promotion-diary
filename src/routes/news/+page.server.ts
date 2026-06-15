import type { PageServerLoad } from "./$types";
import { listNews } from "$lib/server/news.js";

// Public /news index. No auth gate (absent from +layout.server.ts
// PROTECTED_PATHS), indexable (handled in +layout.svelte). `user` arrives via
// the layout load so the page can show the anonymous brand bar when signed out.
export const load: PageServerLoad = async () => {
  return { posts: listNews() };
};
