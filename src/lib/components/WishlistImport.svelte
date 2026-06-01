<script lang="ts">
  // WishlistImport — per-listing "Import wishlist CSV" affordance on
  // /games/[id] (WISH-02, D-07/D-08). Rendered INSIDE SteamListingRow.
  //
  // D-07: the appid is implicit in `listingId` — the file is NEVER parsed
  // for an appid. The chosen listing IS the binding.
  // D-08: immediate import — no preview/confirm step. On submit we POST the
  // file straight to the tenant-scoped import route and surface a result
  // message (rows / date range / updated / skipped) inline.
  //
  // On success we call onImported() so the parent invalidates the loader
  // and WishlistSummary refreshes with the new balance.
  //
  // v2 design tokens + Paraglide m.* only; NO hard-coded English literals.
  // Error codes from the route (wishlist_csv_invalid_header /
  // wishlist_csv_too_large / wishlist_csv_missing_file) map to clear m.*
  // copy via the same code→message pattern AddSteamListingForm uses.

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
  let selectedName = $state<string | null>(null);
  let uploading = $state(false);
  let errorText = $state<string | null>(null);
  // Result message after a successful import (D-08 toast equivalent —
  // rendered inline since the repo has no global toast store on this
  // surface, mirroring AddSteamListingForm's inline result UX).
  let resultText = $state<string | null>(null);

  // Map the route's 4xx error codes to localized copy. Unknown codes fall
  // back to the generic server error.
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

  function onFileChange(): void {
    selectedName = fileInput?.files?.[0]?.name ?? null;
    errorText = null;
    resultText = null;
  }

  async function submit(e: Event): Promise<void> {
    e.preventDefault();
    if (uploading) return;
    errorText = null;
    resultText = null;

    const file = fileInput?.files?.[0] ?? null;
    if (!file) {
      errorText = m.wishlist_import_no_file();
      return;
    }

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
      // Reset the picker so a re-import starts clean.
      if (fileInput) fileInput.value = "";
      selectedName = null;
      onImported?.();
    } catch {
      errorText = m.error_network();
    } finally {
      uploading = false;
    }
  }
</script>

<form class="wishlist-import" onsubmit={submit}>
  <label class="field">
    <span class="field-label">{m.wishlist_import_file_label()}</span>
    <input
      class="file-input"
      type="file"
      accept=".csv,text/csv"
      bind:this={fileInput}
      onchange={onFileChange}
      disabled={uploading}
    />
  </label>
  {#if selectedName}
    <p class="selected-name" title={selectedName}>{selectedName}</p>
  {/if}
  <button type="submit" class="submit" disabled={uploading}>
    {uploading ? m.wishlist_import_uploading() : m.wishlist_import_cta()}
  </button>
</form>
{#if resultText}<p class="result" role="status">{resultText}</p>{/if}
{#if errorText}<InlineError message={errorText} />{/if}

<style>
  /* v2 WishlistImport — compact import form inside the listing card.
   * --surface-3 well, --accent submit at --hit height. Mirrors
   * AddSteamListingForm's recipe at a smaller scale. */
  .wishlist-import {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
  }
  .field-label {
    font-family: var(--f-sans);
    font-size: var(--t-12);
    color: var(--text-2);
    font-weight: var(--w-md);
  }
  .file-input {
    font-family: var(--f-sans);
    font-size: var(--t-12);
    color: var(--text-2);
    min-width: 0;
  }
  .file-input::file-selector-button {
    margin-right: var(--s-2);
    padding: var(--s-1) var(--s-2);
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    font-family: var(--f-sans);
    font-size: var(--t-12);
    cursor: pointer;
  }
  .file-input::file-selector-button:hover {
    border-color: var(--accent-strong);
  }
  .selected-name {
    margin: 0;
    color: var(--text-3);
    font-family: var(--f-mono);
    font-size: var(--t-12);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
