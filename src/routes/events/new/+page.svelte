<script lang="ts">
  // /events/new — full-page free-form event creation (Plan 02.1-09; CONTEXT
  // D-09). The /events list page is removed in 2.1 (UI-SPEC §"/events
  // (REMOVED)") so this is the canonical entry point for free-form events;
  // the paste flow on /games/[id] (and Plan 07's /feed paste affordance)
  // handles the pollable kinds (youtube_video) for users who already have
  // the URL.
  //
  // Plan 02.1-20: kind picker shows ONLY functional kinds (youtube_video,
  // post, conference, talk, press, other) — non-functional Phase-3+ kinds
  // (reddit_post, twitter_post, telegram_post, discord_drop) are HIDDEN.
  // Backend continues to accept all enum values (UI-gate only); legacy rows
  // of hidden kinds still render correctly via KindIcon + FilterChips.
  //
  // The paste flow is the FAST path; free-form is the FALLBACK. When a
  // Phase-3+ adapter ships, add the value back to FUNCTIONAL_KINDS.
  //
  // Submit → POST /api/events { gameId|null, kind, occurredAt, title, url,
  // notes }. On 201 → goto("/feed") so the user sees their event in the
  // chronological pool. On 422 → InlineError.

  import { goto, invalidateAll } from "$app/navigation";
  import { m } from "$lib/paraglide/messages.js";
  import InlineError from "$lib/components/InlineError.svelte";
  import { sortByLabel } from "$lib/util/sort-kinds.js";
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
  // Plan 02.1-18 — author_is_me discriminator (default false). Server-side
  // schema acceptance ships in Plan 02.1-17; this wires the client.
  let authorIsMe = $state(false);
  let pending = $state(false);
  let errorText = $state<string | null>(null);
  // Phase 3.0 post-build (UAT 2026-05-06) — "Get from YouTube" button state.
  let fetching = $state(false);
  let fetchInfo = $state<string | null>(null);

  async function fetchFromYouTube(): Promise<void> {
    if (fetching) return;
    if (!url.trim()) return;
    fetching = true;
    fetchInfo = null;
    errorText = null;
    try {
      const res = await fetch("/api/youtube/fetch-metadata", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (res.status === 422) errorText = "Это не похоже на YouTube URL";
        else if (res.status === 404) errorText = "Видео не найдено на YouTube";
        else if (res.status === 503)
          errorText = "Оператор не настроил YouTube API key — fetch отключён";
        else errorText = body.error ?? "Ошибка fetch metadata";
        return;
      }
      const meta = (await res.json()) as {
        title: string;
        description: string | null;
        publishedAt: string | null;
        cached: boolean;
      };
      // Pre-fill: don't overwrite a title the user already typed.
      if (!title.trim()) title = meta.title;
      if (meta.description && !notes.trim()) notes = meta.description;
      if (meta.publishedAt) {
        occurredAt = meta.publishedAt.slice(0, 10);
      }
      // Force kind to youtube_video — they pasted a YouTube URL.
      kind = "youtube_video";
      fetchInfo = meta.cached ? "Загружено из кэша (0 quota)" : "Загружено с YouTube (1 quota)";
    } catch (e) {
      errorText = "Сетевая ошибка";
    } finally {
      fetching = false;
    }
  }

  function isYoutubeUrl(u: string): boolean {
    try {
      const p = new URL(u);
      return /(^|\.)youtube\.com$/i.test(p.hostname) || p.hostname === "youtu.be";
    } catch {
      return false;
    }
  }
  const canFetch = $derived(isYoutubeUrl(url.trim()) && !fetching && !pending);

  function setToday(): void {
    occurredAt = new Date().toISOString().slice(0, 10);
  }
  function setYesterday(): void {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    occurredAt = d.toISOString().slice(0, 10);
  }

  // Plan 02.1-20: functional-only allowlist + alphabetical-by-label sort.
  // Hidden kinds (reddit_post, twitter_post, telegram_post, discord_drop)
  // re-appear when their adapter ships in Phase 3+ — just add the value
  // back to FUNCTIONAL_KINDS. Backend continues to accept all enum values;
  // legacy rows of hidden kinds still render correctly via KindIcon +
  // FilterChips. UI-gate only — no schema / migration / service change.
  const FUNCTIONAL_KINDS: ReadonlyArray<EventKind> = [
    "youtube_video",
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
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) code = body.error;
        } catch {
          /* ignore */
        }
        errorText =
          code === "validation_failed" ? m.ingest_error_malformed_url() : m.error_server_generic();
        return;
      }
      // Plan 02.1-19: invalidateAll() forces SvelteKit to re-run /feed's
      // +page.server.ts loader after the POST succeeds. Without this, /feed
      // shows stale data and the user must hard-refresh to see the new
      // event (UAT round-2 gap "feed loader stale after POST /api/events").
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
        <button
          type="button"
          class="fetch-btn"
          onclick={fetchFromYouTube}
          disabled={!canFetch}
          title="Загрузить заголовок и описание из YouTube"
        >
          {fetching ? "Загрузка…" : "Получить из YouTube"}
        </button>
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
    gap: var(--space-xs);
    color: var(--color-text-muted);
    font-size: var(--font-size-label);
    margin-bottom: var(--space-md);
  }
  .breadcrumb a {
    color: var(--color-accent);
    text-decoration: none;
  }
  .newevent {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
    min-width: 0;
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
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
  }
  .field.checkbox {
    flex-direction: row;
    align-items: center;
    gap: var(--space-sm);
  }
  .field.checkbox input {
    width: 18px;
    height: 18px;
    min-height: 0;
  }
  .field-label {
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
  .textarea {
    padding: var(--space-sm) var(--space-md);
    min-height: 88px;
    line-height: var(--line-height-body);
    font-family: inherit;
    resize: vertical;
  }
  .actions {
    display: flex;
    gap: var(--space-sm);
    justify-content: flex-end;
    align-items: center;
  }
  .cancel {
    color: var(--color-text-muted);
    text-decoration: underline;
    padding: var(--space-sm);
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
  }
  .submit:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .quick-set {
    display: flex;
    gap: var(--space-sm);
    flex-wrap: wrap;
  }
  .chip {
    min-height: 44px;
    padding: 0 var(--space-md);
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 999px;
    font-size: var(--font-size-label);
    cursor: pointer;
  }
  .chip:hover {
    border-color: var(--color-text);
  }
  .chip:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
