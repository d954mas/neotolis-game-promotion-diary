---
phase: 02-ingest-secrets-and-audit
plan: 10
type: execute
wave: 3
depends_on: [02-08-routes-and-sweeps, 02-09-theme-components-paraglide]
files_modified:
  - src/routes/+layout.svelte
  - src/routes/+layout.server.ts
  - src/routes/games/+page.svelte
  - src/routes/games/+page.server.ts
  - src/routes/games/[gameId]/+page.svelte
  - src/routes/games/[gameId]/+page.server.ts
  - src/routes/events/+page.svelte
  - src/routes/events/+page.server.ts
  - src/routes/audit/+page.svelte
  - src/routes/audit/+page.server.ts
  - src/routes/accounts/youtube/+page.svelte
  - src/routes/accounts/youtube/+page.server.ts
  - src/routes/keys/steam/+page.svelte
  - src/routes/keys/steam/+page.server.ts
  - src/routes/settings/+page.svelte
  - src/routes/settings/+page.server.ts
  - src/routes/+page.svelte
autonomous: true
requirements: [GAMES-01, GAMES-02, GAMES-03, GAMES-04a, KEYS-03, KEYS-04, KEYS-05, KEYS-06, INGEST-02, INGEST-03, INGEST-04, EVENTS-01, EVENTS-02, EVENTS-03, PRIV-02, UX-01, UX-02, UX-03]
requirements_addressed: [GAMES-01, GAMES-02, GAMES-03, GAMES-04a, KEYS-03, KEYS-04, KEYS-05, KEYS-06, INGEST-02, INGEST-03, INGEST-04, EVENTS-01, EVENTS-02, EVENTS-03, PRIV-02, UX-01, UX-02, UX-03]
must_haves:
  truths:
    - "+layout.svelte imports app.css ONCE and renders <AppHeader> + <Nav> at every authenticated route"
    - "+layout.server.ts gates protected routes (PROTECTED_PATHS extends to /games, /events, /audit, /accounts, /keys, /settings) and reconciles cookie ↔ DB theme on signin"
    - "Each new page has +page.svelte (UI) + +page.server.ts (loader calling /api/* via fetch with the user's cookie)"
    - "Pages compose the Plan 09 components — no new component logic introduced here"
    - "Every page renders <EmptyState> in the empty branch with Paraglide-driven copy"
    - "Cookie-wins reconciliation: if cookie + user.themePreference disagree at signin, cookie wins and writes back to DB"
  artifacts:
    - path: "src/routes/+layout.svelte"
      provides: "Imports app.css; renders AppHeader + Nav for authenticated; passes data.user from layout-server"
      contains: "AppHeader"
    - path: "src/routes/+layout.server.ts"
      provides: "Extended PROTECTED_PATHS list + cookie ↔ DB theme reconciliation; passes locals.theme to all pages"
      contains: "PROTECTED_PATHS"
    - path: "src/routes/games/+page.svelte"
      provides: "List page with <EmptyState> + <GameCard> grid + new-game form"
      contains: "GameCard"
    - path: "src/routes/games/[gameId]/+page.svelte"
      provides: "Detail page with <PasteBox>, listings panel, channels panel, items panel, events timeline"
      contains: "PasteBox"
    - path: "src/routes/audit/+page.svelte"
      provides: "Audit list with <ActionFilter>, <AuditRow> stack/table, <CursorPager>"
      contains: "AuditRow"
    - path: "src/routes/keys/steam/+page.svelte"
      provides: "Empty-state OR <KeyMaskRow> + <ReplaceKeyForm>"
      contains: "KeyMaskRow"
    - path: "src/routes/settings/+page.svelte"
      provides: "<ThemeToggle> + read-only retention badge + sign-out / sign-out-all buttons"
      contains: "ThemeToggle"
  key_links:
    - from: "src/routes/+layout.svelte"
      to: "src/app.css"
      via: "Single global stylesheet import"
      pattern: "import.*app\\.css"
    - from: "src/routes/games/+page.server.ts"
      to: "/api/games"
      via: "fetch GET /api/games via SvelteKit's `fetch` with cookie forwarding"
      pattern: "/api/games"
    - from: "src/routes/games/[gameId]/+page.svelte"
      to: "src/lib/components/PasteBox.svelte"
      via: "PasteBox calls /api/items/youtube via the orchestrator from Plan 06"
      pattern: "PasteBox"
---

<objective>
Compose the Plan 09 components into 8 SvelteKit pages: dashboard / games-list / game-detail / events / audit / accounts/youtube / keys/steam / settings. Wire the +page.server.ts loaders to the Plan 08 HTTP routes (using SvelteKit's `fetch` so cookies forward correctly). Extend the existing protected-paths list and cookie ↔ DB theme reconciliation in `+layout.server.ts`. The pages are mostly composition — every component contract was settled in Plan 09; this plan exercises them.

Purpose: Phase 2 ships an end-to-end usable product. This is the page where it becomes visible. UX-02 (360px) is verified at the page level by Plan 11; this plan focuses on page COMPOSITION.

Output: 1 amended root layout, 1 amended root layout-server (PROTECTED_PATHS extension + reconciliation), 7 new page directories under `src/routes/`, each with +page.svelte + +page.server.ts.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@src/routes/+layout.server.ts
@src/routes/+layout.svelte
@src/routes/+page.svelte
@src/routes/login/+page.svelte
@.planning/phases/02-ingest-secrets-and-audit/02-UI-SPEC.md
@.planning/phases/02-ingest-secrets-and-audit/02-09-SUMMARY.md
@.planning/phases/02-ingest-secrets-and-audit/02-08-SUMMARY.md

<interfaces>
<!-- Phase 1 +layout.server.ts (current shape):
const PROTECTED_PATHS: string[] = [];   // empty
export const load = ({ locals, url }) => {
  if (PROTECTED_PATHS.some(p => url.pathname.startsWith(p)) && !locals.user) throw redirect(303, `/login?next=...`);
  return { user: locals.user ?? null };
};

Phase 2 extends PROTECTED_PATHS to ['/games', '/events', '/audit', '/accounts', '/keys', '/settings']
AND adds the theme cookie ↔ DB reconciliation step.
-->

<!-- SvelteKit fetch in +page.server.ts (load function):
export const load = async ({ fetch, url, parent }) => {
  const { user } = await parent();
  if (!user) return { rows: [] };
  const res = await fetch('/api/games');   // uses the request's cookies
  const games = await res.json();
  return { games };
};
-->

<!-- Page-by-page surface inventory (UI-SPEC §"Page-by-Page Surface Inventory"):

/                — dashboard, lightly extended (links to /games, /events, /audit)
/games           — list with EmptyState or GameCard grid + soft-deleted toggle
/games/[gameId]  — detail with PasteBox, listings panel, channels panel, items panel, events timeline
/events          — global timeline list with EventRow grouped by month
/audit           — ActionFilter + AuditRow stack/table + CursorPager
/accounts/youtube — ChannelRow list + add-channel form
/keys/steam      — empty-state or KeyMaskRow + ReplaceKeyForm
/settings        — ThemeToggle + retention badge + sign-out buttons
-->
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Root layout + layout-server (protected paths + theme reconciliation) + dashboard touch-up</name>
  <files>src/routes/+layout.svelte, src/routes/+layout.server.ts, src/routes/+page.svelte</files>
  <read_first>
    - src/routes/+layout.server.ts (Phase 1 — empty PROTECTED_PATHS array + comment "Phase 2 will add: '/games', '/settings'")
    - src/routes/+layout.svelte (Phase 1 — minimal; this plan adds AppHeader + Nav for authenticated routes)
    - src/routes/+page.svelte (Phase 1 — dashboard placeholder; this plan adds links to /games, /events, /audit, /settings)
    - src/lib/server/services/me.ts (Plan 08 — `updateUserTheme`; reuse for the cookie-wins reconciliation)
  </read_first>
  <action>
    **A. AMEND `src/routes/+layout.server.ts`** — extend PROTECTED_PATHS + add theme reconciliation:

    ```typescript
    import type { LayoutServerLoad } from "./$types";
    import { redirect } from "@sveltejs/kit";
    import { db } from "$lib/server/db/client.js";
    import { user } from "$lib/server/db/schema/auth.js";
    import { eq } from "drizzle-orm";
    import { writeAudit } from "$lib/server/audit.js";

    // Phase 2: every route except '/' and '/login' is auth-gated.
    const PROTECTED_PATHS: string[] = [
      "/games",
      "/events",
      "/audit",
      "/accounts",
      "/keys",
      "/settings",
    ];

    export const load: LayoutServerLoad = async ({ locals, url, cookies, request }) => {
      const isProtected = PROTECTED_PATHS.some((p) => url.pathname.startsWith(p));
      if (isProtected && !locals.user) {
        throw redirect(303, `/login?next=${encodeURIComponent(url.pathname)}`);
      }

      // Theme cookie ↔ DB reconciliation (D-40 cookie-wins on signin).
      // Fires once per request when an authenticated user has both a cookie value and a DB
      // value that disagree. Cookie wins; write the cookie value back to DB. The audit
      // row is written via writeAudit (no AppError on failure — never break the request).
      let theme = locals.theme;
      if (locals.user) {
        const cookieTheme = cookies.get("__theme");
        const [row] = await db.select({ themePreference: user.themePreference }).from(user).where(eq(user.id, locals.user.id)).limit(1);
        const dbTheme = row?.themePreference ?? "system";

        if (cookieTheme && cookieTheme !== dbTheme && (["light", "dark", "system"] as const).includes(cookieTheme as any)) {
          // Cookie wins — write back to DB (no audit; this is a sync, not a user action).
          await db.update(user).set({ themePreference: cookieTheme, updatedAt: new Date() }).where(eq(user.id, locals.user.id));
          theme = cookieTheme as "light" | "dark" | "system";
        } else if (!cookieTheme && dbTheme !== "system") {
          // No cookie — hydrate cookie from DB.
          cookies.set("__theme", dbTheme, {
            path: "/",
            sameSite: "lax",
            httpOnly: false,
            maxAge: 60 * 60 * 24 * 365,
            secure: !!request.url.startsWith("https://"),
          });
          theme = dbTheme as "light" | "dark" | "system";
        }
      }

      return { user: locals.user ?? null, theme };
    };
    ```

    Note: this is the wire that flips Plan 09's `02-09: UX-01 cookie wins on signin reconciliation` test from `it.skip` to `it`. If Plan 09 already enabled it, ensure the test passes against this wired logic. If Plan 09 left it `it.skip`, flip it now AND retitle the annotation to `02-10:` (the gating annotation matches the implementing plan).

    **B. AMEND `src/routes/+layout.svelte`** — import app.css once, render AppHeader + Nav for authenticated routes:

    ```svelte
    <script lang="ts">
      import "../app.css";
      import AppHeader from "$lib/components/AppHeader.svelte";
      import Nav from "$lib/components/Nav.svelte";
      import type { LayoutData } from "./$types";

      let { data, children } = $props<{ data: LayoutData; children: any }>();
    </script>

    {#if data.user}
      <AppHeader user={data.user} />
      <Nav />
    {/if}

    <main>
      {@render children()}
    </main>

    <style>
      main {
        max-width: 1024px;
        margin: 0 auto;
        padding: var(--space-md);
      }
      @media (min-width: 768px) {
        main { padding: var(--space-2xl); }
      }
    </style>
    ```

    The `Nav` component reads the current pathname via `$page` to determine `active` (UI-SPEC §"Layout & Responsive Contract"). Plan 09's Nav must use SvelteKit's `$page` store (or pass `active` as a prop and have +layout pass it). Cleaner: pass `pathname={$page.url.pathname}` and let Nav decide active itself.

    **C. AMEND `src/routes/+page.svelte`** — dashboard renders links to /games, /events, /audit, /settings (UI-SPEC §"/ (existing dashboard, lightly extended)"):

    ```svelte
    <script lang="ts">
      import * as m from "$lib/paraglide/messages.js";
      import type { PageData } from "./$types";
      let { data } = $props<{ data: PageData }>();
    </script>

    {#if data.user}
      <h1>{m.dashboard_title()}</h1>
      <p>{m.dashboard_welcome_intro({ name: data.user.name })}</p>
      <nav class="dashboard-links">
        <a href="/games">Games</a>
        <a href="/events">Events</a>
        <a href="/audit">Audit log</a>
        <a href="/settings">Settings</a>
      </nav>
    {:else}
      <h1>{m.app_title()}</h1>
      <p>{m.dashboard_unauth_intro()}</p>
      <a href="/login">{m.login_continue()}</a>
    {/if}

    <style>
      .dashboard-links { display: flex; gap: var(--space-md); flex-wrap: wrap; }
      .dashboard-links a { color: var(--color-accent); }
    </style>
    ```
  </action>
  <verify>
    <automated>pnpm exec svelte-kit sync && pnpm exec svelte-check 2>&1 | tail -10</automated>
  </verify>
  <done>
    - PROTECTED_PATHS includes the 6 new path prefixes; anonymous request to any of them gets 303 → /login?next=....
    - Cookie ↔ DB reconciliation wired in layout-server; cookie wins when both exist and disagree.
    - +layout.svelte renders AppHeader + Nav for authenticated routes; imports app.css once.
    - Dashboard `/` links to the four primary destinations.
    - svelte-check is clean.
  </done>
</task>

<task type="auto">
  <name>Task 2: Build the 7 new page bundles (each = +page.svelte + +page.server.ts)</name>
  <files>src/routes/games/+page.svelte, src/routes/games/+page.server.ts, src/routes/games/[gameId]/+page.svelte, src/routes/games/[gameId]/+page.server.ts, src/routes/events/+page.svelte, src/routes/events/+page.server.ts, src/routes/audit/+page.svelte, src/routes/audit/+page.server.ts, src/routes/accounts/youtube/+page.svelte, src/routes/accounts/youtube/+page.server.ts, src/routes/keys/steam/+page.svelte, src/routes/keys/steam/+page.server.ts, src/routes/settings/+page.svelte, src/routes/settings/+page.server.ts</files>
  <read_first>
    - .planning/phases/02-ingest-secrets-and-audit/02-UI-SPEC.md §"Page-by-Page Surface Inventory" (every page's primary widgets, success states, error states)
    - All Plan 09 components (the contract surface this plan composes)
    - All Plan 08 routes (the API endpoints +page.server.ts loaders consume via SvelteKit `fetch`)
  </read_first>
  <action>
    Each page bundle has:
    - **`+page.server.ts`**: SSR data loader. Calls `/api/*` via SvelteKit's `fetch` (which automatically forwards request cookies). Returns typed `data` to +page.svelte. Errors translate to SvelteKit `error()` helper.
    - **`+page.svelte`**: Composes Plan 09 components. Renders empty / loading / populated states per UI-SPEC §"Loading & empty contract".

    **Canonical loader sketch (games/+page.server.ts):**

    ```typescript
    import type { PageServerLoad } from "./$types";

    export const load: PageServerLoad = async ({ fetch, url }) => {
      const includeSoftDeleted = url.searchParams.get("includeSoftDeleted") === "true";
      const res = await fetch(`/api/games?includeSoftDeleted=${includeSoftDeleted}`);
      if (!res.ok) {
        return { games: [], softDeletedCount: 0, error: res.status };
      }
      const games = (await res.json()) as Array<unknown>;
      // Soft-deleted count for the "Show 3 deleted games" toggle (UI-SPEC §"/games (NEW — list)")
      const sdRes = await fetch("/api/games?includeSoftDeleted=true");
      const allGames = await sdRes.json() as any[];
      const softDeletedCount = allGames.filter((g: any) => g.deletedAt !== null).length;
      return { games, softDeletedCount };
    };
    ```

    **Page composition for each route (UI-SPEC §"Page-by-Page Surface Inventory" verbatim):**

    1. **`/games` (`src/routes/games/+page.svelte`)**: Use `<EmptyState>` for empty branch (heading=`m.empty_games_heading()`, body=`m.empty_games_body({url:"https://store.steampowered.com/app/1145360/HADES/"})`); for populated branch, `<GameCard>` grid (CSS grid 1col mobile / 2col tablet / 3col desktop); soft-delete toggle as a `<details>` element showing `<RetentionBadge>` rows.

    2. **`/games/[gameId]` (`src/routes/games/[gameId]/+page.svelte`)**: Multi-panel layout (UI-SPEC §"/games/[gameId] (NEW — detail)" enumerates 6 panels). Top: header with title / notes / TBA / tag chips. Mid: store-listings panel (one `<SteamListingRow>` per listing — Plan 09 inventory has no SteamListingRow component, so author it inline OR add to Plan 09's set; planner picks). Channels panel using `<ChannelRow>`. Items panel with `<PasteBox>` at top + items list below. Events timeline panel with `<EventRow>` list + new-event form.
       - Loader fetches: GET `/api/games/${params.gameId}`, GET `/api/games/${params.gameId}/listings`, GET `/api/games/${params.gameId}/youtube-channels`, GET `/api/games/${params.gameId}/items`, GET `/api/games/${params.gameId}/events`. Five fetches in parallel via `Promise.all`. Loader returns `{ game, listings, channels, items, events }`.

    3. **`/events` (`src/routes/events/+page.svelte`)**: GET `/api/games?includeSoftDeleted=false` to populate the game-picker dropdown for the new-event form (Plan 08 doesn't have a global `/api/events` GET — events are scoped per game; the global page lists events ACROSS games by calling `/api/games/${id}/events` for each game and merging — OR plan 08 adds `GET /api/events?gameId=...&kind=...&from=...&to=...`. Given complexity, Plan 10 uses a per-game-fetch + JS merge for Phase 2; Phase 6 polish adds the global endpoint). Render `<EventRow>` grouped by month.

    4. **`/audit` (`src/routes/audit/+page.svelte`)**: Loader calls GET `/api/audit?cursor=<from URL>&action=<from URL>`. Renders `<ActionFilter>` at top, `<AuditRow>` stack on mobile / `<table>` on desktop, `<CursorPager>` at bottom (links update `?cursor=<encoded>` query string).

    5. **`/accounts/youtube` (`src/routes/accounts/youtube/+page.svelte`)**: Loader GET `/api/youtube-channels`. Renders `<EmptyState>` (heading=`m.empty_youtube_channels_heading()`, body=`m.empty_youtube_channels_body({url:"@RickAstleyYT"})`) OR list of `<ChannelRow>`. New-channel form uses POST `/api/youtube-channels`.

    6. **`/keys/steam` (`src/routes/keys/steam/+page.svelte`)** — multi-key UI per CONTEXT.md D-13 / checker B-3 / Plan 02-05 B-3 note:
       - Loader GET `/api/api-keys/steam` returns an array `keys: ApiKeySteamDto[]` of length 0..N.
       - **0 rows** → render `<EmptyState>` (heading=`m.empty_keys_steam_heading()`, body=`m.empty_keys_steam_body({url:"https://steamcommunity.com/dev/apikey"})`) followed by an inline `<ReplaceKeyForm mode="add">` (the "Add your first key" form).
       - **N ≥ 1 rows** → render the list AND the "Add another key" form below it:
         ```svelte
         <ul class="keys-list">
           {#each data.keys as keyDto (keyDto.id)}
             <li>
               <KeyMaskRow
                 keyDto={keyDto}
                 onReplace={() => openReplaceFor(keyDto.id)}
                 onRemove={() => openRemoveDialogFor(keyDto.id)}
               />
             </li>
           {/each}
         </ul>
         <h3>{m.keys_steam_cta_add_another?.() ?? "Add another key"}</h3>
         <ReplaceKeyForm mode="add" />
         ```
       - Each `<KeyMaskRow>` renders `••••••••${keyDto.last4}` plus the row label (so the user can tell rows apart) plus per-row Replace and Remove buttons. Replace opens `<ReplaceKeyForm mode="replace" keyId={keyDto.id}>` (PATCH `/api/api-keys/steam/:id`). Remove opens `<ConfirmDialog isIrreversible>`; on confirm DELETE `/api/api-keys/steam/:id`.
       - On 422 `{error: "steam_key_label_exists"}` from POST or PATCH, the form renders `<InlineError message={m.keys_steam_error_label_exists()}>` next to the label input.
       - **NO `len > 1` ambiguous branch** — the page renders the same list/form layout for `len === 1` and `len > 1`. The single-row case is just the list-of-one.

    7. **`/settings` (`src/routes/settings/+page.svelte`)**: Loader returns `{ retentionDays: env.RETENTION_DAYS }` (NOTE: +page.server.ts can read env via the `$env/static/private` import — but our Phase 1 invariant says only `src/lib/server/config/env.ts` reads process.env. So instead, expose a tiny `GET /api/me/retention` route OR pass the value via `+layout.server.ts` (which already imports from `$lib/server/config/env.js` — preferred). Choose: pass via layout-server's load and consume via `await parent()` in settings page).
       - Renders `<ThemeToggle current={data.theme}>`, retention badge, sign-out + sign-out-all buttons (POST `/api/me/sessions/all`).

    **Form action pattern**: Phase 2 prefers fetch from the page (client-side) rather than SvelteKit form actions, because the API surface lives on Hono not SvelteKit. Each form does:
    ```typescript
    async function submit(e: Event) {
      e.preventDefault();
      const fd = new FormData(e.currentTarget as HTMLFormElement);
      const res = await fetch("/api/<route>", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ /* fields */ }),
      });
      if (!res.ok) {
        const err = await res.json();
        // render <InlineError message={m.<error_key>(err.error)} />
        return;
      }
      // success — invalidate the page data, render toast
      await invalidateAll();
    }
    ```

    Cross-cutting: every page renders `<EmptyState>` for the empty branch with route-specific Paraglide keys; every form uses `<InlineError>` / `<InlineInfo>` per UI-SPEC §"Form interaction contracts"; every destructive button gates through `<ConfirmDialog>`.
  </action>
  <verify>
    <automated>pnpm exec svelte-kit sync && pnpm exec svelte-check 2>&1 | tail -20 && pnpm exec vite build --mode test 2>&1 | tail -10</automated>
  </verify>
  <done>
    - 7 new page directories exist; each has `+page.svelte` + `+page.server.ts`.
    - svelte-check reports zero errors.
    - vite build succeeds (compiled bundle works for production).
    - Every page renders the empty state when its loader returns empty arrays; every page composes Plan 09 components rather than re-implementing markup.
    - `/settings` reads `RETENTION_DAYS` via the layout-server pass-through (NOT directly from process.env in a +page.server.ts).
  </done>
</task>

</tasks>

<verification>
- `pnpm exec svelte-check` is clean.
- `pnpm exec vite build --mode test` succeeds.
- `pnpm test:integration` (full integration suite) is still green — no Wave 1/2 test broke.
- `grep -c "import.*app\\.css" src/routes/+layout.svelte` == 1.
- `grep -c "PROTECTED_PATHS" src/routes/+layout.server.ts` >= 2 (definition + .some(...) usage).
- All 8 routes (the dashboard + 7 new pages) reachable via SSR (sanity-check `app.request("/games")` etc. returns 200 OR 303 to /login depending on auth).
</verification>

<success_criteria>
- 7 page bundles ship + dashboard updated; +layout.svelte imports app.css and renders AppHeader+Nav for authed routes.
- PROTECTED_PATHS extends to /games, /events, /audit, /accounts, /keys, /settings; anonymous → 303 /login.
- Cookie ↔ DB reconciliation wired in +layout.server.ts (cookie wins on disagreement; hydrate cookie from DB if absent).
- Every page renders empty / loading / populated states per UI-SPEC §"Loading & empty contract".
- Every form uses Plan 09 components (PasteBox, ReplaceKeyForm, InlineError, ConfirmDialog).
- No new top-level deps; svelte-check + vite build both clean.
- The 13 REQ-IDs covered (UI surface for GAMES, KEYS, INGEST, EVENTS, PRIV-02, UX-01, UX-02, UX-03) all reachable via SSR.
</success_criteria>

<output>
After completion, create `.planning/phases/02-ingest-secrets-and-audit/02-10-SUMMARY.md`. Highlight: which page directories were created, the loader / parallel-fetch shapes used per page, whether `/events` ships a global endpoint or per-game-merge approach, where `RETENTION_DAYS` is surfaced (layout-server), and confirmation that the cookie-wins reconciliation `it.skip` flag (Plan 09) is now `it(...)` and green.
</output>
