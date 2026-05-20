<script lang="ts">
  // AppHeader — top bar present on every authenticated page.
  //
  // v2 chrome shape (per docs/design/v2/HANDOFF.md § "Chrome"):
  //
  //   1. <Brand>: inline pixel-grid SVG mark (24px, --accent) +
  //      "Promotion diary" wordmark (--t-15 --w-sb) anchored to /feed.
  //      The SVG is a 5-rect 9×9 grid — see Brand() in
  //      docs/design/v2/ui-kit/app.jsx for the canonical recipe.
  //   2. <UserChip>: avatar + email + sign-out menu, right-aligned.
  //      Bell button and the theme toggle are intentionally NOT here —
  //      bell is deferred per UI-SPEC (no notification system yet),
  //      theme switcher stays on /settings per D-05.
  //
  // AppHeader is NON-STICKY here. AppHeader must stay visible while
  // content scrolls — that contract is preserved by the
  // `.sticky-chrome` wrapper in src/routes/+layout.svelte that
  // contains both AppHeader and Nav. When AppHeader and Nav were
  // each independently sticky (top: 0 and top: --app-header-height
  // respectively), every overlap value either left a subpixel gap
  // (too small) or made Nav visibly slip up on scroll-start (too
  // large). User quote on the slip: "Зазора нет, но есть небольшой
  // скрол табов feed sources что выглядит как артефакт". Wrapping
  // both in a single sticky block removes the AppHeader↔Nav internal
  // sticky boundary entirely — they move as one DOM unit, so neither
  // gap nor slip is possible (LB-1).
  //
  // The `theme` prop is no longer consumed here but stays in the props
  // bag (set by +layout.svelte for backward compatibility) — removing it
  // would force a layout-svelte change.

  import UserChip from "./UserChip.svelte";

  type UserShape = { name: string; email: string; image: string | null } | null;
  type Theme = "light" | "dark" | "system";

  let {
    user,
    theme: _theme,
    onSignOut,
    onSignOutAllDevices,
  }: {
    user: UserShape;
    theme?: Theme;
    onSignOut?: () => void;
    onSignOutAllDevices?: () => void;
  } = $props();
</script>

<header class="app-header" aria-label="Application header">
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
  <div class="right-cluster">
    {#if user}
      <UserChip {user} {onSignOut} {onSignOutAllDevices} />
    {/if}
  </div>
</header>

<style>
  .app-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-3);
    padding: var(--s-3) var(--s-4);
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
  .right-cluster {
    display: inline-flex;
    align-items: center;
    gap: var(--s-2);
  }
  @media (min-width: 768px) {
    .app-header {
      padding: var(--s-3) var(--s-6);
    }
  }
</style>
