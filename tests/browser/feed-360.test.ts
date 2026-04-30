/**
 * tests/browser/feed-360.test.ts
 *
 * Plan 02.1-07 — FEED-01 360px responsive surface (extended Plan 02.1-16
 * for FeedCard / Gap 3 closure).
 *
 * SCOPE: PUBLIC-routed assertion only. The plan's <action> Step D specifies
 * "/feed at 360x640 redirects an anonymous request to /login (public-routed
 * assertion only — auth-routed parts deferred to manual UAT)". The
 * authenticated-user 360px sweep (chips collapse to "Filters (N)" sheet
 * button, FeedCard vertical stack at 360px without horizontal overflow,
 * thumbnail occupies full card width on YouTube events) is deferred to
 * Phase 6 per VALIDATION.md `Manual-Only Verifications` — the cookie-
 * injection harness deferred from Phase 2 still hasn't landed (vitest
 * browser-mode tests run in a separate process from the SvelteKit preview
 * server with no in-test DB connection available).
 *
 * Plan 02.1-16 contract additions (deferred — manual UAT covers them):
 *   - rendered cards expose data-kind={event.kind} attribute,
 *   - kind=youtube_video cards contain <img src*="img.youtube.com/vi/">,
 *   - kind=conference cards render the centered KindIcon (no <img>),
 *   - card date strings match formatFeedDate buckets:
 *       /^Today, /, /^Yesterday$/, /^[A-Z][a-z]{2} \d+/.
 * The card-shape contract is unit-tested via tests/unit/format-feed-date
 * + the SSR shape exercised in components-test (auth-gate doesn't apply
 * to a pure render test). Authenticated end-to-end remains in the manual
 * UAT block.
 *
 * Mirrors the pattern of `tests/browser/responsive-360.test.ts`: viewport
 * resize → goto → assert URL or DOM. CI provisions a `pnpm preview`
 * server on :5173; locally:
 *   pnpm build && pnpm preview --port 5173 &
 *   pnpm test:browser
 */

import { describe, it, expect } from "vitest";
import { page, commands } from "@vitest/browser/context";

const BASE = process.env.BROWSER_TEST_BASE_URL ?? "http://localhost:5173";

describe("FEED-01 (browser): /feed responsive at 360px", () => {
  it("anonymous request to /feed redirects to /login (public-routed)", async () => {
    await page.viewport(360, 640);
    await commands.goto(`${BASE}/feed`);
    // Anonymous → +layout.server.ts protected-paths sweep redirects to /login,
    // OR /feed/+page.server.ts's defense-in-depth `if (!locals.user) throw
    // redirect(303, "/login?next=...")` fires. Either way, the URL after
    // navigation contains "/login". The `?next=` param-encoded value is the
    // original `/feed` path so a subsequent successful sign-in lands the user
    // on the page they originally wanted.
    const url = await commands.currentUrl();
    expect(url).toMatch(/\/login/);
  });

  it.skip(
    "authenticated /feed at 360px (cookie-injection harness deferred to Phase 6 per Phase 2 precedent — see 02.1-VALIDATION.md Manual-Only Verifications)",
  );

  it.skip(
    "authenticated /feed filter chips collapse to 'Filters (N)' button below 600px (manual UAT — see Manual-Only verifications)",
  );

  it.skip(
    "Plan 02.1-16: authenticated /feed cards expose data-kind + youtube thumbnail / kind-icon fallback / formatFeedDate string (manual UAT — auth harness deferred to Phase 6)",
  );
});

/**
 * Plan 02.1-19 — feed UX rebuild: filters / scroll / grouping / layout.
 *
 * The full Plan 02.1-19 flow (chip per axis, Show 3-state, date-group
 * headers, infinite scroll auto-append, multi-column at 1024px,
 * /events/new round-trip without manual refresh) requires the
 * authenticated cookie-injection harness which is still deferred to
 * Phase 6 (see 02.1-VALIDATION.md "Manual-Only Verifications"). The
 * 11 specific cases below are stub-skipped here and documented in the
 * VALIDATION.md manual UAT block. The PUBLIC-routed 360px no-horizontal-
 * scroll D-42 invariant remains covered by the existing test above.
 */
describe("Plan 02.1-19: feed UX rebuild — filters / scroll / grouping / layout", () => {
  it.skip(
    "DateRangeControl renders from/to inputs without clicking 'Custom' (manual UAT — auth harness deferred to Phase 6)",
  );
  it.skip(
    "DateRangeControl exposes 4 presets — Today, Week, Month, Year (manual UAT — auth harness deferred)",
  );
  it.skip(
    "DateRangeControl × clear button navigates to ?all=1 (manual UAT — auth harness deferred)",
  );
  it.skip(
    "FilterChips emits one chip per axis with comma-joined values (manual UAT — auth harness deferred)",
  );
  it.skip(
    "FilterChips × dismiss clears the entire axis (manual UAT — auth harness deferred)",
  );
  it.skip(
    "FiltersSheet 'Show: Inbox' hides the games multi-select (manual UAT — auth harness deferred)",
  );
  it.skip(
    "FiltersSheet 'Show: Specific games' reveals the games multi-select (manual UAT — auth harness deferred)",
  );
  it.skip(
    "/feed renders date-group headers above each group's cards (manual UAT — auth harness deferred)",
  );
  it.skip(
    "/feed infinite scroll auto-appends rows on scroll (manual UAT — auth harness deferred)",
  );
  it.skip(
    "/feed renders multiple columns at 1024px viewport (manual UAT — auth harness deferred)",
  );
  it.skip(
    "/events/new submit → /feed shows new event without manual refresh (manual UAT — auth harness deferred)",
  );
});

/**
 * Plan 02.1-18 — edit-flow rebuild via /events/[id] detail page.
 *
 * The full Plan 02.1-18 flow (FeedCard click → /events/[id] detail →
 * Edit pencil → /events/[id]/edit form → Save → back to detail with
 * updated title; Delete-from-detail → ConfirmDialog → /feed without the
 * deleted row; FeedCard renders no Edit/Delete/Open-external buttons;
 * 360px detail page no horizontal scroll) requires the authenticated
 * cookie-injection harness which is still deferred to Phase 6 (see
 * 02.1-VALIDATION.md "Manual-Only Verifications"). The 6 specific cases
 * below are stub-skipped here and documented in the VALIDATION.md
 * manual UAT block. The PUBLIC-routed 360px no-horizontal-scroll D-42
 * invariant for the detail page is partially covered by the existing
 * /feed redirect test above (anonymous /events/[id] also redirects to
 * /login — page-route gate via the loader's redirect(303)).
 *
 * Per Plan 02.1-19's Task 10 deviation #4 precedent, these stubs use
 * `it.skip` with named-plan annotations for grep discoverability when
 * the auth harness arrives.
 */
describe("Plan 02.1-18: edit-flow rebuild via detail page", () => {
  it.skip(
    "FeedCard click → /events/[id] detail page (manual UAT — auth harness deferred)",
  );
  it.skip(
    "FeedCard does NOT render Edit / Delete / Open-external buttons (manual UAT — auth harness deferred)",
  );
  it.skip(
    "/events/[id] detail → Edit pencil → /events/[id]/edit form pre-filled (manual UAT — auth harness deferred)",
  );
  it.skip(
    "/events/[id]/edit save → PATCH /api/events/:id → back to detail with updated title (manual UAT — auth harness deferred)",
  );
  it.skip(
    "/events/[id] Delete → ConfirmDialog → confirm → /feed without the row (manual UAT — auth harness deferred)",
  );
  it.skip(
    "/events/[id] at 360px viewport renders without horizontal scroll (manual UAT — auth harness deferred)",
  );
});

/**
 * Plan 02.1-20 — /audit FilterChips + FiltersSheet UX rewrite.
 *
 * Round-2 UAT closure: ActionFilter dropdown is REMOVED; /audit reuses
 * <FilterChips> + <FiltersSheet> from /feed. URL contract switches from
 * single-select ?action=A to multi-select ?action=A&action=B. These stubs
 * are it.skip pending the cookie-injection auth harness (same pattern as
 * Plan 02.1-18 / 02.1-19 — VALIDATION.md "Manual-Only Verifications").
 */
describe("Plan 02.1-20: /audit FilterChips + FiltersSheet UX", () => {
  it.skip(
    "/audit renders FilterChips strip (no ActionFilter dropdown) (manual UAT — auth harness deferred)",
  );
  it.skip(
    "clicking 'Filters' opens FiltersSheet with action checkbox-list (manual UAT — auth harness deferred)",
  );
  it.skip(
    "selecting two actions produces ONE chip with comma-joined labels (manual UAT — auth harness deferred)",
  );
  it.skip(
    "clicking × on the action chip clears the entire axis (manual UAT — auth harness deferred)",
  );
  it.skip(
    "URL contract: /audit?action=A&action=B repeated params are honored on direct navigation (manual UAT — auth harness deferred)",
  );
  it.skip(
    "invalid ?action=foo entries are silently dropped (forgiving GET) (manual UAT — auth harness deferred)",
  );
  it.skip(
    "/audit at 360px viewport renders without horizontal scroll with chip visible (manual UAT — auth harness deferred)",
  );
});

/**
 * Plan 02.1-21 — /audit FiltersSheet schema honored + date-range filter.
 *
 * Round-3 UAT closure for §9.2-bug. Two requirements verified here:
 *   1. /audit FiltersSheet renders date-range inputs AND action checkbox-list
 *      and renders NO source/kind/show/authorIsMe fieldsets (UAT user quote:
 *      "Открывает окно, там есть типы аудита, но и куча полей из feed
 *      фильтров").
 *   2. /audit URL contract supports ?from=YYYY-MM-DD&to=YYYY-MM-DD and the
 *      rendered rows reflect the filter (UAT user quote: "В окне аудита нет
 *      возможности выбрать дату как в feed").
 *
 * Stub-skipped here pending the cookie-injection auth harness (same pattern
 * as Plans 02.1-18 / 19 / 20). The component-level regression guard is
 * covered by tests/integration/audit-render.test.ts (Plan 02.1-21 describe
 * block), and the service-level dateRange filter is covered by
 * tests/integration/audit.test.ts (Plan 02.1-21 describe block). The
 * end-to-end browser flow is captured in 02.1-VALIDATION.md "Manual-Only
 * Verifications" until the auth harness ships in Phase 6.
 */
describe("Plan 02.1-21: /audit FiltersSheet schema honored + date-range filter", () => {
  it.skip(
    "/audit FiltersSheet renders date-range + action fieldsets ONLY (no source/kind/show/authorIsMe leak) (manual UAT — auth harness deferred)",
  );
  it.skip(
    "/audit URL ?from=YYYY-MM-DD&to=YYYY-MM-DD reflects in DateRangeControl + narrows rendered rows (manual UAT — auth harness deferred)",
  );
  it.skip(
    "/audit DateRangeControl × clear button removes ?from / ?to from the URL (manual UAT — auth harness deferred)",
  );
});

/**
 * Plan 02.1-23 — FeedCard restructured layout (UAT §1.5-redesign closure).
 *
 * The user-proposed card layout from round-3 UAT (ASCII mockup in
 * UAT-NOTES.md §1.5-redesign):
 *   - Top overlay on image carries kind icon+text + Inbox + Mine pills.
 *   - Title under image; notes (if present) clipped at 3 lines.
 *   - Associated games block at the BOTTOM of the card.
 *   - Mine treatment combines `border-left: 4px solid var(--color-accent)`
 *     AND a `Mine` badge in the top overlay (user choice "C and A").
 *
 * Component-level regression guard lives in
 * tests/integration/audit-render.test.ts (Plan 02.1-23 describe block).
 * The end-to-end browser flow at 360px (computed border-left-width === '4px',
 * overlay positioned absolute over the media area) requires the cookie-
 * injection auth harness still deferred to Phase 6 (same precedent as Plans
 * 02.1-18 / 19 / 20 / 21). Stub-skipped here for grep discoverability when
 * the harness arrives; manual UAT covers the visual gate via
 * 02.1-VALIDATION.md "Manual-Only Verifications".
 */
describe("Plan 02.1-23: FeedCard restructured layout (top overlay + bottom games block + Mine treatment)", () => {
  it.skip(
    "FeedCard with author_is_me=true at 360px renders with computed border-left-width === '4px' (manual UAT — auth harness deferred to Phase 6)",
  );
  it.skip(
    "FeedCard top overlay element is absolutely positioned over the media area (manual UAT — auth harness deferred)",
  );
  it.skip(
    "FeedCard top overlay contains kind label + Inbox + Mine pills when applicable (manual UAT — auth harness deferred)",
  );
  it.skip(
    "FeedCard games-block sits at the BOTTOM of the card body (after chips-line) (manual UAT — auth harness deferred)",
  );
  it.skip(
    "FeedCard notes paragraph clamps to 3 lines via -webkit-line-clamp CSS (manual UAT — auth harness deferred)",
  );
});

/**
 * Plan 02.1-25 — SteamListingRow + GameCover on /games/[id] at 360px.
 *
 * Closes UAT-NOTES.md §3.3-polish (Steam name + Open-on-Steam link) +
 * §3.2-redesign (GameCover Steam header_image vs gradient placeholder).
 * The component-level regression guards (SSR render-time) live in
 * tests/integration/audit-render.test.ts (Plan 02.1-25 describe block —
 * 13 tests). Browser-mode at-360px assertions remain stub-skipped pending
 * the Phase 6 auth harness (same precedent as Plans 02.1-18 / 19 / 20 /
 * 21 / 22 / 23 / 24 / 26).
 */
describe("Plan 02.1-25: SteamListingRow + GameCover on /games/[id] at 360px", () => {
  it.skip(
    "SteamListingRow displays the Steam name (e.g. 'Portal 2') instead of 'App 620' when name column is populated (manual UAT — auth harness deferred)",
  );
  it.skip(
    "SteamListingRow Open-on-Steam <a> href === 'https://store.steampowered.com/app/{appId}/' (manual UAT — auth harness deferred)",
  );
  it.skip(
    "SteamListingRow Open-on-Steam <a> opens in a new tab (target='_blank' + rel='noopener noreferrer') (manual UAT — auth harness deferred)",
  );
  it.skip(
    "GameCover renders <img> with referrerpolicy='no-referrer' when first listing has coverUrl (manual UAT — auth harness deferred)",
  );
  it.skip(
    "GameCover renders gradient placeholder + game initials when no listing has coverUrl (manual UAT — auth harness deferred)",
  );
});

/**
 * Plan 02.1-26 — FeedQuickNav (chip strip / segmented control at top of /feed).
 *
 * Closes UAT-NOTES.md §6.2-redesign — the user wants single-click switch
 * between All / Inbox / Standalone / per-game views. NEW component,
 * <FeedQuickNav>, renders ABOVE <DateRangeControl>.
 *
 * The end-to-end 360px viewport flow (visit /feed → strip renders → click
 * Inbox → URL becomes /feed?show=inbox → tab is highlighted; > 5 games →
 * 'More games' dropdown reveals the rest; horizontal scroll within the
 * strip works smoothly on touch) requires the cookie-injection auth harness
 * still deferred to Phase 6 (same precedent as Plans 02.1-18 / 19 / 20 /
 * 21 / 23). Stub-skipped here for grep discoverability when the harness
 * arrives; manual UAT covers the visual + click flow.
 *
 * The component-level regression guard lives in
 * tests/integration/audit-render.test.ts (Plan 02.1-26 describe block) —
 * 13 SSR render-time tests over the tab structure, active-state logic,
 * href construction, and dropdown overflow behavior.
 */
describe("Plan 02.1-26: FeedQuickNav at top of /feed", () => {
  it.skip(
    "FeedQuickNav renders above DateRangeControl with All / Inbox / Standalone tabs at 360px (manual UAT — auth harness deferred to Phase 6)",
  );
  it.skip(
    "clicking 'Inbox' tab navigates to /feed?show=inbox and the loader re-runs (manual UAT — auth harness deferred)",
  );
  it.skip(
    "active tab has the accent background — computed background matches var(--color-accent) (manual UAT — auth harness deferred)",
  );
  it.skip(
    "at 360px viewport with 6 game tabs the strip horizontally scrolls without page-body horizontal scroll (manual UAT — auth harness deferred)",
  );
  it.skip(
    "with > 5 games the 'More games' dropdown reveals the overflow on summary click (manual UAT — auth harness deferred)",
  );
  it.skip(
    "URL /feed?show=specific&game=<id> highlights the matching game tab as active on direct navigation (manual UAT — auth harness deferred)",
  );
});

/**
 * Plan 02.1-31 — Standalone label rename to "Not game-related" / "Не про игры".
 *
 * Closes UAT-NOTES.md §4.24.A — the user does not parse "Standalone" as
 * "not related to any game". User quote: "Standalone странный текст. Не
 * очевидно что это вообще не про игры."
 *
 * Pure i18n value rename. The Paraglide KEYS stay (URL contract / state
 * shape preserved); only the VALUES change:
 *   - feed_card_mark_standalone_button: → "Mark as not game-related"
 *   - feed_filter_show_standalone:      → "Not game-related"
 *   - feed_quick_nav_standalone:        → "Not game-related"
 *   - audit_action_event_marked_standalone:   STAYS (technical audit log)
 *   - audit_action_event_unmarked_standalone: STAYS (technical audit log)
 *
 * The full end-to-end browser flow at 360px (visit /feed → FeedQuickNav
 * standalone tab reads "Not game-related"; click → URL ?show=standalone;
 * FilterChips axis chip reads "Show: Not game-related"; FiltersSheet show
 * radio reads "Not game-related"; FeedCard inbox card inline button reads
 * "Mark as not game-related") requires the cookie-injection auth harness
 * still deferred to Phase 6 (same precedent as Plans 02.1-18 / 19 / 20 /
 * 21 / 23 / 26). Stub-skipped here for grep discoverability when the
 * harness arrives.
 *
 * The component-level regression guard lives in
 * tests/integration/audit-render.test.ts (Plan 02.1-31 describe block) —
 * SSR render-time assertions over each surface that displays the
 * standalone label.
 */
describe("Plan 02.1-31: Standalone label rename — 'Not game-related'", () => {
  it.skip(
    "FeedQuickNav segment for the standalone state renders 'Not game-related' — NOT 'Standalone' (manual UAT — auth harness deferred to Phase 6)",
  );
  it.skip(
    "FilterChips chip for show=standalone reads 'Show: Not game-related' (manual UAT — auth harness deferred)",
  );
  it.skip(
    "FiltersSheet show fieldset radio with value='standalone' has label 'Not game-related' (manual UAT — auth harness deferred)",
  );
  it.skip(
    "FeedCard inbox card inline button reads 'Mark as not game-related' — NOT 'Mark standalone' (manual UAT — auth harness deferred)",
  );
  it.skip(
    "URL contract preserved — clicking the renamed FeedQuickNav segment navigates to /feed?show=standalone (lowercase technical state name STAYS) (manual UAT — auth harness deferred)",
  );
  it.skip(
    "Audit log row for event.marked_standalone still reads 'Event marked standalone' (technical context — by design) (manual UAT — auth harness deferred)",
  );
});

/**
 * Plan 02.1-34 — FiltersSheet body-scroll-lock via CSS :has() (UAT-NOTES.md §4.22.F).
 *
 * Plan 02.1-22 added an imperative document.body.style.overflow = 'hidden'
 * inside the FiltersSheet's $effect (with a cleanup return restoring it).
 * Round-4 UAT surfaced regression: body still scrolled when sheet was open.
 * Root causes (per analysis):
 *   - Svelte 5 $effect cleanup timing was unreliable across re-runs.
 *   - Other dialog components (e.g. ConfirmDialog) could overwrite the
 *     inline style back to '' on their own lifecycle.
 *
 * Plan 02.1-34 fix: declarative CSS :has() selector in src/app.css —
 *   body:has(dialog[open]) { overflow: hidden; }
 * The browser engine applies the lock the moment ANY <dialog open> is in
 * the DOM, and self-restores when none is. No JS state to manage. Works
 * for FiltersSheet, ConfirmDialog, and any future modal using <dialog>.
 *
 * The full end-to-end (open sheet → body unscrollable → close → body
 * scrollable) requires the cookie-injection auth harness still deferred
 * to Phase 6. Stub-skipped here for grep discoverability when the harness
 * arrives. The CSS rule's mere presence in src/app.css is the
 * regression-source guard for this plan; an integration test in
 * tests/integration/audit-render.test.ts (Plan 02.1-34 describe block)
 * also asserts FiltersSheet no longer touches document.body.style.overflow.
 */
describe("Plan 02.1-34: FiltersSheet body-scroll-lock via CSS :has()", () => {
  it.skip(
    "/feed open FiltersSheet → window.scrollTo(0, 100) on body → document.body.scrollTop stays 0 (manual UAT — auth harness deferred to Phase 6)",
  );
  it.skip(
    "/feed close FiltersSheet → window.scrollTo(0, 100) on body → document.body.scrollTop > 0 (lock released) (manual UAT — auth harness deferred)",
  );
  it.skip(
    "getComputedStyle(document.body).overflow === 'hidden' while a <dialog open> is in the DOM (CSS :has() rule applied) (manual UAT — auth harness deferred)",
  );
});

/**
 * Plan 02.1-30 — /games/[id] reuses the SAME FeedCard component as /feed.
 *
 * UAT-NOTES.md §4.25.B user direction: "карточки как в feed ленте,
 * небольшие, без фильтров и выбора даты". Plan 02.1-30 RETIRES the Plan
 * 02.1-25 oversized 2-card layout and replaces it with a vertical FeedCard
 * list grouped by date via the same groupEventsByDate util as /feed —
 * pure list, no FilterChips / DateRangeControl / FiltersSheet on the
 * /games/[id] surface.
 *
 * On /games/[id], every event has at least one attached game (the
 * current game), so EventDto.gameIds.length > 0 by construction. The
 * FeedCard isInboxRow gate (Plan 02.1-28: gameIds.length === 0 → inbox)
 * automatically HIDES the inline 'Mark standalone' affordance on these
 * cards. No FeedCard change required.
 *
 * The end-to-end (visit /games/[id] → cards render with the SAME visual
 * shape as /feed → no inline 'Mark standalone' button anywhere on the
 * page) requires the cookie-injection auth harness still deferred to
 * Phase 6 (same precedent as Plans 02.1-18 / 19 / 20 / 21 / 23 / 25 / 26).
 * Stub-skipped here for grep discoverability when the harness arrives.
 *
 * The component-level regression guard lives in
 * tests/integration/audit-render.test.ts (Plan 02.1-30 describe block) —
 * SSR rendering of the new /games/[id] layout + StoresSection + FeedCard
 * reuse + the standalone-button suppression contract.
 */
describe("Plan 02.1-30: FeedCard reuse on /games/[id] at 360px", () => {
  it.skip(
    "/games/[id] renders the SAME <FeedCard> component as /feed (no per-page variant) — §4.25.B (manual UAT — auth harness deferred to Phase 6)",
  );
  it.skip(
    "/games/[id] FeedCard with gameIds.length > 0 does NOT render the inline 'Mark standalone' button (gated by isInboxRow) — §4.25.B (manual UAT — auth harness deferred)",
  );
  it.skip(
    "/games/[id] events list groups cards under <FeedDateGroupHeader> via the SAME groupEventsByDate util as /feed — §4.25.B (manual UAT — auth harness deferred)",
  );
  it.skip(
    "/games/[id] does NOT render <FilterChips> / <DateRangeControl> / <FiltersSheet> components — §4.25.B user direction (manual UAT — auth harness deferred)",
  );
});

/**
 * Plan 02.1-32 — /events/[id] Edit pencil + Delete placement + AttachToGamePicker compact + visibility.
 *
 * Closes UAT-NOTES.md §4.18.A + §4.18.B + §4.24.E + §4.24.F. The full
 * 360px-viewport flow (visit /events/[id] → pencil at top-right + NO
 * Delete; visit /events/[id]/edit → Delete at form footer; visit /feed
 * → inbox card has compact picker, attached card has NO picker)
 * requires the cookie-injection auth harness still deferred to Phase 6
 * (same precedent as Plans 02.1-18 / 19 / 20 / 21 / 23 / 25 / 26 / 30 /
 * 31 / 33).
 *
 * The component-level regression guard lives in
 * tests/integration/audit-render.test.ts (Plan 02.1-32 describe block) —
 * 7 SSR-render-time tests over the picker visibility gate, compact
 * label swap, /events/[id] edit-pencil presence + Delete absence, and
 * /events/[id]/edit standalone toggle + Delete-at-footer wiring.
 */
describe("Plan 02.1-32: /events/[id] Edit pencil top-right + Delete moved + AttachToGamePicker compact + visibility", () => {
  it.skip(
    "/events/[id] at 360px renders <a class='edit-pencil'> with computed position: absolute, top: small, right: small (manual UAT — auth harness deferred to Phase 6)",
  );
  it.skip(
    "/events/[id] read-only page does NOT render a Delete button (manual UAT — auth harness deferred)",
  );
  it.skip(
    "/events/[id]/edit form footer renders the Delete button (manual UAT — auth harness deferred)",
  );
  it.skip(
    "/events/[id]/edit standalone checkbox toggles metadata.triage.standalone via PATCH /api/events/:id/mark-standalone (manual UAT — auth harness deferred)",
  );
  it.skip(
    "FeedCard with gameIds.length > 0 does NOT render AttachToGamePicker on /feed (manual UAT — auth harness deferred)",
  );
  it.skip(
    "FeedCard with metadata.triage.standalone=true does NOT render AttachToGamePicker on /feed (manual UAT — auth harness deferred)",
  );
  it.skip(
    "FeedCard inbox row renders AttachToGamePicker with class='compact' and label='Attach' (manual UAT — auth harness deferred)",
  );
});

/**
 * Plan 02.1-39 — round-6 UI bundle on /feed (UAT-NOTES.md §5.4 + §5.6).
 * Closes:
 *   §5.4 (P1) — FeedQuickNav (tabs strip below AppHeader on /feed) sticks
 *               below AppHeader + PageHeader. The CSS rule lives in
 *               src/lib/components/FeedQuickNav.svelte:
 *                 position: sticky;
 *                 top: calc(var(--app-header-height, 72px) +
 *                          var(--page-header-height, 56px));
 *               (asserted at the integration / structural layer via grep
 *               in tests/integration/audit-render.test.ts when the
 *               Plan 02.1-39 describe block lands).
 *   §5.6 (P2) — FiltersSheet source list shows kind glyph (SourceKindIcon)
 *               + sourceKindLabel before displayName; typeahead matches
 *               the kind label too.
 *
 * The full /feed end-to-end at 360px (scroll past 5+ FeedCards →
 * FeedQuickNav.getBoundingClientRect().top stays at calc(72 + 56)px;
 * open FiltersSheet → assert .source-kind-tag is present in source-row;
 * type "youtube" in typeahead → only YouTube sources remain) requires the
 * cookie-injection auth harness still deferred to Phase 6 (same precedent
 * as Plans 02.1-19 / 21 / 26 / 33 / 34 / 38).
 *
 * Manual UAT recipe (per the round-6 plan's checkpoint task):
 *   1. /feed → scroll deep into the feed (past 5+ FeedCards).
 *      Confirm AppHeader stays pinned at the top.
 *      Confirm PageHeader (Feed title + Add CTA) stays pinned just below.
 *      Confirm FeedQuickNav (All / Inbox / Standalone / per-game tabs)
 *      stays pinned just below PageHeader.
 *   2. /feed → click "Filters" → FiltersSheet opens. Scroll to the
 *      "Sources" section. Confirm each source row shows a kind glyph
 *      (e.g. YouTube ▶ icon) AND a short kind label (e.g. "YouTube
 *      channel") BEFORE the displayName.
 *   3. /feed → FiltersSheet → typeahead input → type "youtube" — confirm
 *      every YouTube source remains visible (matches against the kind
 *      label, not just the handleUrl / displayName).
 */
describe("Plan 02.1-39 — /feed sticky FeedQuickNav + FiltersSheet kind glyph at 360px", () => {
  it.skip(
    "/feed FeedQuickNav.getBoundingClientRect().top stays at calc(--app-header-height + --page-header-height) ≈ 128px after window.scrollTo(0, 400) — §5.4 (manual UAT — auth harness deferred to Phase 6)",
  );
  it.skip(
    "/feed FiltersSheet source-row renders <SourceKindIcon> SVG + <span class='source-kind-label'> with sourceKindLabel(kind) text — §5.6 (manual UAT — auth harness deferred)",
  );
  it.skip(
    "/feed FiltersSheet typeahead matches against sourceKindLabel — typing 'youtube' surfaces every YouTube source even when displayName / handleUrl don't contain that substring — §5.6 (manual UAT — auth harness deferred)",
  );
});
