<script lang="ts">
  // AddEventForm — Wave 2 Plan 09 shared body for the add-event surface
  // (D-16 modal primary + D-17 fetch via /api/events/preview-url +
  // D-18 save toast wired by the caller).
  //
  // Visual contract: 1:1 with docs/design/v2/ui-kit/add-event-modal.jsx
  // + its CSS rules (.field, .kind-grid, .add-kind-chip, .add-game-chip,
  // .field-url, .field-url-fetch, .modal-foot-hint, .modal-date-edit) in
  // index.html.
  //
  // The form owns:
  //   - All field state (title, kind, url, notes, games, off-topic, author,
  //     occurredAt).
  //   - URL Fetch button → POST /api/events/preview-url (NOT mock OG).
  //   - Per-kind URL host validation (instant feedback; server enforces).
  //   - Dirty tracking → onDirtyChange (consumed by AddEventModal for the
  //     scrim-click / Esc confirm gate).

  import KindIcon from "$lib/components/KindIcon.svelte";
  import AuthorPopover from "$lib/components/shared/AuthorPopover.svelte";
  import { m } from "$lib/paraglide/messages.js";
  import InlineError from "$lib/components/InlineError.svelte";
  import { gameColor } from "$lib/util/game-color.js";
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
    // Optional metadata captured from URL fetch (YouTube oEmbed
    // author_name, Reddit subreddit/author, etc). Persisted to
    // events.metadata so FeedCard.sourceLabel can read it back.
    metadata?: Record<string, unknown>;
  };

  let {
    games,
    initialKind = "post",
    initialAttachedGameIds = [],
    currentUserName = "",
    onSave,
    onCancel,
    onDirtyChange,
  }: {
    games: GameDto[];
    initialKind?: EventKind;
    initialAttachedGameIds?: string[];
    currentUserName?: string;
    onSave: (payload: AddEventPayload) => Promise<void>;
    onCancel: () => void;
    onDirtyChange?: (dirty: boolean) => void;
  } = $props();

  // Form state.
  let title = $state("");
  let kind = $state<EventKind>(initialKind);
  let url = $state("");
  let notes = $state("");
  // Big notes-editor modal — opens on click, saves into `notes` $state.
  let notesEditorOpen = $state(false);
  let notesEditorDraft = $state("");
  function openNotesEditor(): void {
    notesEditorDraft = notes;
    notesEditorOpen = true;
  }
  function commitNotesEditor(): void {
    notes = notesEditorDraft;
    notesEditorOpen = false;
  }
  function cancelNotesEditor(): void {
    notesEditorOpen = false;
  }
  let authorIsMe = $state(true);
  let offTopic = $state(false);
  let attachedGameIds = $state<string[]>([...initialAttachedGameIds]);
  let occurredAt = $state(new Date().toISOString().slice(0, 10));
  let authorPopoverOpen = $state(false);

  // Network state.
  let fetching = $state(false);
  let saving = $state(false);
  let fetched = $state(false);
  let fetchedKind = $state<EventKind | null>(null);
  let fetchedSrc = $state<string>("");
  // Adapter-parsed metadata held until save → events.metadata. Surfaces
  // in FeedCard sourceLabel (e.g. "Rick Astley (YouTube channel)") via
  // metadata.channelTitle / metadata.subreddit / metadata.author.
  let fetchedMetadata = $state<Record<string, unknown>>({});

  // After a successful fetch, the URL + kind are AUTHORITATIVE — the
  // adapter parsed them from the live URL. Lock both inputs so the user
  // can't drift them out of sync with the source. A "Reset" button on
  // the fetch-result chip clears these and re-enables editing.
  function resetFetch(): void {
    fetched = false;
    fetchedKind = null;
    fetchedSrc = "";
    urlError = null;
  }
  let urlError = $state<string | null>(null);
  let errorText = $state<string | null>(null);

  // Kind picker — kinds that have either an adapter (YouTube / Reddit)
  // OR a manual-paste flow (press / post / talk / conference / other).
  // Twitter / Telegram / Discord are declared in the DB enum (forward-
  // compat) but have no adapter or manual entry today — PROJECT.md flags
  // them as out-of-scope for v1, and the /feed KIND axis filters them
  // out for the same reason. Keeping the AddEvent picker aligned with
  // the filter axis avoids the awkward state where a user can create
  // events that don't show up in their own filter list.
  const KIND_FLOW: EventKind[] = [
    "youtube_video",
    "reddit_post",
    "press",
    "post",
    "conference",
    "talk",
    "other",
  ];

  function kindShort(k: EventKind): string {
    switch (k) {
      case "youtube_video": return "YouTube";
      case "reddit_post":   return "Reddit";
      case "twitter_post":  return "Twitter";
      case "telegram_post": return "Telegram";
      case "discord_drop":  return "Discord";
      case "press":         return "Press";
      case "talk":          return "Talk";
      case "conference":    return "Conference";
      case "post":          return "Post";
      case "other":         return "Other";
    }
  }

  function eventKindLabel(k: EventKind): string {
    switch (k) {
      case "youtube_video": return m.event_kind_label_youtube_video();
      case "reddit_post":   return m.event_kind_label_reddit_post();
      case "post":          return m.event_kind_label_post();
      case "conference":    return m.event_kind_label_conference();
      case "talk":          return m.event_kind_label_talk();
      case "press":         return m.event_kind_label_press();
      case "other":         return m.event_kind_label_other();
      case "twitter_post":  return m.event_kind_label_twitter_post();
      case "telegram_post": return m.event_kind_label_telegram_post();
      case "discord_drop":  return m.event_kind_label_discord_drop();
    }
  }

  // Dirty tracking — any user-visible change away from initial values.
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
  // feedback; Zod + adapter parseUrl is the load-bearing second layer.
  function urlMatchesKind(u: string, k: EventKind): boolean {
    if (!u.trim()) return true;
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

  // URL Fetch — POST /api/events/preview-url (NOT mock OG).
  async function fetchUrlMetadata(): Promise<void> {
    if (fetching) return;
    const u = url.trim();
    if (!u) return;
    fetching = true;
    fetched = false;
    urlError = null;
    errorText = null;
    try {
      const res = await fetch("/api/events/preview-url", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: u }),
      });
      if (!res.ok) {
        // Surface the server's error code instead of the generic
        // "Not a valid URL" so the user sees WHY it failed
        // (rate-limited / reddit_not_configured / network / …).
        try {
          const body = (await res.json()) as { error?: string; message?: string };
          urlError = body.error ?? body.message ?? m.add_event_modal_url_error_invalid();
        } catch {
          urlError = `${res.status} ${res.statusText}` || m.add_event_modal_url_error_invalid();
        }
        return;
      }
      const data = (await res.json()) as {
        kind?: string | null;
        title?: string | null;
        occurredAt?: string | null;
        sourceLabel?: string | null;
        authorName?: string | null;
        authorUrl?: string | null;
      };
      if (data.title && title.trim().length === 0) {
        title = data.title;
      }
      if (data.occurredAt) {
        occurredAt = data.occurredAt.slice(0, 10);
      }
      const allowed: EventKind[] = [
        "youtube_video", "reddit_post", "twitter_post",
        "telegram_post", "discord_drop",
        "press", "talk", "conference", "post", "other",
      ];
      if (data.kind && (allowed as readonly string[]).includes(data.kind)) {
        kind = data.kind as EventKind;
        fetchedKind = kind;
      }
      // Stash adapter-derived metadata that is INTRINSIC to the URL
      // itself, not a denormalization of a separately-renameable entity.
      //
      //   - subreddit: encoded in the Reddit URL path, never renames
      //     (Reddit forbids renaming subreddits). Safe to store on the
      //     event.
      //   - author handle (reddit u/…): extracted by adapter from the
      //     post payload. Reddit handles CAN be renamed but the change
      //     also breaks the URL itself, so a stale author here matches
      //     a stale URL — consistent.
      //
      // We deliberately do NOT store YouTube channelTitle here. That's
      // a separately-renameable display name owned by the data_sources
      // table (or a future youtube_channel_cache). Caching it on every
      // event would mean "Rick Astley" rows survive a rename. FeedCard's
      // sourceLabel reads channelTitle from data_sources via sourceId —
      // when the user registers the channel as a source, the name flows
      // through; until then events from unregistered channels render
      // with no channel attribution, which is the honest state.
      fetchedMetadata = {};
      if (kind === "reddit_post") {
        try {
          const subMatch = u.match(/\/r\/([^/]+)\//i);
          if (subMatch) fetchedMetadata.subreddit = subMatch[1];
        } catch {
          /* leave empty */
        }
      }
      // Surface a small "Detected …" chip below the URL row. Use the
      // host as the fallback source label when the endpoint didn't
      // return one (the prototype shows e.g. "@neonicle_dev" for tw).
      try {
        const parsedHost = new URL(u.match(/^https?:\/\//) ? u : "https://" + u).hostname.replace(/^www\./, "");
        fetchedSrc = data.sourceLabel ?? parsedHost;
      } catch {
        fetchedSrc = data.sourceLabel ?? "";
      }
      fetched = true;
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
        metadata: Object.keys(fetchedMetadata).length > 0 ? fetchedMetadata : undefined,
      });
    } catch {
      errorText = m.error_server_generic();
    } finally {
      saving = false;
    }
  }

  // "Mon, May 14" label format mirrors prototype foot-hint.
  const occurredHuman = $derived.by(() => {
    const [y, mo, d] = occurredAt.split("-").map((x) => parseInt(x, 10));
    if (!y || !mo || !d) return occurredAt;
    const t = new Date(y, mo - 1, d);
    const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][t.getDay()];
    const mon = [
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ][t.getMonth()];
    return `${day}, ${mon} ${t.getDate()}`;
  });
  const todayISO = new Date().toISOString().slice(0, 10);

  // Kind color from app.css --k-* tokens. Wired via inline --card-accent
  // on each chip — matches FeedCard pattern.
  function kindAccent(k: EventKind): string {
    // CSS var indirection — kind tokens live in src/app.css.
    switch (k) {
      case "youtube_video": return "var(--k-youtube)";
      case "reddit_post":   return "var(--k-reddit)";
      case "twitter_post":  return "var(--k-twitter)";
      case "telegram_post": return "var(--k-telegram)";
      case "discord_drop":  return "var(--k-discord)";
      case "conference":    return "var(--k-conference)";
      case "talk":          return "var(--k-talk)";
      case "press":         return "var(--k-press)";
      case "post":          return "var(--k-post)";
      case "other":         return "var(--k-other)";
    }
  }
</script>

<form class="add-event-form modal-body" onsubmit={submit}>
  <!-- Title — required. Author picker chip sits to the right of the
       label, matching the prototype label-row layout. -->
  <div class="field">
    <label class="field-label" for="addevt-title">
      {m.add_event_modal_title_label()}
      <span class="field-label-req" aria-hidden="true">*</span>
    </label>
    <input
      id="addevt-title"
      class="field-input"
      type="text"
      placeholder={m.add_event_modal_title_placeholder()}
      bind:value={title}
      maxlength="500"
      disabled={saving}
      required
    />
  </div>

  <!-- Link + Fetch button. After fetch, a small preview chip shows the
       parsed metadata so the user can verify before saving. -->
  <div class="field">
    <label class="field-label" for="addevt-url">
      {m.add_event_modal_link_label()}
      <span class="field-label-opt">{m.add_event_modal_link_optional()}</span>
    </label>
    <div class="field-url">
      <input
        id="addevt-url"
        class="field-input"
        type="url"
        placeholder={m.add_event_modal_link_placeholder()}
        bind:value={url}
        oninput={() => { fetched = false; urlError = null; }}
        onkeydown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); void fetchUrlMetadata(); }
        }}
        spellcheck="false"
        autocomplete="off"
        disabled={saving || fetched}
        readonly={fetched}
      />
      <button
        type="button"
        class="btn ghost field-url-fetch"
        onclick={fetched ? resetFetch : fetchUrlMetadata}
        disabled={fetching || saving || (!fetched && url.trim().length === 0)}
      >
        {#if fetched}
          Reset
        {:else if fetching}
          {m.add_event_modal_fetch_button_loading()}
        {:else}
          {m.add_event_modal_fetch_button()}
        {/if}
      </button>
    </div>
    {#if urlError}
      <div class="field-error">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <span>{urlError}</span>
      </div>
    {:else if fetched && fetchedSrc}
      <div class="field-fetch-result">
        <span class="field-fetch-ico" style="color: {kindAccent(kind)}">
          <KindIcon kind={kind} size={14} />
        </span>
        <span class="field-fetch-text">
          Detected <b>{eventKindLabel(kind)}</b>{fetchedSrc ? ` · ` : ""}<span style="font-family: var(--f-mono); font-size: 11.5px">{fetchedSrc}</span>
        </span>
      </div>
    {/if}
  </div>

  <!-- Kind picker — single wrap row of chips, kind-color cued. After
       fetch, the kind was determined by the URL adapter and is locked
       (the picker as a whole becomes non-interactive; only the active
       chip remains visible at full opacity so the user can still see
       the detected kind). Reset on the URL field re-enables. -->
  <div class="field">
    <span class="field-label">{m.add_event_modal_kind_label()}</span>
    <div class="kind-grid" data-locked={fetched ? "1" : "0"}>
      {#each KIND_FLOW as k (k)}
        <button
          type="button"
          class="chip kind-chip add-kind-chip"
          data-active={kind === k ? "1" : "0"}
          style="--card-accent: {kindAccent(k)}"
          onclick={() => (kind = k)}
          disabled={saving || fetched}
        >
          <span class="kind-icon"><KindIcon kind={k} size={16} /></span>
          <span>{kindShort(k)}</span>
        </button>
      {/each}
    </div>
  </div>

  <!-- Notes — click to open big editor. No inline textarea (resize
       handle was distracting + the 3-row preview cramped longer notes).
       User UAT: «при создании эвента хочется такое же редактирование
       заметок. И там не нужно давать возможность расширять эту зону». -->
  <div class="field">
    <span class="field-label">
      {m.add_event_modal_notes_label()}
      <span class="field-label-opt">{m.add_event_modal_notes_optional()}</span>
    </span>
    <button
      type="button"
      class="field-input addevt-notes-trigger"
      class:has-content={notes.trim().length > 0}
      onclick={openNotesEditor}
      disabled={saving}
    >
      {#if notes.trim().length > 0}
        <span class="addevt-notes-preview">{notes}</span>
      {:else}
        <span class="addevt-notes-placeholder">Anything worth remembering — context, numbers, links…</span>
      {/if}
    </button>
  </div>

  <!-- Games — chip grid with the same visual vocabulary as the kind
       picker (game-color cued). Off-topic appears as a dashed chip. -->
  <div class="field">
    <span class="field-label">
      {m.add_event_modal_games_label()}
      <span class="field-label-opt">{m.add_event_modal_link_optional()}</span>
    </span>
    <div class="kind-grid">
      {#each games as g (g.id)}
        {@const active = attachedGameIds.includes(g.id)}
        <button
          type="button"
          class="chip kind-chip game-chip add-game-chip"
          data-active={active ? "1" : "0"}
          style="--card-accent: {gameColor(g.id)};"
          onclick={() => toggleGame(g.id)}
          disabled={saving}
        >
          <span>{g.title}</span>
        </button>
      {/each}
      <button
        type="button"
        class="chip kind-chip add-game-chip off-topic-add"
        data-active={offTopic ? "1" : "0"}
        onclick={() => (offTopic = !offTopic)}
        disabled={saving}
      >
        <span>{m.add_event_modal_off_topic()}</span>
      </button>
    </div>
  </div>

  <!-- Footer hint — author picker + inline date picker, side by side. -->
  <div class="modal-foot-hint">
    <span class="author-pick">
      <button
        type="button"
        class="author-pick-trigger"
        onclick={() => (authorPopoverOpen = !authorPopoverOpen)}
        aria-haspopup="listbox"
        aria-expanded={authorPopoverOpen}
        disabled={saving}
      >
        <span class="author-avatar" data-mine={authorIsMe ? "1" : "0"}>
          {authorIsMe ? (currentUserName[0] ?? "Y").toUpperCase() : "?"}
        </span>
        <span class="author-pick-name">
          {authorIsMe ? (currentUserName || "You") : m.author_popover_someone_else()}
        </span>
        <span class="author-pick-chev" aria-hidden="true">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </span>
      </button>
      {#if authorPopoverOpen}
        <AuthorPopover
          authorIsMe={authorIsMe}
          mineName={currentUserName || "You"}
          placement="up"
          onchange={(next) => {
            authorIsMe = next;
            authorPopoverOpen = false;
          }}
          onclose={() => (authorPopoverOpen = false)}
        />
      {/if}
    </span>
    <span class="modal-hint-sep" aria-hidden="true">·</span>
    <span class="modal-date-edit">
      <span style="font-variant-numeric: tabular-nums">{occurredHuman}</span>
      <span class="modal-date-pencil" aria-hidden="true">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M11 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6"/>
          <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
      </span>
      <input
        type="date"
        class="modal-date-native"
        bind:value={occurredAt}
        max={todayISO}
        aria-label="Change date"
        disabled={saving}
      />
    </span>
  </div>

  {#if errorText}
    <InlineError message={errorText} />
  {/if}
</form>

<!-- Footer button row — outside .modal-body so the prototype's pinned
     foot pattern works (head + body + foot, body scrolls between).
     Caller (AddEventModal) wraps the form in its <dialog>; the foot
     therefore sits inside the same <dialog> as a sibling of <form>.
     For the standalone route mount, .modal-foot still styles into a
     sensible right-aligned button row. -->
<div class="modal-foot">
  <button
    type="button"
    class="btn ghost"
    onclick={onCancel}
    disabled={saving}
  >{m.add_event_modal_cancel()}</button>
  <button
    type="submit"
    class="btn primary"
    onclick={submit}
    disabled={saving || title.trim().length === 0}
  >{m.add_event_modal_save()}</button>
</div>

<!-- Big notes-editor — same pattern as EventDetailContent. Sibling
     dialog on top of the AddEvent modal via browser top-layer. -->
{#if notesEditorOpen}
  <dialog
    class="notes-editor-modal"
    open
    oncancel={(e) => {
      e.preventDefault();
      cancelNotesEditor();
    }}
    onclick={(e) => {
      if (e.target === e.currentTarget) cancelNotesEditor();
    }}
  >
    <header class="notes-editor-head">
      <h2 class="notes-editor-title">{m.add_event_modal_notes_label()}</h2>
      <button
        type="button"
        class="notes-editor-close"
        onclick={cancelNotesEditor}
        aria-label="Close"
        title="Close"
      >×</button>
    </header>
    <div class="notes-editor-body">
      <!-- svelte-ignore a11y_autofocus -->
      <textarea
        class="notes-editor-textarea"
        bind:value={notesEditorDraft}
        onkeydown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            commitNotesEditor();
          }
        }}
        maxlength="50000"
        autofocus
        placeholder="Anything worth remembering — context, numbers, links…"
      ></textarea>
    </div>
    <footer class="notes-editor-foot">
      <button type="button" class="btn ghost" onclick={cancelNotesEditor}>Cancel</button>
      <button type="button" class="btn primary" onclick={commitNotesEditor}>Save</button>
    </footer>
  </dialog>
{/if}

<style>
  /* Prototype 1:1 — class names mirror docs/design/v2/ui-kit/index.html
   * .field, .field-url, .kind-grid, .add-kind-chip, .add-game-chip,
   * .off-topic-add, .modal-foot-hint, .modal-date-edit. */

  .add-event-form {
    background: var(--surface);
    color: var(--text);
    padding: 16px 18px 4px;
    display: flex; flex-direction: column;
    gap: 18px;
    min-width: 0;
    flex: 1;
    overflow-y: auto;
  }

  /* ── Field block ──────────────────────────────────────────────────── */
  .field {
    display: flex; flex-direction: column; gap: 8px;
    min-width: 0;
  }
  .field-label-row {
    display: flex; align-items: center; justify-content: space-between;
    gap: var(--s-3);
    min-width: 0;
  }
  .field-label {
    font-size: 10.5px;
    font-weight: var(--w-sb);
    color: var(--text-3);
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }
  .field-label-opt {
    color: var(--text-4);
    font-weight: var(--w-rg);
    letter-spacing: 0.04em;
    text-transform: none;
  }
  /* Required-field marker — small accent asterisk after the label text.
   * aria-hidden because <input required> carries the a11y contract; this
   * is purely a visual cue. */
  .field-label-req {
    color: var(--accent);
    font-weight: var(--w-sb);
    margin-left: 2px;
  }
  .field-input {
    width: 100%;
    min-height: 40px;
    padding: 0 12px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    color: var(--text);
    font: inherit;
    font-size: var(--t-14);
    font-family: var(--f-sans);
    outline: none;
    transition: border-color var(--m-fast) var(--m-ease),
                background var(--m-fast) var(--m-ease);
  }
  .field-input::placeholder { color: var(--text-4); }
  .field-input:hover { border-color: var(--border-2); }
  .field-input:focus {
    border-color: var(--accent);
    background: var(--surface);
  }
  .field-textarea {
    min-height: 84px;
    padding: 10px 12px;
    resize: vertical;
    line-height: var(--lh-body);
    font-family: var(--f-sans);
  }
  /* Notes preview button — looks like .field-input but is a button that
   * opens the big notes-editor modal. Long content scrolls vertically
   * with a soft max-height; placeholder reads grey-italic. */
  .addevt-notes-trigger {
    text-align: left;
    cursor: pointer;
    min-height: 84px;
    max-height: 200px;
    overflow-y: auto;
    line-height: var(--lh-body);
    font-family: var(--f-sans);
  }
  .addevt-notes-trigger.has-content {
    color: var(--text);
  }
  .addevt-notes-preview {
    white-space: pre-wrap;
    word-break: break-word;
  }
  .addevt-notes-placeholder {
    color: var(--text-4);
    font-style: italic;
  }

  /* Big notes-editor modal — sibling <dialog> opened from the form.
   * Sits on top of the AddEvent modal via browser top-layer stacking. */
  .notes-editor-modal {
    width: min(900px, calc(100vw - 32px));
    max-height: min(86vh, 820px);
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
  }
  .notes-editor-modal::backdrop {
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(2px);
  }
  .notes-editor-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border-hairline);
  }
  .notes-editor-title {
    flex: 1;
    margin: 0;
    font-size: var(--t-15);
    font-weight: var(--w-sb);
  }
  .notes-editor-close {
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
  .notes-editor-close:hover {
    background: var(--surface-2);
    color: var(--text);
  }
  .notes-editor-body {
    flex: 1;
    min-height: 0;
    padding: 16px;
    display: flex;
  }
  .notes-editor-textarea {
    flex: 1;
    min-height: 60vh;
    width: 100%;
    padding: 12px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    color: var(--text);
    font-family: var(--f-sans);
    font-size: var(--t-14);
    line-height: 1.55;
    /* Fixed area per user UAT: «не нужно давать возможность расширять
     * эту зону». */
    resize: none;
    outline: none;
  }
  .notes-editor-textarea:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .notes-editor-foot {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--border-hairline);
  }

  /* ── URL row + Fetch button ───────────────────────────────────────── */
  .field-url {
    display: flex; gap: 8px;
    min-width: 0;
  }
  .field-url .field-input { flex: 1; min-width: 0; }
  .btn.field-url-fetch {
    height: 40px; min-height: 40px;
    padding: 0 14px;
    font-size: var(--t-13);
    font-weight: var(--w-md);
    flex-shrink: 0;
  }
  .btn.field-url-fetch:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .field-error {
    display: inline-flex; align-items: center; gap: 6px;
    color: var(--danger);
    font-size: var(--t-12);
    line-height: 1.3;
  }
  .field-error svg { width: 12px; height: 12px; flex-shrink: 0; }
  .field-fetch-result {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 6px 10px;
    background: var(--surface-2);
    border: 1px solid var(--border-hairline);
    border-radius: var(--r-sm);
    color: var(--text-2);
    font-size: var(--t-12);
    flex-wrap: wrap;
  }
  .field-fetch-result b { color: var(--text); font-weight: var(--w-md); }
  .field-fetch-ico {
    display: inline-flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }

  /* ── Author picker pill (in title label row) ──────────────────────── */
  .author-pick { position: relative; }
  .author-pick-trigger {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 3px 8px 3px 3px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-pill);
    color: var(--text-2);
    font-size: var(--t-12);
    font-weight: var(--w-md);
    cursor: pointer;
    transition: background var(--m-fast), border-color var(--m-fast), color var(--m-fast);
  }
  .author-pick-trigger:hover {
    background: var(--surface-3);
    border-color: var(--border-2);
    color: var(--text);
  }
  .author-pick-trigger:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .author-pick-trigger .author-avatar {
    width: 20px; height: 20px;
    font-size: 11px;
  }
  .author-pick-name {
    color: var(--text);
    letter-spacing: -0.005em;
  }
  .author-pick-chev {
    display: inline-flex; color: var(--text-3);
    margin-right: 2px;
  }
  .author-avatar {
    display: inline-flex; align-items: center; justify-content: center;
    background: var(--surface-3);
    color: var(--text-3);
    border: 1px solid var(--border);
    border-radius: 50%;
    font-weight: var(--w-sb);
    padding: 0;
  }
  .author-avatar[data-mine="1"] {
    background: var(--accent);
    color: var(--accent-text);
    border-color: var(--accent);
  }

  /* ── Chip-grid (kind + games picker) ──────────────────────────────── */
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
  }
  .chip.add-kind-chip,
  .chip.add-game-chip {
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
  .chip.add-kind-chip .kind-icon {
    color: var(--card-accent, var(--text-3));
    opacity: 0.85;
    transition: opacity var(--m-fast) var(--m-ease);
  }
  /* KindIcon.svelte sets `color: var(--text-3)` on its inner <svg.kind>;
   * override so currentColor flows from --card-accent down into the
   * SVG strokes. Same pattern as AxisRow.svelte kind chips. */
  .chip.add-kind-chip .kind-icon :global(svg.kind) {
    color: inherit;
  }
  .chip.add-kind-chip:hover:not(:disabled),
  .chip.add-game-chip:hover:not(:disabled) {
    background: var(--surface-3);
    color: var(--text-2);
    border-color: var(--border-2);
  }
  .chip.add-kind-chip:hover .kind-icon { opacity: 0.9; }
  .chip.add-kind-chip[data-active="1"],
  .chip.add-game-chip[data-active="1"] {
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
  .chip.add-kind-chip[data-active="1"] .kind-icon {
    color: var(--card-accent);
    opacity: 1;
  }
  .chip.off-topic-add {
    box-shadow: none;
    border-style: dashed;
    padding-left: 12px;
  }
  .chip.off-topic-add[data-active="1"] {
    background: var(--surface-3);
    border-color: var(--text-2);
    border-style: dashed;
    color: var(--text);
    box-shadow: 0 1px 0 rgba(255,255,255,.04) inset,
                0 2px 6px rgba(0,0,0,.25);
    transform: scale(1.06);
    font-weight: var(--w-sb);
    height: 36px;
  }
  .chip:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* ── Foot hint: author picker + inline date picker ───────────────── */
  .modal-foot-hint {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    flex-wrap: wrap;
    color: var(--text-3);
    font-size: var(--t-12);
    padding-top: var(--s-2);
    padding-bottom: var(--s-2);
  }
  .modal-foot-hint b {
    color: var(--text-2);
    font-weight: var(--w-md);
  }
  .modal-foot-hint .author-pick {
    position: relative;
  }
  .modal-hint-sep {
    color: var(--text-4);
  }
  /* Date-edit affordance — more obvious now per user UAT: dotted
   * underline + persistent pencil so it reads as clickable without
   * needing hover. */
  .modal-date-edit {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 6px;
    margin: -2px 0 -2px -4px;
    border-radius: var(--r-xs);
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      color var(--m-fast) var(--m-ease);
    color: var(--text);
    font-weight: var(--w-sb);
    border-bottom: 1px dashed var(--border-2);
  }
  .modal-date-pencil {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--accent);
    transition: color var(--m-fast);
  }
  @media (hover: hover) {
    .modal-date-edit:hover {
      background: var(--accent-soft);
      color: var(--accent-strong);
    }
    .modal-date-edit:hover .modal-date-pencil {
      color: var(--accent-strong);
    }
  }
  .modal-date-native {
    position: absolute; inset: 0;
    opacity: 0;
    cursor: pointer;
    padding: 0;
    border: 0;
    background: transparent;
    color-scheme: dark;
    font: inherit;
  }
  :global([data-theme="light"]) .modal-date-native { color-scheme: light; }

  /* ── Footer (Cancel / Save) ───────────────────────────────────────── */
  .modal-foot {
    display: flex; gap: 8px; align-items: center; justify-content: flex-end;
    padding: 12px 18px;
    border-top: 1px solid var(--border-hairline);
    background: var(--surface);
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
  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .btn.primary {
    background: var(--accent); color: var(--accent-text);
    font-weight: var(--w-sb);
    box-shadow: 0 1px 0 rgba(255,255,255,.18) inset, 0 1px 2px rgba(0,0,0,.25);
  }
  .btn.primary:hover:not(:disabled) {
    background: var(--accent-strong);
  }
  .btn.ghost {
    background: var(--surface-2); color: var(--text); border-color: var(--border);
  }
  .btn.ghost:hover:not(:disabled) {
    background: var(--surface-3); border-color: var(--border-2);
  }

  /* Mobile ↓ */
  @media (max-width: 540px) {
    .add-event-form { padding: 12px 14px 0; gap: 14px; }
    .modal-foot { padding: 10px 14px; }
  }

  @media (prefers-reduced-motion: reduce) {
    .chip,
    .btn,
    .field-input,
    .author-pick-trigger,
    .modal-date-edit {
      transition: none;
    }
  }
</style>
