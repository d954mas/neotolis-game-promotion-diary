import type { PageServerLoad } from "./$types";

/**
 * /audit loader — paginated audit-log read (Plan 02-10).
 *
 * The cursor and action filter are URL query parameters so the browser's
 * back/forward stack reflects pagination state. The route itself is
 * parameterless; the loader forwards `cursor` and `action` to GET /api/audit
 * which validates both server-side via zod (Plan 02-08).
 */
export const load: PageServerLoad = async ({ fetch, url, parent }) => {
  const { user } = await parent();
  if (!user) return { rows: [], nextCursor: null, action: "all", cursor: null };

  const cursor = url.searchParams.get("cursor");
  const action = url.searchParams.get("action") ?? "all";

  const params = new URLSearchParams();
  if (cursor) params.set("cursor", cursor);
  if (action && action !== "all") params.set("action", action);
  const qs = params.toString();
  const path = qs ? `/api/audit?${qs}` : "/api/audit";

  const res = await fetch(path);
  if (!res.ok) {
    return { rows: [], nextCursor: null, action, cursor };
  }
  const body = (await res.json()) as { rows: unknown[]; nextCursor: string | null };
  return {
    rows: body.rows,
    nextCursor: body.nextCursor,
    action,
    cursor,
  };
};
