<script lang="ts">
  // BaseFeedCard — markup workhorse shared by FeedCard.svelte (default
  // fallback) and the per-platform variants (YoutubeFeedCard,
  // RedditFeedCard). Renders the article shell + meta row + thumb +
  // notes + footer + per-card affordances.
  //
  // Why a separate file: the per-platform cards differ in WHICH source
  // of truth they read for sourceLabel / bylineLabel / thumbnailUrl /
  // stats — but the layout, click handling, long-press timer, menu
  // state, and CSS hooks are identical. Extracting the markup here lets
  // each wrapper enforce its read path in a tight ~30-line file.
  //
  // CSS hook contract (LB-10) preserved from the original FeedCard:
  //   - `data-testid="feed-card"` on the root article
  //   - `data-selected`, `data-view`, `data-mine`, `data-kind`,
  //     `data-shape`, `data-long-pressed`, `data-event-id`
  //   - `.card-select` always-visible checkbox inside `.card-meta`
  //     (label wraps input so `.card-select input` queries still pass)
  //   - `.card-actions` overflow trigger preserved as a real <button>
  //
  // Markup parity with the original FeedCard is load-bearing — the
  // audit-render integration tests grep `out.body` for exact class
  // strings. Any markup drift here must update those tests in lockstep.

  import { m } from "$lib/paraglide/messages.js";
  import KindIcon from "../../KindIcon.svelte";
  import AuthorAvatar from "./AuthorAvatar.svelte";
  import MediaTypePill from "./MediaTypePill.svelte";
  import { eventKindLabel } from "$lib/sources/kind-display.js";
  import type { OverlayPill } from "./media-type-overlay.js";
  import type { CardEventKind, CardEventLite } from "./derive-card-data.js";
  import {
    formatOccurredAt,
    gameColor,
    isInboxRow as deriveIsInboxRow,
    isMediaShape,
    isStandalone as deriveIsStandalone,
  } from "./derive-card-data.js";

  type GameLite = { id: string; title: string };

  let {
    event,
    sourceLabel,
    bylineLabel = null,
    thumbnailUrl,
    games,
    selected = false,
    anySelected = false,
    view = "feed",
    onToggleSelect,
    onOpenDetail,
    onOpenGamesPickerForCard,
    onDelete,
    onRestore,
    onDeleteForever,
    currentUserName,
    statsSlot,
    extraSlot,
    thumbnailOverlay = null,
    onThumbnailError,
  }: {
    event: CardEventLite;
    /** Already-resolved source-of-truth label for the .src element.
     *  Per-platform wrappers compute this from their adapter-specific
     *  read path (YouTube: source.channelTitle via FK; Reddit:
     *  metadata.subreddit). */
    sourceLabel: string;
    /** Optional second meta line (used by Reddit for /u/<author>). */
    bylineLabel?: string | null;
    /** Already-derived thumbnail URL or null. */
    thumbnailUrl: string | null;
    games: GameLite[];
    selected?: boolean;
    anySelected?: boolean;
    view?: "feed" | "trash";
    onToggleSelect?: (id: string, force?: boolean) => void;
    onOpenDetail?: (id: string) => void;
    onOpenGamesPickerForCard?: (id: string) => void;
    onDelete?: (id: string) => Promise<void> | void;
    onRestore?: (id: string) => Promise<void> | void;
    onDeleteForever?: (id: string) => Promise<void> | void;
    currentUserName?: string;
    /** Per-platform stats row (.card-stats). Rendered between .card-notes
     *  and .card-footer when provided. Snippet so the parent decides what
     *  to render — YouTube emits views/likes/comments, Reddit emits
     *  score/comments/upvote-ratio + baseline badge. */
    statsSlot?: import("svelte").Snippet;
    /** Reserved extension slot for kind-specific surfaces (badges,
     *  warnings) between the stats row and the footer. Currently unused
     *  but kept so future per-platform additions don't need another
     *  prop drop. */
    extraSlot?: import("svelte").Snippet;
    /** Optional media-type pill rendered INSIDE .card-thumb, top-left over the
     *  <img>. The shared mediaTypeOverlay() helper produces the { type, label,
     *  inner } shape; BaseFeedCard renders the icon+TEXT pill markup + CSS once
     *  (ONE treatment for every source — no per-card fork). Used by Instagram
     *  to mark short / carousel / video and by YouTube to mark video; a bare
     *  photo passes null → no pill. Rendered whenever the media slot renders —
     *  over the picture OR the KindIcon placeholder (thumb-less manual events,
     *  expired/blocked covers), matching the event-detail behavior. */
    thumbnailOverlay?: OverlayPill | null;
    /** Optional thumbnail-load-error handler. Used by hotlinked-thumbnail
     *  cards (Instagram, D-08) whose CDN URL expires — on <img> error the
     *  wrapper flips its thumbnail to null so the .card-thumb.empty
     *  KindIcon placeholder shows instead of a broken image. YouTube
     *  thumbnails (img.youtube.com) don't expire, so they pass nothing. */
    onThumbnailError?: () => void;
  } = $props();

  // Kind label resolves through the central kind-display config
  // (eventKindLabel) — same source of truth EventDetailHeader / FilterChips use.
  const kindLabel = $derived(eventKindLabel(event.kind));

  const dateLabel = $derived.by(() => formatOccurredAt(event.occurredAt));
  const mediaShape = $derived.by(() => isMediaShape(event.kind as CardEventKind));
  const showThumb = $derived.by(() => mediaShape || thumbnailUrl !== null);
  const inboxRow = $derived.by(() => deriveIsInboxRow(event));
  const standalone = $derived.by(() => deriveIsStandalone(event));

  // Iterate the canonical `games` list (server-ordered desc createdAt)
  // instead of event.gameIds — loadGameIdsForEvents returns junction
  // rows in arbitrary order. Filtering the ordered games list keeps the
  // chip sequence identical across FeedCard / EventDetailContent /
  // filter axes (everywhere reads from this same array).
  const attachedSet = $derived(new Set(event.gameIds));
  const attachedGames = $derived.by((): GameLite[] => games.filter((g) => attachedSet.has(g.id)));

  // Touch long-press → enters selection mode after 480ms. Scroll-cancel
  // via touchmove is LOAD-BEARING per D-28.
  let pressTimer: ReturnType<typeof setTimeout> | null = null;
  function startPress(e: TouchEvent): void {
    cancelPress();
    const target = e.currentTarget as HTMLElement;
    pressTimer = setTimeout(() => {
      pressTimer = null;
      target.dataset.longPressed = "1";
      onToggleSelect?.(event.id, true);
    }, 480);
  }
  function cancelPress(): void {
    if (pressTimer !== null) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  }

  let menuOpen = $state(false);

  // Auto-close menu on outside click + sibling card open + Escape.
  // Listener attach deferred one tick so the click that opens the
  // menu doesn't immediately close it (capture-phase race).
  $effect(() => {
    if (typeof window === "undefined") return;
    if (!menuOpen) return;
    window.dispatchEvent(new CustomEvent("feedcard:menu-opened", { detail: { id: event.id } }));

    const outsideClick = (e: MouseEvent): void => {
      if (e.target instanceof Node) {
        const root = document.querySelector(
          `[data-testid="feed-card"][data-event-id="${event.id}"]`,
        );
        if (root && root.contains(e.target)) return;
      }
      menuOpen = false;
    };
    const onOtherMenuOpen = (e: Event): void => {
      const ev = e as CustomEvent<{ id: string }>;
      if (ev.detail?.id !== event.id) menuOpen = false;
    };
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === "Escape") menuOpen = false;
    };
    const t = setTimeout(() => {
      document.addEventListener("click", outsideClick, true);
      window.addEventListener("feedcard:menu-opened", onOtherMenuOpen);
      document.addEventListener("keydown", onEsc);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("click", outsideClick, true);
      window.removeEventListener("feedcard:menu-opened", onOtherMenuOpen);
      document.removeEventListener("keydown", onEsc);
    };
  });
</script>

<article
  class="feed-card card"
  class:standalone
  data-kind={event.kind}
  data-shape={mediaShape ? "media" : "text"}
  data-media={showThumb ? "1" : "0"}
  data-kind-color="1"
  data-selected={selected ? "1" : "0"}
  data-view={view}
  data-mine={event.authorIsMe ? "1" : "0"}
  data-testid="feed-card"
  data-event-id={event.id}
  style="--card-accent: var(--k-{event.kind}); --kind-color: var(--k-{event.kind});"
  tabindex="0"
  onkeydown={(e) => {
    if (e.key === "Enter" || e.key === " ") {
      if ((e.target as Element).closest(".card-select, .card-actions, .card-menu")) return;
      e.preventDefault();
      if (anySelected) {
        onToggleSelect?.(event.id, !selected);
      } else if (onOpenDetail) {
        onOpenDetail(event.id);
      }
    }
  }}
  ontouchstart={startPress}
  ontouchend={cancelPress}
  ontouchmove={cancelPress}
  ontouchcancel={cancelPress}
  oncontextmenu={(e) => e.preventDefault()}
  onclick={(e) => {
    const target = e.target as Element;
    if (target.closest(".card-select, .card-actions, .card-menu")) {
      e.preventDefault();
      return;
    }
    const article = e.currentTarget as HTMLElement;
    if (article.dataset.longPressed === "1") {
      delete article.dataset.longPressed;
      e.preventDefault();
      return;
    }
    if (anySelected) {
      e.preventDefault();
      onToggleSelect?.(event.id, !selected);
      return;
    }
    if (onOpenDetail) {
      e.preventDefault();
      onOpenDetail(event.id);
    }
  }}
>
  <div class="card-actions">
    <button
      type="button"
      class="card-action-btn overflow"
      aria-label={m.feed_card_actions_aria()}
      aria-haspopup="menu"
      aria-expanded={menuOpen ? "true" : "false"}
      onclick={(e) => {
        e.stopPropagation();
        menuOpen = !menuOpen;
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="5" r="1.8" fill="currentColor" />
        <circle cx="12" cy="12" r="1.8" fill="currentColor" />
        <circle cx="12" cy="19" r="1.8" fill="currentColor" />
      </svg>
    </button>
  </div>
  {#if menuOpen}
    <div
      class="card-menu"
      role="menu"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          menuOpen = false;
        }
      }}
    >
      {#if view === "trash"}
        <button
          type="button"
          role="menuitem"
          onclick={() => {
            menuOpen = false;
            void onRestore?.(event.id);
          }}
        >
          Restore
        </button>
        <button
          type="button"
          role="menuitem"
          class="danger"
          onclick={() => {
            menuOpen = false;
            void onDeleteForever?.(event.id);
          }}
        >
          Delete forever
        </button>
      {:else}
        <button
          type="button"
          role="menuitem"
          onclick={() => {
            menuOpen = false;
            onOpenGamesPickerForCard?.(event.id);
          }}
        >
          {m.feed_card_menu_edit_games()}
        </button>
        <button
          type="button"
          role="menuitem"
          onclick={() => {
            menuOpen = false;
            onToggleSelect?.(event.id, true);
          }}
        >
          {m.feed_card_menu_select()}
        </button>
        <button
          type="button"
          role="menuitem"
          class="danger"
          onclick={() => {
            menuOpen = false;
            void onDelete?.(event.id);
          }}
        >
          {m.feed_card_menu_delete()}
        </button>
      {/if}
    </div>
  {/if}

  <div class="card-body">
    <div class="card-meta">
      <label
        class="card-select"
        data-checked={selected ? "1" : "0"}
        onclick={(e) => e.stopPropagation()}
        aria-label={selected ? m.feed_card_deselect_aria() : m.feed_card_select_aria()}
      >
        <input
          type="checkbox"
          checked={selected}
          onchange={() => onToggleSelect?.(event.id, !selected)}
        />
        {#if selected}
          <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"
            ><path
              d="M5 12l5 5L20 7"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            /></svg
          >
        {/if}
      </label>

      <AuthorAvatar authorIsMe={event.authorIsMe} {currentUserName} />

      <span class="kind-icon" aria-label={kindLabel} title={kindLabel}>
        <KindIcon kind={event.kind} size={18} />
      </span>

      <span class="src" title={sourceLabel}>{sourceLabel}</span>
      <span class="date">{dateLabel}</span>
    </div>

    {#if bylineLabel}
      <div class="card-byline" title={bylineLabel}>{bylineLabel}</div>
    {/if}

    <h3 class="card-title">{event.title}</h3>

    {#if showThumb}
      <div class="card-thumb" class:empty={!thumbnailUrl}>
        {#if thumbnailUrl}
          <!-- NO crossorigin: these thumbnails are display-only (never read into
               a canvas), and Instagram's cdninstagram.com serves the bytes
               WITHOUT Access-Control-Allow-Origin headers. With
               crossorigin="anonymous" the browser fetches 200 but DISCARDS the
               image on the failed CORS check → broken thumbnail (#69). YouTube /
               Reddit CDNs send CORS headers so they were unaffected, which
               masked this. referrerpolicy stays (CDN hotlink hygiene). -->
          <img
            src={thumbnailUrl}
            alt={m.feed_card_thumbnail_alt({ title: event.title })}
            referrerpolicy="no-referrer"
            loading="lazy"
            onerror={onThumbnailError ? () => onThumbnailError() : undefined}
          />
        {:else}
          <KindIcon kind={event.kind} size={36} />
        {/if}
        <!-- The pill renders whenever the media slot does — including the
             KindIcon placeholder (thumb-less manual events, ORB-blocked
             covers), so the content type stays readable (UAT 2026-06-12).
             Mirrors the event-detail behavior. -->
        {#if thumbnailOverlay}
          <MediaTypePill pill={thumbnailOverlay} />
        {/if}
      </div>
    {/if}

    {#if event.notes}
      <p class="card-notes">{event.notes}</p>
    {/if}

    {#if statsSlot}{@render statsSlot()}{/if}
    {#if extraSlot}{@render extraSlot()}{/if}

    <div class="card-footer">
      <div class="card-footer-chips">
        {#if inboxRow}
          <span class="inbox-chip">{m.inbox_badge()}</span>
          <!-- UX-on-top-of-prototype: a quick-attach chip-button so the
               user can open GamesPicker without going through ⋮. Mirrors
               the chip silhouette but reads as actionable (accent color +
               solid dashed border + cursor pointer). Stops propagation
               so the surrounding article's click→openDetail doesn't fire. -->
          <button
            type="button"
            class="attach-chip"
            onclick={(e) => {
              e.stopPropagation();
              onOpenGamesPickerForCard?.(event.id);
            }}
          >
            + {m.feed_card_menu_edit_games()}
          </button>
        {/if}
        {#each attachedGames as ag (ag.id)}
          <span class="game-chip" style="--card-accent: {gameColor(ag.id)};">{ag.title}</span>
        {/each}
        {#if standalone}
          <span class="off-topic-chip">Off topic</span>
        {/if}
      </div>
    </div>

    <!-- Inline inbox affordances removed to match prototype
         docs/design/v2/ui-kit/app.jsx:1180-1193 — the design surfaces
         only the `inbox` chip in card-footer-chips for un-attached
         events. User attaches games via ⋮ → Edit games (GamesPicker)
         or via bulk select. The off-topic toggle lives in GamesPicker's
         tri-state row + the bulk edit sheet. -->
  </div>
</article>

<style>
  /* Card root mirrors docs/design/v2/ui-kit/index.html .card rules.
   * Styles cloned from the original FeedCard.svelte. Promote z-index
   * when the menu opens so dropdowns paint above sibling cards. */
  .feed-card {
    position: relative;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    display: flex;
    flex-direction: column;
    box-shadow: var(--shadow-card);
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease),
      transform var(--m-fast) var(--m-ease);
    min-width: 0;
    max-width: 100%;
  }
  .feed-card:has(.card-menu) {
    z-index: 20;
  }
  @media (hover: hover) {
    .feed-card:hover {
      background: var(--surface-2);
      border-color: var(--accent);
      cursor: pointer;
    }
  }
  /* Kind-color stripe. Inset 1px so it sits INSIDE the card border;
   * border-radius rounds its corners to match the card. Previously
   * left:0/top:0/bottom:0 made the stripe extend square-edged past
   * the card's rounded corners (visible after .feed-card overflow:
   * hidden was removed for the dropdown menu). */
  .feed-card[data-kind-color="1"]::before {
    content: "";
    position: absolute;
    left: 1px;
    top: 1px;
    bottom: 1px;
    width: 2px;
    background: var(--card-accent, var(--border-2));
    border-top-left-radius: calc(var(--r-md) - 1px);
    border-bottom-left-radius: calc(var(--r-md) - 1px);
    z-index: 1;
  }

  .card-body {
    padding: var(--s-3) var(--s-4) var(--s-4);
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    flex: 1;
    min-width: 0;
  }

  .card-meta {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    color: var(--text-3);
    font-size: var(--t-12);
    min-width: 0;
    padding-right: 34px;
  }
  .card-meta + .card-title {
    margin-top: 2px;
  }

  .kind-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--card-accent, var(--text-2));
    flex-shrink: 0;
  }
  .kind-icon :global(svg.kind) {
    color: inherit;
  }

  .card-meta .src {
    color: var(--text-3);
    font-family: var(--f-mono);
    font-size: 11.5px;
    text-overflow: ellipsis;
    overflow: hidden;
    white-space: nowrap;
    min-width: 0;
    flex: 1;
  }
  .card-meta .date {
    color: var(--text-3);
    font-family: var(--f-mono);
    font-size: 11.5px;
    flex-shrink: 0;
  }

  .card-select {
    display: none;
    width: 18px;
    height: 18px;
    padding: 0;
    margin: 0;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 1px solid var(--border-2);
    border-radius: 4px;
    color: var(--accent-text);
    cursor: pointer;
    flex-shrink: 0;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
    position: relative;
  }
  :global(body[data-selection="1"]) .card-select,
  .feed-card[data-selected="1"] .card-select {
    display: inline-flex;
  }
  .card-select input[type="checkbox"] {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    opacity: 0;
    cursor: pointer;
  }
  .card-select:hover {
    border-color: var(--accent);
    background: var(--surface-2);
  }
  .card-select[data-checked="1"] {
    background: var(--accent);
    border-color: var(--accent);
  }
  .card-select svg {
    width: 12px;
    height: 12px;
    pointer-events: none;
  }

  .feed-card[data-selected="1"] {
    outline: 2px solid var(--accent);
    outline-offset: -1px;
  }
  .feed-card[data-selected="1"] .card-select {
    opacity: 1;
  }
  :global(body[data-selection="1"]) .feed-card {
    cursor: pointer;
  }

  .card-actions {
    position: absolute;
    top: 8px;
    right: 8px;
    display: flex;
    gap: 4px;
    z-index: 2;
  }
  .card-action-btn.overflow {
    width: 26px;
    height: 26px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    color: var(--text-3);
    line-height: 1;
    cursor: pointer;
    transition:
      color var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease),
      background var(--m-fast) var(--m-ease);
  }
  @media (hover: hover) {
    .feed-card:hover .card-action-btn.overflow {
      background: var(--surface-3);
      color: var(--text-2);
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.25);
    }
  }
  .card-action-btn.overflow:hover {
    color: var(--text);
    border-color: var(--accent);
  }

  .card-menu {
    position: absolute;
    top: calc(var(--s-2) + 30px);
    right: var(--s-2);
    z-index: 3;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    box-shadow: var(--shadow-elev);
    padding: var(--s-1);
    display: flex;
    flex-direction: column;
    min-width: 160px;
  }
  .card-menu [role="menuitem"] {
    background: transparent;
    border: none;
    text-align: left;
    padding: var(--s-2) var(--s-3);
    font-size: var(--t-13);
    color: var(--text);
    cursor: pointer;
    border-radius: var(--r-sm);
  }
  .card-menu [role="menuitem"]:hover {
    background: var(--accent-soft);
  }
  .card-menu .danger {
    color: var(--danger);
  }
  .card-menu .danger:hover {
    background: color-mix(in oklab, var(--danger) 12%, var(--surface-2));
  }

  .card-byline {
    /* Left-align with the .card-meta .src text so subreddit (row 1) and
     * author handle (row 2) start at the same column. .card-meta flex
     * sequence is [select=0 default][avatar 20][gap 8][kind-icon ~16]
     * [gap 8][src], so src begins at 52px from the card-body padding.
     * Match here. */
    padding-left: 52px;
    padding-right: 34px;
    margin-top: -2px;
    color: var(--text-3);
    font-family: var(--f-mono);
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    line-height: 1.4;
  }

  .card-title {
    margin: 0;
    font-size: 16px;
    font-weight: var(--w-sb);
    line-height: 1.35;
    color: var(--text);
    letter-spacing: -0.005em;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    word-break: break-word;
  }
  .card-title + .card-thumb {
    margin-top: var(--s-1);
  }

  .card-thumb {
    position: relative;
    aspect-ratio: 16 / 9;
    background: var(--surface-2);
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-4);
    border-radius: var(--r-sm);
    border: 1px solid var(--border-hairline);
  }
  .card-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .card-thumb.empty {
    background: radial-gradient(circle at 50% 50%, var(--surface-2) 0%, var(--surface) 70%);
  }
  .card-thumb.empty :global(svg) {
    color: var(--card-accent, var(--text-4));
    opacity: 0.45;
  }

  .card-notes {
    margin: 0;
    color: var(--text-2);
    font-size: var(--t-13);
    line-height: 1.5;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    word-break: break-word;
  }

  /* .card-stats consumed by per-platform stats snippets — keep global
   * so YoutubeFeedCard / RedditFeedCard rendering inside a stats slot
   * still inherits the layout (CSS scoping wouldn't reach them). */
  :global(.card-stats) {
    display: flex;
    gap: var(--s-3);
    color: var(--text-3);
    font-size: var(--t-12);
    font-variant-numeric: tabular-nums;
    padding-top: var(--s-1);
    flex-wrap: wrap;
    align-items: center;
  }
  :global(.card-stats .stat) {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    white-space: nowrap;
  }
  :global(.card-stats .stat-icon) {
    flex: 0 0 auto;
  }
  :global(.card-stats .num) {
    font-family: var(--f-mono);
  }

  :global(.reddit-baseline-badge) {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-1);
    align-items: center;
  }
  :global(.badge) {
    display: inline-flex;
    align-items: center;
    padding: 2px var(--s-2);
    border-radius: var(--r-sm);
    font-size: var(--t-12);
    line-height: 1.2;
  }
  :global(.badge-warning) {
    background: color-mix(in oklab, var(--warn) 18%, transparent);
    color: var(--warn);
    border: 1px solid var(--warn);
  }

  .card-footer {
    display: flex;
    align-items: flex-end;
    gap: var(--s-2);
    padding-top: var(--s-2);
    margin-top: auto;
    border-top: 1px solid var(--border-hairline);
    flex-wrap: wrap;
  }
  .card-footer-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    flex: 1;
    min-width: 0;
    align-items: center;
  }
  .game-chip,
  .inbox-chip,
  .off-topic-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px 3px 12px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-pill);
    color: var(--text-2);
    font-size: var(--t-12);
    font-weight: var(--w-md);
    white-space: nowrap;
  }
  .game-chip {
    background: color-mix(in oklab, var(--card-accent, var(--border-2)) 14%, var(--surface));
    border-color: color-mix(in oklab, var(--card-accent, var(--border-2)) 45%, var(--border));
    box-shadow: inset 3px 0 0 var(--card-accent, var(--border-2));
    padding-left: 14px;
    color: var(--text);
  }
  .inbox-chip {
    background: color-mix(in oklab, var(--warn) 14%, var(--surface));
    border-color: color-mix(in oklab, var(--warn) 45%, var(--border));
    color: var(--text-2);
  }
  /* Quick-attach chip-button — sits next to .inbox-chip in card-footer-
   * chips. Visually mirrors the chip silhouette but reads as actionable
   * (accent border + accent text + hover fill). UX-on-top-of-prototype:
   * the prototype doesn't have this affordance, but the user asked for
   * a one-click attach path without going through ⋮. */
  .attach-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 10px;
    background: transparent;
    border: 1px dashed color-mix(in oklab, var(--accent) 60%, var(--border));
    border-radius: var(--r-pill);
    color: var(--accent);
    font-size: var(--t-12);
    font-weight: var(--w-sb);
    font-family: inherit;
    white-space: nowrap;
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease),
      color var(--m-fast) var(--m-ease);
  }
  .attach-chip:hover {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent-strong);
  }
  .attach-chip:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .off-topic-chip {
    background: transparent;
    border-style: dashed;
    color: var(--text-2);
    padding-left: 12px;
  }

  @media (prefers-reduced-motion: reduce) {
    .feed-card,
    .card-select,
    .card-action-btn.overflow {
      transition: none;
    }
  }
</style>
