<script lang="ts">
  // Nav — horizontal primary navigation (v2 tab pattern).
  //
  // Each tab is icon + label. Active tab gets a 2px bottom underline in
  // --accent and full --text color; inactive tabs sit at --text-2 with
  // an --accent-soft hover wash. On narrow viewports the whole bar
  // scrolls horizontally (overflow-x: auto + scrollbar-width: none) and
  // the active tab is scrolled into view (auto-fall-back when the user
  // has prefers-reduced-motion set).
  //
  // Visible items: Feed · Sources · Games · Settings · About. ActiveKey
  // also includes "events" and "audit" as type-only members — they're
  // highlightable from /events and /audit routes but intentionally NOT
  // in `items[]` (deep-link only, folded under Settings sub-nav).
  //
  // Nav labels are intentionally English literals here — Paraglide
  // nav-label keys would balloon the dictionary for purely structural
  // strings. A future i18n pass adds nav_* keys; the pattern stays the
  // same.

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
    if (!activeEl) return;
    // Honor prefers-reduced-motion: smooth scroll-into-view becomes
    // instant when the user has requested reduced motion. matchMedia is
    // only available client-side; guard the typeof window check so SSR
    // never executes this branch.
    if (typeof window === "undefined") return;
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const behavior: ScrollBehavior = prefersReducedMotion ? "auto" : "smooth";
    activeEl.scrollIntoView({ behavior, block: "nearest", inline: "center" });
  });
</script>

<!-- <Nav> is NON-STICKY here. Sticky positioning lives one level up in
     the `.sticky-chrome` wrapper in src/routes/+layout.svelte that
     contains both AppHeader and Nav. The user-visible behavior (Nav
     stays pinned just under AppHeader while content scrolls) is
     unchanged — AppHeader and Nav move as a single DOM unit because
     the wrapper is the only sticky element (LB-1).

     Why one wrapper instead of two independent sticky elements: there's
     no overlap-math sweet spot — at every overlap value some browser-
     zoom + DPR combination either left a subpixel gap (overlap too
     small) or made Nav visibly slip up on scroll-start (overlap too
     large). Wrapping removes the sticky boundary between AppHeader and
     Nav by construction. -->
<nav class="nav" aria-label="Primary navigation">
  {#each items as item (item.key)}
    {#if item.key === active}
      <a bind:this={activeEl} href={item.href} class="nav-tab active" aria-current="page">
        <span class="tab-icon" aria-hidden="true">
          {#if item.key === "feed"}
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.75"
              stroke-linecap="round"
              stroke-linejoin="round"
              ><path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h10" /></svg
            >
          {:else if item.key === "sources"}
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.75"
              stroke-linecap="round"
              stroke-linejoin="round"
              ><circle cx="12" cy="12" r="2.5" /><path d="M12 4v3" /><path d="M12 17v3" /><path
                d="M4 12h3"
              /><path d="M17 12h3" /><path d="M6.34 6.34l2.12 2.12" /><path
                d="M15.54 15.54l2.12 2.12"
              /><path d="M6.34 17.66l2.12-2.12" /><path d="M15.54 8.46l2.12-2.12" /></svg
            >
          {:else if item.key === "games"}
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.75"
              stroke-linecap="round"
              stroke-linejoin="round"
              ><rect x="3" y="7" width="18" height="11" rx="3" /><path d="M8 11v3" /><path
                d="M6.5 12.5h3"
              /><circle cx="15.5" cy="11.5" r=".7" fill="currentColor" /><circle
                cx="17.5"
                cy="13.5"
                r=".7"
                fill="currentColor"
              /></svg
            >
          {:else if item.key === "settings"}
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.75"
              stroke-linecap="round"
              stroke-linejoin="round"
              ><circle cx="12" cy="12" r="3" /><path
                d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
              /></svg
            >
          {:else if item.key === "about"}
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.75"
              stroke-linecap="round"
              stroke-linejoin="round"
              ><circle cx="12" cy="12" r="9" /><path d="M12 11v6" /><circle
                cx="12"
                cy="7.6"
                r=".9"
                fill="currentColor"
                stroke="none"
              /></svg
            >
          {/if}
        </span>
        <span class="tab-label">{item.label}</span>
      </a>
    {:else}
      <a href={item.href} class="nav-tab">
        <span class="tab-icon" aria-hidden="true">
          {#if item.key === "feed"}
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.75"
              stroke-linecap="round"
              stroke-linejoin="round"
              ><path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h10" /></svg
            >
          {:else if item.key === "sources"}
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.75"
              stroke-linecap="round"
              stroke-linejoin="round"
              ><circle cx="12" cy="12" r="2.5" /><path d="M12 4v3" /><path d="M12 17v3" /><path
                d="M4 12h3"
              /><path d="M17 12h3" /><path d="M6.34 6.34l2.12 2.12" /><path
                d="M15.54 15.54l2.12 2.12"
              /><path d="M6.34 17.66l2.12-2.12" /><path d="M15.54 8.46l2.12-2.12" /></svg
            >
          {:else if item.key === "games"}
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.75"
              stroke-linecap="round"
              stroke-linejoin="round"
              ><rect x="3" y="7" width="18" height="11" rx="3" /><path d="M8 11v3" /><path
                d="M6.5 12.5h3"
              /><circle cx="15.5" cy="11.5" r=".7" fill="currentColor" /><circle
                cx="17.5"
                cy="13.5"
                r=".7"
                fill="currentColor"
              /></svg
            >
          {:else if item.key === "settings"}
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.75"
              stroke-linecap="round"
              stroke-linejoin="round"
              ><circle cx="12" cy="12" r="3" /><path
                d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
              /></svg
            >
          {:else if item.key === "about"}
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.75"
              stroke-linecap="round"
              stroke-linejoin="round"
              ><circle cx="12" cy="12" r="9" /><path d="M12 11v6" /><circle
                cx="12"
                cy="7.6"
                r=".9"
                fill="currentColor"
                stroke="none"
              /></svg
            >
          {/if}
        </span>
        <span class="tab-label">{item.label}</span>
      </a>
    {/if}
  {/each}
</nav>

<style>
  .nav {
    display: flex;
    align-items: stretch;
    gap: var(--s-1);
    padding: 0 var(--s-4);
    max-width: var(--max-w);
    margin: 0 auto;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none; /* Firefox */
  }
  .nav::-webkit-scrollbar {
    display: none; /* WebKit */
  }
  .nav-tab {
    display: inline-flex;
    align-items: center;
    gap: var(--s-1);
    padding: var(--s-2) var(--s-3);
    min-height: var(--hit);
    color: var(--text-2);
    text-decoration: none;
    border-bottom: 2px solid transparent;
    transition:
      background var(--m-fast) var(--m-ease),
      color var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
    border-radius: var(--r-sm) var(--r-sm) 0 0;
    white-space: nowrap;
  }
  .nav-tab:hover {
    background: var(--accent-soft);
    color: var(--text);
  }
  .nav-tab.active {
    color: var(--text);
    border-bottom: 2px solid var(--accent);
  }
  .nav-tab.active .tab-icon {
    color: var(--accent);
  }
  .tab-icon {
    display: inline-flex;
    width: 16px;
    height: 16px;
    color: currentColor;
  }
  .tab-label {
    font-family: var(--f-sans);
    font-size: var(--t-13);
    font-weight: var(--w-rg);
  }
  @media (min-width: 768px) {
    .nav {
      padding: 0 var(--s-6);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .nav-tab {
      transition: none;
    }
  }
</style>
