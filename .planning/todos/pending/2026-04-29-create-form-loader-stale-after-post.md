# 2026-04-29 — create-form pages: loader-stale-after-POST sibling bugs

**Surfaces:**
- `src/routes/games/+page.svelte` line 61: `await goto(\`/games/\${created.id}\`)` after `POST /api/games`
- `src/routes/sources/new/+page.svelte` line 143: `await goto("/sources")` after `POST /api/sources`

**Root cause (same as Plan 02.1-19 /events/new fix):**
SvelteKit's `goto()` does NOT automatically re-run the destination page's `+page.server.ts` loader. After creating a new game / source via POST, navigating to the list / detail page can show stale data unless the loader is told to re-run. Without `await invalidateAll()` before the `goto()`, the user must hard-refresh to see what they just created.

**Fix (one line each):**
```typescript
import { goto, invalidateAll } from "$app/navigation";
// ...
await invalidateAll();
await goto("/destination");
```

**Why filed as todo, not fixed in Plan 02.1-19:**
Plan 02.1-19's gap is filed against `/events/new` specifically. Per Plan 02.1-19's planner note ("Other surfaces are not in scope unless UAT surfaces them"), the diff stays scoped. UAT round 2 already validated /events/new fix; sibling surfaces flagged here for the next polish phase or a separate fix PR.

**Priority:** P2 — same data-staleness UX as the round-2 UAT issue, but on lower-traffic flows.

**Surfaced:** Plan 02.1-19 Task 9 grep audit.
