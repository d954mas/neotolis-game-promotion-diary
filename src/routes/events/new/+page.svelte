<script lang="ts">
  // /events/new — full-page free-form event creation. The canonical entry
  // point for free-form events; the paste flow on /games/[id] (and the
  // /feed paste affordance) handles the pollable kinds (youtube_video)
  // for users who already have the URL.
  //
  // Kind picker shows ONLY functional kinds (youtube_video, post,
  // conference, talk, press, other) — non-functional future kinds
  // (reddit_post, twitter_post, telegram_post, discord_drop) are HIDDEN.
  // Backend continues to accept all enum values (UI-gate only); legacy
  // rows of hidden kinds still render correctly via KindIcon + FilterChips.
  //
  // The paste flow is the FAST path; free-form is the FALLBACK. When a
  // new adapter ships, add the value back to FUNCTIONAL_KINDS.
  //
  // Submit → POST /api/events { gameId|null, kind, occurredAt, title, url,
  // notes }. On 201 → goto("/feed") so the user sees their event in the
  // chronological pool. On 422 → InlineError.

  import { goto, invalidateAll } from "$app/navigation";
  import { m } from "$lib/paraglide/messages.js";
  import InlineError from "$lib/components/InlineError.svelte";
  import { sortByLabel } from "$lib/util/sort-kinds.js";
  import { findPreviewAdapter } from "$lib/sources/registry-ui-client.js";
  import { sourceKindToEventKind } from "$lib/sources/event-to-source-kind.js";
  import type { PageData } from "./$types";

  type EventKind =
    | "youtube_video"
    | "twitter_post"
    | "telegram_post"
    | "discord_drop"
    | "reddit_post"
    | "conference"
    | "talk"
    | "press"
    | "other"
    | "post";

  type GameOpt = { id: string; title: string };

  let { data }: { data: PageData } = $props();
  const games = $derived(data.games as GameOpt[]);

  let gameId = $state<string>("");
  let kind = $state<EventKind>("other");
  let title = $state("");
  let occurredAt = $state(new Date().toISOString().slice(0, 10));
  let url = $state("");
  let notes = $state("");
  // author_is_me discriminator (default false).
  let authorIsMe = $state(false);
  let pending = $state(false);
  let errorText = $state<string | null>(null);
  // Generic paste-preview button state. The button appears when any
  // registered adapter's `detectPreviewUrl` accepts the input URL —
  // see findPreviewAdapter() in registry-ui-client.ts. Adding a new
  // adapter with paste-preview support is a 2-line change in that
  // adapter's ui/index.ts; no UI code here needs to change.
  let fetching = $state(false);
  let fetchInfo = $state<string | null>(null);

  const previewAdapter = $derived(findPreviewAdapter(url.trim()));
  const canFetch = $derived(previewAdapter !== null && !fetching && !pending);

  async function fetchFromUrl(): Promise<void> {
    if (fetching) return;
    if (previewAdapter === null) return;
    fetching = true;
    fetchInfo = null;
    errorText = null;
    try {
      const res = await fetch(previewAdapter.previewEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      if (!res.ok) {
        if (res.status === 422) errorText = m.events_new_fetch_err_invalid_url();
        else if (res.status === 404) errorText = m.events_new_fetch_err_not_found();
        else if (res.status === 503) errorText = m.events_new_fetch_err_unavailable();
        else if (res.status === 429) errorText = m.events_new_fetch_err_rate_limited();
        else errorText = m.events_new_fetch_err_generic();
        return;
      }
      // Cross-adapter response shape:
      //   YouTube /api/youtube/fetch-metadata: {title, description, publishedAt, cached, ...}
      //   Reddit  /api/reddit/fetch-metadata:  {title, description, publishedAt, cached, ...}
      // Both adapters return the same shape — UI doesn't switch on kind.
      const meta = (await res.json()) as {
        title?: string | null;
        description?: string | null;
        publishedAt?: string | null;
        cached?: boolean;
      };
      // Pre-fill: don't overwrite values the user already typed.
      if (meta.title && !title.trim()) title = meta.title;
      if (meta.description && !notes.trim()) notes = meta.description;
      if (meta.publishedAt) {
        occurredAt = meta.publishedAt.slice(0, 10);
      }
      // Force the event kind to whatever the adapter detected — they
      // pasted a URL the adapter knows how to handle, so the kind is
      // unambiguous from the URL itself.
      const detectedEventKind = sourceKindToEventKind(previewAdapter.sourceKind);
      if (detectedEventKind !== null) {
        kind = detectedEventKind as EventKind;
      }
      fetchInfo = meta.cached ? m.events_new_fetch_info_cached() : m.events_new_fetch_info_fresh();
    } catch {
      errorText = m.events_new_fetch_err_network();
    } finally {
      fetching = false;
    }
  }

  function setToday(): void {
    occurredAt = new Date().toISOString().slice(0, 10);
  }
  function setYesterday(): void {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    occurredAt = d.toISOString().slice(0, 10);
  }

  // Functional-only allowlist + alphabetical-by-label sort.
  // Hidden kinds (twitter_post, telegram_post, discord_drop) re-appear
  // when their adapter ships — just add the value back to FUNCTIONAL_KINDS.
  // Backend continues to accept all enum values; legacy rows of hidden
  // kinds still render correctly via KindIcon + FilterChips. UI-gate
  // only — no schema / migration / service change.
  const FUNCTIONAL_KINDS: ReadonlyArray<EventKind> = [
    "youtube_video",
    "reddit_post",
    "post",
    "conference",
    "talk",
    "press",
    "other",
  ];

  function eventKindLabel(k: EventKind): string {
    switch (k) {
      case "youtube_video":
        return m.event_kind_label_youtube_video();
      case "post":
        return m.event_kind_label_post();
      case "conference":
        return m.event_kind_label_conference();
      case "talk":
        return m.event_kind_label_talk();
      case "press":
        return m.event_kind_label_press();
      case "other":
        return m.event_kind_label_other();
      // Hidden kinds (reddit_post, twitter_post, telegram_post,
      // discord_drop) are unreachable here — FUNCTIONAL_KINDS excludes
      // them — but the switch is exhaustive for type-safety.
      case "reddit_post":
        return m.event_kind_label_reddit_post();
      case "twitter_post":
        return m.event_kind_label_twitter_post();
      case "telegram_post":
        return m.event_kind_label_telegram_post();
      case "discord_drop":
        return m.event_kind_label_discord_drop();
    }
  }

  // $derived so the sort re-runs on locale change; EventKind type preserved.
  const KINDS = $derived(
    sortByLabel(
      FUNCTIONAL_KINDS.map((value) => ({ value, label: eventKindLabel(value) })),
      (item) => item.label,
    ),
  );

  async function submit(e: Event): Promise<void> {
    e.preventDefault();
    if (pending) return;
    if (title.trim().length === 0) {
      errorText = m.error_server_generic();
      return;
    }
    pending = true;
    errorText = null;
    try {
      const res = await fetch("/api/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          gameId: gameId || null,
          kind,
          occurredAt: new Date(occurredAt).toISOString(),
          title: title.trim(),
          url: url.trim() || null,
          notes: notes.trim() || null,
          authorIsMe,
        }),
      });
      if (!res.ok) {
        let code = "error_server_generic";
        let firstField: string | null = null;
        try {
          const body = (await res.json()) as {
            error?: string;
            details?: Array<{ path?: unknown }>;
          };
          if (body.error) code = body.error;
          const path = body.details?.[0]?.path;
          if (Array.isArray(path) && typeof path[0] === "string") {
            firstField = path[0];
          }
        } catch {
          /* ignore */
        }
        if (code === "validation_failed") {
          // Field-aware messaging — "notes too long" is the common
          // path for long-form Reddit selftext pastes (the limit is
          // 50 000 chars). The legacy fallback is the URL-shape error,
          // which covers the kind=reddit_post / kind=youtube_video
          // gate when the user typed a bad URL.
          errorText =
            firstField === "notes"
              ? m.ingest_error_notes_too_long()
              : m.ingest_error_malformed_url();
        } else {
          errorText = m.error_server_generic();
        }
        return;
      }
      // invalidateAll() forces SvelteKit to re-run /feed's +page.server.ts
      // loader after the POST succeeds. Without this, /feed shows stale
      // data and the user must hard-refresh to see the new event.
      await invalidateAll();
      await goto("/feed");
    } catch {
      errorText = m.error_network();
    } finally {
      pending = false;
    }
  }
</script>

<nav class="breadcrumb" aria-label="Breadcrumb">
  <a href="/feed">Feed</a>
  <span aria-hidden="true">/</span>
  <span>New event</span>
</nav>

<section class="newevent">
  <h1>New event</h1>
  <form class="form" onsubmit={submit}>
    <label class="field">
      <span class="field-label">Kind *</span>
      <select class="input" bind:value={kind} disabled={pending}>
        {#each KINDS as opt (opt.value)}
          <option value={opt.value}>{opt.label}</option>
        {/each}
      </select>
    </label>

    <label class="field">
      <span class="field-label">Title *</span>
      <input
        class="input"
        type="text"
        bind:value={title}
        required
        maxlength="500"
        disabled={pending}
      />
    </label>

    <div class="field">
      <label for="event-date" class="field-label-wrap">
        <span class="field-label">Date *</span>
      </label>
      <div class="quick-set" role="group" aria-label="Quick date presets">
        <button type="button" class="chip" onclick={setToday} disabled={pending}>
          {m.events_new_date_today()}
        </button>
        <button type="button" class="chip" onclick={setYesterday} disabled={pending}>
          {m.events_new_date_yesterday()}
        </button>
      </div>
      <input
        id="event-date"
        class="input"
        type="date"
        bind:value={occurredAt}
        required
        disabled={pending}
      />
      {#if occurredAt}
        {@const daysAgo = Math.floor((Date.now() - new Date(occurredAt).getTime()) / 86_400_000)}
        {#if daysAgo > 0}
          <small class="date-hint warn">
            {m.events_new_date_in_past_hint({ daysAgo: String(daysAgo) })}
          </small>
        {/if}
      {/if}
    </div>

    <label class="field checkbox">
      <input type="checkbox" bind:checked={authorIsMe} disabled={pending} />
      <span class="field-label">{m.events_new_author_is_me()}</span>
    </label>

    <div class="field">
      <span class="field-label">URL</span>
      <div class="url-row">
        <input
          class="input"
          type="url"
          bind:value={url}
          placeholder="https://"
          disabled={pending}
        />
        {#if previewAdapter !== null}
          <button
            type="button"
            class="fetch-btn"
            onclick={fetchFromUrl}
            disabled={!canFetch}
            title={m.events_new_fetch_title()}
          >
            {fetching ? m.events_new_fetch_loading() : m.events_new_fetch_button()}
          </button>
        {/if}
      </div>
      {#if fetchInfo}
        <small class="fetch-info">{fetchInfo}</small>
      {/if}
    </div>

    <label class="field">
      <span class="field-label">Game (optional — leave empty to drop in inbox)</span>
      <select class="input" bind:value={gameId} disabled={pending}>
        <option value="">No game (inbox)</option>
        {#each games as g (g.id)}
          <option value={g.id}>{g.title}</option>
        {/each}
      </select>
    </label>

    <label class="field">
      <span class="field-label">Notes</span>
      <textarea class="input textarea" bind:value={notes} rows="3" disabled={pending}></textarea>
    </label>

    <div class="actions">
      <a class="cancel" href="/feed">{m.common_cancel()}</a>
      <button type="submit" class="submit" disabled={pending || title.trim().length === 0}>
        {m.feed_cta_add_event()}
      </button>
    </div>
    {#if errorText}<InlineError message={errorText} />{/if}
  </form>
</section>

<style>
  .breadcrumb {
    display: flex;
    gap: var(--s-1);
    color: var(--text-3);
    font-size: var(--t-13);
    margin-bottom: var(--s-4);
  }
  .breadcrumb a {
    color: var(--accent);
    text-decoration: none;
  }
  .breadcrumb a:hover {
    color: var(--accent-strong);
  }
  .newevent {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
    min-width: 0;
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
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
  }
  .field.checkbox {
    flex-direction: row;
    align-items: center;
    gap: var(--s-2);
  }
  .field.checkbox input {
    width: 18px;
    height: 18px;
    min-height: 0;
  }
  .field-label {
    font-size: var(--t-13);
    color: var(--text-2);
  }
  .input {
    min-height: var(--hit);
    padding: 0 var(--s-4);
    background: var(--surface-3);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    font-family: var(--f-sans);
    font-size: var(--t-14);
  }
  .textarea {
    padding: var(--s-2) var(--s-4);
    min-height: 88px;
    line-height: var(--lh-body);
    font-family: inherit;
    resize: vertical;
  }
  .url-row {
    display: flex;
    gap: var(--s-2);
    align-items: stretch;
  }
  .url-row .input {
    flex: 1 1 auto;
    min-width: 0;
  }
  .fetch-btn {
    min-height: var(--hit);
    padding: 0 var(--s-4);
    background: var(--accent);
    color: var(--accent-text);
    border: 1px solid var(--accent);
    border-radius: var(--r-sm);
    font-family: var(--f-sans);
    font-size: var(--t-14);
    font-weight: var(--w-sb);
    cursor: pointer;
    flex: 0 0 auto;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .fetch-btn:hover:not(:disabled) {
    background: var(--accent-strong);
    border-color: var(--accent-strong);
  }
  .fetch-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .fetch-info {
    color: var(--text-3);
    font-size: var(--t-13);
  }
  .date-hint {
    color: var(--text-3);
    font-size: var(--t-12);
  }
  .date-hint.warn {
    color: var(--warn);
  }
  .actions {
    display: flex;
    gap: var(--s-2);
    justify-content: flex-end;
    align-items: center;
  }
  .cancel {
    color: var(--text-3);
    text-decoration: underline;
    padding: var(--s-2);
    font-size: var(--t-14);
  }
  .cancel:hover {
    color: var(--text);
  }
  .submit {
    min-height: var(--hit-lg);
    padding: 0 var(--s-4);
    background: var(--accent);
    color: var(--accent-text);
    border: 1px solid var(--accent);
    border-radius: var(--r-sm);
    font-family: var(--f-sans);
    font-size: var(--t-14);
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
    opacity: 0.5;
    cursor: not-allowed;
  }
  .quick-set {
    display: flex;
    gap: var(--s-2);
    flex-wrap: wrap;
  }
  .chip {
    min-height: var(--hit);
    padding: 0 var(--s-4);
    background: var(--surface-3);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--r-pill);
    font-family: var(--f-sans);
    font-size: var(--t-13);
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .chip:hover {
    background: var(--accent-soft);
    color: var(--accent);
    border-color: var(--accent-strong);
  }
  .chip:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  @media (prefers-reduced-motion: reduce) {
    .submit,
    .chip,
    .fetch-btn {
      transition: none;
    }
  }
</style>
