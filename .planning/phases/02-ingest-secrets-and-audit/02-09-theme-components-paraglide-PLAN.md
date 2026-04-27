---
phase: 02-ingest-secrets-and-audit
plan: 09
type: execute
wave: 3
depends_on: [02-08-routes-and-sweeps]
files_modified:
  - src/hooks.server.ts
  - src/app.html
  - src/app.d.ts
  - src/app.css
  - src/lib/components/AppHeader.svelte
  - src/lib/components/Nav.svelte
  - src/lib/components/PasteBox.svelte
  - src/lib/components/EmptyState.svelte
  - src/lib/components/InlineError.svelte
  - src/lib/components/InlineInfo.svelte
  - src/lib/components/ConfirmDialog.svelte
  - src/lib/components/ThemeToggle.svelte
  - src/lib/components/AuditRow.svelte
  - src/lib/components/KeyMaskRow.svelte
  - src/lib/components/ReplaceKeyForm.svelte
  - src/lib/components/GameCard.svelte
  - src/lib/components/RetentionBadge.svelte
  - src/lib/components/ChannelRow.svelte
  - src/lib/components/EventRow.svelte
  - src/lib/components/KindIcon.svelte
  - src/lib/components/CursorPager.svelte
  - src/lib/components/ActionFilter.svelte
  - messages/en.json
  - tests/integration/theme.test.ts
  - tests/integration/empty-states.test.ts
  - tests/integration/i18n.test.ts
autonomous: true
requirements: [UX-01, UX-03]
requirements_addressed: [UX-01, UX-03]
must_haves:
  truths:
    - "src/hooks.server.ts reads __theme cookie BEFORE handler; event.locals.theme is populated; SSR root element renders data-theme correctly with no flash"
    - "app.html uses %theme% placeholder rewritten by transformPageChunk; data-theme on <html> matches the cookie value"
    - "app.css declares all design tokens from UI-SPEC: --space-*, --font-size-*, --color-* (light + dark + system via prefers-color-scheme)"
    - "All UI strings exist in messages/en.json; the locale-add invariant test (Phase 1) extends to assert all P2 keys present"
    - "Components are vanilla Svelte 5 (runes-style), no shadcn / no Tailwind / no new deps"
    - "POST /api/me/theme reconciliation: cookie wins on signin if both cookie and DB are present"
    - "Theme integration tests pass: SSR no-flash, POST updates both layers, cookie-wins reconciliation"
    - "UX-03 empty states render monospace example URL and route-specific copy"
  artifacts:
    - path: "src/hooks.server.ts"
      provides: "Auth handle (Phase 1) + theme handle composed via sequence(); event.locals.theme populated"
      contains: "event.locals.theme"
    - path: "src/app.html"
      provides: "<html data-theme=\"%theme%\"> placeholder rewritten in transformPageChunk"
      contains: "%theme%"
    - path: "src/app.d.ts"
      provides: "App.Locals.theme typed as 'light'|'dark'|'system'"
      contains: "theme"
    - path: "src/app.css"
      provides: "Design tokens: spacing, typography, color (light + dark + system)"
      contains: "--color-bg"
      min_lines: 80
    - path: "messages/en.json"
      provides: "~30 new Paraglide keys: 6 empty-state pairs + 16 audit-action chips + ~12 CTAs / errors / confirmations"
      contains: "empty_games_heading"
    - path: "src/lib/components/PasteBox.svelte"
      provides: "Single global URL input with host-routed validation order per UI-SPEC"
      contains: "ingest_cta_add"
    - path: "src/lib/components/EmptyState.svelte"
      provides: "Heading + body + monospace example URL + CTA hint; takes a key prop pointing at Paraglide functions"
      contains: "monospace"
    - path: "src/lib/components/ConfirmDialog.svelte"
      provides: "Native <dialog> element wrapper with optional 'I understand' speed-bump for irreversible actions"
      contains: "<dialog"
  key_links:
    - from: "src/hooks.server.ts"
      to: "src/app.html"
      via: "transformPageChunk replaces %theme% with event.locals.theme"
      pattern: "transformPageChunk"
    - from: "src/app.css"
      to: "src/lib/components/*.svelte"
      via: "Components reference --color-* / --space-* / --font-size-* tokens (single global stylesheet)"
      pattern: "var\\(--color-"
    - from: "src/lib/components/EmptyState.svelte"
      to: "messages/en.json"
      via: "Component takes a Paraglide function ref and calls it for heading + body"
      pattern: "key\\.\\(\\)"
---
<!-- W-1 SCOPE RATIONALE (checker iter 1; "keep as one" path):
     Plan 09 modifies 22+ files (theme plumbing × 4 + design tokens × 1 + 18 components +
     messages/en.json + 3 test files). The 15-file scope-sanity threshold is exceeded, but
     the contents are a single ATOMIC UNIT: design tokens are *consumed* by every component
     in the same plan. Splitting would create:
       - 09a: hooks.server / app.html / app.d.ts / app.css / messages/en.json / i18n.test.ts
              (6 files; theme plumbing + tokens + Paraglide keys)
       - 09b: 18 components + theme.test.ts + empty-states.test.ts (≈ 21 files)
     Cost of splitting (rejected):
       - 09b's components compile against tokens defined in 09a — 09b cannot be authored or
         reviewed in isolation without already having 09a's app.css open. The split is
         "two halves of one design system."
       - All 12 placeholder test stubs landed by Plan 02-01 carry the literal annotation
         `02-09: UX-01...` / `02-09: UX-03...`. Splitting requires retroactively retitling
         those stubs in 02-01 (already-committed file) AND every it() body when stubs flip.
         That's 8+ stub annotations and 3 cross-plan SUMMARY references (Plan 10 lines 6, 92,
         200 + Plan 11 lines 433-435) — high blast radius for a structural cleanup.
     Benefit (kept):
       - One plan, one review, one commit. The executor reads the design-token contract
         (Task 1) and immediately consumes it in Tasks 2-3 without context switching.
       - Plan 09's three tasks already split the work logically: Task 1 = theme plumbing +
         tokens (4 files); Task 2 = Paraglide keys + i18n test (2 files); Task 3 = 18
         components + 2 test files (20 files). Each task is independently reviewable and
         committable; the WHOLE-PLAN file count is the only number above threshold.
     Decision: keep Plan 09 as ONE plan with three internal tasks; surface this rationale
     so the checker has a documented reason, and so any future reviewer sees why the
     scope-sanity threshold was waived. -->



<objective>
Land the UI primitives that all Phase 2 pages share: theme cookie + DB persist plumbing (UX-01), CSS design tokens, the ~18 reusable Svelte 5 components from UI-SPEC, and ~30 new Paraglide keys for empty states / CTAs / audit-action chips / error states / destructive confirmations. Wire the new theme integration tests + extend the existing locale-add invariant.

Purpose: Plan 10 (pages) becomes mechanical once these primitives exist — every page is "compose 3-5 of these components, pass route-specific Paraglide keys, call /api/* loaders". Get the design tokens, the SSR-no-flash hook, and the empty-state contract right; the rest is layout.

Output: 1 amended hooks.server.ts + app.html + app.d.ts + 1 NEW global stylesheet + 18 reusable Svelte components + ~30 new Paraglide keys + theme + empty-state + i18n integration tests light up.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@src/hooks.server.ts
@src/routes/+layout.server.ts
@src/routes/+layout.svelte
@messages/en.json
@.planning/phases/02-ingest-secrets-and-audit/02-UI-SPEC.md
@.planning/phases/02-ingest-secrets-and-audit/02-RESEARCH.md
@.planning/phases/02-ingest-secrets-and-audit/02-CONTEXT.md
@.planning/phases/02-ingest-secrets-and-audit/02-08-SUMMARY.md

<interfaces>
<!-- Phase 1 hooks.server.ts (current shape):
export const handle: Handle = async ({ event, resolve }) => {
  const result = await auth.api.getSession({ headers: event.request.headers });
  if (result) { event.locals.user = ...; event.locals.session = ...; }
  return resolve(event);
};

Phase 2 transforms this into a sequence(authHandle, themeHandle) composition.
-->

<!-- Theme cookie pattern (UI-SPEC §"Theme toggle interaction contract" + RESEARCH.md §"Theme cookie + DB sync"):
1. Cookie name: __theme
2. Values: 'light' | 'dark' | 'system' (default 'system')
3. Attributes: Path=/; SameSite=Lax; Max-Age=31536000; Secure (in production); NO HttpOnly
4. SSR-no-flash via transformPageChunk: replace `%theme%` placeholder in app.html with event.locals.theme
5. Reconciliation: cookie wins on signin if both cookie and DB exist
-->

<!-- Paraglide 2 m.* function calls (Phase 1 plan 01-09):
import * as m from "$lib/paraglide/messages.js";
m.empty_games_heading()    // returns 'No games yet.'
m.empty_games_body({ url }) // parameterized; e.g. { url: 'https://...' }
Adding a key requires: edit messages/en.json + run paraglide compile.
-->

<!-- UI-SPEC §"Reusable component inventory" — 18 components total (some optional):
AppHeader, Nav, PasteBox, EmptyState, GameCard, TagChip, RetentionBadge,
KeyMaskRow, ReplaceKeyForm, AuditRow, ActionFilter, CursorPager, ChannelRow,
EventRow, KindIcon, ThemeToggle, InlineError, InlineInfo, ConfirmDialog
-->
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Theme plumbing — hooks.server, app.html, app.d.ts, app.css design tokens</name>
  <files>src/hooks.server.ts, src/app.html, src/app.d.ts, src/app.css</files>
  <read_first>
    - src/hooks.server.ts (current Phase 1 single-handle export — replace with `sequence(authHandle, themeHandle)`)
    - src/routes/+layout.svelte (find the entry point so app.css import chain is correct)
    - .planning/phases/02-ingest-secrets-and-audit/02-RESEARCH.md §"Theme cookie + DB sync" lines 647–696 (verbatim hooks.server.ts + app.html + app.d.ts shape)
    - .planning/phases/02-ingest-secrets-and-audit/02-UI-SPEC.md §"Color" + §"Spacing Scale" + §"Typography" + §"Layout & Responsive Contract" (the design-token contract)
  </read_first>
  <action>
    **A. AMEND `src/hooks.server.ts`** to compose authHandle + themeHandle via `sequence`:

    ```typescript
    import { sequence } from "@sveltejs/kit/hooks";
    import type { Handle } from "@sveltejs/kit";
    import { auth } from "$lib/auth.js";
    import { toUserDto, toSessionDto } from "$lib/server/dto.js";

    const VALID_THEMES = new Set(["light", "dark", "system"] as const);

    const authHandle: Handle = async ({ event, resolve }) => {
      const result = await auth.api.getSession({ headers: event.request.headers });
      if (result) {
        event.locals.user = toUserDto(result.user as Parameters<typeof toUserDto>[0]);
        event.locals.session = toSessionDto(result.session as Parameters<typeof toSessionDto>[0]);
      }
      return resolve(event);
    };

    const themeHandle: Handle = async ({ event, resolve }) => {
      const cookieValue = event.cookies.get("__theme");
      const theme = cookieValue && VALID_THEMES.has(cookieValue as any)
        ? (cookieValue as "light" | "dark" | "system")
        : "system";
      event.locals.theme = theme;
      return resolve(event, {
        transformPageChunk: ({ html }) => html.replace("%theme%", theme),
      });
    };

    export const handle: Handle = sequence(authHandle, themeHandle);
    ```

    Cookie reconciliation on signin (cookie-wins per D-40): when the user signs in, the existing Better Auth flow lands in the auth callback handler. The reconciliation logic actually lives in `services/me.ts` but is triggered from a SvelteKit layout load that runs after sign-in — for Phase 2 we keep reconciliation simple: if `event.locals.user.themePreference !== event.locals.theme && event.cookies.get('__theme') === undefined`, write the cookie from the DB. This is implemented in `src/routes/+layout.server.ts` (Plan 10 amends that file) — flag it in this plan's SUMMARY but the WIRE is in Plan 10.

    **B. AMEND `src/app.html`** — change the `<html>` opening tag to:
    ```html
    <html lang="en" data-theme="%theme%">
    ```
    The existing `%sveltekit.assets%` and `%sveltekit.head%` placeholders stay untouched.

    **C. AMEND `src/app.d.ts`** — add `theme` to App.Locals:
    ```typescript
    declare global {
      namespace App {
        interface Locals {
          user?: import("$lib/server/dto.js").UserDto;
          session?: import("$lib/server/dto.js").SessionDto;
          theme: "light" | "dark" | "system";
        }
      }
    }
    export {};
    ```

    **D. Create `src/app.css`** — global stylesheet with design tokens (verbatim from UI-SPEC §"Spacing Scale" + §"Typography" + §"Color"):

    ```css
    /* Design tokens — Phase 2 UI-SPEC contract.
     * Single global stylesheet imported once from src/routes/+layout.svelte.
     * Components reference these vars; nothing else lands here.
     */

    :root {
      /* Spacing — 8-point baseline */
      --space-xs: 4px;
      --space-sm: 8px;
      --space-md: 16px;
      --space-lg: 24px;
      --space-xl: 32px;
      --space-2xl: 48px;
      --space-3xl: 64px;

      /* Typography — three sizes + display */
      --font-size-body: 16px;
      --font-size-label: 14px;
      --font-size-heading: 24px;
      --font-size-display: 32px;
      --font-weight-regular: 400;
      --font-weight-semibold: 600;
      --line-height-body: 1.5;
      --line-height-heading: 1.2;
      --line-height-mono: 1.4;

      --font-family-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      --font-family-mono: ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;

      /* Breakpoints */
      --bp-mobile: 360px;
      --bp-tablet: 768px;
      --bp-desktop: 1024px;
    }

    /* Color — light theme (default + explicit) */
    :root,
    :root[data-theme="light"] {
      --color-bg: #fafafa;
      --color-surface: #ffffff;
      --color-border: #e5e5e5;
      --color-text: #1a1a1a;
      --color-text-muted: #666666;
      --color-accent: #2563eb;
      --color-accent-text: #ffffff;
      --color-destructive: #b91c1c;
      --color-info: #0891b2;
      --color-success: #15803d;
    }

    /* Color — dark theme (explicit) */
    :root[data-theme="dark"] {
      --color-bg: #0d0d0d;
      --color-surface: #171717;
      --color-border: #262626;
      --color-text: #f5f5f5;
      --color-text-muted: #a3a3a3;
      --color-accent: #60a5fa;
      --color-accent-text: #0d0d0d;
      --color-destructive: #f87171;
      --color-info: #22d3ee;
      --color-success: #4ade80;
    }

    /* Color — system theme honors prefers-color-scheme */
    @media (prefers-color-scheme: dark) {
      :root[data-theme="system"] {
        --color-bg: #0d0d0d;
        --color-surface: #171717;
        --color-border: #262626;
        --color-text: #f5f5f5;
        --color-text-muted: #a3a3a3;
        --color-accent: #60a5fa;
        --color-accent-text: #0d0d0d;
        --color-destructive: #f87171;
        --color-info: #22d3ee;
        --color-success: #4ade80;
      }
    }

    /* Global resets per UI-SPEC §"Layout & Responsive Contract" */
    *, *::before, *::after { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      background: var(--color-bg);
      color: var(--color-text);
      font-family: var(--font-family-sans);
      font-size: var(--font-size-body);
      line-height: var(--line-height-body);
      overflow-x: hidden;   /* UX-02 — no horizontal scroll at 360px */
    }

    /* Defeat default flex min-width: auto so children at 360px don't overflow */
    main, section, article, header, nav, footer, div { min-width: 0; }

    /* Focus ring */
    :focus-visible {
      outline: 2px solid var(--color-accent);
      outline-offset: 2px;
    }
    ```

    Import this stylesheet from `src/routes/+layout.svelte` — Plan 10 wires the import. Mark this dependency in the SUMMARY.
  </action>
  <verify>
    <automated>pnpm exec svelte-kit sync && pnpm exec tsc --noEmit 2>&1 | tail -10 && grep -c "%theme%" src/app.html && grep -c "transformPageChunk" src/hooks.server.ts && grep -c "data-theme=\\\"dark\\\"" src/app.css</automated>
  </verify>
  <done>
    - `src/hooks.server.ts` exports `handle = sequence(authHandle, themeHandle)`; theme cookie read populates `event.locals.theme`.
    - `src/app.html` has `<html data-theme="%theme%">`.
    - `src/app.d.ts` declares App.Locals.theme.
    - `src/app.css` exports all spacing / typography / color tokens for light / dark / system.
  </done>
</task>

<task type="auto">
  <name>Task 2: Add ~30 new Paraglide keys to messages/en.json + extend i18n.test.ts invariant</name>
  <files>messages/en.json, tests/integration/i18n.test.ts</files>
  <read_first>
    - messages/en.json (Phase 1 — 9 existing keys; expanded sort order: keys appear alphabetically by feature group)
    - .planning/phases/02-ingest-secrets-and-audit/02-UI-SPEC.md §"Copywriting Contract" lines 199–292 (every Paraglide key + English label verbatim)
    - tests/integration/i18n.test.ts (Phase 1 — locale-add snapshot test; this plan extends with `expect(keys).toContain('empty_games_heading')` and similar for every new key)
    - project.inlang/settings.json (paraglide config — no edits needed)
  </read_first>
  <action>
    **A. AMEND `messages/en.json`** — add the keys from UI-SPEC §"Copywriting Contract" verbatim. Start with `$schema` and the 9 Phase 1 keys (preserve), then append:

    ```json
    {
      "$schema": "https://inlang.com/schema/inlang-message-format",
      "app_title": "Promotion diary",
      "dashboard_title": "Promotion diary",
      "dashboard_welcome_intro": "Hello {name}. Your dashboard is empty — Phase 2 lands games.",
      "dashboard_unauth_intro": "Sign in with Google to begin.",
      "login_page_title": "Sign in",
      "login_button": "Sign in with Google",
      "login_continue": "Continue with Google",
      "sign_out": "Sign out",
      "sign_out_all_devices": "Sign out from all devices",

      "games_cta_new_game": "+ New game",
      "ingest_cta_add": "Add",
      "events_cta_new_event": "+ New event",
      "keys_steam_cta_save": "Save key",
      "keys_steam_cta_replace": "Replace key",
      "keys_steam_cta_add_another": "Add another key",
      "youtube_channels_cta_add": "+ Add YouTube channel",
      "settings_cta_save": "Save changes",

      "empty_games_heading": "No games yet.",
      "empty_games_body": "Add your first game card to start tracking. You'll paste your Steam store URL like {url} on the next screen.",
      "empty_items_heading": "No tracked items yet.",
      "empty_items_example_youtube_url": "Paste a YouTube video URL like {url} in the box above. Reddit support arrives in Phase 3.",
      "empty_events_heading": "No events yet.",
      "empty_events_body": "Log a conference, talk, Twitter post, or Telegram drop. Or paste a tweet URL like {url} on a game page to log it automatically.",
      "empty_audit_heading": "Audit log is empty.",
      "empty_audit_body": "Sign-ins, key changes, and item edits will show up here. Only you can see this log.",
      "empty_youtube_channels_heading": "No YouTube channels saved.",
      "empty_youtube_channels_body": "Add a channel handle like {url} to mark videos from that channel as your own (otherwise they're logged as blogger coverage).",
      "empty_keys_steam_heading": "No Steam Web API key saved.",
      "empty_keys_steam_body": "A Steam Web API key is optional — manual wishlist entry and Steamworks CSV import work without one. Get a key at {url} if you want auto-fetch in Phase 3.",

      "audit_action_all": "All actions",
      "audit_action_session_signin": "Sign-in",
      "audit_action_session_signout": "Sign-out",
      "audit_action_session_signout_all": "Sign-out (all devices)",
      "audit_action_key_add": "API key added",
      "audit_action_key_rotate": "API key replaced",
      "audit_action_key_remove": "API key removed",
      "audit_action_game_created": "Game created",
      "audit_action_game_deleted": "Game soft-deleted",
      "audit_action_game_restored": "Game restored",
      "audit_action_item_created": "Tracked item created",
      "audit_action_item_deleted": "Tracked item deleted",
      "audit_action_event_created": "Event created",
      "audit_action_event_edited": "Event edited",
      "audit_action_event_deleted": "Event deleted",
      "audit_action_theme_changed": "Theme changed",

      "ingest_error_malformed_url": "That doesn't look like a URL. Paste a full link starting with https://",
      "ingest_error_unsupported_host": "URL not yet supported. Add it as a free-form event from the Events page.",
      "ingest_info_reddit_phase3": "Reddit support arrives in Phase 3. For now, log this post as a free-form event from the Events page.",
      "ingest_error_youtube_unavailable": "Couldn't fetch that video. It may be private, deleted, or region-locked.",
      "ingest_error_oembed_unreachable": "YouTube's metadata service is temporarily unreachable. Try again in a moment.",
      "keys_steam_error_label_exists": "A key with this label already exists. Pick a different label.",
      "ingest_error_youtube_duplicate": "You've already tracked this video.",
      "keys_steam_error_invalid": "Steam Web API rejected that key. Double-check the value and try again.",
      "error_server_generic": "Something went wrong on our side. Try again in a moment.",
      "error_network": "Couldn't reach the server. Check your connection and try again.",

      "confirm_game_delete": "Soft-delete \"{title}\"? You can restore it within 60 days from the deleted-games view.",
      "confirm_event_delete": "Delete this event? You can restore it within 60 days.",
      "confirm_item_delete": "Remove this tracked video? You can restore it within 60 days.",
      "confirm_key_remove": "Remove your Steam Web API key? Wishlist auto-fetch in Phase 3 won't work until you save a new key. This cannot be undone.",
      "confirm_key_replace": "Replace your Steam Web API key? The previous key will be permanently overwritten. This is recorded in the audit log.",
      "confirm_signout_all": "Sign out from every device? You'll need to sign in again everywhere.",

      "badge_release_tba": "TBA",
      "badge_purge_in_days": "Purges in {days} days",
      "badge_purge_in_days_warning": "Purges in {days} days",
      "toast_saved": "Saved.",
      "toast_deleted": "Deleted.",
      "toast_restored": "Restored.",

      "paste_box_label": "Paste a URL"
    }
    ```

    Order matters for the diff but not for correctness. Run `pnpm exec paraglide-js compile` (or whatever the project's compile script is — check `package.json` "scripts") to regenerate `src/lib/paraglide/messages.js`.

    **B. EXTEND `tests/integration/i18n.test.ts`** — Phase 1 has a snapshot/keyset test. Add an explicit assertion that the new P2 keys exist:

    ```typescript
    it("Phase 2 keys are present in messages/en.json (locale-add invariant — D-41)", async () => {
      const en = JSON.parse(fs.readFileSync("messages/en.json", "utf-8"));
      const required = [
        "games_cta_new_game", "ingest_cta_add", "events_cta_new_event", "keys_steam_cta_save", "keys_steam_cta_replace", "keys_steam_cta_add_another", "youtube_channels_cta_add", "settings_cta_save",
        "empty_games_heading", "empty_games_body", "empty_items_heading", "empty_items_example_youtube_url",
        "empty_events_heading", "empty_events_body", "empty_audit_heading", "empty_audit_body",
        "empty_youtube_channels_heading", "empty_youtube_channels_body", "empty_keys_steam_heading", "empty_keys_steam_body",
        "audit_action_all", "audit_action_session_signin", "audit_action_session_signout", "audit_action_session_signout_all",
        "audit_action_key_add", "audit_action_key_rotate", "audit_action_key_remove",
        "audit_action_game_created", "audit_action_game_deleted", "audit_action_game_restored",
        "audit_action_item_created", "audit_action_item_deleted",
        "audit_action_event_created", "audit_action_event_edited", "audit_action_event_deleted",
        "audit_action_theme_changed",
        "ingest_error_malformed_url", "ingest_error_unsupported_host", "ingest_info_reddit_phase3",
        "ingest_error_youtube_unavailable", "ingest_error_oembed_unreachable", "ingest_error_youtube_duplicate", "keys_steam_error_invalid", "keys_steam_error_label_exists",
        "error_server_generic", "error_network",
        "confirm_game_delete", "confirm_event_delete", "confirm_item_delete", "confirm_key_remove", "confirm_key_replace", "confirm_signout_all",
        "badge_release_tba", "badge_purge_in_days", "badge_purge_in_days_warning",
        "toast_saved", "toast_deleted", "toast_restored",
        "paste_box_label",
      ];
      for (const k of required) {
        expect(en).toHaveProperty(k);
      }
    });
    ```
  </action>
  <verify>
    <automated>pnpm exec paraglide-js compile --project ./project.inlang 2>&1 | tail -5 && pnpm test:integration tests/integration/i18n.test.ts --reporter=verbose 2>&1 | tail -10</automated>
  </verify>
  <done>
    `messages/en.json` contains all the keys listed in UI-SPEC §"Copywriting Contract" (verbatim labels). `pnpm exec paraglide-js compile` succeeds. `tests/integration/i18n.test.ts` is green and the locale-add invariant test verifies all P2 keys are present.
  </done>
</task>

<task type="auto">
  <name>Task 3: Build the 18 reusable Svelte 5 components per UI-SPEC contract; flip empty-states.test.ts + theme.test.ts stubs</name>
  <files>src/lib/components/AppHeader.svelte, src/lib/components/Nav.svelte, src/lib/components/PasteBox.svelte, src/lib/components/EmptyState.svelte, src/lib/components/InlineError.svelte, src/lib/components/InlineInfo.svelte, src/lib/components/ConfirmDialog.svelte, src/lib/components/ThemeToggle.svelte, src/lib/components/AuditRow.svelte, src/lib/components/KeyMaskRow.svelte, src/lib/components/ReplaceKeyForm.svelte, src/lib/components/GameCard.svelte, src/lib/components/RetentionBadge.svelte, src/lib/components/ChannelRow.svelte, src/lib/components/EventRow.svelte, src/lib/components/KindIcon.svelte, src/lib/components/CursorPager.svelte, src/lib/components/ActionFilter.svelte, tests/integration/empty-states.test.ts, tests/integration/theme.test.ts</files>
  <read_first>
    - src/routes/+page.svelte and src/routes/login/+page.svelte (Phase 1 Svelte 5 component conventions — runes-style: `let { foo } = $props()` for props; `<style>` blocks scoped per file)
    - .planning/phases/02-ingest-secrets-and-audit/02-UI-SPEC.md §"Reusable component inventory" (purpose + used-by) and §"<PasteBox> interaction contract" + §"Theme toggle interaction contract" + §"Form interaction contracts" + §"Loading & empty contract"
    - .planning/phases/02-ingest-secrets-and-audit/02-RESEARCH.md §"Theme cookie + DB sync" lines 647–696 (client-side toggle JS — sets data-theme + posts /api/me/theme)
    - tests/integration/empty-states.test.ts (placeholder — has 2 stubs to flip)
    - tests/integration/theme.test.ts (placeholder — has 3 stubs to flip)
  </read_first>
  <action>
    Build each component as a standalone `.svelte` file. Use Svelte 5 runes (`$props()`, `$state()`, `$derived()`). Scoped `<style>` block per file. NO Tailwind. Reference `--color-*`, `--space-*`, `--font-size-*` tokens from app.css.

    **Component contracts (planner picks exact prop names; UI-SPEC is the contract source):**

    1. **`<AppHeader>`** — `let { user } = $props<{ user: UserDto | null }>()`. Renders app title + ThemeToggle + sign-out menu. Mobile-friendly (44px touch targets).

    2. **`<Nav>`** — `let { active } = $props<{ active: 'games'|'events'|'audit'|'accounts'|'keys'|'settings' }>()`. Horizontal scroll on mobile (no hamburger; UI-SPEC §"Layout"). Auto-scrolls active item into view via Svelte 5 effect.

    3. **`<PasteBox>`** — `let { gameId, onSuccess } = $props<{ gameId: string; onSuccess: (result) => void }>()`. Single text input + submit button. Per UI-SPEC §"<PasteBox> interaction contract":
       - Validate URL parseable client-side; if not → InlineError immediate, no POST.
       - If host is `reddit.com` / `redd.it` → InlineInfo with `m.ingest_info_reddit_phase3()`, NO POST.
       - Otherwise POST `/api/items/youtube` with `{gameId, urlInput}`. On 4xx → InlineError. On 2xx → call `onSuccess(result)`, clear input, render toast.
       - Min height 48px on the input (UI-SPEC §"Spacing" — touch target).

    4. **`<EmptyState>`** — `let { heading, body, exampleUrl, ctaLabel, onCta } = $props()`. Renders heading (display size), body (with monospace example URL inline-styled — `<code>` element, `font-family: var(--font-family-mono)`, NO cursor:pointer per UI-SPEC FLAG), and CTA button.

    5. **`<InlineError>`** — `let { message } = $props<{ message: string }>()`. Red `border-left` + icon + copy. Color: `--color-destructive`.

    6. **`<InlineInfo>`** — same shape but color `--color-info`.

    7. **`<ConfirmDialog>`** — native `<dialog>` element. `let { open, message, confirmLabel, isIrreversible, onConfirm, onCancel } = $props()`. If `isIrreversible`, render a checkbox `I understand this is permanent` that gates the confirm button (initially disabled).

    8. **`<ThemeToggle>`** — `let { current } = $props<{ current: 'light'|'dark'|'system' }>()`. Three icons (sun/moon/monitor). Click cycles light→dark→system→light. Optimistically updates `document.documentElement.dataset.theme`, then POSTs `/api/me/theme`. On error, reverts.

    9. **`<AuditRow>`** — `let { entry } = $props<{ entry: AuditEntryDto }>()`. Stacked layout on mobile, table-row on desktop. Renders `m.audit_action_<action>()` for the chip; renders metadata.last4 / metadata.kind for key.* events.

    10. **`<KeyMaskRow>`** — `let { keyDto, onReplace, onRemove } = $props<{ keyDto: ApiKeySteamDto; ... }>()`. Renders `••••••••${keyDto.last4}` in monospace.

    11. **`<ReplaceKeyForm>`** — `let { mode, onSubmit, onCancel } = $props<{ mode: 'add'|'replace'; ... }>()`. Single text input + label + Save button. Calls `/api/api-keys/steam` (POST for add, PATCH for replace).

    12. **`<GameCard>`** — `let { game, onSoftDelete, onRestore } = $props<{ game: GameDto; ... }>()`. Title, optional cover thumb (96–128px), release date or `<TagChip>TBA</TagChip>`, tag chips, soft-delete affordance.

    13. **`<RetentionBadge>`** — `let { deletedAt } = $props<{ deletedAt: Date }>()`. Computes `daysUntilPurge = (deletedAt + RETENTION_DAYS - now).toDays()`. Renders `m.badge_purge_in_days({days})` or warning variant if days < 7.

    14. **`<ChannelRow>`** — `let { channel, onToggleOwn, onRemove } = $props<{ channel: YoutubeChannelDto; ... }>()`. Handle URL + own/blogger toggle + remove button.

    15. **`<EventRow>`** — `let { event, onEdit, onDelete } = $props<{ event: EventDto; ... }>()`. KindIcon + occurredAt (relative + absolute on hover) + title + optional URL link + edit/delete.

    16. **`<KindIcon>`** — `let { kind } = $props<{ kind: EventKind }>()`. Inline SVG dispatch on the 7 kinds (UI-SPEC FLAG: ~15 SVGs total in P2; pick sprite vs per-icon at executor's discretion — RECOMMENDED: per-component file `src/lib/icons/{kind}.svg`).

    17. **`<CursorPager>`** — `let { nextCursor, prevCursors, onNext, onPrev } = $props()`. "Older →" / "← Newer" buttons. No page numbers.

    18. **`<ActionFilter>`** — `let { value, onChange } = $props<{ value: 'all' | AuditAction; onChange: (v) => void }>()`. Native `<select>` element with `<option value="all">m.audit_action_all()</option>` plus one option per AUDIT_ACTIONS member.

    Mobile-first CSS within each component:
    - `min-width: 0` on flex containers (defeats default `auto`).
    - `gap: var(--space-md)` (or other token) instead of margin-based spacing.
    - Touch target floor 44px on icon-only buttons.

    **Flip `tests/integration/empty-states.test.ts` (2 stubs):**

    **W-2 dependency decision:** do NOT add `@testing-library/svelte`. Use Svelte 5's built-in
    server-side `render` from `svelte/server` (Svelte 5 ships SSR rendering as a first-class
    export — no third-party dep required). The empty-state assertions are PURE-TEXT shape
    checks (heading present, monospace `<code>` element wrapping the URL), so the rendered-HTML
    string is sufficient — no DOM event simulation, no testing-library helpers needed.

    ```typescript
    import { describe, it, expect } from "vitest";
    import { render } from "svelte/server";   // Svelte 5 built-in SSR — no new dep
    import EmptyState from "../../src/lib/components/EmptyState.svelte";
    import * as m from "../../src/lib/paraglide/messages.js";

    describe("empty-state copy + Paraglide invariant (UX-03)", () => {
      it("02-09: UX-03 empty /games shows monospace example URL", () => {
        const { body } = render(EmptyState, {
          props: {
            heading: m.empty_games_heading(),
            body: m.empty_games_body({ url: "https://store.steampowered.com/app/1145360/HADES/" }),
          },
        });
        // body is the rendered HTML string from SSR
        expect(body).toContain("No games yet.");
        // Monospace family applied to <code> element holding the example URL (the EmptyState
        // component MUST wrap the URL in <code>; verified by this regex).
        expect(body).toMatch(/<code[^>]*>https:\/\/store\.steampowered\.com\/app\/1145360\/HADES\/<\/code>/);
      });

      it("02-09: UX-03 all P2 keys present in messages/en.json", () => {
        // Re-asserts a subset of i18n.test.ts to keep this test self-contained.
        const required = ["empty_games_heading", "empty_items_heading", "empty_events_heading", "empty_audit_heading", "empty_youtube_channels_heading", "empty_keys_steam_heading"];
        for (const k of required) {
          expect((m as Record<string, unknown>)[k]).toBeDefined();
        }
      });
    });
    ```

    Acceptance: `grep -c "@testing-library/svelte" package.json` returns 0 (the dep is NOT
    added by this plan); `grep -c "from \"svelte/server\"" tests/integration/empty-states.test.ts` returns 1.
    If the executor finds Svelte 5's `svelte/server` SSR import unavailable in the locked
    Svelte version, fall back to: render the EmptyState component INSIDE a tiny throwaway
    SvelteKit page (e.g. `src/routes/__test/empty-state-probe/+page.svelte`) and assert
    against `app.request("/__test/empty-state-probe").then(r => r.text())`. Flag the chosen
    path in `02-09-SUMMARY.md`. NEVER add `@testing-library/svelte` — Plan 11's browser-mode
    suite handles full-DOM assertion needs.

    **Flip `tests/integration/theme.test.ts` (3 stubs):**

    ```typescript
    describe("theme cookie + DB persist (UX-01)", () => {
      it("02-09: UX-01 SSR no flash (locals.theme set before handler)", async () => {
        const { createApp } = await import("../../src/lib/server/http/app.js");
        const app = createApp();
        // GET / with __theme=dark cookie; assert response HTML contains data-theme="dark"
        const res = await app.request("/", {
          headers: { cookie: "__theme=dark" },
        });
        const html = await res.text();
        expect(html).toMatch(/data-theme="dark"/);
        expect(html).not.toMatch(/data-theme="%theme%"/);   // placeholder NOT leaking
      });

      it("02-09: UX-01 POST /api/me/theme updates cookie + DB + audits theme.changed", async () => {
        const { createApp } = await import("../../src/lib/server/http/app.js");
        const app = createApp();
        const u = await seedUserDirectly({ email: "th@test.local" });
        const res = await app.request("/api/me/theme", {
          method: "POST",
          headers: {
            cookie: `neotolis.session_token=${u.signedSessionCookieValue}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ theme: "dark" }),
        });
        expect(res.status).toBe(200);
        // Response Set-Cookie carries __theme=dark with no HttpOnly
        const setCookie = res.headers.get("set-cookie") ?? "";
        expect(setCookie).toContain("__theme=dark");
        expect(setCookie).not.toMatch(/HttpOnly/i);
        // DB updated
        const [row] = await db.select().from(user).where(eq(user.id, u.id)).limit(1);
        expect(row!.themePreference).toBe("dark");
        // Audit row exists
        const [a] = await db.select().from(auditLog).where(and(eq(auditLog.userId, u.id), eq(auditLog.action, "theme.changed"))).limit(1);
        expect(a).toBeDefined();
        expect(a!.metadata).toMatchObject({ from: "system", to: "dark" });
      });

      it("02-09: UX-01 cookie wins on signin reconciliation", async () => {
        // The reconciliation logic lives in src/routes/+layout.server.ts (Plan 10 wires it).
        // Plan 09 ships a placeholder it.skip if the reconciliation logic isn't yet wired.
        // If wired in this plan: assert that with cookie=light AND DB.theme_preference=dark, the next page load surfaces locals.theme === 'light' AND eventually writes 'light' back to DB.
        // If not wired: it.skip with an annotation pointing at Plan 10.
      });
    });
    ```

    The cookie-wins reconciliation test is gated on Plan 10's `+layout.server.ts` change. If executor decides to wire reconciliation in Plan 09 itself (it's a small change — read the cookie + DB in the existing layout-server load and write back if they differ), flip the test fully. Otherwise leave as `it.skip` with annotation `02-10: cookie wins on signin (deferred to Plan 10 +layout.server.ts wire)`.
  </action>
  <verify>
    <automated>pnpm exec svelte-kit sync && pnpm exec svelte-check 2>&1 | tail -10 && pnpm test:integration tests/integration/empty-states.test.ts tests/integration/theme.test.ts --reporter=verbose 2>&1 | tail -20</automated>
  </verify>
  <done>
    - 18 reusable Svelte components exist under `src/lib/components/`; each is a standalone `.svelte` file with scoped `<style>` block referencing `--color-*` / `--space-*` / `--font-size-*` tokens.
    - `pnpm exec svelte-check` reports no errors on the new components.
    - empty-states.test.ts (2 stubs) + theme.test.ts (≥2 stubs; the third may be deferred to Plan 10 with annotation) all green.
    - No Tailwind / shadcn / new component-library deps added.
  </done>
</task>

</tasks>

<verification>
- `pnpm exec svelte-check` is clean.
- `pnpm test:integration tests/integration/i18n.test.ts tests/integration/empty-states.test.ts tests/integration/theme.test.ts` is green.
- `grep -c "var(--color-" src/lib/components/*.svelte | awk -F: '$2>0 {n++} END {print n}'` >= 15 (most components reference design tokens).
- `grep -c "%theme%" src/app.html` == 1.
- `grep -c "sequence" src/hooks.server.ts` >= 1.
</verification>

<success_criteria>
- UX-01: theme cookie read in hooks.server BEFORE handler; transformPageChunk replaces `%theme%`; client-side toggle posts /api/me/theme + sets cookie without HttpOnly + writes audit theme.changed.
- UX-03: ~30 new Paraglide keys land in messages/en.json; locale-add invariant test (i18n.test.ts) passes; empty states render monospace `<code>` example URLs.
- 18 reusable Svelte 5 components exist; scoped styles reference design tokens; no new top-level deps.
- Design tokens (spacing, typography, color × 3 themes) live in `src/app.css` per UI-SPEC contract.
- Theme integration tests pass (SSR no-flash + POST + reconciliation if wired here, or annotated skip pointing at Plan 10).
- Empty-states tests pass (component renders + Paraglide keys present).
</success_criteria>

<output>
After completion, create `.planning/phases/02-ingest-secrets-and-audit/02-09-SUMMARY.md`. Highlight: which 18 components were built, the final keyset count in messages/en.json (Phase 1 + Phase 2 = ~40-50 keys), confirmation that NO new component-test dep was added (W-2: `svelte/server` SSR render used; `@testing-library/svelte` deliberately NOT added), and whether cookie-wins reconciliation was wired in this plan or deferred to Plan 10.
</output>
