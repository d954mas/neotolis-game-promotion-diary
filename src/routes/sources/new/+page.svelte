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

  // `"reddit"` is a synthetic, UI-only kind. The /sources/new chip picker
  // exposes a single "Reddit" entry; on submit, POST /api/sources receives
  // `kind: "reddit"` and the route handler dispatches to
  // redditAdapter.parseSourceUrl to resolve the real DB kind
  // (reddit_account vs reddit_subreddit) from the URL shape. The DB
  // column never stores "reddit".
  type SourceKind =
    | "youtube_channel"
    | "reddit"
    | "twitter_account"
    | "telegram_channel"
    | "discord_server";

  type KindLabelKey =
    | "source_kind_label_youtube_channel"
    | "source_kind_label_twitter_account"
    | "source_kind_label_telegram_channel"
    | "source_kind_label_discord_server"
    | "common_kind_reddit";

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

  // Initial-backfill window. Defaults to '30d'. Safety feature — without
  // a hard cap, registering an active source with auto-import ON could
  // pull "everything" into the user's feed accidentally.
  //
  // The picker is rendered for ANY enabled, ingestable kind (driven by
  // kindMatrix; disabled kinds without an adapter aren't pickable).
  // Toggling auto_import off OR switching to a disabled kind collapses
  // the picker and resets the value to '30d' so the form-state stays
  // clean if the user toggles back on.
  type BackfillWindow = "1d" | "7d" | "30d" | "90d" | "1y" | "everything";
  let backfillWindow = $state<BackfillWindow>("30d");
  let backfillCustomDate = $state<string | null>(null);
  const selectedKindEnabled = $derived(
    kindMatrix.find((k) => k.value === selectedKind)?.disabled !== true,
  );
  const showPicker = $derived(selectedKindEnabled && autoImport);

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
    if (selectedKind === "reddit") return true;
    return handleUrl.toLowerCase().includes("reddit");
  });

  function labelFor(key: KindLabelKey): string {
    switch (key) {
      case "source_kind_label_youtube_channel":
        return m.source_kind_label_youtube_channel();
      case "source_kind_label_twitter_account":
        return m.source_kind_label_twitter_account();
      case "source_kind_label_telegram_channel":
        return m.source_kind_label_telegram_channel();
      case "source_kind_label_discord_server":
        return m.source_kind_label_discord_server();
      case "common_kind_reddit":
        return m.common_kind_reddit();
    }
  }

  // Reddit chip carries both 🧑 and 🏛 so the user understands that the
  // single chip handles both subreddits and user profiles — the backend
  // resolves which by URL shape on submit. aria-hidden because the text
  // label already carries the meaning.
  function chipPrefixFor(value: SourceKind): string {
    if (value === "reddit") return "🧑🏛";
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
          // otherwise the server applies its default ('30d'). Custom date
          // overrides the preset; both consumers pass it through as an
          // absolute ISO timestamp via backfillTargetSince.
          ...(showPicker
            ? backfillCustomDate
              ? { backfillTargetSince: new Date(`${backfillCustomDate}T00:00:00.000Z`).toISOString() }
              : { backfillWindow }
            : {}),
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
      if (res.status === 422 && body.error === "invalid_reddit_url") {
        formError = m.sources_error_not_a_reddit_url();
        return;
      }
      if (res.status === 422 && body.error === "validation_failed") {
        // Generic 422 — most commonly "URL doesn't parse as a YouTube
        // channel / handle / video URL" from createSource. For Reddit
        // we surface `invalid_reddit_url` (above) before falling through.
        formError =
          selectedKind === "reddit"
            ? m.sources_error_not_a_reddit_url()
            : m.sources_error_not_a_youtube_url();
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
      <p class="hint hint-warning">⚠ {m.sources_new_reddit_listing_limit()}</p>
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
      <BackfillPicker bind:value={backfillWindow} bind:customDate={backfillCustomDate} />
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
  /* Bound the form to a comfortable reading width so the kind chip row +
   * URL input do not sprawl across a 1280px viewport. Matches the
   * /sources/[id] detail page (`.source-detail` is also 720px) and the
   * AddEventModal panel chrome — keeps form pages consistent across the
   * app. */
  .new-source {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
    max-width: 720px;
    min-width: 0;
  }
  .breadcrumb {
    display: flex;
    align-items: center;
    gap: var(--s-1);
    font-size: var(--t-13);
    color: var(--text-3);
  }
  .breadcrumb a {
    color: var(--text-3);
    text-decoration: none;
  }
  .breadcrumb a:hover {
    color: var(--text);
  }
  .sep {
    color: var(--text-3);
  }
  h1 {
    margin: 0;
    font-family: var(--f-sans);
    font-size: var(--t-22);
    font-weight: var(--w-sb);
    line-height: var(--lh-tight);
    letter-spacing: -0.01em;
    color: var(--text);
  }
  .form {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
    padding: var(--s-4);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
  }
  .kinds {
    border: none;
    padding: 0;
    margin: 0;
  }
  .kinds legend {
    font-size: var(--t-13);
    color: var(--text-2);
    margin-bottom: var(--s-1);
  }
  .kind-chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-1);
  }
  .chip {
    display: inline-flex;
    flex-direction: column;
    align-items: flex-start;
    min-height: var(--hit);
    padding: var(--s-1) var(--s-2);
    background: var(--surface-3);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    cursor: pointer;
    font-family: var(--f-sans);
    font-size: var(--t-13);
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .chip:hover:not(:disabled) {
    background: var(--accent-soft);
    border-color: var(--accent-strong);
  }
  .chip.active {
    background: var(--accent-soft);
    color: var(--accent);
    border-color: var(--accent-strong);
    font-weight: var(--w-sb);
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
    font-size: var(--t-12);
    color: var(--text-3);
  }
  /* Reddit-specific hint under the URL input — neutral by default,
   * warning-coloured when REDDIT_USER_AGENT is empty (D-RDT-AUTH-EMPTY).
   * Sits between the URL input and the owner/auto-import toggles. */
  .hint {
    margin: 0;
    color: var(--text-3);
    font-size: var(--t-13);
    line-height: var(--lh-body);
  }
  .hint.hint-warning {
    color: var(--warn);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
  }
  .label {
    font-size: var(--t-13);
    color: var(--text-2);
  }
  /* Input mirrors prototype `.field-input` (40px height, surface-2 bg,
   * border with focus ring) — keeps form inputs consistent with the
   * AddEventModal / EventDetailModal modal patterns. */
  .input {
    min-height: var(--hit-lg);
    padding: 0 var(--s-3);
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    font-family: var(--f-sans);
    font-size: var(--t-14);
    transition: border-color var(--m-fast) var(--m-ease);
  }
  .input::placeholder {
    color: var(--text-3);
  }
  .input:focus-visible {
    outline: none;
    border-color: var(--accent);
    box-shadow: var(--focus-ring);
  }
  textarea.input {
    min-height: 80px;
    padding: var(--s-2) var(--s-3);
    line-height: var(--lh-body);
    resize: vertical;
  }
  .toggle {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    color: var(--text);
    font-size: var(--t-14);
    cursor: pointer;
  }
  /* Accent the native checkbox so it reads as the design-system color
   * instead of the browser default blue. Same `accent-color` is applied
   * globally via app.css for app-wide consistency, but the per-page rule
   * is the resilient fallback for browsers without the inherited rule. */
  .toggle input[type="checkbox"] {
    accent-color: var(--accent);
    width: 18px;
    height: 18px;
    cursor: pointer;
  }
  /* Horizontal rule between the kind/owner/auto-import fields and the
     conditional BackfillPicker. Collapses with the picker — no orphan
     separator. */
  .picker-separator {
    border: 0;
    border-top: 1px solid var(--border-hairline);
    margin: 0;
  }
  .actions {
    display: flex;
    gap: var(--s-2);
    justify-content: flex-end;
    align-items: center;
    flex-wrap: wrap;
  }
  .cancel {
    min-height: var(--hit);
    padding: 0 var(--s-4);
    display: inline-flex;
    align-items: center;
    background: transparent;
    color: var(--text-2);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    text-decoration: none;
    font-family: var(--f-sans);
    font-size: var(--t-14);
    transition: background var(--m-fast) var(--m-ease);
  }
  .cancel:hover {
    background: var(--accent-soft);
  }
  .submit {
    min-height: var(--hit-lg);
    padding: 0 var(--s-4);
    background: var(--accent);
    color: var(--accent-text);
    border: 1px solid var(--accent);
    border-radius: var(--r-sm);
    font-family: var(--f-sans);
    font-weight: var(--w-sb);
    font-size: var(--t-14);
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
    opacity: 0.5;
    cursor: not-allowed;
  }
  @media (prefers-reduced-motion: reduce) {
    .chip,
    .cancel,
    .submit {
      transition: none;
    }
  }
</style>
