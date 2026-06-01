<script lang="ts">
  // WishlistImport — per-listing "Import wishlist CSV" affordance on
  // /games/[id] (WISH-02, D-07/D-08). Rendered INSIDE the listing detail modal.
  //
  // D-07: the appid is implicit in `listingId` — the chosen listing IS the
  // binding (the route also guards against a wrong-game filename).
  // D-08: ONE action. The button opens the OS file picker; selecting a file
  // imports it immediately (no separate "choose then submit" step). The file
  // input is hidden and reset after every attempt, so no stale path lingers
  // and re-picking the same file works.
  //
  // On success we call onImported() so the parent invalidates the loader and
  // WishlistSummary refreshes with the new balance.
  //
  // v2 design tokens + Paraglide m.* only. Route 4xx error codes map to clear
  // m.* copy via the same code→message pattern AddSteamListingForm uses.

  import { m } from "$lib/paraglide/messages.js";
  import InlineError from "./InlineError.svelte";

  let {
    gameId,
    listingId,
    onImported,
  }: {
    gameId: string;
    listingId: string;
    onImported?: () => void;
  } = $props();

  let fileInput = $state<HTMLInputElement | null>(null);
  let uploading = $state(false);
  let errorText = $state<string | null>(null);
  let resultText = $state<string | null>(null);

  function errorMessageFor(code: string): string {
    switch (code) {
      case "wishlist_csv_invalid_header":
        return m.wishlist_csv_invalid_header();
      case "wishlist_csv_is_lifetime_summary":
        return m.wishlist_csv_is_lifetime_summary();
      case "wishlist_csv_app_mismatch":
        return m.wishlist_csv_app_mismatch();
      case "wishlist_csv_too_large":
        return m.wishlist_csv_too_large();
      case "wishlist_csv_missing_file":
        return m.wishlist_csv_missing_file();
      default:
        return m.error_server_generic();
    }
  }

  // Fires when the user picks a file in the OS dialog → import immediately.
  async function onPick(): Promise<void> {
    if (uploading) return;
    const file = fileInput?.files?.[0] ?? null;
    if (!file) return; // dialog cancelled — nothing to do
    errorText = null;
    resultText = null;

    const form = new FormData();
    form.append("file", file);

    uploading = true;
    try {
      const res = await fetch(`/api/games/${gameId}/listings/${listingId}/wishlist-import`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        let code = "error_server_generic";
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) code = body.error;
        } catch {
          /* ignore body parse */
        }
        errorText = errorMessageFor(code);
        return;
      }
      const body = (await res.json()) as {
        rowCount: number;
        updated: number;
        skipped: number;
        dateRange: { from: string; to: string };
      };
      resultText =
        body.rowCount === 0
          ? m.wishlist_import_result_empty()
          : m.wishlist_import_result({
              rowCount: body.rowCount,
              from: body.dateRange.from,
              to: body.dateRange.to,
              updated: body.updated,
              skipped: body.skipped,
            });
      onImported?.();
    } catch {
      errorText = m.error_network();
    } finally {
      uploading = false;
      // Always clear so re-picking the SAME file fires change again and no
      // stale filename/path persists across imports or modal reopen.
      if (fileInput) fileInput.value = "";
    }
  }
</script>

<div class="wishlist-import">
  <input
    class="file-input-hidden"
    type="file"
    accept=".csv,text/csv"
    bind:this={fileInput}
    onchange={onPick}
    hidden
  />
  <button type="button" class="submit" onclick={() => fileInput?.click()} disabled={uploading}>
    {uploading ? m.wishlist_import_uploading() : m.wishlist_import_cta()}
  </button>
  {#if resultText}<p class="result" role="status">{resultText}</p>{/if}
  {#if errorText}<InlineError message={errorText} />{/if}
</div>

<style>
  /* v2 WishlistImport — single-action import. One --accent button opens the
   * picker and imports on selection; the file input is hidden. */
  .wishlist-import {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
  }
  .submit {
    align-self: flex-start;
    min-height: var(--hit);
    padding: var(--s-1) var(--s-3);
    background: var(--accent);
    color: var(--accent-text);
    border: 1px solid var(--accent);
    border-radius: var(--r-sm);
    font-family: var(--f-sans);
    font-size: var(--t-13);
    font-weight: var(--w-sb);
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .submit:hover:not(:disabled) {
    background: var(--accent-strong);
    border-color: var(--accent-strong);
  }
  .submit:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .result {
    margin: 0;
    padding: var(--s-1) var(--s-2);
    background: var(--surface-3);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    color: var(--text-2);
    font-family: var(--f-sans);
    font-size: var(--t-12);
    line-height: var(--lh-body);
  }
  @media (prefers-reduced-motion: reduce) {
    .submit {
      transition: none;
    }
  }
</style>
