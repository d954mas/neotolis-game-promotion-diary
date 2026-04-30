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
  /* Plan 02.1-39 (UAT-NOTES.md §5.4 — true closure): primary <Nav> sticks
   * just below the AppHeader so the user can switch between Feed / Sources /
   * Games / Settings while scrolling deep inside any list page. Round-5 user
   * quote: "хедер сейчас липкий все ок. Но вот табы после хедера, не липкие".
   * The first round-6 attempt misread "табы после хедера" as <FeedQuickNav>
   * (the per-feed chip strip) and made THAT sticky; user clarified the
   * intended target is the primary nav strip rendered immediately under
   * AppHeader on every authenticated page. Commit 4717c3c reversed the
   * FeedQuickNav misfix; this rule is the actual closure.
   *
   * Sticky stack now: AppHeader (top: 0, z: 10) → Nav (top: 72px, z: 9) →
   * PageHeader.sticky (top: 72px + --nav-height, z: 5). Background +
   * border-bottom already present prevent see-through during scroll.
   * z-index 9 sits one below AppHeader (10) so AppHeader still wins the
   * visual layer if any future overlay edge case occurs. */
  .nav {
    position: sticky;
    top: var(--app-header-height, 72px);
    z-index: 9;
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
