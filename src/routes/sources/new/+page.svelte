<script lang="ts">
  // /sources/new — full-page form for registering a data_source (Phase 2.1
  // CONTEXT D-09 — same full-page pattern Phase 2 used for /games/new and
  // /keys/steam). NOT an inline dialog: the 5-chip kind picker (4 disabled
  // with phase tooltips per RESEARCH §5.2) earns its own page surface.
  //
  // Submit flow:
  //   - POST /api/sources with {kind, handleUrl, displayName?, isOwnedByMe,
  //     autoImport}.
  //   - 201 Created → goto("/sources").
  //   - 422 kind_not_yet_functional → InlineError with
  //     m.sources_error_kind_not_yet_functional({kind, phase}) sourced from
  //     the response metadata (Plan 02.1-04 service throws AppError with
  //     metadata.kind + metadata.available_phase).
  //   - 422 duplicate_source → InlineError with m.sources_error_duplicate().
  //   - other failures → InlineError with the response body.error or a
  //     generic copy.
  //
  // Cancel returns to /sources via m.common_cancel() — non-destructive close
  // (the typed input is not at risk because navigating back to /sources is
  // the equivalent; UI-SPEC §"Copywriting Contract" Note on common_cancel).

  import { untrack } from "svelte";
  import { goto } from "$app/navigation";
  import { m } from "$lib/paraglide/messages.js";
  import InlineError from "$lib/components/InlineError.svelte";
  import type { PageData } from "./$types";

  type SourceKind =
    | "youtube_channel"
    | "reddit_account"
    | "twitter_account"
    | "telegram_channel"
    | "discord_server";

  type KindLabelKey =
    | "source_kind_label_youtube_channel"
    | "source_kind_label_reddit_account"
    | "source_kind_label_twitter_account"
    | "source_kind_label_telegram_channel"
    | "source_kind_label_discord_server";

  type KindPhaseKey =
    | "source_kind_phase_reddit_account"
    | "source_kind_phase_twitter_account"
    | "source_kind_phase_telegram_channel"
    | "source_kind_phase_discord_server";

  type KindEntry = {
    value: SourceKind;
    labelKey: KindLabelKey;
    phaseKey: KindPhaseKey | null;
    disabled: boolean;
  };

  let { data }: { data: PageData } = $props();
  const kindMatrix = $derived(data.kindMatrix as KindEntry[]);

  // Form defaults are seeded from the loader on the initial render. The
  // form is one-shot (CONTEXT D-09 full-page form pattern) so reading
  // `data.default*` once at init is intentional — there is no parent re-mount
  // path that would change the defaults mid-form. `untrack` decouples the
  // read from the reactive graph so Svelte 5's state_referenced_locally
  // warning recognises the intent.
  const initialIsOwnedByMe = untrack(() => data.defaultIsOwnedByMe);
  const initialAutoImport = untrack(() => data.defaultAutoImport);

  let selectedKind = $state<SourceKind>("youtube_channel");
  let displayName = $state("");
  let handleUrl = $state("");
  let isOwnedByMe = $state(initialIsOwnedByMe);
  let autoImport = $state(initialAutoImport);
  let submitting = $state(false);
  let formError = $state<string | null>(null);

  // When ownership flips to "tracking" (someone else's), default auto_import
  // to OFF — Phase 3's polling worker should not run against a blogger
  // channel until the user explicitly opts in.
  $effect(() => {
    if (!isOwnedByMe && autoImport === initialAutoImport) {
      autoImport = false;
    }
  });

  function labelFor(key: KindLabelKey): string {
    switch (key) {
      case "source_kind_label_youtube_channel":
        return m.source_kind_label_youtube_channel();
      case "source_kind_label_reddit_account":
        return m.source_kind_label_reddit_account();
      case "source_kind_label_twitter_account":
        return m.source_kind_label_twitter_account();
      case "source_kind_label_telegram_channel":
        return m.source_kind_label_telegram_channel();
      case "source_kind_label_discord_server":
        return m.source_kind_label_discord_server();
    }
  }

  function phaseFor(key: KindPhaseKey | null): string | null {
    if (!key) return null;
    switch (key) {
      case "source_kind_phase_reddit_account":
        return m.source_kind_phase_reddit_account();
      case "source_kind_phase_twitter_account":
        return m.source_kind_phase_twitter_account();
      case "source_kind_phase_telegram_channel":
        return m.source_kind_phase_telegram_channel();
      case "source_kind_phase_discord_server":
        return m.source_kind_phase_discord_server();
    }
  }

  function disabledTooltip(entry: KindEntry): string {
    const kindLabel = labelFor(entry.labelKey);
    const phase = phaseFor(entry.phaseKey) ?? "";
    return m.sources_kind_disabled_tooltip({ kind: kindLabel, phase });
  }

  async function submit(e: Event): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    if (handleUrl.trim().length === 0) return;
    if (!handleUrl.trim().startsWith("https://")) {
      formError = m.ingest_error_malformed_url();
      return;
    }
    submitting = true;
    formError = null;
    try {
      const res = await fetch("/api/sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: selectedKind,
          handleUrl: handleUrl.trim(),
          displayName: displayName.trim() || null,
          isOwnedByMe,
          autoImport,
        }),
      });
      if (res.status === 201 || res.status === 200) {
        await goto("/sources");
        return;
      }
      let body: { error?: string; metadata?: { kind?: string; available_phase?: string } } = {};
      try {
        body = (await res.json()) as typeof body;
      } catch {
        // ignore body parse failures
      }
      if (res.status === 422 && body.error === "kind_not_yet_functional") {
        const kindLabel = body.metadata?.kind ?? selectedKind;
        const phase = body.metadata?.available_phase ?? "";
        formError = m.sources_error_kind_not_yet_functional({ kind: kindLabel, phase });
        return;
      }
      if (res.status === 422 && body.error === "duplicate_source") {
        formError = m.sources_error_duplicate();
        return;
      }
      formError = m.error_server_generic();
    } catch {
      formError = m.error_network();
    } finally {
      submitting = false;
    }
  }
</script>

<section class="new-source">
  <nav class="breadcrumb" aria-label="Breadcrumb">
    <a href="/sources">Sources</a>
    <span class="sep" aria-hidden="true">/</span>
    <span aria-current="page">New</span>
  </nav>

  <h1>{m.sources_cta_new_source()}</h1>

  <form onsubmit={submit} class="form">
    <fieldset class="kinds">
      <legend>Kind</legend>
      <div class="kind-chips">
        {#each kindMatrix as entry (entry.value)}
          {#if entry.disabled}
            <button
              type="button"
              class="chip disabled"
              disabled
              aria-disabled="true"
              tabindex="-1"
              title={disabledTooltip(entry)}
            >
              {labelFor(entry.labelKey)}
              <small class="phase">{phaseFor(entry.phaseKey)}</small>
            </button>
          {:else}
            <button
              type="button"
              class="chip"
              class:active={selectedKind === entry.value}
              aria-pressed={selectedKind === entry.value}
              onclick={() => (selectedKind = entry.value)}
            >
              {labelFor(entry.labelKey)}
            </button>
          {/if}
        {/each}
      </div>
    </fieldset>

    <label class="field">
      <span class="label">Display name</span>
      <input
        class="input"
        type="text"
        bind:value={displayName}
        maxlength="120"
        placeholder="e.g. My YouTube channel"
      />
    </label>

    <label class="field">
      <span class="label">Handle URL *</span>
      <input
        class="input"
        type="url"
        bind:value={handleUrl}
        required
        placeholder="https://www.youtube.com/@handle"
      />
    </label>

    <label class="toggle">
      <input type="checkbox" bind:checked={isOwnedByMe} />
      <span>{m.sources_owned_by_me()} (this is my own channel/account)</span>
    </label>

    <label class="toggle">
      <input type="checkbox" bind:checked={autoImport} />
      <span>Auto-import (Phase 3 will start polling)</span>
    </label>

    {#if formError}
      <InlineError message={formError} />
    {/if}

    <div class="actions">
      <a class="cancel" href="/sources">{m.common_cancel()}</a>
      <button
        type="submit"
        class="submit"
        disabled={submitting || handleUrl.trim().length === 0}
      >
        {m.sources_cta_save_source()}
      </button>
    </div>
  </form>
</section>

<style>
  .new-source {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
    min-width: 0;
  }
  .breadcrumb {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
  }
  .breadcrumb a {
    color: var(--color-text-muted);
    text-decoration: none;
  }
  .breadcrumb a:hover {
    color: var(--color-text);
  }
  .sep {
    color: var(--color-text-muted);
  }
  h1 {
    margin: 0;
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-semibold);
  }
  .form {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
    padding: var(--space-md);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 4px;
  }
  .kinds {
    border: none;
    padding: 0;
    margin: 0;
  }
  .kinds legend {
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
    margin-bottom: var(--space-xs);
  }
  .kind-chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-xs);
  }
  .chip {
    display: inline-flex;
    flex-direction: column;
    align-items: flex-start;
    min-height: 44px;
    padding: var(--space-xs) var(--space-sm);
    background: var(--color-bg);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    cursor: pointer;
    font-size: var(--font-size-label);
  }
  .chip.active {
    background: var(--color-surface);
    border-color: var(--color-text);
    font-weight: var(--font-weight-semibold);
  }
  .chip.disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .phase {
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
  }
  .label {
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
  }
  .input {
    min-height: 44px;
    padding: 0 var(--space-md);
    background: var(--color-bg);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-size: var(--font-size-body);
  }
  .toggle {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    color: var(--color-text-muted);
    font-size: var(--font-size-label);
  }
  .actions {
    display: flex;
    gap: var(--space-sm);
    justify-content: flex-end;
    align-items: center;
    flex-wrap: wrap;
  }
  .cancel {
    min-height: 44px;
    padding: 0 var(--space-md);
    display: inline-flex;
    align-items: center;
    background: transparent;
    color: var(--color-text-muted);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    text-decoration: none;
  }
  .submit {
    min-height: 44px;
    padding: 0 var(--space-md);
    background: var(--color-accent);
    color: var(--color-accent-text);
    border: none;
    border-radius: 4px;
    font-weight: var(--font-weight-semibold);
    font-size: var(--font-size-body);
    cursor: pointer;
  }
  .submit:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
