# Neotolis v2 — handoff to Claude Code

Migration brief for **Claude Code** running inside
`d954mas/neotolis-game-promotion-diary`. Goal: migrate the product
surface from v1 (generic blue accent, pure neutrals, 8-point spacing,
system fonts) to v2 (warm-amber accent on warm neutrals, dark-first,
4-point spacing, Inter + JetBrains Mono, kind-coded cards) — **in a
single PR**.

**Design migration only.** No new routes. No service code touched. No
schema changes. No DB queries. If your diff lands anything under
`src/lib/server/`, `src/routes/api/`, or `drizzle/`, the diff got out
of scope — revert and re-scope.

## Reference material

The maintainer drops a copy of the design system at `docs/design/v2/`:

- `tokens.css` — canonical v2 token file. **This is the spec.**
- `ui-kit/` — working HTML+JSX prototype (chrome, feed, event detail,
  sources page, add-event modal). Open `ui-kit/index.html` in a
  browser to see the visual target.
- `README.md` — full design context, content rules, iconography
  contract.
- `HANDOFF.md` — this document.

Read it all before opening any code file. The prototype is the source
of truth for "what should this look like."

---

## What's changing — in one paragraph

The v1 system is monochrome with one blue accent on pure neutrals
(`#fafafa` / `#0d0d0d`), 8-point spacing, 44px hit targets, system
font stack, no card hue beyond text. v2 is the same skeleton but
tuned to feel like a high-quality tool: **warm-neutral darks** with a
slight brown tint, **single warm-amber accent** replacing blue,
**kind-coded card stripe** (2px left border on media cards, 1px top
hairline on text-only cards), **denser 4-point spacing**, **Inter +
JetBrains Mono** from Google Fonts (system stack stays as fallback),
36px hit targets, **3-column feed grid** at desktop (was 2), tighter
type scale (12/13/14/15/17/22/30 vs 14/16/24/32), **backdrop-blurred
chrome**. Same content rules, same iconography contract, same
component vocabulary, same routes.

---

## The PR

- **Branch:** `feat/design-v2`
- **Title:** `feat(design): v2 — warm-neutral dark, amber accent, kind-coded cards`
- **Body** (1–3 bullet *why*, per AGENTS.md):
  - Polished iteration of v1; same skeleton, same content rules,
    retuned to read like a high-quality tool. References: Linear
    (typography), Stripe Dashboard (data legibility), Things 3
    (warm-dark at night).
  - Dark-first (product is for developers; they live in dark mode);
    light theme kept as alternate.
  - Pure design migration — zero service code touched, zero behavior
    changed.
- **Test plan:** lint + typecheck + unit + integration + smoke all
  green; Playwright visual snapshots regenerated; manual walk of
  `/feed`, `/sources`, `/games`, `/events`, `/settings`, `/audit`,
  `/about` in both dark and light themes at 360 / 768 / 1280 widths.
- **`## Self-review`** + **`## Self-review (second pass)`** sections,
  both walking Principles + Tenant scoping + Don'ts from AGENTS.md
  (see § "Self-review checklist" at the bottom of this doc).

### Recommended commit shape inside the PR

One PR, but the diff is easier to review (and easier to revert
partially if smoke breaks) when committed in this order. Squash on
merge — master gets a single commit.

1. `feat(design): v2 tokens (src/app.css, src/app.html fonts)`
2. `feat(design): v2 chrome (AppHeader, Nav, sticky wrapper)`
3. `feat(design): v2 feed card (kind stripe, two shapes)`
4. `feat(design): v2 secondary components (Game/Empty/Dialog/Filter/Picker)`
5. `feat(design): v2 page chrome (PageHeader, date group, month)`
6. `chore(design): v2 token-name sweep + visual snapshots`

Each commit must keep the app rendering — no half-broken commits in
the middle.

---

## Work order

### 1. Tokens — `src/app.css` + `src/app.html`

Replace the visual token declarations (spacing, type, color blocks for
`:root`, `:root[data-theme="light"]`, `:root[data-theme="dark"]`, and
the `@media (prefers-color-scheme: dark) :root[data-theme="system"]`
sibling) with v2 equivalents from `docs/design/v2/tokens.css`. Keep
the v2 token NAMES exactly — this is a clean break, not a parallel
system.

**Do NOT touch** the following blocks (they're runtime contracts, not
visual tokens):

- `--chrome-height` — overwritten by ResizeObserver in
  `src/routes/+layout.svelte`. Keep declaration + multi-paragraph
  comment.
- `--page-header-height` — overwritten by ResizeObserver in
  `src/lib/components/PageHeader.svelte`. Keep declaration + comment.
- `--sticky-overlap`.
- Header comment explaining theme model + SSR delivery via
  `themeHandle` / `transformPageChunk` / `%theme%`.
- `*, *::before, *::after { box-sizing: border-box; }` reset.
- Native date/time picker `filter: invert(1)` block.
- `html, body` base + `overflow-x: clip` (load-bearing for sticky
  descendants — read the comment).
- `min-width: 0` reset on layout containers.
- `:root:has(dialog[open]), body:has(dialog[open])` scroll lock.

**Update** `:focus-visible` to the v2 form:
```css
:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
  border-radius: var(--r-xs);
}
```

**Fonts:** system font stack only (no external requests). `--f-sans` and
`--f-mono` in `src/app.css` use OS-native fonts. Google Fonts links were
removed from `src/app.html` per the privacy/self-host principle — the
self-host operator's visitors must not leak IPs to third parties.

### 2. Chrome — `AppHeader.svelte` + `Nav.svelte` + `+layout.svelte`

Files: `src/lib/components/AppHeader.svelte`,
`src/lib/components/Nav.svelte`, the `.sticky-chrome` block in
`src/routes/+layout.svelte`.

- **Sticky wrapper backdrop blur.** `.sticky-chrome`:
  ```css
  background: color-mix(in oklab, var(--bg) 80%, transparent);
  backdrop-filter: blur(14px) saturate(140%);
  -webkit-backdrop-filter: blur(14px) saturate(140%);
  border-bottom: 1px solid var(--border-hairline);
  ```
  ResizeObserver that publishes `--chrome-height` keeps working.
- **Brand mark.** Replace plain text "Promotion diary" with a 24px
  pixel-style mark (SVG, 3×3 grid lit with accent + gradient overlay
  + soft inset highlight) + wordmark text at `--t-15` semibold. SVG
  source: `Brand()` in `docs/design/v2/ui-kit/app.jsx`. Inline the
  SVG — no new asset file.
- **Nav tabs.** v1 nav is text links; v2 is tabs with icon + label,
  active 2px underline in `--accent`, horizontal scroll on mobile
  (`overflow-x: auto; scrollbar-width: none`). Tab styles in the
  prototype: `.nav-tab` / `.nav-tab.active`.
- **Right-side chips.** Bell button + user chip on the right of the
  topbar. User chip = initial in accent-tinted circle
  (`var(--accent-soft)` background, `var(--accent)` text). Prototype:
  `.user-chip`, `.bell-btn`.

Don't break: sticky stack, `--chrome-height` publication, keyboard
focus order, `data-theme` attribute on `<html>`.

### 3. Feed card — `FeedCard.svelte` + feed grid

`src/lib/components/FeedCard.svelte` (~21KB) is the largest component.
Structural change is small; styling change is significant.

**Two card shapes by kind:**

- **Media cards** (`youtube_video` only today; future: any kind with
  a `thumb`) — keep the 16:9 thumbnail block. Add a 2px left border
  in the kind color.
- **Text-only cards** (everything else) — drop the thumbnail block
  entirely. Add a 1px top hairline in the kind color.

Both shapes: `border-radius: var(--r-md)` (10px), `box-shadow:
var(--shadow-card)` for elevation. Kind color comes from
`--k-youtube`/`--k-reddit`/`--k-twitter`/`--k-telegram`/`--k-discord`/
`--k-conference`/`--k-talk`/`--k-press`/`--k-post` tokens (added in
step 1).

**Kind tag** at the top of the card body: `KindIcon` in the kind
color + kind label in `var(--text-3)`. Prototype: `.kind-tag`.

**Stats line** in the footer: `font-variant-numeric: tabular-nums`,
`font-family: var(--f-mono)` for the numbers, separator dots (`·`).

**"Mine" marker.** v1 uses a 4px left border in `--color-mine`. Since
v2's left border is the kind color, move the "mine" signal to a
small accent-tinted dot in the byline row OR a tiny `↻ mine` chip.
Match what the prototype does — search `.mine` / `.you` in
`app.jsx`.

**Off-topic / standalone fade** stays — drop `opacity: 0.65` (was
0.55) on `.off-topic`.

**Feed grid** (likely in `src/routes/feed/+page.svelte` — grep
`grid-template-columns`): v1 was `repeat(auto-fill, minmax(280px,
1fr))`; v2 is `repeat(auto-fill, minmax(320px, 1fr))` with `gap:
var(--s-4)` and a 3-column cap at `--max-w`.

Don't break:
- `data-*` selectors used by `tests/e2e/feed.spec.ts` etc.
- `referrerpolicy="no-referrer"` + `crossorigin="anonymous"` on
  external thumbnail `<img>` — privacy/safety contract.
- Thumbnail dark pill overlay (rgba(0,0,0,.55) — now
  `var(--overlay-dark)`).

### 4. Secondary components

Lift component-by-component from the prototype. Component file names
roughly match between prototype JSX and Svelte sources.

- `GameCard.svelte` — `--r-md`, warm-neutral surface, accent cover
  frame.
- `GameCover.svelte` — small radius bump to `--r-sm`, kind-color
  shadow ring.
- `EmptyState.svelte` — denser type (`--t-30` display, `--t-14`
  body), accent CTA.
- `ConfirmDialog.svelte`, `GameEditDialog.svelte`,
  `AddStoreDialog.svelte` — `--r-md`, `--shadow-elev`, `--surface-2`
  panel.
- `FiltersSheet.svelte` — sheet variant of dialog: `--shadow-elev`,
  `--surface-2`, slides from right.
- `FilterChips.svelte` — `--r-pill` chips, `--accent-soft` background
  + `--accent` text on active.
- `DateRangeControl.svelte` — `--r-sm` controls, `--surface-2`
  background, `--accent` focus ring.
- `AttachToGamePicker.svelte`, `BackfillPicker.svelte` —
  picker/dropdown surfaces use `--surface-2`, `--shadow-elev`.
- `KindIcon.svelte` — should already be on the right contract; just
  verify `currentColor` flows from the parent kind color, drop
  `stroke-width` from 2 to 1.75, and update the Reddit glyph to the
  v2 Snoo-style silhouette (see `KindIcon` `"reddit_post"` case in
  `app-data.jsx`).
- `EventCard.svelte`, `AuditRow.svelte` — list-row styling on
  `--surface-2`, `border-bottom: 1px solid var(--border-hairline)`.
- `PollingBadge.svelte`, `InboxBadge.svelte` — pill badges,
  `--r-pill`, kind/accent/danger colors per state.
- `CursorPager.svelte`, `InlineError.svelte`, `InlineInfo.svelte` —
  inline text components, smaller pad, `--text-2` / `--danger` /
  `--info` colors.
- `PasteBox.svelte`, `AddSteamListingForm.svelte`, `KeyMaskRow.svelte`
  — form surfaces, `--surface-2` field bg, `--accent` focus
  treatment.
- `DeletedEventsPanel.svelte`, `AccountDeletedBanner.svelte` —
  status banners use `--surface-2` + `--border-2`.
- `FeedQuickNav.svelte` — quick-nav rail uses `--surface-2` with
  `--accent` active state.

### 5. Page chrome

- `PageHeader.svelte` — h1 sentence-case in `--t-22` semibold,
  subtitle in `--t-14 var(--text-2)`. Sticky positioning logic
  unchanged — still reads `--chrome-height`, writes
  `--page-header-height`.
- `FeedDateGroupHeader.svelte` — full-width hairline above (`border-
  top: 1px solid var(--border-hairline)`), label at `--t-13`
  uppercase in `--text-3`, sticks under PageHeader using the same
  `top: calc(var(--chrome-height) + var(--page-header-height) -
  var(--sticky-overlap))` formula.
- `MonthHeader.svelte` — month name in `--t-15` semibold, year in
  `--text-3 --t-13`.

### 6. Sweep + snapshots

Grep for any stragglers — references to old token names:

```
rg --type=svelte --type=css '\-\-color-(bg|surface|border|text|accent|text-muted|destructive|info|success|mine)'
rg --type=svelte --type=css '\-\-space-(xs|sm|md|lg|xl|2xl|3xl)'
rg --type=svelte --type=css '\-\-font-size-(body|label|heading|display)'
rg --type=svelte --type=css '\-\-font-weight-(regular|semibold)'
rg --type=svelte --type=css '\-\-line-height-(body|heading|mono)'
rg --type=svelte --type=css '\-\-font-family-(sans|mono)'
rg --type=svelte --type=css '\-\-bp-(mobile|tablet|desktop)'
```

There should be zero hits after this step. Replace any survivors with
their v2 equivalents.

Then update Playwright visual baselines:
```
pnpm test:e2e --update-snapshots
```

…but only after manually confirming the new look is correct on every
route. The snapshot update is the last thing in the PR — running it
on a half-finished diff bakes in incorrect baselines.

Finally, update the repo's top-level `README.md` to link to
`docs/design/v2/README.md` as the design source-of-truth.

---

## Don'ts (per AGENTS.md, applied to this PR)

- **Don't rename routes, fields, or DB columns.** Visual change only.
- **Don't touch `eslint-plugin-tenant-scope/`** or any code under
  `src/lib/server/`. If you have to, stop and ask.
- **Don't add new dependencies** beyond the two Google Fonts `<link>`
  tags. No icon library, no CSS framework, no component library, no
  CSS preprocessor.
- **Don't add a JS theme picker** beyond what the existing
  `themeHandle` + `data-theme` model supports. The prototype's
  Tweaks panel (vibe / accent / density) is a **design exploration**,
  not production behavior — do not port it.
- **Don't add motion beyond the two values** (`--m-fast`, `--m-base`).
  No spring physics, no entrance animations, no skeleton shimmer.
- **Don't add emoji or exclamation marks to product copy.** Voice
  rules in `docs/design/v2/README.md` § "Content fundamentals" apply
  unchanged.
- **Don't import a brand-mark icon set.** KindIcon stays geometric-
  only by deliberate choice (legal + visual).
- **Don't `db.select` from a route handler** — wasn't allowed before,
  isn't allowed now. (You shouldn't be near service code anyway.)
- **Don't add `process.env` reads.** Same reason.
- **Don't add `try/catch` around `db.insert`.** Same reason.
- **Don't branch on `APP_MODE`.** Same reason.

---

## Self-review checklist (per AGENTS.md)

Before declaring the PR done, walk these — both passes, in the PR body
under `## Self-review` and `## Self-review (second pass)`:

**Principles + Tenant scoping + Don'ts (AGENTS.md):**
- [ ] No new code path branches on `APP_MODE`.
- [ ] No `db.select` or `process.env` reads added.
- [ ] No `try/catch` added around `db.insert`.
- [ ] No tenant-scope filter removed or weakened.
- [ ] No DTO projection bypassed.
- [ ] No `db.select` in a route handler / `+page.server.ts`.
- [ ] No new `boss.send` outside a transaction.

**CI gate honesty:**
- [ ] Every new assertion is load-bearing; no vacuous-pass.
- [ ] Playwright snapshots regenerated against the new visual
      baseline — not stale.
- [ ] `tests/integration/anonymous-401.test.ts` still passes (no
      route accidentally un-gated).
- [ ] `tests/integration/tenant-scope.test.ts` still passes.

**Documentation drift:**
- [ ] `AGENTS.md` still matches reality (nothing in this PR
      contradicts it).
- [ ] `CLAUDE.md` still matches reality.
- [ ] `docs/design/v2/README.md` referenced from top-level `README.md`.

**Scope discipline:**
- [ ] Diff stays inside `src/app.css`, `src/app.html`,
      `src/lib/components/`, `src/routes/+layout.svelte`,
      route-level `+page.svelte` files, and `docs/design/v2/`.
- [ ] No accidental edits to `src/lib/server/`, `src/routes/api/`,
      `drizzle/`, `tests/integration/`, `eslint-plugin-tenant-scope/`,
      or `eslint.config.js`.
- [ ] If a service file was touched by accident — reverted; scope is
      design-only.

**Visual QA:**
- [ ] Manual walk: `/feed`, `/sources`, `/games`, `/events`,
      `/settings`, `/audit`, `/about` at 360 / 768 / 1280 widths, in
      dark + light + system themes.
- [ ] Sticky chrome doesn't drift on scroll-engage at any width.
- [ ] Focus ring is visible on every focusable surface in both
      themes.
- [ ] No FOUC on first paint; system stack covers the font-load
      gap.
- [ ] No console errors, no missing CSS variable warnings.

If any of the above is unclear, stop and ask the maintainer rather
than guessing. This handoff is design-surface only; the engineering
contracts in `AGENTS.md` remain absolute.
