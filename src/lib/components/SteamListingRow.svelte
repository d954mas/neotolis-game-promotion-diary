<script lang="ts">
  // SteamListingRow — one Steam listing on /games/[id] GAME HEADER CARD.
  //
  // Plan 02.1-25 (UAT-NOTES.md §3.3-polish): the user wanted Steam listings
  // to surface the game name (e.g. "Portal 2") + a way to open the Steam
  // store page. Quote: "Хотелось бы видеть еще название и способ перейти
  // в стим".
  //
  // displayName: prefer the persisted `name` (Plan 02.1-25 column added in
  // Task 1's migration 0004); fall back to `App {appId}` for legacy rows
  // (NULL `name`) or rows added during a Steam outage. The fallback is
  // graceful and matches the Phase 2 visual surface so users notice when
  // the metadata fetch failed without breaking the flow.
  //
  // steamUrl: `https://store.steampowered.com/app/{appId}/` — public Steam
  // store URL, no auth needed. `target="_blank"` + `rel="noopener noreferrer"`
  // is the standard external-link safety pair.

  import { m } from "$lib/paraglide/messages.js";

  type Listing = {
    id: string;
    appId: number;
    label: string;
    name: string | null;
    coverUrl: string | null;
    releaseDate: string | null;
    apiKeyId: string | null;
  };

  let { listing }: { listing: Listing } = $props();

  const displayName = $derived(listing.name ?? `App ${listing.appId}`);
  const steamUrl = $derived(`https://store.steampowered.com/app/${listing.appId}/`);
</script>

<div class="row">
  <span class="name">{displayName}</span>
  {#if listing.label}
    <span class="chip label">{listing.label}</span>
  {/if}
  {#if listing.releaseDate}
    <span class="chip date">{listing.releaseDate}</span>
  {/if}
  {#if listing.apiKeyId}
    <span class="chip linked">key linked</span>
  {/if}
  <a class="open-link" href={steamUrl} target="_blank" rel="noopener noreferrer">
    {m.steam_listing_open_link_label()}
  </a>
</div>

<style>
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-sm);
    align-items: center;
    padding: var(--space-sm);
    border-bottom: 1px solid var(--color-border);
    min-width: 0;
  }
  .name {
    color: var(--color-text);
    font-weight: var(--font-weight-semibold);
    word-break: break-word;
    min-width: 0;
  }
  .chip {
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 999px;
    padding: 2px var(--space-sm);
  }
  .open-link {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    min-height: 36px;
    padding: 0 var(--space-md);
    background: var(--color-surface);
    color: var(--color-accent);
    border: 1px solid var(--color-accent);
    border-radius: 4px;
    text-decoration: none;
    font-size: var(--font-size-label);
    font-weight: var(--font-weight-semibold);
    white-space: nowrap;
  }
  .open-link:hover {
    background: var(--color-accent);
    color: var(--color-accent-text, #fff);
  }
</style>
