<script lang="ts">
  // Nav — six-destination horizontal navigation. Auto-scrolls the active
  // item into view on mobile (UI-SPEC §"Layout & Responsive Contract" —
  // no hamburger menu, only 6 destinations all visible by overflow scroll).
  //
  // Nav labels are intentionally English literals here — Paraglide nav-label
  // keys are not in the Phase 2 P2 keyset and would balloon the dictionary
  // for purely structural strings. A future i18n pass adds nav_* keys; the
  // pattern stays the same.

  type ActiveKey = "games" | "events" | "audit" | "accounts" | "keys" | "settings";

  let { active }: { active: ActiveKey } = $props();

  const items: ReadonlyArray<{ key: ActiveKey; href: string; label: string }> = [
    { key: "games", href: "/games", label: "Games" },
    { key: "events", href: "/events", label: "Events" },
    { key: "audit", href: "/audit", label: "Audit" },
    { key: "accounts", href: "/accounts/youtube", label: "Accounts" },
    { key: "keys", href: "/keys/steam", label: "Keys" },
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
