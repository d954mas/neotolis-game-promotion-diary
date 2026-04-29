<script lang="ts">
  // SteamListingRow — one Steam listing on /games/[id] under StoresSection.
  //
  // Plan 02.1-25 (UAT-NOTES.md §3.3-polish): the user wanted Steam listings
  // to surface the game name (e.g. "Portal 2") + a way to open the Steam
  // store page. Quote: "Хотелось бы видеть еще название и способ перейти
  // в стим".
  //
  // Plan 02.1-30 (UAT-NOTES.md §4.25.H): adds a Remove icon button gated
  // by the page-level `editMode` toggle (mirrors Plan 02.1-22's SourceRow
  // edit pattern). Click → ConfirmDialog → DELETE
  // /api/games/:gameId/listings/:listingId → onChange() so the parent can
  // invalidateAll() and the listing disappears from the list.
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
  import ConfirmDialog from "./ConfirmDialog.svelte";

  type Listing = {
    id: string;
    appId: number;
    label: string;
    name: string | null;
    coverUrl: string | null;
    releaseDate: string | null;
    apiKeyId: string | null;
  };

  let {
    listing,
    gameId,
    editMode = false,
    onChange,
  }: {
    listing: Listing;
    // gameId is OPTIONAL for backward compatibility with any callers that
    // render the row outside StoresSection. When omitted, the Remove button
    // hides (no DELETE target). StoresSection passes both editMode + gameId
    // so the Remove flow is fully wired on /games/[id].
    gameId?: string;
    editMode?: boolean;
    onChange?: () => void;
  } = $props();

  const displayName = $derived(listing.name ?? `App ${listing.appId}`);
  const steamUrl = $derived(`https://store.steampowered.com/app/${listing.appId}/`);

  let confirmOpen = $state(false);
  let removing = $state(false);

  async function handleRemoveConfirmed(): Promise<void> {
    if (removing || !gameId) return;
    removing = true;
    try {
      const res = await fetch(`/api/games/${gameId}/listings/${listing.id}`, {
        method: "DELETE",
      });
      if (res.ok) {
        confirmOpen = false;
        onChange?.();
      }
    } finally {
      removing = false;
    }
  }
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
  {#if editMode && gameId}
    <!-- Plan 02.1-30 (UAT-NOTES.md §4.25.H): Remove icon button — visible
         only when the page-level edit toggle is on. Mirrors SourceRow's
         edit-mode Remove pattern (Plan 02.1-22 §2.4). -->
    <button
      type="button"
      class="remove-btn"
      aria-label={m.steam_listing_remove_aria()}
      onclick={() => (confirmOpen = true)}
      disabled={removing}
    >
      ×
    </button>
  {/if}
</div>

<ConfirmDialog
  open={confirmOpen}
  message={m.confirm_listing_remove_title() + " " + m.confirm_listing_remove_body()}
  confirmLabel={m.common_remove()}
  onConfirm={handleRemoveConfirmed}
  onCancel={() => (confirmOpen = false)}
/>

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
  /* Plan 02.1-30: Remove icon button — small × that mirrors the destructive
   * affordance from SourceRow but at icon size (tighter row layout). 44×44
   * hit area preserved per UI-SPEC §"Touch targets". */
  .remove-btn {
    min-width: 44px;
    min-height: 44px;
    padding: 0 var(--space-sm);
    background: transparent;
    color: var(--color-destructive);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-size: var(--font-size-heading);
    line-height: 1;
    cursor: pointer;
  }
  .remove-btn:hover:not(:disabled) {
    border-color: var(--color-destructive);
  }
  .remove-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
