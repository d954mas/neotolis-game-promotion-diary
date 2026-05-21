<script lang="ts">
  // AddEventForm — Wave 2 Plan 09 shared body for the add-event surface
  // (D-16 modal primary + D-17 fetch via /api/events/preview-url +
  // D-18 save toast wired by the caller).
  //
  // This file is the SHARED form that renders identically whether the
  // caller mounts it inside <AddEventModal> (overlay over /feed) OR
  // directly inside /events/new route (Plan 10 wires both). The wrapper
  // owns the <dialog> chrome + dirty-confirm prompt; this form owns the
  // fields + per-kind URL host validation + the Fetch button that hits
  // POST /api/events/preview-url (Phase 02.1-17 endpoint, NOT a mock OG
  // parser per D-17).

  import { m } from "$lib/paraglide/messages.js";
  import InlineError from "$lib/components/InlineError.svelte";
  import { sortByLabel } from "$lib/util/sort-kinds.js";
  import type { GameDto } from "$lib/server/dto.js";

  type EventKind =
    | "youtube_video"
    | "reddit_post"
    | "twitter_post"
    | "telegram_post"
    | "discord_drop"
    | "conference"
    | "talk"
    | "press"
    | "other"
    | "post";

  export type AddEventPayload = {
    title: string;
    kind: EventKind;
    url: string | null;
    notes: string | null;
    gameIds: string[];
    offTopic: boolean;
    authorIsMe: boolean;
    occurredAt: string;
  };

  let {
    games,
    initialKind = "post",
    initialAttachedGameIds = [],
    onSave,
    onCancel,
    onDirtyChange,
  }: {
    games: GameDto[];
    initialKind?: EventKind;
    initialAttachedGameIds?: string[];
    onSave: (payload: AddEventPayload) => Promise<void>;
    onCancel: () => void;
    /** Invoked whenever the dirty state changes — the AddEventModal
     *  wrapper subscribes so it can gate scrim-click / Esc through a
     *  window.confirm prompt (D-16). */
    onDirtyChange?: (dirty: boolean) => void;
  } = $props();

  // Form state.
  let title = $state("");
  let kind = $state<EventKind>(initialKind);
  let url = $state("");
  let notes = $state("");
  let authorIsMe = $state(true);
  let offTopic = $state(false);
  let attachedGameIds = $state<string[]>([...initialAttachedGameIds]);
  let occurredAt = $state(new Date().toISOString().slice(0, 10));

  // Network state.
  let fetching = $state(false);
  let saving = $state(false);
  let urlError = $state<string | null>(null);
  let errorText = $state<string | null>(null);

  // Functional-only kind allowlist — mirrors /events/new's existing gate
  // (Phase 02.1-20). Backend continues to accept all enum values; UI
  // restricts the picker. Hidden kinds reappear when their adapter ships.
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
      case "reddit_post":
        return m.event_kind_label_reddit_post();
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
      case "twitter_post":
        return m.event_kind_label_twitter_post();
      case "telegram_post":
        return m.event_kind_label_telegram_post();
      case "discord_drop":
        return m.event_kind_label_discord_drop();
    }
  }

  const kindOptions = $derived(
    sortByLabel(
      FUNCTIONAL_KINDS.map((value) => ({ value, label: eventKindLabel(value) })),
      (item) => item.label,
    ),
  );

  // Dirty tracking — any user-visible change away from initial values.
  // Re-fires onDirtyChange whenever derived state flips.
  const isDirty = $derived(
    title.trim().length > 0 ||
      url.trim().length > 0 ||
      notes.trim().length > 0 ||
      kind !== initialKind ||
      offTopic !== false ||
      attachedGameIds.length !== initialAttachedGameIds.length ||
      attachedGameIds.some((id) => !initialAttachedGameIds.includes(id)),
  );

  $effect(() => {
    onDirtyChange?.(isDirty);
  });

  function toggleGame(id: string): void {
    if (attachedGameIds.includes(id)) {
      attachedGameIds = attachedGameIds.filter((g) => g !== id);
    } else {
      attachedGameIds = [...attachedGameIds, id];
    }
  }

  // Per-kind URL host validation (D-17). Client-side gives instant
  // feedback; server-side enforcement via Zod + adapter parseUrl is the
  // load-bearing second layer.
  function urlMatchesKind(u: string, k: EventKind): boolean {
    if (!u.trim()) return true; // empty URL is fine for non-pollable kinds
    try {
      const parsed = new URL(u);
      const host = parsed.host.toLowerCase();
      if (k === "youtube_video") {
        return (
          host === "youtube.com" ||
          host === "www.youtube.com" ||
          host === "m.youtube.com" ||
          host === "youtu.be"
        );
      }
      if (k === "reddit_post") {
        return (
          host === "reddit.com" ||
          host === "www.reddit.com" ||
          host === "old.reddit.com" ||
          host === "new.reddit.com"
        );
      }
      return true;
    } catch {
      return false;
    }
  }

  // URL Fetch — calls POST /api/events/preview-url (D-17, NOT mock OG).
  // The endpoint returns { kind, externalId, title, thumbnailUrl,
  // occurredAt } via the adapter registry — same path the /events/new
  // page hits today.
  async function fetchUrlMetadata(): Promise<void> {
    if (fetching) return;
    const u = url.trim();
    if (!u) return;
    fetching = true;
    urlError = null;
    errorText = null;
    try {
      const res = await fetch("/api/events/preview-url", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: u }),
      });
      if (!res.ok) {
        urlError = m.add_event_modal_url_error_invalid();
        return;
      }
      const data = (await res.json()) as {
        kind?: string | null;
        title?: string | null;
        occurredAt?: string | null;
      };
      if (data.title && title.trim().length === 0) {
        title = data.title;
      }
      if (data.occurredAt) {
        occurredAt = data.occurredAt.slice(0, 10);
      }
      // If the adapter detected a concrete kind, adopt it (the URL host
      // is unambiguous when the adapter accepted it).
      if (data.kind && (FUNCTIONAL_KINDS as readonly string[]).includes(data.kind)) {
        kind = data.kind as EventKind;
      }
    } catch {
      errorText = m.error_network();
    } finally {
      fetching = false;
    }
  }

  async function submit(e: Event): Promise<void> {
    e.preventDefault();
    if (saving) return;
    if (title.trim().length === 0) {
      errorText = m.error_server_generic();
      return;
    }
    if (!urlMatchesKind(url, kind)) {
      urlError = m.add_event_modal_url_error_kind_mismatch({
        platform: eventKindLabel(kind),
      });
      return;
    }
    saving = true;
    errorText = null;
    urlError = null;
    try {
      await onSave({
        title: title.trim(),
        kind,
        url: url.trim() || null,
        notes: notes.trim() || null,
        gameIds: [...attachedGameIds],
        offTopic,
        authorIsMe,
        occurredAt: new Date(occurredAt).toISOString(),
      });
    } catch {
      errorText = m.error_server_generic();
    } finally {
      saving = false;
    }
  }
</script>

<form class="add-event-form" onsubmit={submit}>
  <label class="field">
    <span class="field-label">{m.add_event_modal_title_label()}</span>
    <input
      class="input"
      type="text"
      bind:value={title}
      placeholder={m.add_event_modal_title_placeholder()}
      required
      maxlength="500"
      disabled={saving}
    />
  </label>

  <label class="field">
    <span class="field-label">{m.add_event_modal_kind_label()}</span>
    <select class="input" bind:value={kind} disabled={saving}>
      {#each kindOptions as opt (opt.value)}
        <option value={opt.value}>{opt.label}</option>
      {/each}
    </select>
  </label>

  <div class="field">
    <span class="field-label">
      {m.add_event_modal_link_label()}
      <span class="optional">{m.add_event_modal_link_optional()}</span>
    </span>
    <div class="url-row">
      <input
        class="input"
        type="url"
        bind:value={url}
        placeholder={m.add_event_modal_link_placeholder()}
        disabled={saving}
      />
      <button
        type="button"
        class="fetch-btn"
        onclick={fetchUrlMetadata}
        disabled={fetching || saving || url.trim().length === 0}
      >
        {fetching ? m.add_event_modal_fetch_button_loading() : m.add_event_modal_fetch_button()}
      </button>
    </div>
    {#if urlError}
      <small class="field-error">{urlError}</small>
    {/if}
  </div>

  <label class="field">
    <span class="field-label">Date</span>
    <input
      class="input"
      type="date"
      bind:value={occurredAt}
      max={new Date().toISOString().slice(0, 10)}
      required
      disabled={saving}
    />
  </label>

  <label class="field checkbox">
    <input type="checkbox" bind:checked={authorIsMe} disabled={saving} />
    <span class="field-label">Author is me</span>
  </label>

  <div class="field">
    <span class="field-label">{m.add_event_modal_games_label()}</span>
    <div class="games-row">
      {#each games as g (g.id)}
        <button
          type="button"
          class="game-chip"
          data-active={attachedGameIds.includes(g.id) ? "1" : "0"}
          onclick={() => toggleGame(g.id)}
          disabled={saving}
        >
          {g.title}
        </button>
      {/each}
      <label class="off-topic-toggle">
        <input type="checkbox" bind:checked={offTopic} disabled={saving} />
        <span>{m.add_event_modal_off_topic()}</span>
      </label>
    </div>
  </div>

  <label class="field">
    <span class="field-label">
      {m.add_event_modal_notes_label()}
      <span class="optional">{m.add_event_modal_notes_optional()}</span>
    </span>
    <textarea
      class="input textarea"
      bind:value={notes}
      rows="3"
      maxlength="50000"
      disabled={saving}
    ></textarea>
  </label>

  <div class="footer">
    <button type="button" class="footer-btn footer-btn-ghost" onclick={onCancel} disabled={saving}>
      {m.add_event_modal_cancel()}
    </button>
    <button
      type="submit"
      class="footer-btn footer-btn-primary"
      disabled={saving || title.trim().length === 0}
    >
      {m.add_event_modal_save()}
    </button>
  </div>

  {#if errorText}
    <InlineError message={errorText} />
  {/if}
</form>

<style>
  .add-event-form {
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
    padding: var(--s-4);
    min-width: 0;
    background: var(--surface-2);
    color: var(--text);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
    min-width: 0;
  }
  .field.checkbox {
    flex-direction: row;
    align-items: center;
    gap: var(--s-2);
  }
  .field-label {
    font-size: var(--t-13);
    color: var(--text-2);
    font-weight: var(--w-md);
  }
  .optional {
    color: var(--text-3);
    font-weight: var(--w-rg);
  }
  .input {
    min-height: var(--hit);
    padding: 0 var(--s-3);
    background: var(--surface-3);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    font-family: var(--f-sans);
    font-size: var(--t-14);
    width: 100%;
    min-width: 0;
  }
  .input:focus {
    outline: none;
    border-color: var(--accent-strong);
  }
  .textarea {
    padding: var(--s-2) var(--s-3);
    min-height: 88px;
    line-height: var(--lh-body);
    font-family: inherit;
    resize: vertical;
  }
  .url-row {
    display: flex;
    gap: var(--s-2);
    align-items: stretch;
    min-width: 0;
  }
  .url-row .input {
    flex: 1 1 auto;
    min-width: 0;
  }
  .fetch-btn {
    min-height: var(--hit);
    padding: 0 var(--s-3);
    background: var(--accent);
    color: var(--accent-text);
    border: 1px solid var(--accent);
    border-radius: var(--r-sm);
    font-family: var(--f-sans);
    font-size: var(--t-13);
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
  .field-error {
    color: var(--danger);
    font-size: var(--t-12);
  }
  .games-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-1);
    align-items: center;
  }
  .game-chip {
    display: inline-flex;
    align-items: center;
    padding: var(--s-1) var(--s-2);
    background: var(--surface-3);
    color: var(--text-2);
    border: 1px solid var(--border);
    border-radius: var(--r-pill);
    font-family: var(--f-sans);
    font-size: var(--t-12);
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      color var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .game-chip[data-active="1"] {
    background: var(--accent-soft);
    color: var(--accent);
    border-color: var(--accent-strong);
  }
  .game-chip:hover:not(:disabled) {
    border-color: var(--accent-strong);
  }
  .game-chip:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .off-topic-toggle {
    display: inline-flex;
    align-items: center;
    gap: var(--s-1);
    padding: var(--s-1) var(--s-2);
    border: 1px solid var(--border);
    border-radius: var(--r-pill);
    background: var(--surface-3);
    color: var(--text-2);
    font-size: var(--t-12);
    cursor: pointer;
  }
  .off-topic-toggle input {
    width: 14px;
    height: 14px;
    min-height: 0;
  }
  .footer {
    display: flex;
    gap: var(--s-2);
    justify-content: flex-end;
    align-items: center;
    padding-top: var(--s-2);
    border-top: 1px solid var(--border-hairline);
    margin-top: var(--s-2);
  }
  .footer-btn {
    min-height: var(--hit);
    padding: var(--s-2) var(--s-4);
    border-radius: var(--r-sm);
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text);
    cursor: pointer;
    font-family: var(--f-sans);
    font-size: var(--t-13);
    font-weight: var(--w-sb);
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .footer-btn:hover:not(:disabled) {
    background: var(--accent-soft);
    border-color: var(--accent-strong);
  }
  .footer-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .footer-btn-ghost {
    background: transparent;
  }
  .footer-btn-primary {
    background: var(--accent);
    color: var(--accent-text);
    border-color: var(--accent);
  }
  .footer-btn-primary:hover:not(:disabled) {
    background: var(--accent-strong);
    border-color: var(--accent-strong);
  }
  @media (prefers-reduced-motion: reduce) {
    .game-chip,
    .fetch-btn,
    .footer-btn,
    .input {
      transition: none;
    }
  }
</style>
