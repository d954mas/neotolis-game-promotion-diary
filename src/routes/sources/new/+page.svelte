<script lang="ts">
  // /sources/new — full-page, non-JS fallback for the AddSourceModal. The
  // primary affordance is the modal launched from /sources; this page exists
  // for direct-link / no-JS entry and is kept in the SAME URL-first
  // interaction model as the modal (F2 — the two Add-Source surfaces must not
  // diverge). Both consume the SAME derived kindMatrix (buildKindMatrix), and
  // both treat the chips as an INFORMATIONAL legend, not a selector: the
  // pasted URL decides the kind (user 2026-06-09: «тип понятен из URL, кнопки
  // выбора не нужны»).
  //
  // Submit flow (mirrors AddSourceModal):
  //   - POST /api/sources with {kind, handleUrl, isOwnedByMe, autoImport, …}.
  //     `kind` is the URL-derived synthetic UI kind ("reddit" / "youtube_channel"
  //     / "telegram_channel" / "instagram_account"); the server resolves the
  //     real DB kind. The DB column never stores "reddit".
  //   - 201 → goto("/sources").
  //   - typed errors map to the same InlineError copy as the modal.
  //
  // Cancel returns to /sources — non-destructive (navigating away is the
  // equivalent of dropping the local form draft).

  import { untrack } from "svelte";
  import { goto } from "$app/navigation";
  import { m } from "$lib/paraglide/messages.js";
  import InlineError from "$lib/components/InlineError.svelte";
  import BackfillPicker from "$lib/components/BackfillPicker.svelte";
  import {
    inferSourceKindFromUrl,
    normalizeHandleUrl,
  } from "$lib/components/sources/infer-source-kind.js";
  import type {
    AddSourceUiKind,
    KindLabelKey,
    KindStatusKey,
    KindMatrixEntry,
  } from "$lib/sources/kind-matrix.js";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
  const kindMatrix = $derived(data.kindMatrix as KindMatrixEntry[]);

  // One-shot form: seed defaults once at init (no re-mount path changes them
  // mid-form). untrack decouples the read from the reactive graph so Svelte 5's
  // state_referenced_locally warning recognises the intent.
  let description = $state("");
  let handleUrl = $state("");
  let isOwnedByMe = $state(untrack(() => data.defaultIsOwnedByMe));
  let autoImport = $state(untrack(() => data.defaultAutoImport));
  let submitting = $state(false);
  let formError = $state<string | null>(null);

  type BackfillWindow = "1d" | "7d" | "30d" | "90d" | "1y" | "everything";
  let backfillWindow = $state<BackfillWindow>("30d");
  let backfillCustomDate = $state<string | null>(null);

  // URL-first: the pasted link decides the kind. The chips below are an
  // informational legend, NOT selectors. Client infer is a preview; the
  // server's parseSourceUrl iterator stays the source of truth on submit.
  const inferredKind = $derived(inferSourceKindFromUrl(handleUrl));
  const inferredEntry = $derived(
    inferredKind ? (kindMatrix.find((k) => k.value === inferredKind) ?? null) : null,
  );

  // Legend = every kind EXCEPT "not-built" ones (Twitter / Discord hidden).
  // "not-configured" kinds (Reddit / Instagram without operator keys) stay
  // visible but greyed.
  const visibleKinds = $derived(kindMatrix.filter((k) => k.disabledReason !== "not-built"));

  // The kind we POST — purely URL-derived. null when the link is empty,
  // unrecognized, or resolves to a kind that isn't usable right now.
  const submitKind = $derived<AddSourceUiKind | null>(
    inferredEntry && !inferredEntry.disabled ? inferredEntry.value : null,
  );
  const hasUrl = $derived(handleUrl.trim().length > 0);

  // Detection feedback shown under the input (same states as the modal).
  type DetectState =
    | { state: "idle" }
    | { state: "ok"; label: string }
    | { state: "needs-config"; entry: KindMatrixEntry }
    | { state: "not-built"; label: string }
    | { state: "unknown" };
  const detect = $derived.by((): DetectState => {
    if (!hasUrl) return { state: "idle" };
    if (!inferredEntry) return { state: "unknown" };
    if (!inferredEntry.disabled) return { state: "ok", label: labelFor(inferredEntry.labelKey) };
    if (inferredEntry.disabledReason === "not-configured")
      return { state: "needs-config", entry: inferredEntry };
    return { state: "not-built", label: labelFor(inferredEntry.labelKey) };
  });

  // Reddit's listing-limit caveat is useful whenever a Reddit link is detected.
  const showRedditCaveat = $derived(inferredKind === "reddit");

  const showPicker = $derived(submitKind !== null && autoImport);
  const pickerKind: AddSourceUiKind = $derived(submitKind ?? "youtube_channel");
  // Kind-appropriate post-cap ceiling for the picker honesty note: Telegram
  // caps deeper (free t.me/s scrape) than IG. Read from the loader, not hardcoded.
  const pickerPostCap = $derived(
    pickerKind === "telegram_channel" ? data.telegramBackfillMaxPosts : data.socialBackfillMaxPosts,
  );

  // Picker collapse → reset value (same effect as the modal).
  $effect(() => {
    if (!showPicker && backfillWindow !== "30d") {
      backfillWindow = "30d";
    }
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
      case "source_kind_label_tiktok_account":
        return m.source_kind_label_tiktok_account();
      case "common_kind_reddit":
        return m.common_kind_reddit();
    }
  }

  // Reddit chip carries both 🧑 and 🏛 so the user understands that the
  // single chip handles both subreddits and user profiles — the backend
  // resolves which by URL shape on submit. aria-hidden because the text
  // label already carries the meaning.
  function chipPrefixFor(value: AddSourceUiKind): string {
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
      case "source_kind_status_tiktok_account":
        return m.source_kind_status_tiktok_account();
    }
  }

  function disabledTooltip(entry: KindMatrixEntry): string {
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

  async function submit(e: Event): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    if (handleUrl.trim().length === 0) return;
    if (submitKind === null) {
      formError = m.add_source_link_unrecognized();
      return;
    }
    // URL-first: accept scheme-less host/paths ("t.me/durov") and raw handles —
    // normalize to an absolute URL the server's parseSourceUrl can read. The
    // detector already matched a kind above, so this is a recognized link.
    const normalizedUrl = normalizeHandleUrl(handleUrl);
    submitting = true;
    formError = null;
    try {
      const res = await fetch("/api/sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: submitKind,
          handleUrl: normalizedUrl,
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
        await goto("/sources");
        return;
      }
      let body: { error?: string; metadata?: { kind?: string; status?: string; handle?: string } } =
        {};
      try {
        body = (await res.json()) as typeof body;
      } catch {
        // ignore body parse failures
      }
      // Adapter resolved the handle against the live platform and it doesn't
      // exist / isn't public — surface the handle, not the generic copy.
      if (
        res.status === 422 &&
        (body.error === "tiktok_handle_unresolvable" ||
          body.error === "instagram_handle_unresolvable")
      ) {
        formError = m.sources_error_handle_unresolvable({ handle: body.metadata?.handle ?? "" });
        return;
      }
      if (res.status === 422 && body.error === "kind_not_yet_functional") {
        const kindLabel = body.metadata?.kind ?? submitKind ?? "";
        const status = body.metadata?.status ?? "";
        formError = m.sources_error_kind_not_yet_functional({ kind: kindLabel, status });
        return;
      }
      // SOC-05: instagram_account gated on operator provider env → 422
      // kind_not_configured (the chip is disabled; this is the bypass path).
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
        // Generic 422 — most commonly "URL doesn't parse as a YouTube
        // channel / handle / video URL" from createSource. For Reddit
        // we surface `invalid_reddit_url` (above) before falling through.
        formError =
          inferredKind === "reddit"
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
    <p class="url-first-hint">{m.add_source_url_first_hint()}</p>

    <label class="field">
      <span class="label">Handle URL *</span>
      <!-- type="text" (not "url"): the field accepts scheme-less host/paths and
           raw @handles per the placeholder; type="url" would natively reject
           "t.me/durov" before submit (the normalize step adds the scheme). -->
      <input
        class="input"
        type="text"
        inputmode="url"
        bind:value={handleUrl}
        required
        placeholder="https://t.me/channel · youtube.com/@handle · reddit.com/r/sub"
      />
    </label>

    {#if detect.state === "ok"}
      <p class="detect-ok">✓ {m.add_source_detected({ kind: detect.label })}</p>
    {:else if detect.state === "needs-config"}
      {#if detect.entry.value === "instagram_account"}
        <p class="hint">{m.sources_new_instagram_disabled_hint()}</p>
      {:else if detect.entry.value === "reddit"}
        <p class="hint">{m.sources_new_reddit_disabled()}</p>
      {:else}
        <p class="hint">{disabledTooltip(detect.entry)}</p>
      {/if}
    {:else if detect.state === "not-built"}
      <p class="hint">{m.add_source_not_supported_yet({ kind: detect.label })}</p>
    {:else if detect.state === "unknown"}
      <p class="hint">{m.add_source_link_unrecognized()}</p>
    {/if}

    {#if showRedditCaveat}
      <p class="hint">{m.sources_new_reddit_input_hint()}</p>
      <p class="hint hint-warning">⚠ {m.sources_new_reddit_listing_limit()}</p>
    {/if}

    <div class="legend">
      <span class="legend-label">{m.add_source_supported_legend()}</span>
      <ul class="kind-legend">
        {#each visibleKinds as entry (entry.value)}
          {@const prefix = chipPrefixFor(entry.value)}
          {@const isMatch = inferredKind === entry.value}
          <li
            class="chip"
            class:active={isMatch && !entry.disabled}
            class:muted={entry.disabled}
            class:matched={isMatch}
            title={entry.disabled ? disabledTooltip(entry) : undefined}
          >
            {#if prefix}<span aria-hidden="true" class="chip-prefix">{prefix}</span>{/if}
            <span class="chip-label">{labelFor(entry.labelKey)}</span>
            {#if entry.disabled}<small class="status">{statusFor(entry.statusKey)}</small>{/if}
          </li>
        {/each}
      </ul>
    </div>

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
        kind={pickerKind}
        postCap={pickerPostCap}
      />
    {/if}

    {#if formError}
      <InlineError message={formError} />
    {/if}

    <div class="actions">
      <a class="cancel" href="/sources">{m.common_cancel()}</a>
      <button type="submit" class="submit" disabled={submitting || submitKind === null}>
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
  /* URL-first model (mirrors AddSourceModal). The pasted link decides the
     kind; the chips below are an INFORMATIONAL legend, not selectors — no
     pointer / hover affordance, no per-chip click handler. */
  .url-first-hint {
    margin: 0;
    color: var(--text-2);
    font-size: var(--t-13);
    line-height: var(--lh-body);
  }
  .detect-ok {
    margin: 0;
    color: var(--accent);
    font-size: var(--t-13);
    font-weight: var(--w-md);
  }
  .legend {
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
  }
  .legend-label {
    font-size: var(--t-13);
    color: var(--text-2);
  }
  .kind-legend {
    list-style: none;
    margin: 0;
    padding: 0;
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
    font-family: var(--f-sans);
    font-size: var(--t-13);
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  /* The matched-from-URL kind, when usable. */
  .chip.active {
    background: var(--accent-soft);
    color: var(--accent);
    border-color: var(--accent-strong);
    font-weight: var(--w-sb);
  }
  /* not-configured kinds (Reddit / Instagram without operator keys): visible
     but greyed, so the user sees they exist but need setup. */
  .chip.muted {
    opacity: 0.55;
  }
  /* a greyed chip the URL points at — accent the border so it reads
     "this is what you pasted, but it isn't configured yet". */
  .chip.muted.matched {
    opacity: 0.85;
    border-color: var(--accent-strong);
  }
  .chip-prefix {
    font-size: 1em;
    line-height: 1;
    margin-right: 4px;
  }
  .chip-label {
    line-height: 1;
  }
  .status {
    font-size: var(--t-12);
    color: var(--text-3);
  }
  /* Detection / caveat hints under the URL input — neutral by default,
   * warning-coloured for the Reddit listing-limit caveat. */
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
