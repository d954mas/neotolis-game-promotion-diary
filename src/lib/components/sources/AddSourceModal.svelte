<script lang="ts">
  // AddSourceModal — the /sources/new form, presented as a <dialog> from
  // /sources. The /sources/new route still exists as a fallback for
  // non-JS / direct-link entry, but the primary affordance from /sources
  // is this modal (user feedback 2026-05-23: «add source должно быть
  // модальным окном»).
  //
  // Implementation: the form body is a near-verbatim port of
  // src/routes/sources/new/+page.svelte's <form> (chip picker, URL input,
  // BackfillPicker, owner / auto-import toggles, description disclosure).
  // The dialog chrome (.add-source-dialog) mirrors .backfill-dialog and
  // .note-dialog already in SourceRow.svelte — keeps the dialog vocab
  // consistent across /sources entry points.
  //
  // Submit semantics: POST /api/sources with the same payload shape as
  // /sources/new. On 201 → onSuccess() fires (the parent does
  // invalidateAll()); on error → InlineError shows the user-facing toast
  // string. Cancel + Esc + backdrop click are all non-destructive (the
  // form draft is local component state and dies with the dialog mount).
  //
  // No DB work here — purely a thin UI shell that orchestrates the same
  // /api/sources endpoint /sources/new submits to. The kindMatrix +
  // redditOperatorConfigured props are sourced from the /sources loader
  // (see +page.server.ts; matches /sources/new exactly).

  import { untrack } from "svelte";
  import { invalidateAll } from "$app/navigation";
  import { m } from "$lib/paraglide/messages.js";
  import InlineError from "$lib/components/InlineError.svelte";
  import BackfillPicker from "$lib/components/BackfillPicker.svelte";
  import { inferSourceKindFromUrl } from "$lib/components/sources/infer-source-kind.js";

  // Mirror the synthetic UI kind picker from /sources/new — "reddit" is
  // resolved server-side to reddit_account / reddit_subreddit by URL
  // shape; the DB column never stores "reddit".
  type SourceKind =
    | "youtube_channel"
    | "reddit"
    | "instagram_account"
    | "twitter_account"
    | "telegram_channel"
    | "discord_server";

  type KindLabelKey =
    | "source_kind_label_youtube_channel"
    | "source_kind_label_twitter_account"
    | "source_kind_label_telegram_channel"
    | "source_kind_label_discord_server"
    | "source_kind_label_instagram_account"
    | "common_kind_reddit";

  type KindStatusKey =
    | "source_kind_status_reddit_account"
    | "source_kind_status_twitter_account"
    | "source_kind_status_telegram_channel"
    | "source_kind_status_discord_server"
    | "source_kind_status_instagram_account";

  // disabledReason distinguishes "adapter built, operator env unset"
  // (Reddit / Instagram unconfigured) from "not built yet" (Twitter /
  // Telegram / Discord) so the tooltip is accurate (issue #64). null when
  // the chip is enabled. Sourced from the /sources loader's kindMatrix.
  type DisabledReason = "not-configured" | "not-built";

  type KindEntry = {
    value: SourceKind;
    labelKey: KindLabelKey;
    statusKey: KindStatusKey | null;
    disabled: boolean;
    disabledReason: DisabledReason | null;
  };

  let {
    open,
    kindMatrix,
    redditOperatorConfigured = false,
    instagramConfigured = false,
    socialBackfillMaxPosts = 48,
    defaultIsOwnedByMe = true,
    defaultAutoImport = true,
    onClose,
    onSuccess,
  }: {
    open: boolean;
    kindMatrix: KindEntry[];
    redditOperatorConfigured?: boolean;
    instagramConfigured?: boolean;
    socialBackfillMaxPosts?: number;
    defaultIsOwnedByMe?: boolean;
    defaultAutoImport?: boolean;
    onClose: () => void;
    onSuccess?: () => void;
  } = $props();

  // Same untrack pattern as /sources/new — seed defaults once on mount.
  const initialIsOwnedByMe = untrack(() => defaultIsOwnedByMe);
  const initialAutoImport = untrack(() => defaultAutoImport);

  let selectedKind = $state<SourceKind>("youtube_channel");
  let description = $state("");
  let handleUrl = $state("");
  let isOwnedByMe = $state(initialIsOwnedByMe);
  let autoImport = $state(initialAutoImport);
  let submitting = $state(false);
  let formError = $state<string | null>(null);

  type BackfillWindow = "1d" | "7d" | "30d" | "90d" | "1y" | "everything";
  let backfillWindow = $state<BackfillWindow>("30d");
  let backfillCustomDate = $state<string | null>(null);
  const selectedKindEnabled = $derived(
    kindMatrix.find((k) => k.value === selectedKind)?.disabled !== true,
  );
  const showPicker = $derived(selectedKindEnabled && autoImport);

  // Picker collapse → reset value (same effect as /sources/new).
  $effect(() => {
    if (!showPicker && backfillWindow !== "30d") {
      backfillWindow = "30d";
    }
  });

  const showRedditHint = $derived.by(() => {
    if (selectedKind === "reddit") return true;
    return handleUrl.toLowerCase().includes("reddit");
  });

  // SOC-05: surface the env-var hint when Instagram is not configured and
  // the user is looking at it (selected the disabled chip OR typed an IG
  // URL). Mirror showRedditHint exactly. The disabled-chip + this hint is
  // the COMPLETE key-related UI — no operator-key form (CONTEXT D-03).
  const showInstagramHint = $derived.by(() => {
    if (instagramConfigured) return false;
    if (selectedKind === "instagram_account") return true;
    return handleUrl.toLowerCase().includes("instagram");
  });

  // "Paste a link → we figure out the kind." Same client-side heuristic +
  // auto-select behaviour as /sources/new (the shared helper keeps the
  // host table single-sourced). The server's parseSourceUrl iterator stays
  // the source of truth on submit.
  const inferredKind = $derived(inferSourceKindFromUrl(handleUrl));
  const inferredEntry = $derived(
    inferredKind ? (kindMatrix.find((k) => k.value === inferredKind) ?? null) : null,
  );

  // Auto-select the matched chip when ENABLED; never select a disabled
  // chip (those surface a hint instead). untrack(selectedKind) avoids a
  // self-dependency thrash loop.
  $effect(() => {
    const entry = inferredEntry;
    if (entry && !entry.disabled && untrack(() => selectedKind) !== entry.value) {
      selectedKind = entry.value;
    }
  });

  // Generic coming-soon / out-of-scope hint for a matched-but-disabled
  // kind that doesn't already own dedicated copy (Reddit / Instagram do).
  const showComingSoonHint = $derived.by(() => {
    const entry = inferredEntry;
    if (!entry || !entry.disabled) return false;
    if (entry.value === "reddit" || entry.value === "instagram_account") return false;
    return true;
  });
  const comingSoonHintText = $derived.by(() => {
    const entry = inferredEntry;
    if (!entry) return "";
    return m.sources_kind_disabled_tooltip({
      kind: labelFor(entry.labelKey),
      status: statusFor(entry.statusKey) ?? "",
    });
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
      case "source_kind_label_instagram_account":
        return m.source_kind_label_instagram_account();
      case "common_kind_reddit":
        return m.common_kind_reddit();
    }
  }

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
      case "source_kind_status_instagram_account":
        return m.source_kind_status_instagram_account();
    }
  }

  function disabledTooltip(entry: KindEntry): string {
    const kindLabel = labelFor(entry.labelKey);
    // not-configured: adapter IS built, operator hasn't set the env. The
    // generic "schema ready, adapter isn't" tail would mislead a self-host
    // operator (issue #64) — use the configuration-focused copy instead.
    if (entry.disabledReason === "not-configured") {
      return m.sources_kind_disabled_tooltip_not_configured({ kind: kindLabel });
    }
    const status = statusFor(entry.statusKey) ?? "";
    return m.sources_kind_disabled_tooltip({ kind: kindLabel, status });
  }

  function resetForm(): void {
    selectedKind = "youtube_channel";
    description = "";
    handleUrl = "";
    isOwnedByMe = initialIsOwnedByMe;
    autoImport = initialAutoImport;
    backfillWindow = "30d";
    backfillCustomDate = null;
    submitting = false;
    formError = null;
  }

  function handleClose(): void {
    if (submitting) return;
    resetForm();
    onClose();
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
          metadata: description.trim() ? { description: description.trim() } : undefined,
          isOwnedByMe,
          autoImport,
          ...(showPicker
            ? backfillCustomDate
              ? {
                  backfillTargetSince: new Date(
                    `${backfillCustomDate}T00:00:00.000Z`,
                  ).toISOString(),
                }
              : { backfillWindow }
            : {}),
        }),
      });
      if (res.status === 201 || res.status === 200) {
        resetForm();
        await invalidateAll();
        onSuccess?.();
        onClose();
        return;
      }
      let body: { error?: string; metadata?: { kind?: string; status?: string } } = {};
      try {
        body = (await res.json()) as typeof body;
      } catch {
        // ignore parse failures
      }
      if (res.status === 422 && body.error === "kind_not_yet_functional") {
        const kindLabel = body.metadata?.kind ?? selectedKind;
        const status = body.metadata?.status ?? "";
        formError = m.sources_error_kind_not_yet_functional({ kind: kindLabel, status });
        return;
      }
      // SOC-05: createSource gates instagram_account on the operator's
      // provider env and degrades to 422 kind_not_configured when unset.
      // The chip is already disabled in the UI, so this only fires on a
      // direct/bypass submit — surface the same env-var hint inline.
      if (res.status === 422 && body.error === "kind_not_configured") {
        formError = m.sources_new_instagram_disabled_hint();
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

{#if open}
  <dialog
    class="add-source-dialog"
    open
    oncancel={(e) => {
      e.preventDefault();
      handleClose();
    }}
    onclick={(e) => {
      if (e.target === e.currentTarget) handleClose();
    }}
  >
    <header class="add-source-dialog-head">
      <h2 class="add-source-dialog-title">{m.add_source_modal_title()}</h2>
      <button
        type="button"
        class="add-source-dialog-close"
        onclick={handleClose}
        aria-label={m.add_source_modal_close_aria()}
        disabled={submitting}>×</button
      >
    </header>

    <form onsubmit={submit} class="add-source-dialog-body">
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

      {#if showInstagramHint}
        <p class="hint">{m.sources_new_instagram_disabled_hint()}</p>
      {/if}

      {#if showComingSoonHint}
        <p class="hint">{comingSoonHintText}</p>
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
        <BackfillPicker
          bind:value={backfillWindow}
          bind:customDate={backfillCustomDate}
          kind={selectedKind}
          postCap={socialBackfillMaxPosts}
        />
      {/if}

      {#if formError}
        <InlineError message={formError} />
      {/if}

      <footer class="add-source-dialog-foot">
        <button type="button" class="btn ghost" onclick={handleClose} disabled={submitting}
          >{m.common_cancel()}</button
        >
        <button
          type="submit"
          class="btn primary"
          disabled={submitting || handleUrl.trim().length === 0}
        >
          {submitting ? "Saving…" : m.sources_cta_save_source()}
        </button>
      </footer>
    </form>
  </dialog>
{/if}

<style>
  /* Add-Source dialog. Same chrome vocabulary as .backfill-dialog and
   * .note-dialog already in SourceRow.svelte — fixed-position centred
   * shell, ::backdrop blur, head/body/foot rows. Wider than the smaller
   * dialogs because the form has more fields (kind chips + URL + backfill
   * picker + description disclosure). */
  .add-source-dialog {
    width: min(640px, calc(100vw - 32px));
    max-height: calc(100vh - 32px);
    padding: 0;
    margin: auto;
    border: 1px solid var(--border-2);
    border-radius: var(--r-lg);
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--shadow-elev);
    display: flex;
    flex-direction: column;
    position: fixed;
    inset: 0;
    z-index: 1000;
    overflow: hidden;
  }
  .add-source-dialog::backdrop {
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(2px);
  }
  .add-source-dialog-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border-hairline);
    flex-shrink: 0;
  }
  .add-source-dialog-title {
    flex: 1;
    margin: 0;
    font-size: var(--t-15);
    font-weight: var(--w-sb);
  }
  .add-source-dialog-close {
    width: 30px;
    height: 30px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--r-sm);
    color: var(--text-3);
    font-size: 22px;
    line-height: 1;
    cursor: pointer;
  }
  .add-source-dialog-close:hover:not(:disabled) {
    background: var(--surface-2);
    color: var(--text);
  }
  .add-source-dialog-close:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* The body IS the form — flex column with overflow-y inside so the
   * footer stays anchored at the bottom of the dialog. */
  .add-source-dialog-body {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
    padding: var(--s-4);
    overflow-y: auto;
    min-height: 0;
  }

  /* ----- Field controls. Ported from /sources/new/+page.svelte. -----
   * Kept structurally identical so behaviour matches the fallback route
   * exactly. */
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
  .toggle input[type="checkbox"] {
    accent-color: var(--accent);
    width: 18px;
    height: 18px;
    cursor: pointer;
  }
  .picker-separator {
    border: 0;
    border-top: 1px solid var(--border-hairline);
    margin: 0;
  }

  /* Footer — same vocab as .backfill-dialog-foot / .note-dialog-foot. */
  .add-source-dialog-foot {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--border-hairline);
    margin: 0 calc(-1 * var(--s-4)) calc(-1 * var(--s-4));
    background: var(--surface);
    position: sticky;
    bottom: calc(-1 * var(--s-4));
  }
  .add-source-dialog-foot .btn {
    display: inline-flex;
    align-items: center;
    min-height: var(--hit);
    padding: 0 var(--s-3);
    border-radius: var(--r-sm);
    font-size: var(--t-13);
    font-weight: var(--w-md);
    cursor: pointer;
    transition:
      background var(--m-fast),
      border-color var(--m-fast);
  }
  .add-source-dialog-foot .btn.ghost {
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text);
  }
  .add-source-dialog-foot .btn.ghost:hover:not(:disabled) {
    background: var(--surface-3);
    border-color: var(--border-2);
  }
  .add-source-dialog-foot .btn.primary {
    background: var(--accent);
    border: 1px solid var(--accent);
    color: var(--accent-text);
    font-weight: var(--w-sb);
  }
  .add-source-dialog-foot .btn.primary:hover:not(:disabled) {
    background: var(--accent-strong);
    border-color: var(--accent-strong);
  }
  .add-source-dialog-foot .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  @media (prefers-reduced-motion: reduce) {
    .chip {
      transition: none;
    }
  }
</style>
