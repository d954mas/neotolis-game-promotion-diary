<script lang="ts">
  // WishlistSummary — per-listing wishlist mini-summary on /games/[id]
  // (WISH-02, D-09). Rendered INSIDE SteamListingRow under the import
  // affordance.
  //
  // Two states:
  //   - summary === null → empty state: a short "no data yet" line + a
  //     copy-paste hint of where the Steamworks CSV comes from. The import
  //     affordance itself lives in WishlistImport (sibling), so the empty
  //     state here is pure guidance, not an action.
  //   - summary non-null → headline `balance` (the outstanding-wishlist
  //     count, prominent) + "as of {lastDate}" + a relative "updated X ago"
  //     (computed from recentDays[0].updatedAt) + a compact ≤14-row table
  //     (Date | Adds | Deletes | Balance), date DESC (the service already
  //     returns rows DESC).
  //
  // No chart — Phase 4 reads the same daily rows for the time-series view.
  // v2 design tokens + Paraglide m.* only; NO hard-coded English literals.
  //
  // NO DENORMALIZATION: this component renders only the wishlist summary;
  // the listing/game name is owned by the parent row (game_steam_listings).

  import { m } from "$lib/paraglide/messages.js";
  import { wishlistAgo } from "$lib/wishlist-ago.js";
  import type { WishlistSummaryDto } from "$lib/server/dto.js";

  let { summary }: { summary: WishlistSummaryDto | null } = $props();

  // Relative-time copy from the most recent snapshot's updatedAt — the last
  // time this listing's wishlist data changed. Shared bucketing helper
  // (wishlistAgo) routes every label through m.* (i18n contract). Recomputed
  // reactively when `summary` changes.
  const updatedAgo = $derived(
    summary && summary.recentDays.length > 0 ? wishlistAgo(summary.recentDays[0]!.updatedAt) : null,
  );
</script>

{#if summary === null}
  <div class="wishlist-empty">
    <p class="empty-line">{m.wishlist_summary_empty()}</p>
    <p class="empty-hint">{m.wishlist_summary_empty_hint()}</p>
  </div>
{:else}
  <div class="wishlist-summary">
    <div class="headline">
      <span class="balance">{summary.balance.toLocaleString("en")}</span>
      <span class="balance-label">{m.wishlist_summary_balance_label()}</span>
    </div>
    <p class="meta">
      <span class="as-of">{m.wishlist_summary_last_date({ date: summary.lastDate })}</span>
      {#if updatedAgo}
        <span class="dot" aria-hidden="true">·</span>
        <span class="updated">{m.wishlist_summary_updated_ago({ ago: updatedAgo })}</span>
      {/if}
    </p>
    {#if summary.recentDays.length > 0}
      <table class="recent">
        <caption class="recent-caption">{m.wishlist_summary_recent_heading()}</caption>
        <thead>
          <tr>
            <th scope="col" class="col-date">{m.wishlist_summary_col_date()}</th>
            <th scope="col" class="num">{m.wishlist_summary_col_adds()}</th>
            <th scope="col" class="num">{m.wishlist_summary_col_deletes()}</th>
            <th scope="col" class="num">{m.wishlist_summary_col_balance()}</th>
          </tr>
        </thead>
        <tbody>
          {#each summary.recentDays as day (day.id)}
            <tr>
              <td class="col-date">{day.date}</td>
              <td class="num">{(day.adds ?? 0).toLocaleString("en")}</td>
              <td class="num">{(day.deletes ?? 0).toLocaleString("en")}</td>
              <td class="num">{day.balance.toLocaleString("en")}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>
{/if}

<style>
  /* v2 WishlistSummary — sits in a --surface-3 well inside the listing
   * card. Headline balance is the visual anchor; the recent-days table is
   * compact mono so daily texture scans at a glance. No chart (Phase 4). */
  .wishlist-empty {
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
  }
  .empty-line {
    margin: 0;
    color: var(--text-2);
    font-family: var(--f-sans);
    font-size: var(--t-13);
    font-weight: var(--w-md);
  }
  .empty-hint {
    margin: 0;
    color: var(--text-3);
    font-family: var(--f-sans);
    font-size: var(--t-12);
    line-height: var(--lh-body);
  }
  .wishlist-summary {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
  }
  .headline {
    display: flex;
    align-items: baseline;
    gap: var(--s-2);
    flex-wrap: wrap;
  }
  .balance {
    color: var(--text);
    font-family: var(--f-mono);
    font-size: var(--t-22, 1.375rem);
    font-weight: var(--w-sb);
    line-height: 1;
  }
  .balance-label {
    color: var(--text-3);
    font-family: var(--f-sans);
    font-size: var(--t-12);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .meta {
    margin: 0;
    display: flex;
    align-items: center;
    gap: var(--s-1);
    flex-wrap: wrap;
    color: var(--text-3);
    font-family: var(--f-sans);
    font-size: var(--t-12);
  }
  .recent {
    width: 100%;
    border-collapse: collapse;
    font-family: var(--f-mono);
    font-size: var(--t-12);
  }
  .recent-caption {
    text-align: left;
    color: var(--text-3);
    font-family: var(--f-sans);
    font-size: var(--t-12);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding-bottom: var(--s-1);
  }
  .recent th,
  .recent td {
    padding: var(--s-0) var(--s-1);
    border-bottom: 1px solid var(--border);
    color: var(--text-2);
    text-align: left;
    white-space: nowrap;
  }
  .recent th {
    color: var(--text-3);
    font-weight: var(--w-md);
  }
  .recent .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .recent .col-date {
    color: var(--text);
  }
</style>
