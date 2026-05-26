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
  // Visual contract: 1:1 with docs/design/v2/ui-kit/event-detail.jsx +
  // its CSS rules (.detail-*) in index.html. Class names match the
  // prototype so the test contract (`.title`, `.notes`, `.game-chip`,
  // `.kind-tag-label`, `.stat b`, `.title-row .edit-btn`, `.title-input`)
  // is preserved alongside the prototype's `.detail-*` selectors.
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
  // Sub-components extracted for maintainability:
  //   - EventDetailHeader — author, kind, source, date, overflow menu, close
  //   - EventDetailStats  — YouTube views/likes/comments row
  //   - EventDetailGames  — attached games chips + "Edit games" button

  import KindIcon from "$lib/components/KindIcon.svelte";
  import NotesEditorModal from "$lib/components/shared/NotesEditorModal.svelte";
  import EventDetailHeader from "./EventDetailHeader.svelte";
  import EventDetailStats from "./EventDetailStats.svelte";
  import EventDetailGames from "./EventDetailGames.svelte";
  import { m } from "$lib/paraglide/messages.js";
  import {
    deriveThumbnailUrl,
    isMediaShape as deriveIsMediaShape,
    type CardEventLite,
  } from "$lib/components/feed/parts/derive-card-data.js";
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
    currentUserName = "",
    onClose,
    onDelete,
    onRestore,
    onDeleteForever,
    onUpdate,
    onOpenGamesPickerForCard,
  }: {
    event: EventDto;
    games: GameDto[];
    sources: DataSourceDto[];
    view?: "feed" | "trash";
    currentUserName?: string;
    onClose: () => void;
    onDelete: (id: string) => Promise<void>;
    onRestore?: (id: string) => Promise<void>;
    onDeleteForever?: (id: string) => Promise<void>;
    onUpdate: (id: string, patch: EventUpdatePatch) => Promise<void>;
    /** Opens the shared GamesPicker (tri-state games + off-topic) for
     *  this event. Same callback FeedCard's ⋮ → Edit games uses, so the
     *  detail surface shares one game-edit path. */
    onOpenGamesPickerForCard?: (id: string) => void;
  } = $props();

  // Inline-edit drafts. null = not editing; string = current draft.
  let titleDraft = $state<string | null>(null);
  // notesEditorOpen flips the big NotesEditorModal (Esc cascade reads
  // this same flag — the modal owns its own draft buffer so we don't
  // need the legacy `notesDraft` string here).
  let notesEditorOpen = $state(false);
  let urlDraft = $state<string | null>(null);

  const inTrash = $derived(view === "trash");

  // Deleted-on-Reddit flag — populated by feed-enrichment from
  // reddit_posts.deletion_detected_at via redditEnrichment.
  const redditDeletedAt = $derived.by((): string | null => {
    const re = (event as { redditEnrichment?: { deletionDetectedAt?: string | null } })
      .redditEnrichment;
    return re?.deletionDetectedAt ?? null;
  });

  // Source name for the byline. Manual-paste events have sourceId=null
  // so this resolves to undefined → byline falls back to "".
  const sourceRow = $derived(
    event.sourceId ? sources.find((s) => s.id === event.sourceId) : undefined,
  );

  const sourceLabel = $derived(
    sourceRow?.channelTitle ?? sourceRow?.displayName ?? sourceRow?.handleUrl ?? "",
  );

  // Compact "Mon, May 12" date format — mirrors prototype dateGroup.
  const occurredHuman = $derived.by(() => {
    const t = typeof event.occurredAt === "string" ? new Date(event.occurredAt) : event.occurredAt;
    const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][t.getDay()];
    const mon = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ][t.getMonth()];
    return `${day}, ${mon} ${t.getDate()}`;
  });

  // ISO date for the native date picker (yyyy-mm-dd).
  const occurredISO = $derived.by(() => {
    const t = typeof event.occurredAt === "string" ? new Date(event.occurredAt) : event.occurredAt;
    const y = t.getFullYear();
    const mo = String(t.getMonth() + 1).padStart(2, "0");
    const d = String(t.getDate()).padStart(2, "0");
    return `${y}-${mo}-${d}`;
  });

  const todayISO = (() => {
    const t = new Date();
    const y = t.getFullYear();
    const mo = String(t.getMonth() + 1).padStart(2, "0");
    const d = String(t.getDate()).padStart(2, "0");
    return `${y}-${mo}-${d}`;
  })();

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
    notesEditorOpen = true;
  }

  async function commitEditNotes(value: string): Promise<void> {
    const next = value.trim();
    const currentNotes = event.notes ?? "";
    if (next !== currentNotes) {
      await onUpdate(event.id, { notes: next.length > 0 ? next : null });
    }
    notesEditorOpen = false;
  }

  function cancelEditNotes(): void {
    notesEditorOpen = false;
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

  // URL is read-only for ALL event kinds. Per user UAT: «url и тип
  // менять нехочется, тк это трекинг и тд, и в этом нет смысла».
  // URL is set at creation only (paste-flow fetches it; manual-flow
  // collects it in AddEventForm); after that it's a permanent link.
  // Delete + recreate if the user needs a different URL.
  const urlIsEditable = $derived(false as boolean);

  // Thumbnail: same derivation FeedCard uses so the detail view reads
  // as a zoomed-in version of the card the user just clicked.
  // - youtube_video: always reserves a 16:9 slot (KindIcon fills the
  //   empty state)
  // - reddit_post / twitter_post / telegram_post: only when image-like
  //   URL is derivable
  // - other kinds: no thumb (showThumb=false)
  const mediaShape = $derived(deriveIsMediaShape(event.kind as CardEventLite["kind"]));
  const thumbnailUrl = $derived(deriveThumbnailUrl(event as unknown as CardEventLite));
  const showDetailThumb = $derived(mediaShape || thumbnailUrl !== null);
  // YouTube click-to-play facade — flips to embedded iframe on user
  // click. Reset whenever the event changes (modal pagination).
  let iframeLoaded = $state(false);
  $effect(() => {
    void event.id;
    iframeLoaded = false;
  });

  async function changeAuthor(isMe: boolean): Promise<void> {
    await onUpdate(event.id, { authorIsMe: isMe });
  }

  // Global keyboard handler — Esc cascades through active drafts, then
  // closes the modal; ←/→ navigate between events when the wrapper says
  // it's safe to do so.
  function onkeydown(e: KeyboardEvent): void {
    // Don't hijack arrows while typing into a field.
    const target = e.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
    ) {
      if (e.key === "Escape") {
        if (titleDraft !== null) {
          cancelEditTitle();
          e.preventDefault();
          return;
        }
        if (notesEditorOpen) {
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
      } else if (notesEditorOpen) {
        cancelEditNotes();
      } else if (urlDraft !== null) {
        cancelEditUrl();
      } else {
        onClose();
      }
      e.preventDefault();
      return;
    }

    // ←/→ keyboard nav removed (D-05 buttons were removed per UAT;
    // detail is now a single-event modal, not a paginated list).
  }

  async function onDateChange(iso: string): Promise<void> {
    if (!iso) return;
    // Only patch if date differs.
    if (iso === occurredISO) return;
    // Build an ISO timestamp at noon local — the prototype only edits
    // calendar day, not time-of-day; noon avoids timezone day-shift.
    const [y, mo, d] = iso.split("-").map((x) => parseInt(x, 10));
    if (!y || !mo || !d) return;
    const t = new Date(y, mo - 1, d, 12, 0, 0);
    await onUpdate(event.id, {
      // occurredAt isn't in EventUpdatePatch yet — the API endpoint
      // accepts it though. Cast through unknown to keep types honest.
      ...({ occurredAt: t.toISOString() } as unknown as EventUpdatePatch),
    });
  }

  // svelte-ignore a11y_no_static_element_interactions
</script>

<svelte:window {onkeydown} />

<div class="event-detail-content" data-view={view} style="--card-accent: var(--k-{event.kind});">
  <EventDetailHeader
    {event}
    {view}
    {currentUserName}
    {sourceLabel}
    {occurredHuman}
    {occurredISO}
    {todayISO}
    {onClose}
    {onDelete}
    {onRestore}
    {onDeleteForever}
    {onDateChange}
    onChangeAuthor={changeAuthor}
  />

  {#if redditDeletedAt}
    <div class="detail-deleted-banner" role="status">
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <polyline points="3 6 5 6 21 6" />
        <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6" />
        <path d="M10 11v6" /><path d="M14 11v6" />
      </svg>
      <span><strong>Deleted on Reddit.</strong> The post is no longer reachable.</span>
    </div>
  {/if}

  <div class="detail-body">
    <!-- Title: inline-editable, pencil edit-btn affordance. -->
    {#if titleDraft !== null && !inTrash}
      <input
        class="detail-title detail-title-input title-input"
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
      <div class="detail-editable-row title-row">
        <!-- Title is read-only text — pencil button is the only edit
             affordance. On mobile, tap-to-scroll vs tap-to-edit are
             indistinguishable, so the text doesn't carry a click handler.
             Same convention applies to notes below. -->
        <h2 class="detail-title title">{event.title}</h2>
        {#if !inTrash}
          <button
            type="button"
            class="detail-edit-btn edit-btn"
            onclick={startEditTitle}
            aria-label={m.event_detail_edit_title_aria()}
            title={m.event_detail_edit_title_aria()}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.75"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M11 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6" />
              <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
          </button>
        {/if}
      </div>
    {/if}

    <!-- URL row — mono, truncated, with edit pencil for freeform kinds. -->
    {#if urlDraft !== null && urlIsEditable}
      <div class="detail-url">
        <input
          class="detail-url-input"
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
      <div class="detail-url">
        {#if event.url}
          <a
            class="detail-url-text"
            href={event.url}
            target="_blank"
            rel="noopener noreferrer"
            title={event.url}>{event.url}</a
          >
          {#if urlIsEditable}
            <button
              type="button"
              class="detail-url-edit"
              onclick={startEditUrl}
              aria-label={m.event_detail_edit_url_aria()}
              title={m.event_detail_edit_url_aria()}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.75"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M11 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6" />
                <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            </button>
          {/if}
        {:else if urlIsEditable}
          <button
            type="button"
            class="detail-url-text detail-url-empty is-editable"
            onclick={startEditUrl}
            aria-label={m.event_detail_edit_url_aria()}
          >
            {m.event_detail_url_click_to_add()}
          </button>
        {:else}
          <span class="detail-url-text detail-url-empty">{m.event_detail_url_empty()}</span>
        {/if}
      </div>
    {/if}

    <!-- Thumbnail / playable preview — 16:9 media slot. For YouTube we
         use a click-to-play facade: thumb + ▶ overlay → click → swap
         to an embedded iframe (no autoload to keep dialog open cheap;
         iframe pulls ~500KB of YT player JS only when the user opts in).
         For Reddit image posts we just show the static image. -->
    {#if showDetailThumb}
      {#if event.kind === "youtube_video" && !iframeLoaded}
        <button
          type="button"
          class="detail-thumb detail-thumb-yt-facade"
          class:empty={thumbnailUrl === null}
          onclick={() => (iframeLoaded = true)}
          aria-label="Play video preview"
        >
          {#if thumbnailUrl}
            <img src={thumbnailUrl} alt="" referrerpolicy="no-referrer" />
          {:else}
            <KindIcon kind={event.kind} size={48} />
          {/if}
          <span class="detail-thumb-play" aria-hidden="true">
            <svg width="56" height="56" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M8 5v14l11-7z" />
            </svg>
          </span>
        </button>
      {:else if event.kind === "youtube_video" && iframeLoaded && event.externalId}
        <div class="detail-thumb detail-thumb-iframe">
          <iframe
            src="https://www.youtube.com/embed/{event.externalId}?autoplay=1"
            title="YouTube video player"
            frameborder="0"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            referrerpolicy="strict-origin-when-cross-origin"
            allowfullscreen
          ></iframe>
        </div>
      {:else}
        <div class="detail-thumb" class:empty={thumbnailUrl === null}>
          {#if thumbnailUrl}
            <img src={thumbnailUrl} alt="" referrerpolicy="no-referrer" />
          {:else}
            <KindIcon kind={event.kind} size={48} />
          {/if}
        </div>
      {/if}
    {/if}

    <!-- Notes — read-only display. Editing opens a separate big dialog. -->
    {#if event.notes}
      <div class="detail-editable-row notes-row">
        <p class="detail-notes notes">{event.notes}</p>
        {#if !inTrash}
          <button
            type="button"
            class="detail-edit-btn edit-btn"
            onclick={startEditNotes}
            aria-label={m.event_detail_edit_notes_aria()}
            title={m.event_detail_edit_notes_aria()}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.75"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M11 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6" />
              <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
          </button>
        {/if}
      </div>
    {:else if !inTrash}
      <button
        type="button"
        class="detail-notes detail-notes-empty is-editable detail-empty-btn"
        onclick={startEditNotes}
      >
        {m.event_detail_notes_click_to_add()}
      </button>
    {:else}
      <p class="detail-notes detail-notes-empty">{m.event_detail_notes_empty()}</p>
    {/if}

    {#if stats}
      <EventDetailStats {stats} />
    {/if}

    <EventDetailGames
      {event}
      {games}
      {view}
      {onOpenGamesPickerForCard}
    />
  </div>

  <!-- Footer dock removed — every action moved into the header strip:
       × close + ⋮ overflow (Delete / Restore / Delete forever) +
       RefreshNowButton for YouTube. Mirrors modal pattern in
       AddEventModal / GamesPicker (no bottom action dock). -->
</div>

<!-- Notes editor — shared NotesEditorModal (DRY-extract per audit). -->
<NotesEditorModal
  open={notesEditorOpen && !inTrash}
  initialValue={event.notes ?? ""}
  title={m.event_detail_edit_notes_aria()}
  maxLength={4000}
  onSave={(value) => commitEditNotes(value)}
  onCancel={cancelEditNotes}
/>

<style>
  /* Orchestrator layout — only the content wrapper + body scroll + elements
   * that remain in the orchestrator (title, URL, thumb, notes, banner). */

  .event-detail-content {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    min-width: 0;
    background: var(--surface);
    color: var(--text);
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  /* ── Body ─────────────────────────────────────────────────────────── */
  .detail-body {
    flex: 1;
    overflow-y: auto;
    padding: 10px 22px 24px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  /* ── Title ────────────────────────────────────────────────────────── */
  .detail-title {
    margin: 4px 0 4px;
    font-size: 22px;
    font-weight: var(--w-sb);
    line-height: 1.25;
    color: var(--text);
    letter-spacing: -0.012em;
  }
  .detail-editable-row {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    min-width: 0;
  }
  .detail-editable-row > :first-child {
    flex: 1;
    min-width: 0;
  }
  .detail-edit-btn {
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    margin-top: 4px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--r-sm);
    color: var(--text-3);
    cursor: pointer;
    opacity: 0.55;
    transition:
      background var(--m-fast),
      border-color var(--m-fast),
      color var(--m-fast),
      opacity var(--m-fast);
  }
  @media (hover: hover) {
    .detail-editable-row:hover .detail-edit-btn {
      opacity: 1;
    }
  }
  @media (hover: none) {
    .detail-edit-btn {
      opacity: 0.7;
    }
  }
  .detail-edit-btn:hover {
    background: var(--surface-2);
    border-color: var(--border);
    color: var(--text);
    opacity: 1;
  }

  .detail-empty-btn {
    width: 100%;
    background: transparent;
    border: 0;
    padding: 4px 8px;
    margin-left: -8px;
    text-align: left;
    cursor: pointer;
  }
  .detail-title.is-editable,
  .detail-notes.is-editable {
    cursor: text;
    padding: 4px 8px;
    margin-left: -8px;
    margin-right: -8px;
    border-radius: var(--r-sm);
    transition:
      background var(--m-fast) var(--m-ease),
      box-shadow var(--m-fast) var(--m-ease);
  }
  @media (hover: hover) {
    .detail-title.is-editable:hover,
    .detail-notes.is-editable:hover {
      background: var(--surface-2);
      box-shadow: inset 0 0 0 1px var(--border-hairline);
    }
  }
  .detail-title-input,
  .detail-notes-input {
    width: calc(100% + 16px);
    margin-left: -8px;
    padding: 4px 8px !important;
    background: var(--surface-2);
    border: 1px solid var(--accent) !important;
    border-radius: var(--r-sm);
    color: var(--text);
    font: inherit;
    outline: none;
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .detail-title-input {
    font-size: 22px;
    font-weight: var(--w-sb);
    line-height: 1.25;
    letter-spacing: -0.012em;
  }
  .detail-notes-input {
    min-height: 240px;
    font-family: var(--f-sans);
    font-size: var(--t-14);
    line-height: 1.55;
    resize: vertical;
  }

  /* ── Thumbnail (16:9 media slot) ──────────────────────────────────── */
  .detail-thumb {
    position: relative;
    aspect-ratio: 16 / 9;
    width: 100%;
    flex-shrink: 0;
    background: var(--surface-2);
    border: 1px solid var(--border-hairline);
    border-radius: var(--r-md);
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-4);
  }
  .detail-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .detail-thumb.empty :global(svg.kind) {
    color: var(--card-accent, var(--text-4));
    opacity: 0.55;
  }
  .detail-thumb-yt-facade {
    cursor: pointer;
    padding: 0;
    border: 1px solid var(--border-hairline);
  }
  .detail-thumb-yt-facade:hover .detail-thumb-play {
    background: rgba(255, 0, 0, 0.95);
    transform: translate(-50%, -50%) scale(1.05);
  }
  .detail-thumb-play {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 64px;
    height: 64px;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.65);
    color: #fff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    transition:
      background var(--m-fast),
      transform var(--m-fast);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  }
  .detail-thumb-iframe iframe {
    width: 100%;
    height: 100%;
    border: 0;
  }

  /* ── URL row ──────────────────────────────────────────────────────── */
  .detail-url {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .detail-url-text {
    flex: 1;
    min-width: 0;
    padding: 2px 6px;
    margin-left: -6px;
    background: transparent;
    border: 0;
    text-align: left;
    font-family: var(--f-mono);
    font-size: 11px;
    color: var(--text-3);
    text-decoration: underline;
    text-underline-offset: 2px;
    text-decoration-color: color-mix(in oklab, var(--text-3) 40%, transparent);
    text-overflow: ellipsis;
    overflow: hidden;
    white-space: nowrap;
    border-radius: var(--r-sm);
    transition:
      background var(--m-fast) var(--m-ease),
      color var(--m-fast) var(--m-ease),
      text-decoration-color var(--m-fast) var(--m-ease);
  }
  .detail-url-text:hover {
    color: var(--text);
    text-decoration-color: var(--text-2);
    background: var(--surface-2);
  }
  .detail-url-empty {
    color: var(--text-4);
    font-style: italic;
    font-family: var(--f-sans);
    font-size: var(--t-13);
    text-decoration: none;
    cursor: pointer;
  }
  .detail-url-empty:hover {
    color: var(--text-2);
    text-decoration: none;
  }
  .detail-url-edit {
    width: 28px;
    height: 28px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--r-sm);
    color: var(--text-3);
    cursor: pointer;
    flex-shrink: 0;
    transition:
      background var(--m-fast),
      border-color var(--m-fast),
      color var(--m-fast);
  }
  .detail-url-edit:hover {
    background: var(--surface-2);
    border-color: var(--border);
    color: var(--text);
  }
  .detail-url-input {
    width: calc(100% + 16px) !important;
    margin-left: -8px;
    padding: 4px 8px !important;
    background: var(--surface-2);
    border: 1px solid var(--accent) !important;
    border-radius: var(--r-sm);
    color: var(--text);
    font-family: var(--f-mono);
    font-size: 12px;
    outline: none;
    box-shadow: 0 0 0 3px var(--accent-soft);
    min-height: 32px;
  }

  /* ── Notes ────────────────────────────────────────────────────────── */
  .detail-notes {
    margin: 0;
    color: var(--text);
    font-size: var(--t-14);
    line-height: 1.55;
    white-space: pre-wrap;
  }
  .detail-notes-empty {
    color: var(--text-3);
    font-style: italic;
  }

  /* ── Deleted-on-Reddit banner ─────────────────────────────────────── */
  .detail-deleted-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 22px;
    background: color-mix(in oklab, var(--danger) 12%, var(--surface));
    border-top: 1px solid color-mix(in oklab, var(--danger) 30%, var(--border));
    border-bottom: 1px solid color-mix(in oklab, var(--danger) 30%, var(--border));
    color: var(--danger);
    font-size: var(--t-13);
    flex-shrink: 0;
  }

  /* Mobile */
  @media (max-width: 640px) {
    .detail-body {
      padding: 14px 16px 18px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .detail-edit-btn,
    .detail-url-edit {
      transition: none;
    }
  }
</style>
