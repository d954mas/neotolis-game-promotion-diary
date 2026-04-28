<script lang="ts">
  // AddSteamListingForm — inline form for "+ Add Steam listing" on
  // /games/[id]. Closes the second half of the Phase 2 P0 functional gap
  // (the first half is RenameInline).
  //
  // Steam URL paste field. We parse the appId from the URL client-side and
  // POST /api/games/:gameId/listings { appId, label } — the existing Phase 2
  // game-listings router (Plan 02-08) accepts a numeric appId, not a URL.
  //
  // On 201/200 → invalidateAll() to refresh the parent loader. On 422 →
  // InlineError with the server's error code. The paste-then-validate UX
  // mirrors <PasteBox> but is scoped to Steam URLs.

  import { invalidateAll } from "$app/navigation";
  import { m } from "$lib/paraglide/messages.js";
  import InlineError from "./InlineError.svelte";

  let {
    gameId,
  }: {
    gameId: string;
  } = $props();

  let value = $state("");
  let label = $state("");
  let pending = $state(false);
  let errorText = $state<string | null>(null);

  // Extract numeric appId from a Steam store URL like
  // `https://store.steampowered.com/app/1145360/HADES/`.
  function parseAppId(raw: string): number | null {
    let url: URL;
    try {
      url = new URL(raw.trim());
    } catch {
      return null;
    }
    if (
      url.host !== "store.steampowered.com" &&
      url.host !== "steamcommunity.com" &&
      url.host !== "www.store.steampowered.com"
    ) {
      return null;
    }
    const match = url.pathname.match(/\/app\/(\d+)/);
    if (!match) return null;
    const id = Number(match[1]);
    return Number.isFinite(id) && id > 0 ? id : null;
  }

  async function submit(e: Event): Promise<void> {
    e.preventDefault();
    if (pending) return;
    errorText = null;

    const appId = parseAppId(value);
    if (appId === null) {
      errorText = m.ingest_error_malformed_url();
      return;
    }

    pending = true;
    try {
      const res = await fetch(`/api/games/${gameId}/listings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appId, label: label.trim() || undefined }),
      });
      if (!res.ok) {
        let code = "error_server_generic";
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) code = body.error;
        } catch {
          /* ignore body parse */
        }
        errorText =
          code === "validation_failed"
            ? m.ingest_error_malformed_url()
            : m.error_server_generic();
        return;
      }
      value = "";
      label = "";
      await invalidateAll();
    } catch {
      errorText = m.error_network();
    } finally {
      pending = false;
    }
  }
</script>

<form class="add-listing" onsubmit={submit}>
  <label class="field">
    <span class="field-label">Steam URL</span>
    <input
      class="input"
      type="url"
      bind:value
      placeholder="https://store.steampowered.com/app/…"
      autocomplete="off"
      spellcheck="false"
      disabled={pending}
    />
  </label>
  <label class="field">
    <span class="field-label">Label (optional)</span>
    <input
      class="input"
      type="text"
      bind:value={label}
      maxlength="100"
      placeholder="Demo / Full / DLC / OST"
      disabled={pending}
    />
  </label>
  <button type="submit" class="submit" disabled={pending || value.trim().length === 0}>
    {m.game_add_steam_listing_cta()}
  </button>
</form>
{#if errorText}<InlineError message={errorText} />{/if}

<style>
  .add-listing {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
    padding: var(--space-md);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 4px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
  }
  .field-label {
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
  }
  .input {
    min-height: 44px;
    padding: 0 var(--space-md);
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-size: var(--font-size-body);
  }
  .submit {
    min-height: 44px;
    padding: 0 var(--space-md);
    background: var(--color-accent);
    color: var(--color-accent-text);
    border: none;
    border-radius: 4px;
    font-weight: var(--font-weight-semibold);
    cursor: pointer;
    align-self: flex-start;
  }
  .submit:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
