<script lang="ts">
  // /sources/new — full-page form for registering a data_source. NOT an
  // inline dialog: the 5-chip kind picker (4 disabled with availability
  // tooltips) earns its own page surface.
  //
  // Submit flow:
  //   - POST /api/sources with {kind, handleUrl, displayName?, isOwnedByMe,
  //     autoImport}.
  //   - 201 Created → goto("/sources").
  //   - 422 kind_not_yet_functional → InlineError with
  //     m.sources_error_kind_not_yet_functional({kind, status}) sourced from
  //     the response metadata (the service throws AppError with
  //     metadata.kind + metadata.status).
  //   - 422 duplicate_source → InlineError with m.sources_error_duplicate().
  //   - other failures → InlineError with the response body.error or a
  //     generic copy.
  //
  // Cancel returns to /sources via m.common_cancel() — non-destructive close
  // (the typed input is not at risk because navigating back to /sources is
  // the equivalent).

  import { untrack } from "svelte";
  import { goto } from "$app/navigation";
  import { m } from "$lib/paraglide/messages.js";
  import InlineError from "$lib/components/InlineError.svelte";
  import BackfillPicker from "$lib/components/BackfillPicker.svelte";
  import type { PageData } from "./$types";

  type SourceKind =
    | "youtube_channel"
    | "reddit_account"
    | "reddit_subreddit"
    | "twitter_account"
    | "telegram_channel"
    | "discord_server";

  type KindLabelKey =
    | "source_kind_label_youtube_channel"
    | "source_kind_label_reddit_account"
    | "source_kind_label_twitter_account"
    | "source_kind_label_telegram_channel"
    | "source_kind_label_discord_server"
    // Reddit kinds paint with distinct labels per D-RDT-SOURCE-DISPLAY
    // (Phase 03.1 plan 08): reddit_account → "Reddit user" (🧑 prefix
    // rendered in the chip body); reddit_subreddit → "Subreddit" (🏛
    // prefix). The labels live under `common_kind_*` keys so other
    // surfaces (audit log filters, future per-kind chips) can reuse.
    | "common_kind_reddit_user"
    | "common_kind_reddit_subreddit";

  type KindStatusKey =
    | "source_kind_status_reddit_account"
    | "source_kind_status_twitter_account"
    | "source_kind_status_telegram_channel"
    | "source_kind_status_discord_server";

  type KindEntry = {
    value: SourceKind;
    labelKey: KindLabelKey;
    statusKey: KindStatusKey | null;
    disabled: boolean;
  };

  let { data }: { data: PageData } = $props();
  const kindMatrix = $derived(data.kindMatrix as KindEntry[]);
  const redditOperatorConfigured = $derived(data.redditOperatorConfigured ?? false);

  // Form defaults are seeded from the loader on the initial render. The
  // form is one-shot, so reading `data.default*` once at init is
  // intentional — there is no parent re-mount path that would change the
  // defaults mid-form. `untrack` decouples the read from the reactive graph
  // so Svelte 5's state_referenced_locally warning recognises the intent.
  const initialIsOwnedByMe = untrack(() => data.defaultIsOwnedByMe);
  const initialAutoImport = untrack(() => data.defaultAutoImport);

  let selectedKind = $state<SourceKind>("youtube_channel");
  // displayName is intentionally not in this onboarding form. Source name
  // comes from the platform (YouTube channel title, Reddit account name,
  // etc.) — that's more identifiable than a user-typed label. Custom rename
  // lives on /sources/[id] detail page. Description (free-form note)
  // replaces it — optional drop-down for additional context the user wants
  // to remember about this source.
  let description = $state("");
  let handleUrl = $state("");
  let isOwnedByMe = $state(initialIsOwnedByMe);
  let autoImport = $state(initialAutoImport);
  let submitting = $state(false);
  let formError = $state<string | null>(null);

  // Initial-backfill window for YouTube channels. Defaults to '30d'. The
  // picker is conditionally rendered ONLY when the chosen kind is
  // 'youtube_channel' AND auto-import is ON; toggling either off collapses
  // the picker AND resets the value to '30d'. The reset is what the server
  // expects (createSource defaults undefined → '30d' but resetting here
  // keeps the form-state clean if the user toggles back on).
  type BackfillWindow = "1d" | "7d" | "30d" | "90d" | "1y" | "everything";
  let backfillWindow = $state<BackfillWindow>("30d");
  const showPicker = $derived(selectedKind === "youtube_channel" && autoImport);

  // No auto-link between is_owned_by_me and auto_import — auto-import is
  // available for any channel, not just owned ones. Both checkboxes are
  // fully independent. An earlier "soft-default reset" effect had a
  // self-resetting bug (autoImport === initialAutoImport could become true
  // again after user re-checked, causing the effect to re-fire and uncheck
  // it).

  // Picker collapse → reset value. Toggling auto_import off OR switching
  // kind collapses the picker AND resets its value to '30d'.
  $effect(() => {
    if (!showPicker && backfillWindow !== "30d") {
      backfillWindow = "30d";
    }
  });

  // Reddit-specific hint visibility (Phase 03.1 plan 08). Shown when EITHER
  // the user has picked a reddit_* chip OR the typed URL contains "reddit"
  // (substring, case-insensitive). The latter catches the paste-flow case
  // where the user pastes reddit.com/r/X before clicking any chip — the
  // form-action's parseSourceUrl iterator will auto-detect the kind on
  // submit; the hint signals "we recognize this and will do the right thing".
  const showRedditHint = $derived.by(() => {
    if (selectedKind === "reddit_account" || selectedKind === "reddit_subreddit") return true;
    return handleUrl.toLowerCase().includes("reddit");
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
      case "common_kind_reddit_user":
        return m.common_kind_reddit_user();
      case "common_kind_reddit_subreddit":
        return m.common_kind_reddit_subreddit();
    }
  }

  // Per D-RDT-SOURCE-DISPLAY (Phase 03.1 plan 08): Reddit chips show a
  // small emoji prefix so reddit_account vs reddit_subreddit read at a
  // glance. Other kinds return "" (no prefix). aria-hidden on the emoji
  // span keeps screen readers from announcing the picto twice (the
  // chip's text label already carries the meaning).
  function chipPrefixFor(value: SourceKind): string {
    if (value === "reddit_account") return "🧑";
    if (value === "reddit_subreddit") return "🏛";
    return "";
  }

  function statusFor(key: KindStatusKey | null): string | null {
    if (!key) return null;
    switch (key) {
      case "source_kind_status_reddit_account":
        return m.source_kind_status_reddit_account();
      case "source_kind_status_twitter_account":
        return m.source_kind_status_twitter_account();
      case "source_kind_status_telegram_channel":
        return m.source_kind_status_telegram_channel();
      case "source_kind_status_discord_server":
        return m.source_kind_status_discord_server();
    }
  }

  function disabledTooltip(entry: KindEntry): string {
    const kindLabel = labelFor(entry.labelKey);
    const status = statusFor(entry.statusKey) ?? "";
    return m.sources_kind_disabled_tooltip({ kind: kindLabel, status });
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
          // Description stored in metadata.description (no schema change
          // — jsonb column accepts arbitrary keys).
          metadata: description.trim() ? { description: description.trim() } : undefined,
          isOwnedByMe,
          autoImport,
          // Only include the field when the picker would have been visible —
          // otherwise the server applies its default ('30d'). The chosen
          // value is included when kind=youtube_channel AND auto_import=true.
          ...(showPicker ? { backfillWindow } : {}),
        }),
      });
      if (res.status === 201 || res.status === 200) {
        await goto("/sources");
        return;
      }
      let body: { error?: string; metadata?: { kind?: string; status?: string } } = {};
      try {
        body = (await res.json()) as typeof body;
      } catch {
        // ignore body parse failures
      }
      if (res.status === 422 && body.error === "kind_not_yet_functional") {
        const kindLabel = body.metadata?.kind ?? selectedKind;
        const status = body.metadata?.status ?? "";
        formError = m.sources_error_kind_not_yet_functional({ kind: kindLabel, status });
        return;
      }
      if (
        (res.status === 422 || res.status === 409) &&
        (body.error === "duplicate_source" || body.error === "duplicate_source_soft_deleted")
      ) {
        const md = body.metadata as
          | {
              channel_title?: string | null;
              display_name?: string | null;
              handle_url?: string | null;
            }
          | undefined;
        const channelName =
          md?.channel_title ?? md?.display_name ?? md?.handle_url ?? "this channel";
        formError =
          body.error === "duplicate_source_soft_deleted"
            ? m.sources_error_duplicate_channel_soft_deleted({ channelName })
            : m.sources_error_duplicate_channel({ channelName });
        return;
      }
      if (res.status === 404 && body.error === "not_found") {
        formError = m.sources_error_video_not_found();
        return;
      }
      if (res.status === 502 && body.error === "upstream_error") {
        formError = m.sources_error_youtube_unreachable();
        return;
      }
      if (res.status === 503 && body.error === "service_unavailable") {
        formError = m.sources_error_no_youtube_keys();
        return;
      }
      if (res.status === 422 && body.error === "validation_failed") {
        // Generic 422 — most commonly "URL doesn't parse as a YouTube
        // channel / handle / video URL" from createSource.
        formError = m.sources_error_not_a_youtube_url();
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
          {@const prefix = chipPrefixFor(entry.value)}
          {#if entry.disabled}
            <button
              type="button"
              class="chip disabled"
              disabled
              aria-disabled="true"
              tabindex="-1"
              title={disabledTooltip(entry)}
            >
              {#if prefix}<span aria-hidden="true" class="chip-prefix">{prefix}</span>{/if}
              {labelFor(entry.labelKey)}
              <small class="status">{statusFor(entry.statusKey)}</small>
            </button>
          {:else}
            <button
              type="button"
              class="chip"
              class:active={selectedKind === entry.value}
              aria-pressed={selectedKind === entry.value}
              onclick={() => (selectedKind = entry.value)}
            >
              {#if prefix}<span aria-hidden="true" class="chip-prefix">{prefix}</span>{/if}
              {labelFor(entry.labelKey)}
            </button>
          {/if}
        {/each}
      </div>
    </fieldset>

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

    {#if showRedditHint}
      <p class="hint">{m.sources_new_reddit_input_hint()}</p>
      {#if !redditOperatorConfigured}
        <p class="hint hint-warning">{m.sources_new_reddit_disabled()}</p>
      {/if}
    {/if}

    <label class="toggle">
      <input type="checkbox" bind:checked={isOwnedByMe} />
      <span>{m.sources_owned_by_me()} (this is my own channel/account)</span>
    </label>

    <label class="toggle">
      <input type="checkbox" bind:checked={autoImport} />
      <span>Auto-import (poll every 6 hours)</span>
    </label>

    <details class="description-details">
      <summary>Add description (optional)</summary>
      <label class="field">
        <textarea
          class="input"
          rows="3"
          bind:value={description}
          maxlength="500"
          placeholder="Why are you tracking this? E.g. 'Indie horror channel I'm collaborating with'"
        ></textarea>
      </label>
    </details>

    {#if showPicker}
      <hr class="picker-separator" />
      <BackfillPicker bind:value={backfillWindow} />
    {/if}

    {#if formError}
      <InlineError message={formError} />
    {/if}

    <div class="actions">
      <a class="cancel" href="/sources">{m.common_cancel()}</a>
      <button type="submit" class="submit" disabled={submitting || handleUrl.trim().length === 0}>
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
  .chip-prefix {
    font-size: 1em;
    line-height: 1;
    margin-right: 4px;
  }
  .status {
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
  }
  /* Reddit-specific hint under the URL input — neutral by default,
   * warning-coloured when REDDIT_USER_AGENT is empty (D-RDT-AUTH-EMPTY).
   * Sits between the URL input and the owner/auto-import toggles. */
  .hint {
    margin: 0;
    color: var(--color-text-muted);
    font-size: var(--font-size-label);
    line-height: var(--line-height-body);
  }
  .hint.hint-warning {
    color: var(--color-warning, #d90);
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
  .toggle.disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  /* Horizontal rule between the kind/owner/auto-import fields and the
     conditional BackfillPicker. Collapses with the picker — no orphan
     separator. */
  .picker-separator {
    border: 0;
    border-top: 1px solid var(--color-border);
    margin: 0;
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
