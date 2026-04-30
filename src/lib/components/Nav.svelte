<script lang="ts">
  // Nav — six-destination horizontal navigation. Auto-scrolls the active
  // item into view on mobile (UI-SPEC §"Layout & Responsive Contract" —
  // no hamburger menu, only 6 destinations all visible by overflow scroll).
  //
  // Phase 2.1 reshuffle (UI-SPEC §"<Nav>" delta): six destinations REPLACE
  // the Phase 2 set. New order: Feed (default landing) · Sources · Games ·
  // Events · Audit · Settings. Removed: the Phase 2 per-platform accounts
  // entry (replaced by Sources — its route is physically gone) and the
  // Phase 2 top-level Keys entry (folds under Settings sub-nav per
  // Phase 2.1 polish — Plan 02.1-09 owns the Settings sub-nav layout).
  //
  // Nav labels are intentionally English literals here — Paraglide nav-label
  // keys are not in the Phase 2.1 keyset and would balloon the dictionary
  // for purely structural strings. A future i18n pass adds nav_* keys; the
  // pattern stays the same.

  type ActiveKey = "feed" | "sources" | "games" | "events" | "audit" | "settings";

  let { active }: { active: ActiveKey } = $props();

  const items: ReadonlyArray<{ key: ActiveKey; href: string; label: string }> = [
    { key: "feed", href: "/feed", label: "Feed" },
    { key: "sources", href: "/sources", label: "Sources" },
    { key: "games", href: "/games", label: "Games" },
    { key: "settings", href: "/settings", label: "Settings" },
  ];

  let activeEl: HTMLAnchorElement | null = $state(null);

  $effect(() => {
    if (activeEl) {
      activeEl.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    }
  });
</script>

<nav class="nav" aria-label="Primary">
  {#each items as item}
    {#if item.key === active}
      <a bind:this={activeEl} href={item.href} class="item active" aria-current="page">
        {item.label}
      </a>
    {:else}
      <a href={item.href} class="item">{item.label}</a>
    {/if}
  {/each}
</nav>

<style>
  /* Plan 02.1-39 round-6 #5 (UAT-NOTES.md §5.4 follow-up #5): <Nav> is
   * NON-STICKY here. Sticky positioning moved UP one level to the
   * `.sticky-chrome` wrapper in src/routes/+layout.svelte that contains
   * both AppHeader and Nav. The user-visible behavior (Nav stays pinned
   * just under AppHeader while content scrolls) is unchanged — AppHeader
   * and Nav now move as a single DOM unit because the wrapper is the only
   * sticky element.
   *
   * History: round-6 #1-#4 tried to make Nav independently sticky at
   * `top: var(--app-header-height) - var(--sticky-overlap)`. That math
   * never quite worked: at every overlap value some browser-zoom + DPR
   * combination either left a subpixel gap (overlap too small) or made
   * Nav visibly slip up on scroll-start (overlap too large, so Nav's
   * sticky `top:` sat ABOVE its in-flow position by the overlap amount,
   * forcing it to scroll up by N pixels before the sticky engaged).
   * User reported the slip after the 4px overlap landed (419e3c7):
   * "Зазора нет, но есть небольшой скрол табов feed sources что выглядит
   * как артефакт".
   *
   * The fix is architectural: there's no overlap-math sweet spot for two
   * stacked independent sticky elements. Wrap them in a single sticky
   * container instead — the AppHeader↔Nav boundary is no longer a sticky
   * boundary, so it can neither gap nor slip by construction. */
  .nav {
    display: flex;
    gap: var(--space-md);
    padding: 0 var(--space-md);
    overflow-x: auto;
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
    scrollbar-width: thin;
    min-width: 0;
  }
  .item {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    padding: 0 var(--space-sm);
    color: var(--color-text-muted);
    text-decoration: none;
    font-size: var(--font-size-body);
    border-bottom: 2px solid transparent;
    white-space: nowrap;
  }
  .item:hover {
    color: var(--color-text);
  }
  .active {
    color: var(--color-text);
    border-bottom-color: var(--color-accent);
  }
</style>
