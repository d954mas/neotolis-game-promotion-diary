<script lang="ts">
  // EventDetailContent — Wave 2 Plan 09 dual-render content component
  // (D-05 modal + D-06 route SSR fallback).
  //
  // This file is the SHARED body that renders identically whether
  // mounted via <EventDetailModal> from /feed?event=ev_123 OR directly
  // inside /events/[id]/+page.svelte. The wrapper handles the dialog
  // chrome (showModal / scrim / oncancel); this component owns the
  // content + inline-edit drafts + keyboard navigation.
  //
  // Inline-edit drafts (D-07): three independent `$state<string | null>`
  // values — title / notes / url. `null` = not editing; string = current
  // draft value. Esc closes the active draft (cascade: title → notes →
  // url → onClose). Enter / blur commits via onUpdate.
  //
  // Keyboard nav (D-05): ←/→ arrows call onPrev/onNext when hasPrev /
  // hasNext are true; the modal wrapper hosts the actual arrow buttons
  // but the keydown handler lives here so the route mount (where the
  // wrapper does NOT exist) also picks up the shortcut.
  //
  // View modes:
  //   - "feed"  → footer renders Edit + Delete (Edit hooks into the
  //                AddEventModal prefill flow wired by Plan 10).
  //   - "trash" → footer renders Restore + Delete-forever.

  import KindIcon from "$lib/components/KindIcon.svelte";
  import AuthorPopover from "$lib/components/shared/AuthorPopover.svelte";
  import { m } from "$lib/paraglide/messages.js";
  import type { EventDto, GameDto, DataSourceDto } from "$lib/server/dto.js";

  type EventUpdatePatch = Partial<{
    title: string;
    notes: string | null;
    url: string | null;
    authorIsMe: boolean;
  }>;

  let {
    event,
    games,
    sources,
    view = "feed",
    hasPrev = false,
    hasNext = false,
    currentUserName = "",
    onPrev,
    onNext,
    onClose,
    onDelete,
    onRestore,
    onDeleteForever,
    onUpdate,
    onEdit,
  }: {
    event: EventDto;
    games: GameDto[];
    sources: DataSourceDto[];
    view?: "feed" | "trash";
    hasPrev?: boolean;
    hasNext?: boolean;
    currentUserName?: string;
    onPrev?: () => void;
    onNext?: () => void;
    onClose: () => void;
    onDelete: (id: string) => Promise<void>;
    onRestore?: (id: string) => Promise<void>;
    onDeleteForever?: (id: string) => Promise<void>;
    onUpdate: (id: string, patch: EventUpdatePatch) => Promise<void>;
    onEdit?: (id: string) => void;
  } = $props();

  // Inline-edit drafts. null = not editing; string = current draft.
  let titleDraft = $state<string | null>(null);
  let notesDraft = $state<string | null>(null);
  let urlDraft = $state<string | null>(null);
  let authorPopoverOpen = $state(false);

  const inTrash = $derived(view === "trash");

  // Games attached to this event (resolve gameIds → GameDto[]).
  const attachedGames = $derived(
    event.gameIds
      .map((id) => games.find((g) => g.id === id))
      .filter((g): g is GameDto => g !== undefined),
  );

  // Source name for the byline. Manual-paste events have sourceId=null
  // so this resolves to undefined → byline falls back to "(no source)".
  const sourceRow = $derived(
    event.sourceId ? sources.find((s) => s.id === event.sourceId) : undefined,
  );

  const sourceLabel = $derived(
    sourceRow?.channelTitle ??
      sourceRow?.displayName ??
      sourceRow?.handleUrl ??
      "",
  );

  // Pretty kind label (matches FeedCard / EventDetailModal labels).
  const kindLabel = $derived.by(() => {
    switch (event.kind) {
      case "youtube_video":
        return m.event_kind_label_youtube_video();
      case "reddit_post":
        return m.event_kind_label_reddit_post();
      case "twitter_post":
        return m.event_kind_label_twitter_post();
      case "telegram_post":
        return m.event_kind_label_telegram_post();
      case "discord_drop":
        return m.event_kind_label_discord_drop();
      case "conference":
        return m.event_kind_label_conference();
      case "talk":
        return m.event_kind_label_talk();
      case "press":
        return m.event_kind_label_press();
      case "post":
        return m.event_kind_label_post();
      case "other":
      default:
        return m.event_kind_label_other();
    }
  });

  const occurredHuman = $derived.by(() => {
    const t =
      typeof event.occurredAt === "string"
        ? new Date(event.occurredAt)
        : event.occurredAt;
    return t.toLocaleDateString("en-GB", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  });

  // Stats — only YouTube events carry a stats snapshot today.
  const stats = $derived(event.stats);

  function startEditTitle(): void {
    if (inTrash) return;
    titleDraft = event.title ?? "";
  }

  async function commitEditTitle(): Promise<void> {
    if (titleDraft === null) return;
    const next = titleDraft.trim();
    if (next.length > 0 && next !== event.title) {
      await onUpdate(event.id, { title: next });
    }
    titleDraft = null;
  }

  function cancelEditTitle(): void {
    titleDraft = null;
  }

  function startEditNotes(): void {
    if (inTrash) return;
    notesDraft = event.notes ?? "";
  }

  async function commitEditNotes(): Promise<void> {
    if (notesDraft === null) return;
    const next = notesDraft.trim();
    const currentNotes = event.notes ?? "";
    if (next !== currentNotes) {
      await onUpdate(event.id, { notes: next.length > 0 ? next : null });
    }
    notesDraft = null;
  }

  function cancelEditNotes(): void {
    notesDraft = null;
  }

  function startEditUrl(): void {
    if (inTrash) return;
    urlDraft = event.url ?? "";
  }

  async function commitEditUrl(): Promise<void> {
    if (urlDraft === null) return;
    const next = urlDraft.trim();
    const currentUrl = event.url ?? "";
    if (next !== currentUrl) {
      await onUpdate(event.id, { url: next.length > 0 ? next : null });
    }
    urlDraft = null;
  }

  function cancelEditUrl(): void {
    urlDraft = null;
  }

  // URL is read-only for platform-locked kinds — the URL is the binding
  // between event and its source. Editable only for freeform kinds.
  const URL_LOCKED_KINDS = new Set([
    "youtube_video",
    "reddit_post",
    "twitter_post",
    "telegram_post",
    "discord_drop",
  ]);
  const urlIsLocked = $derived(URL_LOCKED_KINDS.has(event.kind));
  const urlIsEditable = $derived(!inTrash && !urlIsLocked);

  async function changeAuthor(isMe: boolean): Promise<void> {
    await onUpdate(event.id, { authorIsMe: isMe });
    authorPopoverOpen = false;
  }

  // Global keyboard handler — Esc cascades through active drafts, then
  // closes the modal; ←/→ navigate between events when the wrapper says
  // it's safe to do so.
  function onkeydown(e: KeyboardEvent): void {
    // Don't hijack arrows while typing into a field.
    const target = e.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable)
    ) {
      if (e.key === "Escape") {
        if (titleDraft !== null) {
          cancelEditTitle();
          e.preventDefault();
          return;
        }
        if (notesDraft !== null) {
          cancelEditNotes();
          e.preventDefault();
          return;
        }
        if (urlDraft !== null) {
          cancelEditUrl();
          e.preventDefault();
          return;
        }
      }
      return;
    }

    if (e.key === "Escape") {
      if (titleDraft !== null) {
        cancelEditTitle();
      } else if (notesDraft !== null) {
        cancelEditNotes();
      } else if (urlDraft !== null) {
        cancelEditUrl();
      } else {
        onClose();
      }
      e.preventDefault();
      return;
    }

    if (e.key === "ArrowLeft" && hasPrev) {
      onPrev?.();
      e.preventDefault();
    }
    if (e.key === "ArrowRight" && hasNext) {
      onNext?.();
      e.preventDefault();
    }
  }

  // svelte-ignore a11y_no_static_element_interactions
</script>

<svelte:window {onkeydown} />

<div class="event-detail-content" data-view={view}>
  <!-- Header: nav arrows + close button + author + kind tag + date -->
  <header class="head">
    <div class="head-nav">
      <button
        type="button"
        class="nav-btn"
        onclick={onPrev}
        disabled={!hasPrev}
        aria-label={m.event_detail_modal_prev_aria()}
        title={m.event_detail_modal_prev_aria()}
      >‹</button>
      <button
        type="button"
        class="nav-btn"
        onclick={onNext}
        disabled={!hasNext}
        aria-label={m.event_detail_modal_next_aria()}
        title={m.event_detail_modal_next_aria()}
      >›</button>
    </div>
    <div class="head-spacer"></div>
    <button
      type="button"
      class="close-btn"
      onclick={onClose}
      aria-label={m.event_detail_modal_close_aria()}
      title={m.event_detail_modal_close_aria()}
    >×</button>
  </header>

  <div class="body">
    <!-- Meta row: author + kind + source + date -->
    <div class="meta-row">
      {#if !inTrash}
        <span class="author-pick" style="position: relative">
          <button
            type="button"
            class="author-avatar"
            data-mine={event.authorIsMe ? "1" : "0"}
            onclick={() => (authorPopoverOpen = !authorPopoverOpen)}
            aria-haspopup="menu"
            aria-expanded={authorPopoverOpen}
            aria-label={event.authorIsMe
              ? m.author_avatar_mine_aria({ name: currentUserName || "you" })
              : m.author_avatar_unknown_aria()}
          >
            {event.authorIsMe ? (currentUserName[0] ?? "Y").toUpperCase() : "?"}
          </button>
          {#if authorPopoverOpen}
            <AuthorPopover
              authorIsMe={event.authorIsMe}
              mineName={currentUserName || "You"}
              onchange={changeAuthor}
              onclose={() => (authorPopoverOpen = false)}
            />
          {/if}
        </span>
      {:else}
        <span
          class="author-avatar"
          data-mine={event.authorIsMe ? "1" : "0"}
          aria-label={event.authorIsMe
            ? m.author_avatar_mine_aria({ name: currentUserName || "you" })
            : m.author_avatar_unknown_aria()}
        >
          {event.authorIsMe ? (currentUserName[0] ?? "Y").toUpperCase() : "?"}
        </span>
      {/if}

      <span class="kind-tag">
        <KindIcon kind={event.kind} size={16} />
        <span class="kind-tag-label">{kindLabel}</span>
      </span>

      {#if sourceLabel}
        <span class="meta-src" title={sourceLabel}>{sourceLabel}</span>
        <span class="meta-sep">·</span>
      {/if}
      <time class="meta-date">{occurredHuman}</time>
    </div>

    <!-- Title: inline-editable -->
    {#if titleDraft !== null && !inTrash}
      <input
        class="title-input"
        bind:value={titleDraft}
        onblur={commitEditTitle}
        onkeydown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          }
        }}
        maxlength="500"
        aria-label={m.event_detail_edit_title_aria()}
      />
    {:else}
      <div class="title-row">
        <h1 class="title" class:is-editable={!inTrash}>{event.title}</h1>
        {#if !inTrash}
          <button
            type="button"
            class="edit-btn"
            onclick={startEditTitle}
            aria-label={m.event_detail_edit_title_aria()}
            title={m.event_detail_edit_title_aria()}
          >✎</button>
        {/if}
      </div>
    {/if}

    <!-- URL: inline-editable for freeform kinds; read-only for platform-locked -->
    {#if urlDraft !== null && urlIsEditable}
      <div class="url-row">
        <input
          class="url-input"
          type="url"
          bind:value={urlDraft}
          onblur={commitEditUrl}
          onkeydown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            }
          }}
          placeholder="https://"
          aria-label={m.event_detail_edit_url_aria()}
        />
      </div>
    {:else}
      <div class="url-row">
        {#if event.url}
          <a
            class="url-text"
            href={event.url}
            target="_blank"
            rel="noopener noreferrer"
            title={event.url}
          >
            {event.url}
          </a>
          <a
            class="url-open"
            href={event.url}
            target="_blank"
            rel="noopener noreferrer"
            title={m.event_detail_open_external()}
          >
            {m.event_detail_open_external()}
          </a>
          {#if urlIsEditable}
            <button
              type="button"
              class="edit-btn"
              onclick={startEditUrl}
              aria-label={m.event_detail_edit_url_aria()}
              title={m.event_detail_edit_url_aria()}
            >✎</button>
          {/if}
        {:else if urlIsEditable}
          <button
            type="button"
            class="url-empty is-editable"
            onclick={startEditUrl}
            aria-label={m.event_detail_edit_url_aria()}
          >
            {m.event_detail_url_click_to_add()}
          </button>
        {:else}
          <span class="url-empty">{m.event_detail_url_empty()}</span>
        {/if}
      </div>
    {/if}

    <!-- Notes: inline-editable -->
    {#if notesDraft !== null && !inTrash}
      <textarea
        class="notes-input"
        bind:value={notesDraft}
        onblur={commitEditNotes}
        onkeydown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            (e.target as HTMLTextAreaElement).blur();
          }
        }}
        rows="4"
        maxlength="4000"
        aria-label={m.event_detail_edit_notes_aria()}
      ></textarea>
    {:else if event.notes}
      <div class="notes-row">
        <p class="notes" class:is-editable={!inTrash}>{event.notes}</p>
        {#if !inTrash}
          <button
            type="button"
            class="edit-btn"
            onclick={startEditNotes}
            aria-label={m.event_detail_edit_notes_aria()}
            title={m.event_detail_edit_notes_aria()}
          >✎</button>
        {/if}
      </div>
    {:else if !inTrash}
      <button type="button" class="notes-empty is-editable" onclick={startEditNotes}>
        {m.event_detail_notes_click_to_add()}
      </button>
    {:else}
      <p class="notes-empty">{m.event_detail_notes_empty()}</p>
    {/if}

    <!-- Stats (YouTube-only today) -->
    {#if stats}
      <div class="stats">
        <span class="stat"><b>{stats.viewCount.toLocaleString()}</b>
          <span>{m.event_detail_stat_views()}</span></span>
        <span class="stat"><b>{stats.likeCount.toLocaleString()}</b>
          <span>{m.event_detail_stat_likes()}</span></span>
        <span class="stat"><b>{stats.commentCount.toLocaleString()}</b>
          <span>{m.event_detail_stat_comments()}</span></span>
      </div>
    {/if}

    <!-- Games chip row -->
    <div class="games-section">
      <span class="games-section-label">{m.event_detail_section_games()}</span>
      <div class="games-row">
        {#if attachedGames.length === 0}
          <span class="games-empty">inbox</span>
        {/if}
        {#each attachedGames as g (g.id)}
          <span class="game-chip">{g.title}</span>
        {/each}
      </div>
    </div>
  </div>

  <!-- Footer — view-dependent action row -->
  <footer class="foot">
    {#if inTrash}
      {#if onRestore}
        <button
          type="button"
          class="foot-btn"
          onclick={() => onRestore?.(event.id)}
        >
          {m.event_detail_footer_restore()}
        </button>
      {/if}
      {#if onDeleteForever}
        <button
          type="button"
          class="foot-btn foot-btn-danger"
          onclick={() => onDeleteForever?.(event.id)}
        >
          {m.event_detail_footer_delete_forever()}
        </button>
      {/if}
    {:else}
      <button
        type="button"
        class="foot-btn foot-btn-primary"
        onclick={() => onEdit?.(event.id)}
      >
        {m.event_detail_footer_edit()}
      </button>
      <button
        type="button"
        class="foot-btn foot-btn-danger"
        onclick={() => onDelete(event.id)}
      >
        {m.events_detail_delete()}
      </button>
    {/if}
  </footer>
</div>

<style>
  .event-detail-content {
    display: flex;
    flex-direction: column;
    min-width: 0;
    background: var(--surface-2);
    color: var(--text);
  }
  .head {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    padding: var(--s-3) var(--s-4);
    border-bottom: 1px solid var(--border-hairline);
  }
  .head-nav {
    display: inline-flex;
    gap: var(--s-1);
  }
  .head-spacer {
    flex: 1;
  }
  .nav-btn,
  .close-btn {
    min-width: var(--hit);
    min-height: var(--hit);
    padding: 0 var(--s-3);
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    color: var(--text);
    cursor: pointer;
    font-size: var(--t-17);
    line-height: 1;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .nav-btn:hover:not(:disabled),
  .close-btn:hover {
    background: var(--accent-soft);
    border-color: var(--accent-strong);
  }
  .nav-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
    padding: var(--s-4);
    min-width: 0;
    overflow-y: auto;
  }
  .meta-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-2);
    font-size: var(--t-13);
    color: var(--text-3);
  }
  .author-avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    background: var(--surface-3);
    color: var(--text-3);
    border: 1px solid var(--border);
    border-radius: 50%;
    font-size: var(--t-12);
    font-weight: var(--w-sb);
    cursor: pointer;
    padding: 0;
  }
  .author-avatar[data-mine="1"] {
    background: var(--accent);
    color: var(--accent-text);
    border-color: var(--accent);
  }
  .kind-tag {
    display: inline-flex;
    align-items: center;
    gap: var(--s-1);
    color: var(--text-3);
  }
  .kind-tag-label {
    font-size: var(--t-12);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: var(--w-sb);
  }
  .meta-src {
    color: var(--text-2);
    font-family: var(--f-sans);
  }
  .meta-sep {
    color: var(--text-3);
  }
  .meta-date {
    color: var(--text-3);
    font-family: var(--f-mono);
    font-variant-numeric: tabular-nums;
  }
  .title-row {
    display: flex;
    align-items: flex-start;
    gap: var(--s-2);
    min-width: 0;
  }
  .title {
    margin: 0;
    font-family: var(--f-sans);
    font-size: var(--t-22);
    font-weight: var(--w-sb);
    line-height: var(--lh-tight);
    letter-spacing: -0.01em;
    color: var(--text);
    word-break: break-word;
    flex: 1 1 auto;
    min-width: 0;
  }
  .title.is-editable {
    cursor: text;
  }
  .title-input {
    min-height: var(--hit);
    padding: var(--s-1) var(--s-3);
    background: var(--surface-3);
    color: var(--text);
    border: 1px solid var(--accent-strong);
    border-radius: var(--r-sm);
    font-family: var(--f-sans);
    font-size: var(--t-22);
    font-weight: var(--w-sb);
    width: 100%;
  }
  .edit-btn {
    flex-shrink: 0;
    width: var(--hit);
    height: var(--hit);
    background: transparent;
    color: var(--text-3);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    cursor: pointer;
    font-size: var(--t-14);
    transition:
      background var(--m-fast) var(--m-ease),
      color var(--m-fast) var(--m-ease);
  }
  .edit-btn:hover {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .url-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-2);
    min-width: 0;
  }
  .url-text {
    color: var(--accent);
    text-decoration: none;
    word-break: break-all;
    font-family: var(--f-mono);
    font-size: var(--t-13);
    flex: 1 1 auto;
    min-width: 0;
  }
  .url-text:hover {
    text-decoration: underline;
    color: var(--accent-strong);
  }
  .url-open {
    color: var(--accent);
    text-decoration: none;
    font-size: var(--t-13);
    padding: var(--s-1) var(--s-2);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    background: var(--surface-3);
  }
  .url-open:hover {
    background: var(--accent-soft);
  }
  .url-input {
    flex: 1 1 auto;
    min-width: 0;
    min-height: var(--hit);
    padding: var(--s-1) var(--s-3);
    background: var(--surface-3);
    color: var(--text);
    border: 1px solid var(--accent-strong);
    border-radius: var(--r-sm);
    font-family: var(--f-mono);
    font-size: var(--t-13);
  }
  .url-empty {
    color: var(--text-3);
    font-style: italic;
    background: transparent;
    border: none;
    padding: 0;
    cursor: default;
    font-family: var(--f-sans);
    font-size: var(--t-13);
  }
  .url-empty.is-editable {
    cursor: pointer;
    text-decoration: underline dotted;
  }
  .url-empty.is-editable:hover {
    color: var(--accent);
  }
  .notes-row {
    display: flex;
    align-items: flex-start;
    gap: var(--s-2);
    min-width: 0;
  }
  .notes {
    margin: 0;
    white-space: pre-wrap;
    line-height: var(--lh-body);
    color: var(--text);
    flex: 1 1 auto;
    min-width: 0;
  }
  .notes.is-editable {
    cursor: text;
  }
  .notes-input {
    width: 100%;
    min-height: 96px;
    padding: var(--s-2) var(--s-3);
    background: var(--surface-3);
    color: var(--text);
    border: 1px solid var(--accent-strong);
    border-radius: var(--r-sm);
    font-family: var(--f-sans);
    font-size: var(--t-14);
    line-height: var(--lh-body);
    resize: vertical;
  }
  .notes-empty {
    color: var(--text-3);
    font-style: italic;
    background: transparent;
    border: none;
    text-align: left;
    padding: 0;
    font-size: var(--t-13);
    font-family: var(--f-sans);
  }
  .notes-empty.is-editable {
    cursor: pointer;
    text-decoration: underline dotted;
  }
  .notes-empty.is-editable:hover {
    color: var(--accent);
  }
  .stats {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-3);
    padding: var(--s-2) var(--s-3);
    background: var(--surface-3);
    border: 1px solid var(--border-hairline);
    border-radius: var(--r-sm);
  }
  .stat {
    display: inline-flex;
    align-items: baseline;
    gap: var(--s-1);
    font-size: var(--t-13);
    color: var(--text-3);
    font-family: var(--f-mono);
    font-variant-numeric: tabular-nums;
  }
  .stat b {
    color: var(--text);
    font-weight: var(--w-sb);
  }
  .games-section {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
  }
  .games-section-label {
    font-size: var(--t-12);
    color: var(--text-3);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: var(--w-sb);
  }
  .games-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-1);
  }
  .game-chip {
    display: inline-flex;
    align-items: center;
    padding: var(--s-1) var(--s-2);
    background: var(--surface-3);
    color: var(--text-2);
    border: 1px solid var(--border);
    border-radius: var(--r-pill);
    font-size: var(--t-12);
  }
  .games-empty {
    color: var(--text-3);
    font-style: italic;
    font-size: var(--t-12);
  }
  .foot {
    display: flex;
    gap: var(--s-2);
    padding: var(--s-3) var(--s-4);
    border-top: 1px solid var(--border-hairline);
  }
  .foot-btn {
    min-height: var(--hit);
    padding: var(--s-2) var(--s-4);
    background: transparent;
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    cursor: pointer;
    font-family: var(--f-sans);
    font-size: var(--t-13);
    font-weight: var(--w-sb);
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .foot-btn:hover {
    background: var(--accent-soft);
    border-color: var(--accent-strong);
  }
  .foot-btn-primary {
    background: var(--accent);
    color: var(--accent-text);
    border-color: var(--accent);
  }
  .foot-btn-primary:hover {
    background: var(--accent-strong);
    border-color: var(--accent-strong);
  }
  .foot-btn-danger {
    color: var(--danger);
    border-color: var(--border);
  }
  .foot-btn-danger:hover {
    background: var(--danger);
    color: #fff;
    border-color: var(--danger);
  }
  @media (prefers-reduced-motion: reduce) {
    .nav-btn,
    .close-btn,
    .edit-btn,
    .url-open,
    .foot-btn {
      transition: none;
    }
  }
</style>
