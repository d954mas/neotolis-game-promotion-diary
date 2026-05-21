<script lang="ts">
  // AppHeader — top bar present on every authenticated page.
  //
  // v2 chrome shape (per docs/design/v2/HANDOFF.md § "Chrome" + Phase 3.4
  // CONTEXT + RESEARCH §"Chrome Layout — Nav into Topbar (Question 9)"):
  //
  //   1. <Brand>: inline pixel-grid SVG mark (24px, --accent) +
  //      "Promotion diary" wordmark (--t-15 --w-sb) anchored to /feed.
  //      The SVG is a 5-rect 9×9 grid — see Brand() in
  //      docs/design/v2/ui-kit/app.jsx for the canonical recipe.
  //   2. <Nav> tab strip — rendered via the `children` snippet slot.
  //      The parent layout passes <Nav active={navActive} /> in.
  //      At ≥768px Nav sits centered in the topbar; at <768px it drops
  //      to a second row below brand + userchip (Phase 3.3 mobile
  //      architecture fallback per RESEARCH Question 9).
  //   3. <UserChip>: avatar + email + sign-out menu, right-aligned.
  //      Bell button and the theme toggle are intentionally NOT here —
  //      bell is deferred per UI-SPEC (no notification system yet),
  //      theme switcher stays on /settings per D-05.
  //
  // AppHeader is NON-STICKY here. AppHeader must stay visible while
  // content scrolls — that contract is preserved by the
  // `.sticky-chrome` wrapper in src/routes/+layout.svelte that
  // contains AppHeader (which now ALSO contains Nav inside its grid).
  // The single sticky wrapper (LB-1) ensures no internal sticky boundary
  // between brand and nav-tabs can produce a gap or slip on scroll.
  //
  // LB-2 contract: the ResizeObserver in +layout.svelte watches
  // `.sticky-chrome` and publishes `--chrome-height`. Single-row topbar
  // is shorter than the previous two-row stack, so --chrome-height
  // decreases and PageHeader's sticky `top:` calc adapts automatically.
  //
  // The `theme` prop is no longer consumed here but stays in the props
  // bag (set by +layout.svelte for backward compatibility) — removing it
  // would force a layout-svelte change.

  import UserChip from "./UserChip.svelte";
  import type { Snippet } from "svelte";

  type UserShape = { name: string; email: string; image: string | null } | null;
  type Theme = "light" | "dark" | "system";

  let {
    user,
    theme: _theme,
    onSignOut,
    onSignOutAllDevices,
    children,
  }: {
    user: UserShape;
    theme?: Theme;
    onSignOut?: () => void;
    onSignOutAllDevices?: () => void;
    children?: Snippet;
  } = $props();
</script>

<header class="topbar app-header" aria-label="Application header">
  <a class="brand" href="/feed" aria-label="Promotion diary — go to feed">
    <span class="brand-mark" aria-hidden="true">
      <svg width="14" height="14" viewBox="0 0 9 9">
        <rect x="0" y="0" width="3" height="3" fill="currentColor" opacity="0.85" />
        <rect x="3" y="0" width="3" height="3" fill="currentColor" opacity="0.55" />
        <rect x="0" y="3" width="3" height="3" fill="currentColor" opacity="0.65" />
        <rect x="6" y="3" width="3" height="3" fill="currentColor" opacity="0.95" />
        <rect x="3" y="6" width="3" height="3" fill="currentColor" opacity="0.40" />
      </svg>
    </span>
    <span class="wordmark">Promotion diary</span>
  </a>
  <div class="nav-tabs-slot">
    {@render children?.()}
  </div>
  <div class="right-cluster userchip-slot">
    {#if user}
      <UserChip {user} {onSignOut} {onSignOutAllDevices} />
    {/if}
  </div>
</header>

<style>
  /* v2 topbar — CSS Grid 3-column layout at ≥768px (brand | nav | userchip).
   * Drops to 2-row stack at <768px (brand+userchip on row 1; nav spans
   * row 2). The legacy `.app-header` class is preserved on the same
   * <header> so existing CSS hooks / a11y tooling that grep for it
   * continue to work; the new `.topbar` selector is the v2 grid driver. */
  .topbar {
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: var(--s-3);
    align-items: center;
    padding: var(--s-2) var(--s-4);
    max-width: var(--max-w);
    margin: 0 auto;
    min-width: 0;
  }
  .brand {
    display: inline-flex;
    align-items: center;
    gap: var(--s-2);
    color: var(--text);
    text-decoration: none;
    min-width: 0;
  }
  .brand:hover {
    color: var(--text);
  }
  .brand-mark {
    width: 24px;
    height: 24px;
    color: var(--accent);
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .wordmark {
    font-family: var(--f-sans);
    font-size: var(--t-15);
    font-weight: var(--w-sb);
    letter-spacing: -0.01em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .nav-tabs-slot {
    justify-self: center;
    min-width: 0;
    display: flex;
    align-items: center;
  }
  .right-cluster {
    display: inline-flex;
    align-items: center;
    gap: var(--s-2);
  }
  @media (min-width: 768px) {
    .topbar {
      padding: var(--s-2) var(--s-6);
    }
  }
  /* Below 768px the topbar can't fit brand + nav + userchip on one row
   * without truncating. Fall back to two rows: brand+userchip on row 1
   * (nav-tabs span the full width on row 2). The Phase 3.3 mobile Nav
   * horizontal-scroll contract continues to apply because <Nav> itself
   * uses overflow-x:auto + scrollbar-width:none. */
  @media (max-width: 767px) {
    .topbar {
      grid-template-columns: auto auto;
      grid-template-rows: auto auto;
      padding: var(--s-2) var(--s-4);
    }
    .brand {
      grid-column: 1;
      grid-row: 1;
    }
    .userchip-slot {
      grid-column: 2;
      grid-row: 1;
      justify-self: end;
    }
    .nav-tabs-slot {
      grid-column: 1 / -1;
      grid-row: 2;
      justify-self: stretch;
    }
  }
</style>
