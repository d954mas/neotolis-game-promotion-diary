<script lang="ts">
  // FeedQuickNav — chip strip / segmented-control at the TOP of /feed for the
  // most-common Show axis values. Plan 02.1-26, closing UAT-NOTES.md
  // §6.2-redesign — the user wants a single-click switch between All / Inbox /
  // Standalone / per-game views; today they have to open the FiltersSheet,
  // scroll, choose, apply (4+ taps for a frequent action).
  //
  // SHORTCUT, NOT REPLACEMENT — The full FiltersSheet stays for long-tail
  // filters (kind, source, date range, authorIsMe). FeedQuickNav covers the
  // Show axis only. Click → URL change → loader re-runs → feed list refreshes.
  //
  // URL contract: this component DOES NOT invent a new param. It consumes the
  // existing `?show=any|inbox|standalone|specific&game=<id>` URL contract
  // established by Plan 02.1-19 (any/inbox/specific) + Plan 02.1-24
  // (standalone). Per-game tab uses `?show=specific&game=<id>` — single value.
  //
  // Tabs:
  //   - All       (default — show.kind === "any") → clears ?show + ?game
  //   - Inbox     (show.kind === "inbox")         → ?show=inbox
  //   - Standalone (show.kind === "standalone")   → ?show=standalone
  //   - <Game N>  (show.kind === "specific" AND gameIds=[g.id])
  //               → ?show=specific&game=<id> (single value)
  //
  // Overflow handling at 360px: with > 5 games, additional games collapse
  // into a 'More games ▾' <details> dropdown to keep the strip from
  // overflowing. The visible 5 + dropdown stays within the 360px viewport
  // (each chip ~80-120px wide; 5 short titles fit; dropdown handles the rest).
  // Strip itself uses overflow-x: auto + scroll-snap for graceful degradation
  // on extreme cases (long titles, > 10 games).
  //
  // Testability — Pure component:
  //   - currentUrlSearch (string) is passed in by the parent /feed/+page.svelte
  //     reading $app/state.page.url.search. Component never imports $app/state
  //     directly — the SSR test harness (audit-render.test.ts) doesn't load
  //     SvelteKit virtual modules.
  //   - onNavigate (href: string) callback is provided by the parent which
  //     calls SvelteKit's goto(href). Component never imports $app/navigation.
  //   - The component renders <a href> for accessibility (right-click "Open
  //     in new tab" works) and intercepts onclick via onNavigate.

  import { m } from "$lib/paraglide/messages.js";

  type ShowFilter =
    | { kind: "any" }
    | { kind: "inbox" }
    | { kind: "standalone" }
    | { kind: "specific"; gameIds: string[] };

  type GameLite = { id: string; title: string };

  type TabKey = "all" | "inbox" | "standalone" | { game: string };

  let {
    games,
    activeShow,
    currentUrlSearch,
    onNavigate,
  }: {
    games: GameLite[];
    activeShow: ShowFilter;
    // The current URL's `.search` substring (e.g. "?show=inbox&kind=press").
    // Empty string when no params present. The parent reads this from
    // $app/state.page.url.search; the SSR test passes it directly.
    currentUrlSearch: string;
    // Called with the destination href on a tab click. The parent runs
    // goto(href) (SvelteKit) and invalidateAll() if needed. The component
    // also renders <a href> so middle-click / right-click "Open link" still
    // work for accessibility.
    onNavigate: (href: string) => void;
  } = $props();

  // > 5 visible games collapses the rest into the "More games ▾" dropdown.
  // 5 was chosen because at 360px viewport with 4 short tabs (All / Inbox /
  // Standalone / "More games") + 5 game chips, the strip is filled but each
  // chip is still tappable; dropping the threshold to 4 leaves dead space at
  // common 6-7-game indie collections. Future iteration can promote this
  // to a CSS container query if real users ship > 10 games.
  const COLLAPSE_THRESHOLD = 5;

  const visibleGames = $derived(games.slice(0, COLLAPSE_THRESHOLD));
  const overflowGames = $derived(games.slice(COLLAPSE_THRESHOLD));

  const activeKey = $derived.by((): TabKey => {
    if (activeShow.kind === "any") return "all";
    if (activeShow.kind === "inbox") return "inbox";
    if (activeShow.kind === "standalone") return "standalone";
    if (activeShow.kind === "specific" && activeShow.gameIds.length === 1) {
      return { game: activeShow.gameIds[0]! };
    }
    // Specific with 0 or 2+ games is the FiltersSheet multi-select path —
    // not a quick-nav state. Falls back to "all" (no quick-nav tab is
    // highlighted, but the FilterChips strip below still shows the
    // multi-game chip).
    return "all";
  });

  function isActive(tab: TabKey): boolean {
    if (typeof activeKey === "string" && typeof tab === "string") {
      return activeKey === tab;
    }
    if (typeof activeKey === "object" && typeof tab === "object") {
      return activeKey.game === tab.game;
    }
    return false;
  }

  function buildHref(target: TabKey): string {
    const params = new URLSearchParams(currentUrlSearch);
    // Cursor is always cleared on a tab change — the new view starts fresh
    // (the previous cursor pointed into the old result set; reusing it
    // would land an empty / wrong page).
    params.delete("cursor");
    // The Show axis lives in two params: ?show + ?game (when specific). Both
    // are dropped before the new shape is set so leftover values from the
    // previous view don't leak through.
    params.delete("show");
    params.delete("game");

    if (typeof target === "string") {
      if (target === "all") {
        // No params — All is the default; preserves date / kind / source /
        // authorIsMe / all=1 so long-tail filters stay applied.
      } else if (target === "inbox") {
        params.set("show", "inbox");
      } else if (target === "standalone") {
        params.set("show", "standalone");
      }
    } else {
      params.set("show", "specific");
      params.append("game", target.game);
    }

    const qs = params.toString();
    return qs ? `/feed?${qs}` : "/feed";
  }

  function handleClick(target: TabKey, e: Event): void {
    e.preventDefault();
    onNavigate(buildHref(target));
  }

  let dropdownOpen = $state(false);
</script>

<nav class="quick-nav" aria-label="Feed quick navigation" data-testid="feed-quick-nav">
  <a
    class="tab"
    class:active={isActive("all")}
    data-tab="all"
    href={buildHref("all")}
    onclick={(e) => handleClick("all", e)}
  >{m.feed_quick_nav_all()}</a>

  <a
    class="tab"
    class:active={isActive("inbox")}
    data-tab="inbox"
    href={buildHref("inbox")}
    onclick={(e) => handleClick("inbox", e)}
  >{m.feed_quick_nav_inbox()}</a>

  <a
    class="tab"
    class:active={isActive("standalone")}
    data-tab="standalone"
    href={buildHref("standalone")}
    onclick={(e) => handleClick("standalone", e)}
  >{m.feed_quick_nav_standalone()}</a>

  {#each visibleGames as g (g.id)}
    <a
      class="tab"
      class:active={isActive({ game: g.id })}
      data-tab="game"
      data-game-id={g.id}
      href={buildHref({ game: g.id })}
      onclick={(e) => handleClick({ game: g.id }, e)}
    >{g.title}</a>
  {/each}

  {#if overflowGames.length > 0}
    <details bind:open={dropdownOpen} class="more" data-testid="feed-quick-nav-more">
      <summary class="tab">{m.feed_quick_nav_more_games()}</summary>
      <div class="dropdown">
        {#each overflowGames as g (g.id)}
          <a
            class="tab dropdown-item"
            class:active={isActive({ game: g.id })}
            data-tab="game"
            data-game-id={g.id}
            href={buildHref({ game: g.id })}
            onclick={(e) => {
              handleClick({ game: g.id }, e);
              dropdownOpen = false;
            }}
          >{g.title}</a>
        {/each}
      </div>
    </details>
  {/if}
</nav>

<style>
  .quick-nav {
    display: flex;
    gap: var(--space-sm);
    flex-wrap: nowrap;
    overflow-x: auto;
    /* scroll-snap-type ensures touch scrolling on iOS lands cleanly on the
     * next tab boundary — critical for thumb-only navigation at 360px when
     * the strip overflows (6+ games). */
    scroll-snap-type: x mandatory;
    padding: var(--space-xs) 0;
    -webkit-overflow-scrolling: touch;
    /* Hide scrollbar visually on platforms that show it by default; the
     * touch / wheel scroll affordance still works. */
    scrollbar-width: none;
  }
  .quick-nav::-webkit-scrollbar {
    display: none;
  }
  .tab {
    flex: 0 0 auto;
    scroll-snap-align: start;
    display: inline-flex;
    align-items: center;
    min-height: 36px;
    padding: 0 var(--space-md);
    background: transparent;
    color: var(--color-text-muted);
    border: 1px solid var(--color-border);
    border-radius: 999px;
    font-size: var(--font-size-label);
    font-weight: var(--font-weight-semibold);
    text-decoration: none;
    cursor: pointer;
    white-space: nowrap;
    /* Reset <summary> default disclosure marker so the "More games" tab
     * looks identical to the sibling chips. The tab still toggles open
     * via native <details> behavior. */
    list-style: none;
  }
  .tab::-webkit-details-marker {
    display: none;
  }
  .tab:hover {
    background: var(--color-bg);
  }
  .tab.active {
    background: var(--color-accent);
    color: var(--color-on-accent, #fff);
    border-color: var(--color-accent);
  }
  .more {
    flex: 0 0 auto;
    scroll-snap-align: start;
    position: relative;
  }
  .more > summary {
    list-style: none;
  }
  .more > summary::-webkit-details-marker {
    display: none;
  }
  .dropdown {
    position: absolute;
    top: calc(100% + var(--space-xs));
    left: 0;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    padding: var(--space-xs);
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
    min-width: 180px;
    z-index: 5;
  }
  .dropdown-item {
    width: 100%;
    /* Inside the dropdown, chips read like a vertical menu — pull the
     * border-radius back to a normal rect so adjacent items align. */
    border-radius: 4px;
    justify-content: flex-start;
  }
</style>
