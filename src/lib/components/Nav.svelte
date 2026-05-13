<script lang="ts">
  // Nav — horizontal navigation. Auto-scrolls the active item into view on
  // mobile (no hamburger menu).
  //
  // Visible items: Feed · Sources · Games · Settings · About. ActiveKey also
  // includes "events" and "audit" as type-only members — they're highlightable
  // from /events and /audit routes but intentionally NOT in `items[]`
  // (deep-link only, folded under Settings sub-nav).
  //
  // Nav labels are intentionally English literals here — Paraglide nav-label
  // keys would balloon the dictionary for purely structural strings. A future
  // i18n pass adds nav_* keys; the pattern stays the same.

  type ActiveKey = "feed" | "sources" | "games" | "events" | "audit" | "settings" | "about";

  let { active }: { active: ActiveKey } = $props();

  const items: ReadonlyArray<{ key: ActiveKey; href: string; label: string }> = [
    { key: "feed", href: "/feed", label: "Feed" },
    { key: "sources", href: "/sources", label: "Sources" },
    { key: "games", href: "/games", label: "Games" },
    { key: "settings", href: "/settings", label: "Settings" },
    { key: "about", href: "/about", label: "About" },
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
  /* <Nav> is NON-STICKY here. Sticky positioning lives one level up in
   * the `.sticky-chrome` wrapper in src/routes/+layout.svelte that
   * contains both AppHeader and Nav. The user-visible behavior (Nav
   * stays pinned just under AppHeader while content scrolls) is
   * unchanged — AppHeader and Nav move as a single DOM unit because
   * the wrapper is the only sticky element.
   *
   * Why one wrapper instead of two independent sticky elements: there's
   * no overlap-math sweet spot — at every overlap value some browser-zoom
   * + DPR combination either left a subpixel gap (overlap too small) or
   * made Nav visibly slip up on scroll-start (overlap too large). Wrapping
   * removes the sticky boundary between AppHeader and Nav by construction. */
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
