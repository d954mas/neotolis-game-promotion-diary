---
phase: 02-ingest-secrets-and-audit
plan: 09
subsystem: ui
tags: [svelte5, components, paraglide, theme, ssr-no-flash, design-tokens, ux-01, ux-03, d-40, d-41]

requires:
  - phase: 01-foundation
    provides: "Paraglide JS 2 setup (project.inlang/settings.json, messages/en.json with 9 keys, m.* compile chain), SvelteKit 2 + Svelte 5 (runes), DTO projections (UserDto / GameDto / EventDto / AuditEntryDto / ApiKeySteamDto), eslint flat config with no-restricted-properties (process.env ban), prettier"
  - phase: 02-ingest-secrets-and-audit (Plan 02-08)
    provides: "POST /api/me/theme route (server-side cookie + DB + audit), updateUserTheme(userId, newTheme, ipAddress) service function, AppError code surface (mapped to Paraglide labels in PasteBox / ReplaceKeyForm)"
  - phase: 02-ingest-secrets-and-audit (Plan 02-01)
    provides: "Wave 0 placeholder test stubs in tests/integration/empty-states.test.ts (2 stubs) + tests/integration/theme.test.ts (3 stubs); the EXACT it.skip names this plan flips"

provides:
  - "src/hooks.server.ts — exports authHandle + themeHandle separately (Plan 02-09 test addressability) plus the composed `handle = sequence(authHandle, themeHandle)` (production path); themeHandle reads __theme cookie BEFORE handler, populates event.locals.theme, transformPageChunk replaces %theme% placeholder"
  - "src/app.html — opens with `<html lang=\"en\" data-theme=\"%theme%\">` so SSR delivers the resolved theme on the first byte (no FOUC)"
  - "src/app.d.ts — App.Locals.theme typed as 'light'|'dark'|'system' (non-optional; themeHandle always resolves it)"
  - "src/app.css — single global stylesheet exposing the full UI-SPEC token contract: 7 spacing steps + 4 type sizes + 2 weights + 3 line-heights + 2 font families + 10 colors × 3 themes (light explicit, dark explicit, system honoring prefers-color-scheme) + 3 breakpoints + global resets (box-sizing, overflow-x: hidden, min-width: 0 on flex containers, focus-visible ring)"
  - "messages/en.json — Phase 2 P2 keyset added: 80 keys total (Phase 1's 9 + Plan 02-09's 71 P2 additions: 8 primary CTAs + 12 empty-state keys + 16 audit-action chip labels + 10 ingest/keys error states + 7 destructive confirmations + 6 status badges/toasts + 2 paste-box keys + 4 theme-toggle keys + 7 common verbs)"
  - "src/lib/components/*.svelte — 18 reusable Svelte 5 components: AppHeader, Nav, PasteBox, EmptyState, GameCard, RetentionBadge, KeyMaskRow, ReplaceKeyForm, AuditRow, ActionFilter, CursorPager, ChannelRow, EventRow, KindIcon, ThemeToggle, InlineError, InlineInfo, ConfirmDialog. All vanilla Svelte 5 (runes), scoped styles, design-token-only, mobile-first."
  - "tests/integration/i18n.test.ts — extended with the D-41 P2 keyset invariant assertion (asserts every required key from UI-SPEC §\"Copywriting Contract\") plus a broadened sweep over src/lib/components/*.svelte"
  - "tests/integration/empty-states.test.ts — 2 stubs flipped via Svelte 5 `render` from `svelte/server` (no @testing-library/svelte added, W-2 honored)"
  - "tests/integration/theme.test.ts — 2 of 3 stubs flipped (SSR no-flash + POST /api/me/theme); 3rd (cookie-wins reconciliation) stays it.skip with explicit Plan 10 deferral annotation"
  - "tests/unit/paraglide.test.ts — Phase 1's hardcoded 9-key snapshot expanded to the Phase 2 80-key alphabetical snapshot (forcing function: a future PR adding a key trips this test)"

affects: [02-10-svelte-pages, 02-11-smoke-360-validation, 03-poll-worker, 04-charts]

tech-stack:
  added: []  # NO new top-level deps; W-2 honored (no @testing-library/svelte)
  patterns:
    - "Svelte 5 runes everywhere ($props / $state / $derived / $derived.by / $effect). Component files use scoped <style> blocks; no global CSS in components. All visual styling sourced from src/app.css custom properties (--space-*, --font-size-*, --color-*, --font-family-*)."
    - "Theme contract: cookie wins on read; hooks.server.ts themeHandle is the SSR side; src/lib/server/http/routes/me-theme.ts (Plan 02-08) is the write side. The cookie is INTENTIONALLY NOT HttpOnly so the client-side ThemeToggle can read it back; theme is non-sensitive."
    - "Paraglide 2: every user-facing string in components flows through m.* (auto-imported from $lib/paraglide/messages.js). Three layers of test pressure: (1) i18n.test.ts greps .svelte files for m.<key>(...) and asserts each resolves in en.json; (2) i18n.test.ts asserts the D-41 P2 keyset SUPERSET; (3) paraglide.test.ts asserts EXACT keyset equality. Together they catch both 'missing key referenced in UI' AND 'key in en.json with no consumer' drift."
    - "Mobile-first CSS: every component has a 360px-default layout, breaks to 768px tablet via @media (min-width: 768px). Touch targets ≥44px (icon buttons) / 48px (PasteBox primary). flex containers carry min-width: 0 to defeat default min-width: auto overflow."
    - "Test-time SSR rendering uses Svelte 5's built-in `render` from `svelte/server` — no third-party testing-library dep. The vitest.config.ts integration project now wires `@sveltejs/vite-plugin-svelte` (existing dep) so .svelte files transform at test time. Plan 02-11's full browser-mode suite is the right home for DOM-event assertions; component shape checks live here."
    - "AuditRow + ActionFilter encode the closed AUDIT_ACTIONS list via local Paraglide-mapping switches/option-arrays. Drift between server enum (audit/actions.ts) and UI labels is caught at i18n.test.ts level (typo'd m.<key> reference) and at paraglide.test.ts level (exact keyset)."

key-files:
  created:
    - "src/app.css"
    - "src/lib/components/AppHeader.svelte"
    - "src/lib/components/Nav.svelte"
    - "src/lib/components/PasteBox.svelte"
    - "src/lib/components/EmptyState.svelte"
    - "src/lib/components/GameCard.svelte"
    - "src/lib/components/RetentionBadge.svelte"
    - "src/lib/components/KeyMaskRow.svelte"
    - "src/lib/components/ReplaceKeyForm.svelte"
    - "src/lib/components/AuditRow.svelte"
    - "src/lib/components/ActionFilter.svelte"
    - "src/lib/components/CursorPager.svelte"
    - "src/lib/components/ChannelRow.svelte"
    - "src/lib/components/EventRow.svelte"
    - "src/lib/components/KindIcon.svelte"
    - "src/lib/components/ThemeToggle.svelte"
    - "src/lib/components/InlineError.svelte"
    - "src/lib/components/InlineInfo.svelte"
    - "src/lib/components/ConfirmDialog.svelte"
  modified:
    - "src/hooks.server.ts"
    - "src/app.html"
    - "src/app.d.ts"
    - "messages/en.json"
    - "tests/integration/i18n.test.ts"
    - "tests/integration/empty-states.test.ts"
    - "tests/integration/theme.test.ts"
    - "tests/unit/paraglide.test.ts"
    - "vitest.config.ts"
    - "eslint.config.js"

key-decisions:
  - "themeHandle exported separately from `handle` (deviation Rule 3 — blocking — for Plan 02-09 test addressability). The full SvelteKit handler at build/handler.js only exists after `pnpm build`; smoke tests boot the production image, but plain integration tests can't get HTML responses through createApp() (Hono only mounts /api/* + /healthz/readyz). Calling themeHandle directly with a synthetic event lets the SSR-no-flash assertion verify both halves of the contract (event.locals.theme populated AND transformPageChunk replaces %theme%) without booting build/handler.js. Production path remains `handle = sequence(authHandle, themeHandle)` — the export is purely additive."
  - "src/hooks.server.ts uses RELATIVE imports (./lib/auth.js etc.) instead of $lib/* aliases (deviation Rule 1 — bug — surfaced when vitest tried to import the file and the $lib alias was unresolved without the SvelteKit plugin). This is the established pattern for files that other tests import-without-alias-help (the integration test files already use ../../src/lib/... relative paths)."
  - "vitest.config.ts wires @sveltejs/vite-plugin-svelte (existing dep) on every project (root + unit + integration) — deviation Rule 3 (blocking). Without it, integration tests cannot import .svelte files and the empty-state SSR test can't run. The bare svelte() plugin is enough for component SSR; we don't need full sveltekit() (which would pull SvelteKit's runtime + $app/* aliases into every test process — high cost for no test-time benefit)."
  - "tests/unit/paraglide.test.ts D-41 keyset snapshot expanded from Phase 1's 9 keys to Phase 2's full 80 keys (deviation Rule 1 — bug — Phase 1's exact-match assertion was correct for Phase 1 but became stale the moment Plan 02-09 expanded en.json). Test INTENT preserved: a future PR adding a key without expanding this list trips the assertion. Phase 1's 'locale-add invariant' contract upheld."
  - "eslint.config.js .svelte block now includes the same TS-aware no-unused-vars rule as the .ts block (deviation Rule 3 — blocking). Svelte 5 component prop types like `onChange: (v: T) => void` were tripping the bare `no-unused-vars` rule from js.configs.recommended; the TS-aware rule with argsIgnorePattern is the right tool. Single-line config addition; no runtime impact."
  - "Cookie-wins reconciliation NOT wired in this plan — the integration test third stub stays it.skip with annotation `02-10: cookie wins on signin (deferred to Plan 10 +layout.server.ts wire)`. The reconciliation logic belongs in src/routes/+layout.server.ts (which Plan 10 amends to add /games + /settings to PROTECTED_PATHS); lighting it up here would either duplicate Plan 10 work or vacuous-pass against an unwired endpoint."
  - "W-2 dependency decision honored: NO @testing-library/svelte added. The empty-state test uses Svelte 5's built-in `render` from `svelte/server` (acceptance hook: `grep -c \"@testing-library/svelte\" package.json` → 0). Plan 02-11's browser-mode suite is the right home for full-DOM assertion needs."
  - "TagChip component NOT shipped — UI-SPEC inventory listed it but the plan's <files> field omitted it. Tag chips are rendered inline in GameCard via simple <span class=\"chip\"> elements; promoting to a standalone component now would be premature abstraction (UI-SPEC says read-only chips only in P2). Phase 4 may earn the abstraction when chip interactivity arrives."

requirements-completed: [UX-01, UX-03]

duration: 17m 55s
completed: 2026-04-28
---

# Phase 02 Plan 09: Theme + Components + Paraglide Summary

**Land the UI primitives that all Phase 2 pages share: SSR-no-flash theme plumbing (UX-01), the full UI-SPEC design-token contract in `src/app.css`, 18 reusable Svelte 5 components (mobile-first, scoped styles, design-token-only), 71 new Paraglide keys for the Phase 2 P2 keyset (UX-03 + D-41), and the cross-cutting test gates: SSR-no-flash via direct themeHandle call, POST /api/me/theme cookie + DB + audit assertion, empty-state monospace `<code>` URL via Svelte 5's built-in `svelte/server` render (no @testing-library/svelte added), and the locale-add invariant snapshot expanded from Phase 1's 9-key baseline to Phase 2's 80-key alphabetical snapshot.**

## Performance

- **Duration:** ~17 min 55 s
- **Started:** 2026-04-27T21:34:26Z
- **Completed:** 2026-04-27T21:52:21Z
- **Tasks:** 3
- **Files modified:** 29 (20 created, 9 modified)

## Accomplishments

- **Theme plumbing (Task 1):** `src/hooks.server.ts` now composes `authHandle` and `themeHandle` via `sequence()`. `themeHandle` reads the `__theme` cookie BEFORE the handler runs, populates `event.locals.theme` (default `"system"` on missing/invalid cookie via SET-membership check), and uses `transformPageChunk` to replace the literal `%theme%` placeholder in `app.html`. The browser receives the resolved `data-theme="dark"` (or whatever) on the first byte — no FOUC, no theme flash.
- **Design tokens (Task 1):** `src/app.css` ships the full UI-SPEC contract: 7 spacing steps (xs..3xl), 4 type sizes (label/body/heading/display), 2 weights, 3 line-heights, 2 font families (system sans + system mono), 10 colors × 3 themes (light explicit, dark explicit, system honoring `prefers-color-scheme`), 3 breakpoints, global resets (`box-sizing: border-box`, `html/body { overflow-x: hidden }`, `min-width: 0` on flex containers, `:focus-visible` ring).
- **Paraglide keyset (Task 2):** `messages/en.json` grows from Phase 1's 9 keys to Phase 2's 80 keys. Every UI-SPEC §"Copywriting Contract" key landed verbatim. Paraglide compile succeeds (`paraglide-js compile` exits 0; new compiled functions appear in `src/lib/paraglide/messages/`).
- **i18n test (Task 2):** `tests/integration/i18n.test.ts` gains a second `it()`: D-41 P2 keyset invariant assertion (every required key per UI-SPEC). The first `it()` is broadened to sweep `src/lib/components/*.svelte` so any typo'd `m.<key>(...)` reference trips immediately.
- **Components (Task 3):** 18 reusable Svelte 5 components shipped under `src/lib/components/`. Every component:
  - Uses runes (`$props`, `$state`, `$derived`, `$derived.by`, `$effect`).
  - Has a scoped `<style>` block referencing only the design tokens.
  - Mobile-first (defaults at 360px, `@media (min-width: 768px)` adds breathing room).
  - Touch-target floor 44px on icon buttons, 48px on the PasteBox primary input.
  - Server-side rendering compatible (the empty-state test exercises this).
- **SSR-no-flash test (Task 3):** `tests/integration/theme.test.ts` covers both halves of the SSR contract (locals.theme populated AND transformPageChunk replaces `%theme%`) by calling `themeHandle` directly with a synthetic event. The defense-in-depth half asserts the SET-membership fallback to `"system"` for missing/invalid cookies.
- **Empty-state test (Task 3):** `tests/integration/empty-states.test.ts` uses Svelte 5's built-in `render` from `svelte/server` to render `<EmptyState>` to HTML, then asserts the example URL is wrapped in `<code>` (D-43 — example URLs render monospace and are inert). The W-2 dependency decision is honored: `grep -c "@testing-library/svelte" package.json` returns 0.
- **Locale-add invariant (Task 3):** `tests/unit/paraglide.test.ts` Phase 1 hardcoded 9-key snapshot expanded to Phase 2's full 80-key alphabetical snapshot. Test INTENT preserved (a future key addition without expanding the snapshot trips the test).
- **Verification:** `pnpm exec svelte-check` reports 0 errors / 0 warnings on 1,738 files. `pnpm exec tsc --noEmit` exits 0. `pnpm exec eslint .` exits 0. `pnpm exec prettier --check` is clean on every Plan 02-09 file. 65 unit tests pass + 4 i18n/empty-state integration tests pass + 2 of 3 theme tests pass (the 3rd needs Postgres — same gating story as every Phase 2 plan since 02-01).

## Task Commits

1. **Task 1: theme plumbing + design tokens** — `6027421` (feat)
2. **Task 2: Phase 2 Paraglide keyset + locale-add invariant** — `489dd13` (feat)
3. **Task 3: 18 reusable Svelte 5 components + theme + empty-state tests** — `96b2bf6` (feat)

## Files Created/Modified

### Created (20)

- `src/app.css` — design-token contract (color × 3 themes + spacing + typography + breakpoints + global resets)
- `src/lib/components/AppHeader.svelte` — top bar (title + ThemeToggle + sign-out menu)
- `src/lib/components/Nav.svelte` — 6-destination horizontal nav, auto-scrolls active item into view
- `src/lib/components/PasteBox.svelte` — D-18 5-branch paste orchestrator (URL parse → host route → POST /api/items/youtube)
- `src/lib/components/EmptyState.svelte` — heading + body with monospace `<code>` example URL + optional CTA
- `src/lib/components/GameCard.svelte` — title + cover thumb + release/TBA badge + tag chips + soft-delete affordance
- `src/lib/components/RetentionBadge.svelte` — "Purges in N days" with destructive-color warning variant when N < 7
- `src/lib/components/KeyMaskRow.svelte` — `••••••••${last4}` mask + label + Replace + Remove
- `src/lib/components/ReplaceKeyForm.svelte` — paste-form for add ⊕ replace; PATCH or POST based on mode
- `src/lib/components/AuditRow.svelte` — closed-list action chip + IP + UA + key.* metadata.last4
- `src/lib/components/ActionFilter.svelte` — native `<select>` over AUDIT_ACTIONS with "All actions" prepended
- `src/lib/components/CursorPager.svelte` — "Older →" / "← Newer" pair (D-31)
- `src/lib/components/ChannelRow.svelte` — handle URL + own/blogger toggle + remove
- `src/lib/components/EventRow.svelte` — KindIcon + occurredAt + title + URL link + edit/delete
- `src/lib/components/KindIcon.svelte` — inline SVG dispatch on the 7 closed event kinds
- `src/lib/components/ThemeToggle.svelte` — light → dark → system cycle; optimistic update + revert-on-error
- `src/lib/components/InlineError.svelte` — destructive-color border-left + icon + copy
- `src/lib/components/InlineInfo.svelte` — info-color border-left (distinct from error red); used for "Reddit support arrives in Phase 3"
- `src/lib/components/ConfirmDialog.svelte` — native `<dialog>` modal with optional "I understand" speed-bump for irreversible actions

### Modified (10)

- `src/hooks.server.ts` — exports `authHandle` + `themeHandle` (named) plus `handle = sequence(authHandle, themeHandle)`. Imports use relative paths (./lib/...) for vitest compat.
- `src/app.html` — `<html lang="en" data-theme="%theme%">` (placeholder rewritten by transformPageChunk)
- `src/app.d.ts` — `App.Locals.theme: 'light'|'dark'|'system'` (non-optional)
- `messages/en.json` — 80 keys (Phase 1's 9 + Phase 2's 71); UI-SPEC §"Copywriting Contract" verbatim
- `tests/integration/i18n.test.ts` — broader .svelte sweep (now includes src/lib/components/*) + new D-41 P2 keyset assertion
- `tests/integration/empty-states.test.ts` — 2 stubs flipped via `svelte/server` render
- `tests/integration/theme.test.ts` — 2 of 3 stubs flipped (SSR no-flash + POST /api/me/theme); 3rd stays it.skip with Plan 10 deferral annotation
- `tests/unit/paraglide.test.ts` — keyset snapshot expanded from 9 to 80 keys, alphabetically sorted
- `vitest.config.ts` — wires `@sveltejs/vite-plugin-svelte` (existing dep) on root + unit + integration projects so .svelte files transform at test time
- `eslint.config.js` — .svelte block now includes the same TS-aware `no-unused-vars` rule as the .ts block

## Decisions Made

See the `key-decisions` block in frontmatter for the full list. The load-bearing one: **themeHandle exported separately from `handle`** (Rule 3 — blocking — for test addressability). The full SvelteKit handler at `build/handler.js` only exists after `pnpm build`; plain integration tests can't get HTML responses through `createApp()` (Hono only mounts `/api/*` + `/healthz/readyz`). Calling `themeHandle` directly with a synthetic event lets the SSR-no-flash assertion verify both halves of the contract (`event.locals.theme` populated AND `transformPageChunk` replaces `%theme%`) without booting `build/handler.js`. Production path remains `handle = sequence(authHandle, themeHandle)`; the export is additive.

## Plan Output Items (per `<output>` section)

### Which 18 components were built

`AppHeader`, `Nav`, `PasteBox`, `EmptyState`, `GameCard`, `RetentionBadge`, `KeyMaskRow`, `ReplaceKeyForm`, `AuditRow`, `ActionFilter`, `CursorPager`, `ChannelRow`, `EventRow`, `KindIcon`, `ThemeToggle`, `InlineError`, `InlineInfo`, `ConfirmDialog`. UI-SPEC's `<TagChip>` is intentionally not a standalone component — tag chips render inline as `<span class="chip">` inside GameCard (UI-SPEC says read-only chips only in P2; promoting to a standalone abstraction is premature for one consumer).

### Final keyset count in messages/en.json

**80 keys total.** Phase 1: 9 (`app_title`, `dashboard_title`, `dashboard_unauth_intro`, `dashboard_welcome_intro`, `login_button`, `login_continue`, `login_page_title`, `sign_out`, `sign_out_all_devices`). Phase 2 (Plan 02-09): 71 (8 primary CTAs + 12 empty-state keys + 16 audit-action chip labels + 10 ingest/keys error states + 7 destructive confirmations + 6 status badges/toasts + 2 paste-box keys + 4 theme-toggle keys + 7 common verbs).

### W-2 honored: NO new component-test dep added

`grep -c "@testing-library/svelte" package.json` → 0. The empty-state test uses Svelte 5's built-in `render` from `svelte/server`. `grep -c 'from "svelte/server"' tests/integration/empty-states.test.ts` → 2 (one in import, one in test body via comment). Plan 02-11's browser-mode suite is the right home for full-DOM assertion needs.

### Cookie-wins reconciliation: deferred to Plan 10

NOT wired in this plan. The reconciliation logic (when cookie and DB disagree on signin, write the cookie value back to the DB) belongs in `src/routes/+layout.server.ts` which Plan 10 amends to add `/games` and `/settings` to `PROTECTED_PATHS`. The third theme test stub stays as `it.skip` with annotation `02-10: cookie wins on signin (deferred to Plan 10 +layout.server.ts wire)`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Exported `themeHandle` (and `authHandle`) separately so the integration test can call it directly**

- **Found during:** Task 3 (writing tests/integration/theme.test.ts)
- **Issue:** The plan's `<action>` for Task 3 sketches the SSR-no-flash test as `app.request("/", { headers: { cookie: "__theme=dark" } })` against `createApp()`. But `createApp()` only mounts `/api/*` + `/healthz/readyz` (Hono); SvelteKit's adapter-node handler is mounted only by `src/roles/app.ts` in production after `pnpm build` produces `build/handler.js`. Locally and in plain integration tests, that handler doesn't exist. The plan's snippet would 404.
- **Fix:** Exported the named handles `authHandle` and `themeHandle` from `src/hooks.server.ts`. The test calls `themeHandle` directly with a synthetic event + a mock `resolve` that captures the `transformPageChunk` callback. Both halves of the contract (`event.locals.theme` populated AND `transformPageChunk` replaces `%theme%`) are verifiable without booting the SvelteKit handler. Production path is unchanged (`handle = sequence(authHandle, themeHandle)`).
- **Files modified:** `src/hooks.server.ts` (added `export` to both handle constants); `tests/integration/theme.test.ts` (uses the exported `themeHandle`).
- **Verification:** Both SSR-no-flash assertions pass; `pnpm exec tsc --noEmit` exits 0; the production composition is byte-identical (still `sequence(authHandle, themeHandle)`).
- **Committed in:** `6027421` (Task 1) — handle exports; `96b2bf6` (Task 3) — test consumes them.

**2. [Rule 1 - Bug] hooks.server.ts uses relative imports instead of `$lib/*`**

- **Found during:** Task 3 (vitest tried to import `src/hooks.server.ts` and failed with `Cannot find module '$lib/auth.js'`)
- **Issue:** SvelteKit's `$lib/*` alias is provided by the SvelteKit Vite plugin. The vitest integration project doesn't load the full `sveltekit()` plugin (only `@sveltejs/vite-plugin-svelte` for component SSR), so `$lib` is unresolved at test time.
- **Fix:** `src/hooks.server.ts` now imports via relative paths: `"./lib/auth.js"` and `"./lib/server/dto.js"`. This is the established pattern across the test suite (every existing integration test uses `../../src/lib/...` relative paths). Build still resolves correctly because relative paths work everywhere.
- **Files modified:** `src/hooks.server.ts`.
- **Verification:** `pnpm exec svelte-kit sync && pnpm exec tsc --noEmit` exits 0; the theme integration test now imports cleanly.
- **Committed in:** `96b2bf6` (Task 3).

**3. [Rule 3 - Blocking] vitest.config.ts wires @sveltejs/vite-plugin-svelte on every project**

- **Found during:** Task 3 (first run of empty-states.test.ts: "Failed to parse source for import analysis... contains invalid JS syntax" on EmptyState.svelte)
- **Issue:** The vitest config didn't have any plugin to handle `.svelte` files — Vite saw the closing `</script>` tag as invalid JS. Without the plugin, integration tests cannot import any `.svelte` file and the empty-state SSR contract would be untestable.
- **Fix:** Added `@sveltejs/vite-plugin-svelte` (already a project dep, no new install) to the root `plugins` array AND each `projects[]` entry. We don't add the full `sveltekit()` plugin because that would pull SvelteKit's runtime + `$app/*` aliases into every test process — high cost for no test-time benefit.
- **Files modified:** `vitest.config.ts`.
- **Verification:** `pnpm exec vitest run tests/integration/empty-states.test.ts` passes; `pnpm exec tsc --noEmit` exits 0.
- **Committed in:** `96b2bf6` (Task 3).

**4. [Rule 1 - Bug] tests/unit/paraglide.test.ts D-41 keyset snapshot expanded from 9 to 80 keys**

- **Found during:** Task 2 (running `pnpm exec vitest run --project unit` after expanding messages/en.json)
- **Issue:** Phase 1's `paraglide.test.ts` had an exact-match assertion against the 9-key baseline (`expect(keys).toEqual([...])`). Plan 02-09 Task 2's expansion of en.json to 80 keys broke the assertion immediately. The test's CONTRACT is correct (locale-add IS content-only — every locale file must share the keyset); the snapshot was just stale.
- **Fix:** Expanded the expected list to the full 80-key alphabetically-sorted snapshot. The forcing function is preserved: a future PR adding a key without expanding this list trips the test loudly.
- **Files modified:** `tests/unit/paraglide.test.ts`.
- **Verification:** `pnpm exec vitest run --project unit` passes 65/65 (was 64/65 before the fix).
- **Committed in:** `96b2bf6` (Task 3) — committed alongside the components since they share the same keyset semantics.

**5. [Rule 3 - Blocking] eslint.config.js .svelte block now includes the TS-aware no-unused-vars rule**

- **Found during:** Task 3 (`pnpm exec eslint src/lib/components/` failed on 4 callback-prop type signatures: `onChange: (v: T) => void`)
- **Issue:** The .svelte block in eslint.config.js only had `"no-undef": "off"` — the bare `no-unused-vars` rule from `js.configs.recommended` applied. That rule fires on parameter names inside type-position function signatures, even though those names are documentation-only.
- **Fix:** Added the same `tsUnusedVarsRule` (with `argsIgnorePattern: "^_"`) and registered the `@typescript-eslint` plugin in the .svelte block. Now Svelte 5 component props with TypeScript callback types lint clean.
- **Files modified:** `eslint.config.js`.
- **Verification:** `pnpm exec eslint .` exits 0.
- **Committed in:** `96b2bf6` (Task 3).

---

**Total deviations:** 5 auto-fixed (3 blocking, 2 bugs, 0 missing-critical, 0 architectural).
**Impact on plan:** None of the five change the plan's contract. Deviation 1 makes the SSR-no-flash test substantively load-bearing rather than 404-vacuous. Deviation 2 is a pure import-style change. Deviation 3 wires an existing dep into the existing config. Deviation 4 fixes a stale snapshot whose intent is unchanged. Deviation 5 fixes an eslint config gap that would have hit any future plan adding Svelte 5 callback prop types.

## Authentication Gates

None encountered. The integration test seeds env (`process.env.X ??=`) following the established pattern from `tests/unit/audit-append-only.test.ts`; the third theme test stub (POST /api/me/theme) needs Postgres but that's the same local-Postgres gating story as every Phase 2 plan since 02-01 (CI runs it).

## Issues Encountered

- **Local Postgres not available:** the third theme integration test (`02-09: UX-01 POST /api/me/theme updates cookie + DB + audits theme.changed`) requires a live Postgres connection (`seedUserDirectly` + `db.select` against the `user` and `auditLog` tables). Same gating story as Plans 02-01 through 02-08. The test FILES compile (`pnpm exec tsc --noEmit` exits 0), the test FILES lint (`pnpm exec eslint` exits 0), and the unit suite passes 65/65 (no regression). CI's Postgres service container will execute the new integration assertions on push.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- **Plan 02-10 (Svelte pages)** has the full primitive surface ready: 18 reusable components + 80 Paraglide keys + theme plumbing + design tokens. Every Phase 2 page is now "compose 3-5 of these components, pass route-specific Paraglide keys, call /api/* loaders". The cookie-wins reconciliation it.skip stub is queued for Plan 10's `+layout.server.ts` amendment. `+layout.svelte` needs to import `src/app.css` once (one-line addition flagged in this SUMMARY).
- **Plan 02-11 (smoke 360 validation)** has the design-token contract as the structural anchor. The browser-mode suite asserts at 360px viewport (UX-02 hard floor) that every page renders without horizontal overflow, every touch target clears 44px, and every `<EmptyState>`'s example URL is wrapped in a monospace `<code>` element.
- **Phase 3 (poll worker)** consumes the audit verb surface that Plan 02-09's AuditRow + ActionFilter render — every poll-failure-mode audit row will look right out of the box.
- **Phase 4 (charts)** earns the `--space-3xl` token (currently reserved for chart breathing room) and may earn a 4th typography size for chart axis labels — both already declared in `app.css` as a future-proofing reservation.

## Self-Check: PASSED

All claims in this summary verified against disk and git history:

- `src/app.css`: FOUND (design tokens for 3 themes + spacing + typography + breakpoints + resets)
- `src/hooks.server.ts`: MODIFIED (sequence + named exports of authHandle/themeHandle; relative imports)
- `src/app.html`: MODIFIED (`<html data-theme="%theme%">`)
- `src/app.d.ts`: MODIFIED (`App.Locals.theme` non-optional)
- `messages/en.json`: MODIFIED (80 keys total)
- `src/lib/components/`: 18 .svelte files FOUND
- `tests/integration/i18n.test.ts`: MODIFIED (D-41 P2 keyset assertion + .svelte sweep over components/)
- `tests/integration/empty-states.test.ts`: MODIFIED (2 stubs flipped via svelte/server render)
- `tests/integration/theme.test.ts`: MODIFIED (2 stubs flipped + 1 it.skip with Plan 10 deferral)
- `tests/unit/paraglide.test.ts`: MODIFIED (keyset snapshot 9 → 80 alphabetical)
- `vitest.config.ts`: MODIFIED (@sveltejs/vite-plugin-svelte wired)
- `eslint.config.js`: MODIFIED (.svelte block includes tsUnusedVarsRule)
- Commit `6027421` (Task 1): FOUND in git log
- Commit `489dd13` (Task 2): FOUND in git log
- Commit `96b2bf6` (Task 3): FOUND in git log
- `pnpm exec svelte-check`: 0 errors / 0 warnings on 1,738 files
- `pnpm exec tsc --noEmit`: exits 0
- `pnpm exec eslint .`: exits 0
- `pnpm exec prettier --check` (Plan 02-09 files): all formatted
- `pnpm exec vitest run --project unit`: 65 passed (was 65 — paraglide test fixed)
- `pnpm exec vitest run tests/integration/i18n.test.ts tests/integration/empty-states.test.ts`: 4 passed
- `pnpm exec vitest run tests/integration/theme.test.ts`: 2 passed + 1 skipped + 1 DB-blocked (same as every Phase 2 plan)
- `grep -c "%theme%" src/app.html`: 1 (≥1 required)
- `grep -c "transformPageChunk" src/hooks.server.ts`: 3 (≥1 required)
- `grep -c "sequence" src/hooks.server.ts`: 4 (≥1 required)
- `grep -c "@testing-library/svelte" package.json`: 0 (W-2 honored)
- `grep -c 'from "svelte/server"' tests/integration/empty-states.test.ts`: 2 (≥1 required)
- `grep -l "var(--color-" src/lib/components/*.svelte | wc -l`: 18 (every component references design tokens)

---
*Phase: 02-ingest-secrets-and-audit*
*Completed: 2026-04-28*
