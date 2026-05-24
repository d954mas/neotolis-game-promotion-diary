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

  import KindIcon from "$lib/components/KindIcon.svelte";
  import AuthorPopover from "$lib/components/shared/AuthorPopover.svelte";
  import NotesEditorModal from "$lib/components/shared/NotesEditorModal.svelte";
  import PollingBadge from "$lib/components/PollingBadge.svelte";
  import { m } from "$lib/paraglide/messages.js";
  import { gameColor } from "$lib/util/game-color.js";
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
    onOpenGamesPickerForCard,
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
  let authorPopoverOpen = $state(false);
  let authorAvatarEl = $state<HTMLButtonElement | null>(null);
  let overflowOpen = $state(false);

  const inTrash = $derived(view === "trash");

  // Deleted-on-Reddit flag — populated by feed-enrichment from
  // reddit_posts.deletion_detected_at via redditEnrichment.
  const redditDeletedAt = $derived.by((): string | null => {
    const re = (event as { redditEnrichment?: { deletionDetectedAt?: string | null } })
      .redditEnrichment;
    return re?.deletionDetectedAt ?? null;
  });

  // Off-topic flag — written by GamesPicker into metadata.triage.offTopic.
  const isOffTopic = $derived.by((): boolean => {
    const md = (event.metadata ?? {}) as { triage?: { offTopic?: boolean } };
    return md.triage?.offTopic === true;
  });

  // Iterate the canonical `games` list (server-ordered desc createdAt)
  // instead of event.gameIds — junction-row order is non-deterministic.
  // Filtering the ordered list keeps the chip sequence identical to
  // BaseFeedCard + filter-axis chip ordering.
  const attachedGameSet = $derived(new Set(event.gameIds));
  const attachedGames = $derived(
    games.filter((g) => attachedGameSet.has(g.id)),
  );

  // Source name for the byline. Manual-paste events have sourceId=null
  // so this resolves to undefined → byline falls back to "".
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

  // Compact "Mon, May 12" date format — mirrors prototype dateGroup.
  const occurredHuman = $derived.by(() => {
    const t =
      typeof event.occurredAt === "string"
        ? new Date(event.occurredAt)
        : event.occurredAt;
    const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][t.getDay()];
    const mon = [
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ][t.getMonth()];
    return `${day}, ${mon} ${t.getDate()}`;
  });

  // ISO date for the native date picker (yyyy-mm-dd).
  const occurredISO = $derived.by(() => {
    const t =
      typeof event.occurredAt === "string"
        ? new Date(event.occurredAt)
        : event.occurredAt;
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

  // Per-source byline (e.g. reddit r/sub author u/handle). For YouTube
  // and reddit_post the channelTitle/handleUrl is already in `sourceLabel`,
  // so a real byline only exists if a future schema field is added.
  // Today we leave it null — the prototype shows it for reddit_post only.
  const byline: string | null = null;

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

    if (e.key === "ArrowLeft" && hasPrev) {
      onPrev?.();
      e.preventDefault();
    }
    if (e.key === "ArrowRight" && hasNext) {
      onNext?.();
      e.preventDefault();
    }
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

<div
  class="event-detail-content"
  data-view={view}
  style="--card-accent: var(--k-{event.kind});"
>
  <!-- Header: rich strip with author + kind icon + kind label + source +
       date + ×. Replaces the bare 'Event details' label and the in-body
       meta row — saves a row of vertical body real estate (more space
       for thumbnail / notes) AND lets the user see + edit primary
       metadata without scrolling. User UAT: «может автора и тип и дату
       прям в заголовок вместо event details». -->
  <header class="detail-head">
    {#if !inTrash}
      <!-- AuthorPopover renders fixed-position via `anchor` prop so it
           escapes the modal's overflow:hidden clip. -->
      <button
        type="button"
        bind:this={authorAvatarEl}
        class="author-avatar detail-author-trigger"
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
          anchor={authorAvatarEl}
          onchange={changeAuthor}
          onclose={() => (authorPopoverOpen = false)}
        />
      {/if}
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

    <span class="kind-icon" title={kindLabel}>
      <KindIcon kind={event.kind} size={18} />
    </span>
    <span class="detail-kind-label">{kindLabel}</span>

    {#if sourceLabel}
      <span class="detail-sep" aria-hidden="true">·</span>
      <span class="detail-src" title={sourceLabel}>{sourceLabel}</span>
    {/if}

    <span class="detail-sep" aria-hidden="true">·</span>

    {#if !inTrash}
      <span class="detail-date-edit">
        <span class="detail-date">{occurredHuman}</span>
        <span class="detail-date-pencil" aria-hidden="true">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M11 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6"/>
            <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
        </span>
        <input
          type="date"
          class="detail-date-native"
          value={occurredISO}
          max={todayISO}
          onchange={(e) => onDateChange((e.target as HTMLInputElement).value)}
          aria-label="Change date"
          title="Change date"
        />
      </span>
    {:else}
      <span class="detail-date">{occurredHuman}</span>
    {/if}

    <span class="detail-head-spacer"></span>

    {#if !inTrash && (event.kind === "youtube_video" || event.kind === "reddit_post")}
      <PollingBadge
        event={{
          id: event.id,
          kind: event.kind,
          occurredAt: event.occurredAt,
          publishedAt: event.publishedAt ?? null,
          lastPolledAt: event.lastPolledAt ?? null,
          lastPollStatus: event.lastPollStatus ?? null,
          metadata: (event.metadata ?? null) as Record<string, unknown> | null,
        }}
      />
    {/if}

    {#if !inTrash || onRestore || onDeleteForever}
      <div class="detail-head-overflow">
        <button
          type="button"
          class="detail-close-btn"
          onclick={() => (overflowOpen = !overflowOpen)}
          aria-haspopup="menu"
          aria-expanded={overflowOpen}
          aria-label="More actions"
          title="More actions"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="5" cy="12" r="1.8" fill="currentColor" />
            <circle cx="12" cy="12" r="1.8" fill="currentColor" />
            <circle cx="19" cy="12" r="1.8" fill="currentColor" />
          </svg>
        </button>
        {#if overflowOpen}
          <div
            class="author-pick-scrim"
            onclick={() => (overflowOpen = false)}
            role="presentation"
          ></div>
          <div class="detail-head-overflow-pop" role="menu">
            {#if inTrash && onRestore}
              <button
                type="button"
                class="card-menu-item"
                onclick={() => {
                  overflowOpen = false;
                  void onRestore?.(event.id);
                }}
              >{m.event_detail_footer_restore()}</button>
            {/if}
            {#if inTrash && onDeleteForever}
              <button
                type="button"
                class="card-menu-item danger"
                onclick={() => {
                  overflowOpen = false;
                  void onDeleteForever?.(event.id);
                }}
              >{m.event_detail_footer_delete_forever()}</button>
            {:else if !inTrash}
              <button
                type="button"
                class="card-menu-item danger"
                onclick={() => {
                  overflowOpen = false;
                  void onDelete(event.id);
                }}
              >{m.events_detail_delete()}</button>
            {/if}
          </div>
        {/if}
      </div>
    {/if}

    <button
      type="button"
      class="detail-close-btn"
      onclick={onClose}
      aria-label={m.event_detail_modal_close_aria()}
      title={m.event_detail_modal_close_aria()}
    >×</button>
  </header>

  {#if redditDeletedAt}
    <div class="detail-deleted-banner" role="status">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
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
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M11 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6"/>
              <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
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
            title={event.url}
          >{event.url}</a>
          {#if urlIsEditable}
            <button
              type="button"
              class="detail-url-edit"
              onclick={startEditUrl}
              aria-label={m.event_detail_edit_url_aria()}
              title={m.event_detail_edit_url_aria()}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M11 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6"/>
                <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
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

    <!-- Notes — read-only display. Editing opens a separate big dialog
         (see <dialog class="notes-editor-modal"> at the end of this
         file) so the user gets full-page real estate for long notes
         without the parent modal's body-scroll constraints. -->
    {#if event.notes}
      <div class="detail-editable-row notes-row">
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- Notes are read-only here — pencil button below opens the
             big notes-editor modal. No click-on-text edit handler
             because mobile tap-to-scroll would accidentally fire it. -->
        <p class="detail-notes notes">{event.notes}</p>
        {#if !inTrash}
          <button
            type="button"
            class="detail-edit-btn edit-btn"
            onclick={startEditNotes}
            aria-label={m.event_detail_edit_notes_aria()}
            title={m.event_detail_edit_notes_aria()}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M11 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6"/>
              <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
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

    <!-- Stats — inline icon row, same vocabulary as FeedCard but a
         touch larger. User UAT: «1578 views 91 likes 8 comments много
         места занимает. На превью меньше и читаемо. Можно в таком
         стиле только чуть больше». -->
    {#if stats}
      <div class="detail-stats stats">
        <span class="detail-stat stat" title={m.event_detail_stat_views()}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          <span class="detail-stat-num">{stats.viewCount.toLocaleString()}</span>
        </span>
        <span class="detail-stat stat" title={m.event_detail_stat_likes()}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
          </svg>
          <span class="detail-stat-num">{stats.likeCount.toLocaleString()}</span>
        </span>
        <span class="detail-stat stat" title={m.event_detail_stat_comments()}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          <span class="detail-stat-num">{stats.commentCount.toLocaleString()}</span>
        </span>
      </div>
    {/if}

    <!-- Games + off-topic — show ONLY attached. Editing happens through
         the shared GamesPicker (tri-state games + off-topic row) via the
         "Edit games" button — same path FeedCard's ⋮ → Edit games uses,
         so the detail surface doesn't duplicate the picker chip-grid
         inline. -->
    <div class="detail-section">
      <div class="detail-section-head">
        <span class="detail-section-label">{m.event_detail_section_games()}</span>
        {#if !inTrash && onOpenGamesPickerForCard}
          <button
            type="button"
            class="detail-section-edit"
            onclick={() => onOpenGamesPickerForCard?.(event.id)}
          >+ {m.feed_card_menu_edit_games()}</button>
        {/if}
      </div>
      <div class="detail-game-row">
        {#if attachedGames.length === 0 && !isOffTopic}
          <span class="inbox-chip">{m.inbox_badge()}</span>
        {/if}
        {#each attachedGames as g (g.id)}
          <span class="game-chip" style="--card-accent: {gameColor(g.id)};">{g.title}</span>
        {/each}
        {#if isOffTopic}
          <span class="off-topic-chip">Off topic</span>
        {/if}
      </div>
    </div>
  </div>

  <!-- Footer dock removed — every action moved into the header strip:
       × close + ⋮ overflow (Delete / Restore / Delete forever) +
       RefreshNowButton for YouTube. Mirrors modal pattern in
       AddEventModal / GamesPicker (no bottom action dock). -->
</div>

<!-- Notes editor — shared NotesEditorModal (DRY-extract per audit).
     User UAT: «может большое отдельное модальное вью, заметки это важно
     и там может быть много текста». The shared component preserves the
     bigger-surface + header + footer + Cmd/Ctrl+Enter + Esc / backdrop
     cancel contract verbatim. The Esc cascade above also reads
     `notesEditorOpen` so cancel-on-Esc inside the parent
     event-detail-modal still works. -->
<NotesEditorModal
  open={notesEditorOpen && !inTrash}
  initialValue={event.notes ?? ""}
  title={m.event_detail_edit_notes_aria()}
  maxLength={4000}
  onSave={(value) => commitEditNotes(value)}
  onCancel={cancelEditNotes}
/>

<style>
  /* Prototype 1:1 — class names mirror docs/design/v2/ui-kit/index.html
   * .detail-* selectors. Test-contract class aliases (`.title`, `.notes`,
   * `.title-row`, `.notes-row`, `.title-input`, `.notes-input`, `.stat`,
   * `.game-chip`, `.kind-tag-label`, `.edit-btn`) are kept alongside so
   * the existing browser parity test keeps passing. */

  .event-detail-content {
    /* Fills the dialog's column-flex container as the sole child.
     * `flex: 1` makes it claim the remaining height; `min-height: 0`
     * is REQUIRED so the inner .detail-body's `overflow-y: auto`
     * actually scrolls — without min-height:0 the flex item refuses
     * to shrink below content size, the scroll context is lost, and
     * notes blow past the dialog bottom (and past .detail-foot). */
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
    width: 1px; height: 1px;
    padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0, 0, 0, 0);
    white-space: nowrap; border: 0;
  }

  /* ── Header (nav only; close moved to bottom dock) ────────────────── */
  .detail-head {
    display: flex; align-items: center; gap: 6px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border-hairline);
    flex-shrink: 0;
  }
  /* Rich header strip — [author][kind-icon][kind-label][src][date][×].
   * flex-wrap so narrow viewports stack into 2 lines instead of clipping. */
  .detail-head {
    flex-wrap: wrap;
  }
  .detail-head-spacer {
    flex: 1;
  }
  .detail-head .author-avatar {
    width: 26px;
    height: 26px;
    font-size: 11px;
  }
  .detail-head .kind-icon {
    color: var(--card-accent, var(--text-2));
    display: inline-flex;
    align-items: center;
  }
  .detail-head .kind-icon :global(svg.kind) {
    color: inherit;
  }
  .detail-head .detail-kind-label {
    color: var(--text);
    font-weight: var(--w-sb);
    font-size: var(--t-13);
  }
  .detail-head .detail-src {
    font-family: var(--f-mono);
    font-size: 12px;
    color: var(--text-2);
    max-width: 240px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .detail-head .detail-sep {
    color: var(--text-4);
  }
  .detail-head .detail-date {
    color: var(--text-2);
    font-family: var(--f-mono);
    font-size: 12px;
  }
  /* ⋮ overflow in header — sibling of × close. Popover anchored via
   * position:relative on .detail-head-overflow. */
  .detail-head-overflow {
    position: relative;
  }
  .detail-head-overflow-pop {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    min-width: 180px;
    background: var(--surface);
    border: 1px solid var(--border-2);
    border-radius: var(--r-md);
    box-shadow: var(--shadow-elev);
    padding: 4px;
    display: flex;
    flex-direction: column;
    z-index: 50;
  }
  .detail-head-overflow-pop .card-menu-item {
    background: transparent;
    border: none;
    text-align: left;
    padding: 8px 12px;
    font-size: var(--t-13);
    color: var(--text);
    cursor: pointer;
    border-radius: var(--r-sm);
  }
  .detail-head-overflow-pop .card-menu-item:hover {
    background: var(--accent-soft);
  }
  .detail-head-overflow-pop .card-menu-item.danger {
    color: var(--danger);
  }
  .detail-head-overflow-pop .card-menu-item.danger:hover {
    background: color-mix(in oklab, var(--danger) 12%, var(--surface));
  }
  /* × close button — mirrors AddEventModal / GamesPicker close affordance.
   * Sits at the top-right of the detail header. */
  .detail-close-btn {
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
    transition:
      background var(--m-fast),
      color var(--m-fast),
      border-color var(--m-fast);
  }
  .detail-close-btn:hover {
    background: var(--surface-2);
    border-color: var(--border);
    color: var(--text);
  }
  .detail-close-btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  /* ── Body ─────────────────────────────────────────────────────────── */
  .detail-body {
    flex: 1;
    overflow-y: auto;
    padding: 10px 22px 24px;
    display: flex; flex-direction: column;
    gap: 8px;
  }

  /* ── Meta line: author + kind icon + src · date ──────────────────── */
  .detail-meta {
    display: flex; align-items: center; gap: 8px;
    color: var(--text-3);
    font-size: var(--t-12);
    flex-wrap: wrap;
  }
  .detail-meta-compact {
    gap: 8px;
    font-size: var(--t-13);
    color: var(--text-3);
  }
  .detail-meta-compact .kind-icon {
    display: inline-flex; align-items: center; justify-content: center;
    flex-shrink: 0;
    color: var(--card-accent, var(--text-2));
  }
  /* KindIcon's inner <svg.kind> forces text-3 — override so currentColor
   * flows from --card-accent. Same trick BaseFeedCard uses. */
  .detail-meta-compact .kind-icon :global(svg.kind) {
    color: inherit;
  }
  .detail-meta-compact .detail-kind-label {
    color: var(--text-2);
    font-weight: var(--w-md);
    font-size: var(--t-13);
    flex-shrink: 0;
  }
  .detail-meta-compact .detail-src {
    font-family: var(--f-mono);
    font-size: 12px;
    color: var(--text-2);
    flex: 0 1 auto;
    text-overflow: ellipsis; overflow: hidden; white-space: nowrap;
    max-width: 240px;
  }
  .detail-sep { color: var(--text-4); }
  .detail-date {
    color: var(--text-2);
    font-family: var(--f-mono);
    font-size: 11.5px;
  }

  /* ── Thumbnail (16:9 media slot) ──────────────────────────────────── *
   * flex-shrink:0 is LOAD-BEARING — the parent .detail-body is a flex
   * column with overflow:auto. Without flex-shrink:0, flex layout
   * happily collapses the aspect-ratio-sized thumb when content is
   * taller than the viewport, producing a 60-80px sliver instead of
   * the 16:9 panel the user expects. */
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
  /* YouTube click-to-play facade — thumb + centered play overlay.
   * Whole thing is a <button> so keyboard + screen readers get a real
   * activation target. */
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
    transition: background var(--m-fast), transform var(--m-fast);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  }
  .detail-thumb-iframe iframe {
    width: 100%;
    height: 100%;
    border: 0;
  }

  .author-avatar {
    display: inline-flex; align-items: center; justify-content: center;
    width: 22px; height: 22px;
    background: var(--surface-3);
    color: var(--text-3);
    border: 1px solid var(--border);
    border-radius: 50%;
    font-size: 11px; font-weight: var(--w-sb);
    padding: 0;
  }
  .author-avatar[data-mine="1"] {
    background: var(--accent);
    color: var(--accent-text);
    border-color: var(--accent);
  }
  .author-avatar.detail-author-trigger {
    cursor: pointer;
    transition: transform var(--m-fast) var(--m-ease),
                box-shadow var(--m-fast) var(--m-ease);
  }
  @media (hover: hover) {
    .author-avatar.detail-author-trigger:hover {
      transform: scale(1.1);
      box-shadow: 0 0 0 2px var(--accent-soft);
    }
  }

  /* Editable date — visible text + native input layered invisibly. */
  .detail-date-edit {
    position: relative;
    display: inline-flex; align-items: center; gap: 4px;
    padding: 2px 6px;
    margin: -2px 0;
    border-radius: var(--r-xs);
    cursor: pointer;
    transition: background var(--m-fast) var(--m-ease);
  }
  .detail-date-pencil {
    display: inline-flex; align-items: center; justify-content: center;
    color: var(--text-4);
    opacity: 0.7;
    transition: color var(--m-fast), opacity var(--m-fast);
  }
  @media (hover: hover) {
    .detail-date-edit:hover {
      background: var(--surface-2);
      box-shadow: inset 0 0 0 1px var(--border-hairline);
    }
    .detail-date-edit:hover .detail-date-pencil {
      color: var(--text-2);
      opacity: 1;
    }
  }
  .detail-date-edit .detail-date {
    pointer-events: none;
  }
  .detail-date-native {
    position: absolute; inset: 0;
    opacity: 0;
    cursor: pointer;
    padding: 0; border: 0;
    background: transparent;
    color-scheme: dark;
    font: inherit;
  }
  :global([data-theme="light"]) .detail-date-native { color-scheme: light; }

  .detail-byline {
    flex-basis: 100%;
    color: var(--text-3);
    font-family: var(--f-mono);
    font-size: 11.5px;
    margin-top: -2px;
    padding-left: 30px;
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
    display: flex; align-items: flex-start; gap: 6px;
    min-width: 0;
  }
  .detail-editable-row > :first-child {
    flex: 1; min-width: 0;
  }
  .detail-edit-btn {
    flex-shrink: 0;
    width: 28px; height: 28px;
    margin-top: 4px;
    display: inline-flex; align-items: center; justify-content: center;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--r-sm);
    color: var(--text-3);
    cursor: pointer;
    opacity: 0.55;
    transition: background var(--m-fast), border-color var(--m-fast),
                color var(--m-fast), opacity var(--m-fast);
  }
  @media (hover: hover) {
    .detail-editable-row:hover .detail-edit-btn { opacity: 1; }
  }
  @media (hover: none) {
    .detail-edit-btn { opacity: 0.7; }
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
    margin-left: -8px; margin-right: -8px;
    border-radius: var(--r-sm);
    transition: background var(--m-fast) var(--m-ease),
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

  /* .notes-editor-* styles moved to NotesEditorModal.svelte (DRY per
   * audit). The component's open prop is bound to notesEditorOpen
   * above; cancel/save callbacks go through the same draft-state +
   * Save/Cancel/Esc/Cmd+Enter contract the inlined version used. */
  /* Save / Cancel row for notes editing. Replaces blur-to-save because
   * users couldn't tell when blur fires (closing the modal mid-edit
   * lost the draft). Explicit buttons + Cmd/Ctrl+Enter shortcut + Esc
   * to cancel — same vocab as Add Event modal footer. */
  .detail-notes-editor {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .detail-notes-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  /* Deleted-on-Reddit banner — full-width danger-tinted strip between
   * the header and the body so the user can't miss the deletion when
   * opening the detail card. */
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

  /* Primary action button (Save in notes-editor-modal, etc). The
   * default .btn rule sets border:1px solid transparent — that left
   * the Save button reading as white-on-white inside the notes editor
   * because no class besides .btn applied. Explicit accent fill +
   * accent-text label makes it readable. */
  .btn.primary {
    background: var(--accent);
    color: var(--accent-text);
    border: 1px solid var(--accent);
    font-weight: var(--w-sb);
  }
  .btn.primary:hover {
    background: var(--accent-strong);
    border-color: var(--accent-strong);
  }

  /* ── URL row ──────────────────────────────────────────────────────── */
  .detail-url {
    display: flex; align-items: center; gap: 8px;
    min-width: 0;
  }
  .detail-url-text {
    flex: 1; min-width: 0;
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
    text-overflow: ellipsis; overflow: hidden; white-space: nowrap;
    border-radius: var(--r-sm);
    transition: background var(--m-fast) var(--m-ease),
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
    width: 28px; height: 28px;
    display: inline-flex; align-items: center; justify-content: center;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--r-sm);
    color: var(--text-3);
    cursor: pointer;
    flex-shrink: 0;
    transition: background var(--m-fast), border-color var(--m-fast), color var(--m-fast);
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

  /* ── Stats ────────────────────────────────────────────────────────── */
  .detail-stats {
    display: flex;
    flex-wrap: wrap;
    gap: 18px;
    padding: 4px 0;
    color: var(--text-3);
  }
  .detail-stat {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: var(--t-13);
  }
  .detail-stat-num {
    color: var(--text);
    font-weight: var(--w-sb);
    font-variant-numeric: tabular-nums;
  }

  /* ── Section (Games) ──────────────────────────────────────────────── */
  .detail-section {
    display: flex; flex-direction: column; gap: 8px;
    padding-top: 6px;
  }
  /* Row that pairs the section label with its inline edit affordance.
   * gap:10 so the chip-button sits right beside the GAMES label rather
   * than pushed to the right edge of the section. */
  .detail-section-head {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .detail-section-label {
    font-size: 10.5px;
    font-weight: var(--w-sb);
    color: var(--text-3);
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }
  /* Edit-games chip-button — same dashed accent silhouette as the
   * attach-chip on FeedCard. Opens the shared GamesPicker. */
  .detail-section-edit {
    padding: 3px 10px;
    background: transparent;
    border: 1px dashed color-mix(in oklab, var(--accent) 60%, var(--border));
    border-radius: var(--r-pill);
    color: var(--accent);
    font-size: var(--t-12);
    font-weight: var(--w-sb);
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease),
      color var(--m-fast) var(--m-ease);
  }
  .detail-section-edit:hover {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent-strong);
  }
  .detail-game-row {
    display: flex; flex-wrap: wrap; gap: 6px;
    align-items: center;
  }

  /* ── Chip-grid (games picker) — same vocab as AddEventForm ──────── */
  .kind-grid {
    display: flex; flex-wrap: wrap; gap: 6px;
    align-items: center;
  }
  .chip {
    display: inline-flex; align-items: center; gap: var(--s-2);
    padding: 0 var(--s-3);
    height: 28px;
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--text-2);
    border-radius: var(--r-pill);
    font-size: var(--t-12); font-weight: var(--w-md);
    transition: background var(--m-fast), border-color var(--m-fast), color var(--m-fast);
    white-space: nowrap;
  }
  .chip.kind-chip {
    height: 34px;
    padding: 0 12px 0 14px;
    gap: 8px;
    font-size: var(--t-13);
    font-weight: var(--w-md);
    background: var(--surface-2);
    color: var(--text-3);
    border-color: var(--border);
    box-shadow: inset 3px 0 0 color-mix(in oklab, var(--card-accent) 55%, transparent);
    cursor: pointer;
    transition: background var(--m-fast) var(--m-ease),
                color var(--m-fast) var(--m-ease),
                border-color var(--m-fast) var(--m-ease),
                transform var(--m-fast) var(--m-ease);
  }
  .chip.kind-chip:hover {
    background: var(--surface-3);
    color: var(--text-2);
    border-color: var(--border-2);
  }
  .chip.kind-chip[data-active="1"] {
    background: color-mix(in oklab, var(--card-accent) 32%, var(--surface));
    border-color: var(--card-accent);
    color: var(--text);
    box-shadow: inset 3px 0 0 var(--card-accent),
                0 1px 0 rgba(255,255,255,.04) inset,
                0 2px 6px rgba(0,0,0,.25);
    transform: scale(1.06);
    font-weight: var(--w-sb);
    height: 36px;
  }

  /* Inbox-chip in trash mode (read-only). */
  .inbox-chip {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 3px 10px 3px 12px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-pill);
    color: var(--text-2);
    font-size: var(--t-12); font-weight: var(--w-md);
  }

  /* Game chip — same per-game accent styling as FeedCard (kind-color
   * stripe on the left + tinted fill). --card-accent is set inline
   * via gameColor(g.id) so each game keeps its deterministic hue. */
  .detail-game-row .game-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px 3px 14px;
    background: color-mix(in oklab, var(--card-accent, var(--border-2)) 14%, var(--surface));
    border: 1px solid color-mix(
      in oklab,
      var(--card-accent, var(--border-2)) 45%,
      var(--border)
    );
    box-shadow: inset 3px 0 0 var(--card-accent, var(--border-2));
    border-radius: var(--r-pill);
    color: var(--text);
    font-size: var(--t-12);
    font-weight: var(--w-md);
    white-space: nowrap;
  }
  /* Off-topic chip — transparent + dashed border, matches FeedCard. */
  .detail-game-row .off-topic-chip {
    display: inline-flex;
    align-items: center;
    padding: 3px 10px;
    background: transparent;
    border: 1px dashed var(--border-2);
    border-radius: var(--r-pill);
    color: var(--text-2);
    font-size: var(--t-12);
    font-weight: var(--w-md);
  }
  /* Inbox chip — dashed, warn-tinted, mirrors FeedCard. */
  .detail-game-row .inbox-chip {
    display: inline-flex;
    align-items: center;
    padding: 3px 10px;
    background: color-mix(in oklab, var(--warn) 14%, var(--surface));
    border: 1px solid color-mix(in oklab, var(--warn) 45%, var(--border));
    border-radius: var(--r-pill);
    color: var(--text-2);
    font-size: var(--t-12);
    font-weight: var(--w-md);
  }

  /* ── Footer (bottom dock) ─────────────────────────────────────────── */
  .detail-foot {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--border-hairline);
    flex-shrink: 0;
    background: var(--surface);
    /* flex-wrap so narrow viewports stack actions instead of clipping. */
    flex-wrap: wrap;
  }
  .btn {
    display: inline-flex; align-items: center; gap: var(--s-2);
    padding: 0 var(--s-3);
    min-height: var(--hit);
    border-radius: var(--r-sm);
    font-size: var(--t-13); font-weight: var(--w-md);
    border: 1px solid transparent;
    cursor: pointer;
    font-family: var(--f-sans);
    transition: background var(--m-fast) var(--m-ease),
                border-color var(--m-fast),
                color var(--m-fast);
  }
  .btn.ghost {
    background: var(--surface-2);
    color: var(--text);
    border-color: var(--border);
  }
  .btn.ghost:hover {
    background: var(--surface-3);
    border-color: var(--border-2);
  }
  .btn.detail-foot-close {
    min-height: 40px;
    padding: 0 16px;
    font-weight: var(--w-md);
  }
  .detail-foot-overflow {
    position: relative;
  }
  .btn.detail-foot-overflow-btn {
    width: 40px;
    min-height: 40px;
    padding: 0;
    display: inline-flex; align-items: center; justify-content: center;
  }
  .detail-foot-overflow-pop {
    position: absolute; z-index: 82;
    bottom: calc(100% + 6px); right: 0;
    min-width: 200px;
    background: var(--surface);
    border: 1px solid var(--border-2);
    border-radius: var(--r-md);
    box-shadow: var(--shadow-elev);
    padding: 4px;
    display: flex; flex-direction: column;
  }
  .card-menu-item {
    display: inline-flex; align-items: center; gap: 8px;
    width: 100%;
    padding: 8px 10px;
    background: transparent;
    border: 0;
    border-radius: var(--r-sm);
    color: var(--text);
    font-size: var(--t-13);
    text-align: left;
    cursor: pointer;
    transition: background var(--m-fast);
  }
  .card-menu-item:hover {
    background: var(--surface-2);
  }
  .card-menu-item.danger {
    color: var(--danger);
  }
  .card-menu-item.danger:hover {
    background: color-mix(in oklab, var(--danger) 12%, var(--surface-2));
  }
  .author-pick-scrim {
    position: fixed; inset: 0; z-index: 80;
    background: transparent;
  }

  /* Mobile ↓ */
  @media (max-width: 640px) {
    .detail-body { padding: 14px 16px 18px; }
  }

  @media (prefers-reduced-motion: reduce) {
    .detail-close-btn,
    .detail-edit-btn,
    .detail-url-edit,
    .btn,
    .chip,
    .author-avatar.detail-author-trigger {
      transition: none;
    }
  }
</style>
