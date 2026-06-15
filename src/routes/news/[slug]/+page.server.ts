import type { PageServerLoad } from "./$types";
import { error } from "@sveltejs/kit";
import { getNewsPost } from "$lib/server/news.js";

// Public /news/[slug] article. Unknown slug → 404 (the content is the same for
// everyone, so there is no tenant 404-vs-403 concern here).
export const load: PageServerLoad = async ({ params }) => {
  const post = getNewsPost(params.slug);
  if (!post) throw error(404, "Not found");
  return { post };
};
