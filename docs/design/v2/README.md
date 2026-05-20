# Neotolis Design System

Design system for **Neotolis Game Promotion Diary** — a self‑tracking diary
for indie game developers. Log promotion activity (YouTube, Reddit, Telegram,
Twitter, Discord, conferences, press) across every channel and accumulate the
data in one chronological feed.

The product is open‑source (MIT), ships in two identical modes (hosted SaaS
+ self‑host VPS), and the source repo is
[d954mas/neotolis-game-promotion-diary](https://github.com/d954mas/neotolis-game-promotion-diary).

This folder is the system the rest of the project leans on. Tokens,
foundations, components, and a working UI‑kit prototype of the web app.

## Files

| File | What's in it |
| --- | --- |
| `README.md` | This document — context, content + visual foundations, iconography. |
| `SKILL.md` | Agent‑compatible skill manifest. |
| `HANDOFF.md` | **Migration brief for Claude Code** running in the product repo. |
| `assets/` | Brand mark + wordmark + favicon. |
| `preview/` | Design‑system cards rendered for the review tab. |
| `ui_kits/web/` | UI‑kit prototype: chrome, feed, kind‑coded cards, event detail, sources, add‑event modal, Tweaks panel. |
| `ui_kits/web/tokens.css` | The token file. Single source of truth for color, type, spacing, radii, motion. |

## Product context

**Neotolis** is the studio handle of one indie developer (`d954mas` on
GitHub). The Diary is the first user‑facing product under that handle and
this design system targets it specifically.

The product surface is a single SvelteKit web app. There is no mobile app,
no marketing site separate from the app, no docs site separate from the
GitHub README. The same web app serves anonymous landing (`/`, `/about`,
`/privacy`, `/terms`) and the signed‑in workspace (`/feed`, `/sources`,
`/games`, `/events`, `/audit`, `/settings`). One UI kit covers both.

Audience: solo / small‑team indie game developers — technical, time‑poor,
allergic to fluff. The product replaces "messy Google Sheets and markdown
files." That framing drives every design choice below.

References we lean on: **Linear** (typographic discipline), **Stripe
Dashboard** (data legibility), **Things 3** (warm‑dark at night).

---

## Content fundamentals

**Voice.** Plain, direct, second‑person ("you"). Never first‑person plural in
casual context ("we" appears only in legal text — Privacy and Terms — where
it denotes the operator). The product addresses one user; it does not
pretend there's a team behind a curtain.

**Casing.** Sentence case everywhere. Buttons, nav, headings, table columns
all read like normal sentences. Title Case is reserved for legal section
headings ("Privacy Policy", "Terms of Service") and brand‑name elements
("Promotion diary" in the header — lowercase "diary" intentional). Examples:

- Nav items: `Feed`, `Sources`, `Games`, `Settings`, `About`.
- Buttons: `+ New game`, `Add event`, `Save changes`, `Refresh now`,
  `Pull new content`.
- Headings: `Your feed is empty.`, `No games yet.`, `Recently deleted (3)`.

**Punctuation.** Sentences end in periods even when short (`Your feed is
empty.`). Em dashes for asides (`Hot · checked 3h ago`). The interpunct `·`
separates compound metadata (`Hot · checked 3h ago`, `Cold · 2d ago`).
Ellipses on async states (`Loading more…`, `Refreshing…`, `Deleting…`).

**Honesty about state.** The copy never hides immaturity. Disabled adapters
say so out loud (`Coming soon — pending Reddit OAuth`, `Out of scope —
Twitter API is paid`). Empty states explain what to do next, not what's
wrong. Errors are specific and actionable.

**Inline code.** Backticks for literal URLs, env names, file paths inside
body copy (`https://steamcommunity.com/dev/apikey`,
`SERVICE_YOUTUBE_API_KEYS`). Example URLs inside empty states render as
inert `<code>` — they are copy‑and‑paste hints, not links (`cursor: text`,
not pointer).

**No emoji as decoration.** The dictionary contains exactly three Unicode
glyphs used as semantic icons: `✓` (caught up / done), `⏸` (paused),
`⚠` (warning hint). Never 🎉, 🚀, 💡, etc.

**No exclamation marks** in product copy. Cheerfulness is performed by the
absence of friction, not by punctuation.

**Tone in one sentence:** the maintainer's voice — terse, honest, slightly
dry, never marketing‑y.

---

## Visual foundations

**Personality.** Utilitarian, but warm. The system reads as a clean text
editor or a no‑bullshit admin panel — not a Material/Apple/Linear pastiche.
The user is expected to spend hours in it logging things, so the visual
surface gets out of the way; the warmth comes from neutral tone, not from
illustration or decoration.

**Theme model.** Dark‑first. The product is for developers; they live in
dark mode. Light is preserved as an alternate. `system` honors
`prefers-color-scheme`. Theme attribute is set on `<html>` by SSR
(`themeHandle` in `src/hooks.server.ts`) so the right tokens are delivered
on the first byte — no FOUC.

**Color — dark theme (default).**

```
bg        #0E0E10   page background, warm‑tinted near‑black
surface   #16161A   cards, dialogs
surface-2 #1C1C21   elevated panels, hover
surface-3 #232328   highest tier (overlays, focused fields)
border    #2B2B31
border-2  #393940
text      #ECECEE
text-2    #B0B0B7
text-3    #7E7E86
text-4    #57575E   hint, disabled

accent          #E89B5E   warm amber, single chromatic surface
accent-strong   #F3AE73   hover
accent-soft     rgba(232,155,94,.14)
accent-text     #0E0E10

success #6FB36A   warn #D8B259   danger #E07377   info #6FA0D1
```

**Color — light theme.**

```
bg        #FBFAF7   warm off-white, paper-feel
surface   #FFFFFF
surface-2 #F4F2EE
surface-3 #EBE9E3
border    #E3E0D9
text      #1B1B1D
text-2    #56565C
text-3    #82828A

accent    #C76D3C   slightly deeper amber for light bg contrast
```

The accent is the only chromatic surface across the neutral ramp. It paints
primary CTAs, active nav underline, focus rings, the brand mark gradient,
and "mine" content markers. No gradients on cards. No secondary palette.

**Kind‑coded card colors.** Each event type gets a characteristic hue
rendered as a 2px left border + colored kind‑tag icon at the top of the
card. Saturation kept in the 55–70 range, lightness 60–72, so colors read
on dark backgrounds without screaming:

```
--k-youtube    #E0625C   warm red
--k-reddit     #E08555   orange
--k-twitter    #6FA0D1   muted sky
--k-telegram   #5BAAC8   cyan
--k-discord    #7A82D6   indigo
--k-conference #7FB46A   sage
--k-talk       #D8B259   amber
--k-press      #B488D4   lilac
--k-post       #8A8A95   neutral
--k-other      #8A8A95
```

Press cards read as press at a glance; YouTube cards read as YouTube at a
glance — without colored backgrounds shouting.

**Type.** **Inter** for body, **JetBrains Mono** for source handles and
tabular numerics on stats. Loaded from Google Fonts; system stack stays as
fallback. No serif anywhere. No display family.

```
--f-sans: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI",
          Roboto, "Helvetica Neue", Arial, sans-serif;
--f-mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
```

Sizes — a 7‑step scale, no in‑between values:

```
--t-12  12px   meta, chips, mono
--t-13  13px   dense body, source handles
--t-14  14px   default body
--t-15  15px   card title
--t-17  17px   page subtitle
--t-22  22px   h1
--t-30  30px   display, empty‑state headings
```

Three weights: 420 regular (slightly heavier than 400 for dark‑mode
legibility), 520 medium, 600 semibold. Inter variable font handles the
non‑integer weights. Body is 420; card titles + headings are 600; chips
and badges are 420.

`font-feature-settings: "ss01", "cv11", "cv05"` enabled body‑wide — Inter's
single‑story `a`, alternate `1`, and disambiguated `l` make data legible
without becoming a display face.

**Spacing.** 4‑point baseline, exposed as `--s-0` through `--s-8`:

```
--s-0  2px    --s-3  12px   --s-6  24px
--s-1  4px    --s-4  16px   --s-7  32px
--s-2  8px    --s-5  20px   --s-8  48px
```

Cards pad `--s-4` (16). Sections gap `--s-4` between siblings. Forms use
`--s-6` (24) between fieldsets. Mobile main padding is `--s-4`; desktop
bumps to `--s-6`.

**Radii.** `--r-xs` 3px (inline `<code>`), `--r-sm` 6px (controls,
buttons), `--r-md` 10px (cards, dialogs), `--r-lg` 14px (large panels),
`--r-pill` 999px (chips, pills).

**Layout.** Single fixed max width: `--max-w: 1280px` for the main content
column, centered, horizontally padded. Breakpoints: `360px` (hard floor),
`768px` tablet, `1024px` desktop. Below 640px the feed grid collapses to
one column; otherwise it's a 3‑column responsive grid (`repeat(auto-fill,
minmax(320px, 1fr))`).

**Sticky chrome.** Single sticky wrapper holds `AppHeader` + `Nav`. The
wrapper height (~116px) is published as `--chrome-height` by a
ResizeObserver in the root layout. Per‑page `PageHeader.sticky` reads
`top: calc(var(--chrome-height) - var(--sticky-overlap))`. A 1px
`--sticky-overlap` shim absorbs subpixel rounding at the chrome ↔ page
header boundary. This pattern is load‑bearing — never use two stacked
independent sticky elements. The chrome itself has a subtle backdrop blur
(`backdrop-filter: blur(14px) saturate(140%)`) — the one place blur is
used in the system.

**Cards.** `border-radius: --r-md` (10px), 1px solid `--border`. **No
heavy shadows** — `--shadow-card` is `0 1px 0 rgba(255,255,255,.025) inset,
0 1px 2px rgba(0,0,0,.35)`, just enough to lift from the page. Elevation
above that is reserved for dialogs (`--shadow-elev`). A 2px left border in
the kind color paints the kind stripe. "Mine" cards add a separate
accent‑colored marker.

**Two card shapes.** Media‑bearing events (YouTube) keep the 16:9
thumbnail block. Press / Reddit / Post / Conference / Talk drop the
thumbnail entirely and render as text‑only cards with a kind‑colored top
hairline — saves vertical space and makes type‑mix visually distinct.

**Borders.** Always 1px solid `--border` except: the active nav underline
(2px solid accent), the focus ring (`var(--focus-ring)` — 2px solid bg +
2px solid accent ring via box‑shadow), the kind stripe (2px solid kind
color on left), and hairline separators inside dense lists
(`--border-hairline: rgba(255,255,255,.06)`).

**Animation.** Two motion values: `--m-fast` 120ms for hover/state
transitions, `--m-base` 180ms for layout (sheets, modals). `--m-ease:
cubic-bezier(.32,.72,.32,1)` — iOS‑like subtle ease‑out. No spring
physics, no entrance animations, no skeleton shimmer. Nav auto‑scrolls
the active item into view on mobile with `behavior: 'smooth'` — that's
the only motion that runs without user input.

**Focus.** Never remove the ring. `:focus-visible { outline: none;
box-shadow: var(--focus-ring); }` — a two‑ring effect that reads as a
deliberate accent halo, not a default browser line.

**Hit targets.** `--hit: 36px` minimum on every interactive control,
`--hit-lg: 40px` on primary CTAs. The 360px viewport is the hard floor;
everything must read at that width without horizontal scroll.

**Transparency / blur.** Used in three places: the chrome backdrop, the
dark pill overlay on feed‑card thumbnails, and the accent‑soft tint
behind active filter chips. Otherwise opacity is reserved for state
(disabled: 0.55; off‑topic events: 0.65).

**Imagery vibe.** External images (YouTube thumbnails, Steam game covers)
load with `referrerpolicy="no-referrer"` and `crossorigin="anonymous"` —
a privacy + safety choice that shows up everywhere visual media is
rendered. The product does not produce its own imagery; it embeds the
platform's. No warm/cool grading, no grain overlay, no hue shifts.

**Numerics.** Stats are tabular (`font-variant-numeric: tabular-nums`) and
compacted (`1.2K`, `3.4M`). Time deltas are rendered as `{n}h ago`,
`{n}d ago`, never as "a few hours back".

---

## Iconography

**System.** Hand‑rolled inline SVG, one component (`KindIcon.svelte` in
the product repo, `ui_kits/web/app-data.jsx` here) that dispatches on a
`kind` prop. Style contract is strict:

- 24×24 viewBox (rendered at 14/16/20/48 depending on context)
- `stroke="currentColor"`, `stroke-width: 1.75`, `stroke-linecap: round`,
  `stroke-linejoin: round`, `fill: none` (except small filled accents
  inside the same path)
- Geometric forms only — **no brand marks**. The YouTube icon is a
  generic play‑triangle inside a rounded rectangle; Reddit is a Snoo‑style
  silhouette built from primitives; Twitter is a generic bird outline.
  This is a legal + visual choice — brand marks would clash with the
  otherwise monochrome neutral surface and would expose the project to
  trademark drift.
- `aria-hidden="true"`; the kind name is conveyed in adjacent text.
- Color is the kind color via `currentColor`; the overlay variant on dark
  pills flips to `white` via the same mechanism.

**No icon font.** No Lucide/Heroicons/Phosphor CDN dependency. The set is
exactly the event‑kind glyphs + a small chrome set (search, plus, filter,
bell, settings, calendar, etc.) — that's all the product needs. If you
add new icons, follow the contract above; do not import a CDN set.

**Unicode glyphs as icons.** Used sparingly for state:

- `↻` — auto‑imported / tracked source indicator
- `✓` — "Fully loaded" coverage state
- `⏸` — "Daily quota reached"
- `⚠` — date‑in‑past warning hint
- `×` — delete affordance / dialog close
- `·` — separator on meta lines
- `+` — prefix on "new" CTAs (`+ New game`, `+ Add event`, `+ Add data source`)

**Logo / brand mark.** No formal logo. The header renders the plain text
`Promotion diary` at `--t-15` semibold next to a 24px pixel‑style mark —
3×3 grid lit with the accent, gradient overlay, soft inner highlight. That
mark + the wordmark together *are* the brand mark. Files in `assets/`.

---

## How to use this in a design

1. Pull tokens from `ui_kits/web/tokens.css`. Don't redeclare colors or
   sizes.
2. Read the component CSS in `ui_kits/web/index.html` — components are
   the working pixel implementation. The JSX modules (`app.jsx`,
   `app-data.jsx`, `event-detail.jsx`, `sources-page.jsx`,
   `add-event-modal.jsx`) carry the structure and copy.
3. For copy, match the README's "Content fundamentals" section: lowercase
   verbs, period at the end, no emoji, no exclamation, prefer "you" over
   "the user".
4. For icons, extend `KindIcon` rather than importing a new set. If you
   genuinely need a new icon outside the kind enum, draw it on the same
   contract (24×24, 1.75px stroke, currentColor, round caps).

See `SKILL.md` for an agent‑invocable summary, and `HANDOFF.md` for the
migration brief targeted at Claude Code running in the product repo.
