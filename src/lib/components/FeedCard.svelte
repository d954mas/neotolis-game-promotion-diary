<script lang="ts">
  // FeedCard — v2 visual-parity rewrite (Phase 03.4 gap-closure).
  //
  // Markup + CSS mirror docs/design/v2/ui-kit/app.jsx `FeedCard`
  // (lines 1019-1198) + docs/design/v2/ui-kit/index.html .card* rules
  // (~lines 836-1135). Slot order is:
  //
  //   1. card-meta       — [select][author-avatar][kind-icon][src][date]
  //   2. card-byline     — per-source second line (today: reddit /u/handle)
  //   3. card-title      — h3, 16px sb, line-clamp 3
  //   4. card-thumb      — 16/9 aspect; youtube + image-ish reddit/twitter
  //                        /telegram links; KindIcon fallback
  //   5. card-notes      — 2-line clipped paragraph
  //   6. card-stats      — youtube views/likes/comments OR reddit score row
  //   7. card-footer     — chips on left (inbox / game(s) / off-topic),
  //                        with per-card affordances (picker, mark-
  //                        standalone) flowing inside .card-footer-chips
  //
  // CSS hook contract preserved end-to-end (LB-10):
  //   - `data-testid="feed-card"` on the root article
  //   - `data-selected`, `data-view`, `data-mine`, `data-kind`,
  //     `data-shape`, `data-long-pressed` all kept for tests + CSS hooks
  //   - `.card-select` always-visible checkbox inside .card-meta;
  //     <input> still wrapped by <label> so existing test querying
  //     `.card-select input` continues to pass
  //   - `.card-actions` overflow trigger preserved as a real <button>
  //     so the keyboard / aria contract holds; the article-level click
  //     handler short-circuits on closest('.card-actions') so tests
  //     calling `.card-actions.click()` don't navigate
  //
  // Image-source rules (auto-derived only — manual upload still TODO):
  //   - kind=youtube_video + externalId → img.youtube.com/vi/{id}/mqdefault.jpg
  //   - kind=reddit_post → enrichment.linkUrl OR metadata.media.url, only
  //     when isImageLikeUrl() (i.redd.it / preview.redd.it / image ext)
  //   - kind=twitter_post / telegram_post → metadata.media.url
  //   - all other kinds → KindIcon fallback rendered inside .card-thumb
  //     when data-shape="media", or no thumb at all when text-shape
  //
  // Privacy invariants (unchanged):
  //   - <img referrerpolicy="no-referrer" crossorigin="anonymous"> for
  //     every external image (LB-9)
  //   - Image URLs sourced from already-projected event fields; no
  //     ciphertext / userId leak path

  import { m } from "$lib/paraglide/messages.js";
  import KindIcon from "./KindIcon.svelte";
  import AttachToGamePicker from "./AttachToGamePicker.svelte";

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

  type EventDtoLite = {
    id: string;
    gameIds: string[];
    sourceId: string | null;
    kind: EventKind;
    authorIsMe: boolean;
    occurredAt: Date | string;
    title: string;
    url: string | null;
    externalId: string | null;
    notes: string | null;
    metadata: unknown;
    publishedAt?: Date | string | null;
    lastPolledAt: Date | string | null;
    lastPollStatus: string | null;
    stats?: {
      viewCount: number;
      likeCount: number;
      commentCount: number;
      polledAt: Date | string;
    } | null;
    channelTitle?: string | null;
    redditEnrichment?: {
      stats: {
        score: number;
        numComments: number;
        upvoteRatio: number;
        awardsTotal: number;
      } | null;
      subredditSubscribers: number | null;
      authorKarma: number | null;
      baseline: {
        medianScore24h: number | null;
        p75Score24h: number | null;
        sampleSize: number;
      } | null;
      linkUrl?: string | null;
      bodyExcerpt?: string | null;
    };
  };
  type SourceLite = {
    id: string;
    displayName: string | null;
    handleUrl: string;
    channelTitle?: string | null;
  };
  type GameLite = {
    id: string;
    title: string;
  };

  let {
    event,
    source,
    game,
    games,
    onChanged,
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
  }: {
    event: EventDtoLite;
    source: SourceLite | null;
    game: GameLite | null;
    games: GameLite[];
    onChanged?: () => void;
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
  } = $props();

  // Author avatar tooltip + glyph derived from currentUserName.
  // Mirrors prototype docs/design/v2/ui-kit/app.jsx lines 1124-1131:
  //   - mine:    title = "{name} (you)",   glyph = first char of name
  //   - unknown: title = "Unknown author", glyph = "?"
  const authorTooltip = $derived.by((): string => {
    if (event.authorIsMe) {
      const name = (currentUserName ?? "").trim();
      return name ? `${name} (you)` : "You";
    }
    return "Unknown author";
  });
  const authorGlyph = $derived.by((): string => {
    if (event.authorIsMe) {
      const name = (currentUserName ?? "").trim();
      return name ? name.charAt(0).toUpperCase() : "Y";
    }
    return "?";
  });

  // Touch long-press → enters selection mode after 480ms. cancelPress wires
  // touchmove/touchend/touchcancel — scroll-cancel is LOAD-BEARING per D-28.
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

  function readMediaUrlFromMetadata(md: unknown): string | null {
    if (md === null || typeof md !== "object") return null;
    const mediaContainer = (md as { media?: unknown }).media;
    if (
      mediaContainer === null ||
      mediaContainer === undefined ||
      typeof mediaContainer !== "object"
    )
      return null;
    const url = (mediaContainer as { url?: unknown }).url;
    return typeof url === "string" && url.length > 0 ? url : null;
  }

  function isImageLikeUrl(url: string): boolean {
    const lower = url.toLowerCase();
    if (lower.startsWith("https://i.redd.it/")) return true;
    if (lower.startsWith("https://preview.redd.it/")) return true;
    return /\.(jpg|jpeg|png|gif|webp)(\?|$)/i.test(lower);
  }

  const thumbnailUrl = $derived.by((): string | null => {
    if (event.kind === "youtube_video") {
      if (!event.externalId) return null;
      return `https://img.youtube.com/vi/${event.externalId}/mqdefault.jpg`;
    }
    if (event.kind === "reddit_post") {
      const link = event.redditEnrichment?.linkUrl ?? null;
      if (link && isImageLikeUrl(link)) return link;
      return readMediaUrlFromMetadata(event.metadata);
    }
    if (event.kind === "twitter_post" || event.kind === "telegram_post") {
      return readMediaUrlFromMetadata(event.metadata);
    }
    return null;
  });

  // data-shape="media" reserves a 16:9 thumb slot for kinds where a thumb
  // is expected even when missing (youtube). Other kinds only show a thumb
  // when an image is actually available.
  const isMediaShape = $derived.by((): boolean => event.kind === "youtube_video");
  const showThumb = $derived.by((): boolean => isMediaShape || thumbnailUrl !== null);

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

  // Source-handle label for .card-meta .src. Prefers the YouTube channel
  // title when present (auto-imported AND manual paste both go through the
  // /feed loader's youtube_videos enrichment), falls back to the user's
  // displayName on the source row, then the raw handleUrl. Reddit / Twitter
  // / Telegram pull subreddit / @handle from event.metadata.
  const sourceLabel = $derived.by((): string => {
    if (event.kind === "youtube_video") {
      return event.channelTitle ?? source?.channelTitle ?? source?.displayName ?? source?.handleUrl ?? "";
    }
    const md = (event.metadata ?? {}) as { subreddit?: string; handle?: string; channel?: string };
    if (event.kind === "reddit_post" && md.subreddit) return `r/${md.subreddit}`;
    if (event.kind === "twitter_post" && md.handle) return `@${md.handle}`;
    if (event.kind === "telegram_post" && md.channel) return md.channel;
    return source?.displayName ?? source?.handleUrl ?? "";
  });

  const bylineLabel = $derived.by((): string | null => {
    if (event.kind === "reddit_post") {
      const md = (event.metadata ?? {}) as { author?: string };
      return md.author ? `/u/${md.author}` : null;
    }
    return null;
  });

  // Month-Day formatter — mirrors prototype's fmtMonthDay (app.jsx:323).
  // "May 21" style. Uses Intl with month: short for locale-correct labels.
  const dateLabel = $derived.by((): string => {
    const d = typeof event.occurredAt === "string" ? new Date(event.occurredAt) : event.occurredAt;
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  });

  const isInboxRow = $derived.by((): boolean => {
    if (event.gameIds.length > 0) return false;
    const md = event.metadata as
      | { inbox?: { dismissed?: boolean }; triage?: { offTopic?: boolean } }
      | null
      | undefined;
    if (md?.inbox?.dismissed === true) return false;
    if (md?.triage?.offTopic === true) return false;
    return true;
  });

  const isStandalone = $derived.by((): boolean => {
    const md = event.metadata as { triage?: { offTopic?: boolean } } | null | undefined;
    return md?.triage?.offTopic === true;
  });

  // All attached games (multi-attach events render one chip per game).
  // Looks up each gameId from the games catalog passed by the orchestrator.
  const attachedGames = $derived.by((): { id: string; title: string }[] => {
    if (event.gameIds.length === 0) return [];
    const map = new Map(games.map((g) => [g.id, g] as const));
    return event.gameIds
      .map((gid) => map.get(gid))
      .filter((g): g is GameLite => g !== undefined);
  });

  // Deterministic per-game color from id hash → CSS hsl. GameDto has no
  // color field, so derive client-side. Same id → same hue across the
  // app. Light/dark theme adapts via fixed saturation + lightness curve.
  function gameColor(id: string): string {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
    const hue = ((h % 360) + 360) % 360;
    return `hsl(${hue} 62% 52%)`;
  }

  let markingStandalone = $state(false);
  async function markStandaloneClick(): Promise<void> {
    if (markingStandalone) return;
    markingStandalone = true;
    try {
      const res = await fetch(`/api/events/${event.id}/mark-standalone`, {
        method: "PATCH",
      });
      if (res.ok) onChanged?.();
    } finally {
      markingStandalone = false;
    }
  }

  function formatStat(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  }
</script>

<article
  class="feed-card card"
  class:standalone={isStandalone}
  data-kind={event.kind}
  data-shape={isMediaShape ? "media" : "text"}
  data-media={showThumb ? "1" : "0"}
  data-kind-color="1"
  data-selected={selected ? "1" : "0"}
  data-view={view}
  data-mine={event.authorIsMe ? "1" : "0"}
  data-testid="feed-card"
  style="--card-accent: var(--k-{event.kind}); --kind-color: var(--k-{event.kind});"
  ontouchstart={startPress}
  ontouchend={cancelPress}
  ontouchmove={cancelPress}
  ontouchcancel={cancelPress}
  oncontextmenu={(e) => e.preventDefault()}
  onclick={(e) => {
    const target = e.target as Element;
    if (target.closest(".card-select, .card-actions, .card-menu, .picker-line")) {
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
  <!-- ⋯ overflow trigger sits top-right OUTSIDE .card-body so its click
       short-circuits the article-level handler via closest('.card-actions').
       Wrapped in a <div class="card-actions"> mirrors prototype lines
       1080-1098 — the div is the closest() anchor, the inner <button> is
       the focusable / keyboard target. -->
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
        <!-- Trash view: Restore + Delete forever. The soft-delete + edit-games
             actions don't make sense on an already-deleted row. -->
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
      <!-- Selection checkbox — leftmost. <label>+<input> kept so the
           existing browser test querying `.card-select input` still passes;
           visually styled as the prototype's button-shaped checkbox. The
           outer <label> stops bubbling so clicks don't navigate. -->
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

      <span
        class="author-avatar"
        class:mine={event.authorIsMe}
        class:unknown={!event.authorIsMe}
        data-mine={event.authorIsMe ? "1" : "0"}
        title={authorTooltip}
        aria-label={event.authorIsMe
          ? m.author_avatar_mine_aria({ name: currentUserName ?? "you" })
          : m.author_avatar_unknown_aria()}
      >
        {authorGlyph}
      </span>

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
          <img
            src={thumbnailUrl}
            alt={m.feed_card_thumbnail_alt({ title: event.title })}
            referrerpolicy="no-referrer"
            crossorigin="anonymous"
            loading="lazy"
          />
        {:else}
          <KindIcon kind={event.kind} size={36} />
        {/if}
        {#if isInboxRow}
          <span class="thumb-badge thumb-badge--inbox">{m.inbox_badge()}</span>
        {/if}
        {#if event.authorIsMe}
          <span class="thumb-badge thumb-badge--mine">{m.feed_card_author_is_me_badge()}</span>
        {/if}
      </div>
    {/if}

    {#if event.notes}
      <p class="card-notes">{event.notes}</p>
    {/if}

    {#if event.kind === "youtube_video" && event.stats}
      <div class="card-stats stats-line">
        <span class="stat">
          <svg
            class="stat-icon"
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
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          <span class="num">{formatStat(event.stats.viewCount)}</span>
        </span>
        <span class="stat">
          <svg
            class="stat-icon"
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
            <path
              d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"
            />
          </svg>
          <span class="num">{formatStat(event.stats.likeCount)}</span>
        </span>
        <span class="stat">
          <svg
            class="stat-icon"
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
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          <span class="num">{formatStat(event.stats.commentCount)}</span>
        </span>
      </div>
    {/if}

    {#if event.kind === "reddit_post"}
      {@const rstats = event.redditEnrichment?.stats ?? null}
      {@const rbaseline = event.redditEnrichment?.baseline ?? null}
      {@const underperforming =
        rstats !== null &&
        rbaseline !== null &&
        rbaseline.sampleSize >= 5 &&
        rbaseline.medianScore24h !== null &&
        rstats.score < rbaseline.medianScore24h}
      {@const baselinePct =
        rstats !== null &&
        rbaseline !== null &&
        rbaseline.medianScore24h !== null &&
        rbaseline.medianScore24h > 0
          ? Math.round((rstats.score / rbaseline.medianScore24h) * 100)
          : null}
      {#if rstats}
        <div class="card-stats stats-line">
          <span class="stat"
            >{m.feed_card_reddit_stats({
              score: rstats.score,
              comments: rstats.numComments,
              ratio: Math.round(rstats.upvoteRatio * 100),
            })}</span
          >
        </div>
      {/if}
      {#if underperforming && baselinePct !== null}
        <div class="reddit-baseline-badge">
          <span class="badge badge-warning"
            >{m.feed_card_reddit_baseline_underperforming({
              pct: baselinePct,
            })}</span
          >
        </div>
      {/if}
    {/if}

    <div class="card-footer">
      <div class="card-footer-chips">
        {#if isInboxRow}
          <span class="inbox-chip">{m.inbox_badge()}</span>
        {/if}
        {#each attachedGames as ag (ag.id)}
          <span class="game-chip" style="--card-accent: {gameColor(ag.id)};">{ag.title}</span>
        {/each}
        {#if isStandalone}
          <span class="off-topic-chip">Off topic</span>
        {/if}
      </div>
    </div>

    {#if isInboxRow}
      <!-- INBOX-only flow — the only mutating control on the card surface.
           Lives inside .card-body so it shares meta-row left padding, but
           below .card-footer so the chips read first. The article-level
           click handler short-circuits on closest('.picker-line') so
           interactions here don't fall through to onOpenDetail. -->
      <div class="picker-line" onclick={(e) => e.stopPropagation()} role="presentation">
        <AttachToGamePicker {event} {games} onChanged={() => onChanged?.()} compact={true} />
        <button
          type="button"
          class="standalone-button"
          onclick={markStandaloneClick}
          disabled={markingStandalone}
        >
          {m.feed_card_mark_standalone_button()}
        </button>
      </div>
    {/if}
  </div>
</article>

<style>
  /* ── Card root (mirrors docs/design/v2/ui-kit/index.html .card rules) ── */
  /* No overflow:hidden on .feed-card — it would clip the .card-menu
   * dropdown (position:absolute) when the menu's height exceeds the
   * card's height. The .card-thumb has its own overflow:hidden +
   * border-radius for image rounding, so removing it here doesn't
   * leak the thumb image past the card's rounded corners. */
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
  @media (hover: hover) {
    .feed-card:hover {
      background: var(--surface-2);
      border-color: var(--accent);
      cursor: pointer;
    }
  }
  /* Kind color-coded left stripe. Sits on top of the card border via
   * absolute positioning so border-radius doesn't clip it weirdly. */
  .feed-card[data-kind-color="1"]::before {
    content: "";
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 2px;
    background: var(--card-accent, var(--border-2));
    z-index: 1;
  }
  /* Off-topic events are NOT faded — matches prototype
   * docs/design/v2/ui-kit/index.html which has no .card.standalone
   * opacity rule. Off-topic state is communicated via the .off-topic-chip
   * in card-footer, not by dimming the entire card (user confused the
   * fade with "deleted" styling after restoring from trash). */

  /* ── Card body ── */
  .card-body {
    padding: var(--s-3) var(--s-4) var(--s-4);
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    flex: 1;
    min-width: 0;
  }

  /* ── Card meta line — [select][avatar][kind-icon][src][date] ── */
  .card-meta {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    color: var(--text-3);
    font-size: var(--t-12);
    min-width: 0;
    /* Reserve space for the ⋯ button so the date stays readable. */
    padding-right: 34px;
  }
  .card-meta + .card-title {
    margin-top: 2px;
  }

  /* Author avatar — leftmost meaningful glyph after the checkbox.
   *   mine    = accent fill with current user's initial
   *   unknown = empty neutral circle (no derived initial — we don't
   *             fake authorship from .src). */
  .author-avatar {
    width: 20px;
    height: 20px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    border-radius: 50%;
    background: var(--surface-2);
    color: var(--text-4);
    font-family: var(--f-sans);
    font-size: 11px;
    font-weight: var(--w-md);
    letter-spacing: 0;
    border: 1px dashed var(--border-2);
    cursor: default;
  }
  .author-avatar.mine,
  .author-avatar[data-mine="1"] {
    background: var(--accent);
    color: var(--accent-text);
    border-color: var(--accent);
    border-style: solid;
    font-weight: var(--w-sb);
    font-size: 10.5px;
    letter-spacing: 0.02em;
    box-shadow: 0 0 0 1.5px color-mix(in oklab, var(--accent) 35%, transparent);
  }
  /* .author-avatar.unknown — base styles already cover the unknown state;
   * selector kept on the element for grep parity. */

  .kind-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--card-accent, var(--text-2));
    flex-shrink: 0;
  }
  /* KindIcon's SVG inherits the kind color via currentColor. */
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

  /* ── Selection checkbox — leftmost slot in the meta row ──
   *
   * Hidden by default (display:none → no layout reservation, no visual
   * distraction). Reveals when:
   *   - mass-select mode is active (`body[data-selection="1"]` —
   *     orchestrator sets this when anySelected from feedUiStore)
   *   - this specific card is selected (`data-selected="1"` on .feed-card)
   *
   * User can enter mass-select via ⋮ → Select OR touch long-press.
   * Once in mass-select mode, every card's checkbox appears so the user
   * can shift-click / sweep additional rows.
   */
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
  /* Reveal when mass-select mode is on OR this card is itself selected. */
  :global(body[data-selection="1"]) .card-select,
  .feed-card[data-selected="1"] .card-select {
    display: inline-flex;
  }
  /* Hide the native checkbox visual; it's still focusable + clickable
   * because we forward clicks via the wrapping label and the test
   * queries `.card-select input` directly. */
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

  /* Selected card — accent outline ring (LB-10). */
  .feed-card[data-selected="1"] {
    outline: 2px solid var(--accent);
    outline-offset: -1px;
  }
  .feed-card[data-selected="1"] .card-select {
    opacity: 1;
  }
  /* Gmail sweep cursor hint once any selection is active. */
  :global(body[data-selection="1"]) .feed-card {
    cursor: pointer;
  }

  /* ── ⋯ overflow trigger ── */
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
  .card-menu .danger:hover {
    color: var(--danger);
  }

  /* ── Byline (reddit /u/handle, etc.) ── */
  .card-byline {
    /* Align under the .src column: checkbox 18 + gap 8 + avatar 20 +
     * gap 8 + kind-icon 18 + gap 8 = 80px. */
    padding-left: 80px;
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

  /* ── Card title ── */
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
  /* Tiny extra breathing room above thumbs that follow the title. */
  .card-title + .card-thumb {
    margin-top: var(--s-1);
  }

  /* ── Card thumb (16:9) ── */
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
    background:
      radial-gradient(circle at 50% 50%, var(--surface-2) 0%, var(--surface) 70%);
  }
  .card-thumb.empty :global(svg) {
    color: var(--card-accent, var(--text-4));
    opacity: 0.45;
  }
  /* Per-thumb badges (inbox + mine). Sit top-left as small dark pills. */
  .thumb-badge {
    position: absolute;
    top: 6px;
    padding: 2px var(--s-2);
    background: var(--overlay-dark);
    color: #fff;
    font-size: var(--t-12);
    line-height: 1;
    border-radius: var(--r-pill);
    pointer-events: none;
    white-space: nowrap;
  }
  .thumb-badge--inbox {
    left: 6px;
  }
  .thumb-badge--mine {
    right: 6px;
    background: color-mix(in oklab, var(--accent) 78%, black);
  }

  /* ── Notes paragraph (2-line clamp per prototype) ── */
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

  /* ── Card stats (views / likes / comments triad) ── */
  .card-stats {
    display: flex;
    gap: var(--s-3);
    color: var(--text-3);
    font-size: var(--t-12);
    font-variant-numeric: tabular-nums;
    padding-top: var(--s-1);
    flex-wrap: wrap;
    align-items: center;
  }
  .card-stats .stat {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    white-space: nowrap;
  }
  .card-stats .stat-icon {
    flex: 0 0 auto;
  }
  .card-stats .num {
    font-family: var(--f-mono);
  }

  /* ── Underperforming-median badge (Reddit) ── */
  .reddit-baseline-badge {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-1);
    align-items: center;
  }
  .badge {
    display: inline-flex;
    align-items: center;
    padding: 2px var(--s-2);
    border-radius: var(--r-sm);
    font-size: var(--t-12);
    line-height: 1.2;
  }
  .badge-warning {
    background: color-mix(in oklab, var(--warn) 18%, transparent);
    color: var(--warn);
    border: 1px solid var(--warn);
  }

  /* ── Card footer (chips) ── */
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
  /* Game chip — neutral surface-2 (matches prototype `.game-chip` once
   * the per-game `--game-color` var is unset, which is our current
   * state: games don't carry a color yet). UAT cat C3: the accent tint
   * read as a global "active filter" signal and visually competed with
   * the active filter-axis game chip in the floor-2 chrome. Neutral
   * grey makes the card-footer chip purely decorative — the active
   * filter-axis game chip retains the accent treatment via DateRangeRow
   * / FilterChips.
   *
   * The 3px inset stripe is retained as a faint border-2 hairline so
   * the chip still echoes the prototype's "left-stripe in game color"
   * pattern (visually muted) — when per-game colors land, swap
   * var(--border-2) for var(--game-color, var(--border-2)). */
  /* Game chip — tinted bg + colored border + inset stripe, all driven by
   * --card-accent (set inline from gameColor(id) hash). Matches prototype
   * card-footer game-chip pattern. */
  .game-chip {
    background: color-mix(in oklab, var(--card-accent, var(--border-2)) 14%, var(--surface));
    border-color: color-mix(
      in oklab,
      var(--card-accent, var(--border-2)) 45%,
      var(--border)
    );
    box-shadow: inset 3px 0 0 var(--card-accent, var(--border-2));
    padding-left: 14px;
    color: var(--text);
  }
  .inbox-chip {
    background: color-mix(in oklab, var(--warn) 14%, var(--surface));
    border-color: color-mix(in oklab, var(--warn) 45%, var(--border));
    color: var(--text-2);
  }
  .off-topic-chip {
    background: transparent;
    border-style: dashed;
    color: var(--text-2);
    padding-left: 12px;
  }

  /* ── Inline INBOX-only mutating controls ── */
  .picker-line {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    flex-wrap: wrap;
    min-width: 0;
    padding-top: var(--s-2);
  }
  .standalone-button {
    min-height: var(--hit);
    padding: 0 var(--s-3);
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    font-size: var(--t-13);
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .standalone-button:hover:not(:disabled) {
    background: var(--surface-2);
  }
  .standalone-button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  @media (prefers-reduced-motion: reduce) {
    .feed-card,
    .standalone-button,
    .card-select,
    .card-action-btn.overflow,
    .author-avatar {
      transition: none;
    }
  }
</style>
