<script lang="ts">
  // AddSteamListingForm — inline form for "+ Add Steam listing" on
  // /games/[id] under StoresSection. Closes the second half of the Phase 2
  // P0 functional gap (the first half is RenameInline).
  //
  // Steam URL paste field. We parse the appId from the URL client-side and
  // POST /api/games/:gameId/listings { appId, label } — the existing Phase 2
  // game-listings router (Plan 02-08) accepts a numeric appId, not a URL.
  //
  // On 201/200 → onSuccess() callback (StoresSection collapses the form +
  // calls invalidateAll on the parent). On 422 with body.error ===
  // 'steam_listing_duplicate' (Plan 02.1-29 service hardening), read
  // body.metadata.existingGameId + existingState and surface inline:
  //   - existingState === 'active'      → text + deep link to /games/{id}
  //   - existingState === 'soft_deleted' → soft-deleted explanation
  // (Plan 02.1-30, UAT-NOTES.md §4.25.G).
  //
  // Other 4xx responses → InlineError with the server's error code.

  import { m } from "$lib/paraglide/messages.js";
  import InlineError from "./InlineError.svelte";

  let {
    gameId,
    onSuccess,
  }: {
    gameId: string;
    onSuccess?: () => void;
  } = $props();

  let value = $state("");
  let label = $state("");
  let pending = $state(false);
  let errorText = $state<string | null>(null);
  // Plan 02.1-30 (UAT-NOTES.md §4.25.G): duplicate-toast state. When set,
  // renders the inline error block with the existingGameId deep link and
  // the appropriate localized copy per existingState.
  let duplicateError = $state<{
    existingGameId: string;
    existingState: "active" | "soft_deleted";
  } | null>(null);

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
    duplicateError = null;

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
      // Plan 02.1-30: 422 with steam_listing_duplicate is a special case —
      // we surface the existing game's deep link instead of a generic error.
      // Plan 02.1-29 service hardening guarantees the metadata shape.
      if (res.status === 422) {
        try {
          const body = (await res.json()) as {
            error?: string;
            metadata?: {
              existingGameId?: string;
              existingState?: "active" | "soft_deleted";
            };
          };
          if (
            body.error === "steam_listing_duplicate" &&
            body.metadata &&
            typeof body.metadata.existingGameId === "string" &&
            (body.metadata.existingState === "active" ||
              body.metadata.existingState === "soft_deleted")
          ) {
            duplicateError = {
              existingGameId: body.metadata.existingGameId,
              existingState: body.metadata.existingState,
            };
            return;
          }
        } catch {
          /* fall through to generic error */
        }
      }
      if (!res.ok) {
        let code = "error_server_generic";
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) code = body.error;
        } catch {
          /* ignore body parse */
        }
        errorText =
          code === "validation_failed" ? m.ingest_error_malformed_url() : m.error_server_generic();
        return;
      }
      value = "";
      label = "";
      onSuccess?.();
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
{#if duplicateError}
  <p class="duplicate-error" role="alert">
    {#if duplicateError.existingState === "active"}
      <!-- Plan 02.1-30 (UAT-NOTES.md §4.25.G): the duplicate-active label
           is split into prefix + link-label so the .svelte renders an
           actual <a href> for the existingGameId deep link. The userId-
           scoped service lookup (Plan 02.1-29) guarantees existingGameId
           never crosses tenants. -->
      {m.steam_listing_duplicate_active_prefix()}
      <a href={`/games/${duplicateError.existingGameId}`}>
        {m.steam_listing_duplicate_active_link_label()}
      </a>
    {:else}
      {m.steam_listing_duplicate_soft_deleted()}
    {/if}
  </p>
{/if}

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
  /* Plan 02.1-30: duplicate-toast inline error block. Mirrors InlineError's
   * destructive surface but keeps the deep link rendered as a child <a>. */
  .duplicate-error {
    margin: var(--space-sm) 0 0 0;
    padding: var(--space-sm) var(--space-md);
    background: var(--color-bg);
    border: 1px solid var(--color-destructive);
    border-radius: 4px;
    color: var(--color-text);
    font-size: var(--font-size-label);
  }
  .duplicate-error a {
    color: var(--color-accent);
    font-weight: var(--font-weight-semibold);
  }
</style>
