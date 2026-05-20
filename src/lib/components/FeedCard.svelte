<script lang="ts">
  // FeedCard — pure preview tile (read-only contract preserved).
  //
  // The vertical structure is (top → bottom):
  //
  //   1. Image area at TOP with absolute-positioned top overlay carrying
  //      kind icon+text label + Inbox badge (if applicable) + Mine badge
  //      (if author_is_me=true).
  //   2. Title under the image.
  //   3. Notes under the title (clipped via -webkit-line-clamp: 3).
  //   4. Meta-line — ONLY <PollingBadge> remains here. Kind label, Inbox,
  //      and Mine moved into the top overlay.
  //   5. Source chip (chips-line — without mine/game).
  //   6. Associated games block at the BOTTOM of the card body. The
  //      .games-block <div> sits AFTER the chips-line by design (user
  //      quote "Ассоцированные игры, давай внизу карточки.").
  //   7. Picker-line — AttachToGamePicker (the only mutating control,
  //      OUTSIDE the wrapping <a> so its onclick handlers don't trigger
  //      card navigation). INBOX-only flow.
  //
  // Mine treatment (v2 — UI-SPEC § "Card Contract" → "Mine marker"):
  //   - `.author-avatar.mine` accent-tinted circle in the meta row
  //     (--accent-soft background + --accent text, 24px). Replaces v1's
  //     4px left-border accent which collides with the v2 kind stripe.
  //   - `<span class='overlay-mine'>` pill in the top overlay stays on
  //     media-shape cards as a secondary signal alongside the kind label.
  //
  // Image-source rules per kind (auto-derived images only;
  // manual upload UI is OUT OF SCOPE, see TODO):
  //   - kind=youtube_video AND externalId → img.youtube.com/vi/{id}/mqdefault.jpg
  //   - kind=reddit_post / twitter_post / telegram_post → metadata.media.url
  //     (type-safe lookup; falls through if missing)
  //   - all other kinds (conference, talk, press, other, post, discord_drop)
  //     → text fallback (KindIcon centered in the .icon-anchor block)
  //
  // The Inbox indicator is rendered INLINE in the overlay:
  // a `<span class='overlay-inbox'>`
  // showing m.inbox_badge() text. The standalone <InboxBadge> component is no
  // longer used here (the overlay needs the dark-pill visual style consistent
  // with overlay-kind / overlay-mine; threading a `variant` prop through
  // InboxBadge would be premature for one consumer). InboxBadge stays
  // exported for potential future contexts.
  //
  // Read-only contract PRESERVED:
  //   - No inline Edit / Delete / Open buttons.
  //   - The wrapping <a href={`/events/${id}`}> stays as the click target.
  //   - AttachToGamePicker is the only mutating control (INBOX-only flow).
  //
  // Date-removal PRESERVED:
  //   - No inline date string on the card. The <FeedDateGroupHeader> above
  //     each card group is the date label (Google Photos / Apple Photos
  //     timeline pattern).
  //
  // TODO: support manual image upload — user quote "Хочется чтобы пользователь
  // мог для каждого такого события сам добавить картинку". Schema would add
  // `cover_url TEXT NULL` on events OR `metadata.image.url` (jsonb path);
  // resolver returns manual upload OR auto-derived per kind. Currently
  // auto-derived only.
  //
  // Privacy invariants:
  //   - <img referrerpolicy="no-referrer" crossorigin="anonymous"> for any
  //     external image source (existing pattern preserved).
  //   - Image URLs come from already-projected event fields (externalId is
  //     projected by toEventDto; metadata.media.url is part of the metadata
  //     jsonb that toEventDto passes through). No ciphertext / userId leaks.
  //   - Tenant scoping unchanged — this is a pure presentational refactor.

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
    // M:N migration — gameIds[] replaces the singular gameId.
    // Empty array === inbox (no attached games); non-empty === at least
    // one attached game. The card renders the first attached game as the
    // primary chip.
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
    // publishedAt + lastPolledAt + lastPollStatus all source from the
    // youtube_videos JOIN in the /feed loader
    // (mapEventsToDtos → loadVideoDataForEvents). Null on fresh events whose
    // channel-context-backfill has not yet completed ('pending' tier window).
    // Optional so test fixtures and non-feed surfaces can omit it;
    // PollingBadge handles undefined as null.
    publishedAt?: Date | string | null;
    lastPolledAt: Date | string | null;
    lastPollStatus: string | null;
    // Latest snapshot stats for youtube_video events. Null when no snapshot
    // exists yet (newly-pasted event before first poll, or non-youtube kinds).
    stats?: {
      viewCount: number;
      likeCount: number;
      commentCount: number;
      polledAt: Date | string;
    } | null;
    // channelTitle for ALL YouTube events (auto-imported AND manual paste),
    // enriched by /feed loader from youtube_videos cache. Used by the
    // single-chip render below.
    channelTitle?: string | null;
    // Reddit-specific enrichment (Phase 03.1 plan 08, D-RDT-BASELINES-DISPLAY).
    // Attached in-place by enrichRedditFeedDtos in the /feed loader's
    // allAdapters[*].enrichFeedDtos iterator. Missing on freshly-pasted
    // posts that haven't been polled yet, or on non-reddit kinds; the
    // card falls back to a stats-less render in that case.
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
    // Real YouTube channel title from the public-data cache. Distinct from
    // displayName (the user's own label for this tracking row). When both
    // are set and differ, the card renders both — channel chip + source chip.
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
  }: {
    event: EventDtoLite;
    source: SourceLite | null;
    game: GameLite | null;
    games: GameLite[];
    onChanged?: () => void;
  } = $props();

  // Type-safe metadata.media.url extraction (image-source rules).
  // metadata is `unknown` from toEventDto — we narrow before reading.
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

  // Image-URL heuristic for Reddit link posts. Reddit's `t3.url` for an
  // image post points at i.redd.it/<id>.jpg or preview.redd.it/...; for
  // crossposts on imgur / external CDNs the URL ends in a recognizable
  // image extension. Link-posts to articles fall through and we render
  // the kind icon instead of a broken image.
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
      // Prefer the link_url we eagerly load in enrichRedditFeedDtos
      // (resolved from reddit_posts.metadata.link_url). Falls back to
      // legacy metadata.media.url for any historical rows that carried it.
      const link = event.redditEnrichment?.linkUrl ?? null;
      if (link && isImageLikeUrl(link)) return link;
      return readMediaUrlFromMetadata(event.metadata);
    }
    if (event.kind === "twitter_post" || event.kind === "telegram_post") {
      return readMediaUrlFromMetadata(event.metadata);
    }
    return null;
  });

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

  const isInboxRow = $derived.by((): boolean => {
    // M:N migration: inbox criterion = ZERO attached games.
    if (event.gameIds.length > 0) return false;
    const md = event.metadata as
      | { inbox?: { dismissed?: boolean }; triage?: { standalone?: boolean } }
      | null
      | undefined;
    if (md?.inbox?.dismissed === true) return false;
    // Standalone events are NOT inbox rows — they have a separate triage
    // state. The inline "Mark standalone" button only appears on plain inbox
    // cards (not on already-standalone ones).
    if (md?.triage?.standalone === true) return false;
    return true;
  });

  // Standalone events render dimmed in /feed (opacity 0.55) so they don't
  // distract from game-tied events. The user-explicit "not related to any
  // game" state surfaces as a visible muting in the timeline.
  const isStandalone = $derived.by((): boolean => {
    const md = event.metadata as { triage?: { standalone?: boolean } } | null | undefined;
    return md?.triage?.standalone === true;
  });

  // Inline "Mark standalone" handler. Calls the new HTTP endpoint then
  // bubbles onChanged() so /feed's invalidateAll() re-runs the loader. The
  // button is the EXPLICIT user-accepted exception to the read-only-tile
  // contract. Errors are swallowed silently; later polish may surface a toast.
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

  // PollingBadge removed from feed cards — tier vocabulary ("Cold", "Frozen")
  // is internal scheduler state, not user-facing. The live state shows up
  // only in the per-event detail view alongside the refresh-now button.
  // /feed cards surface the load-bearing user metric instead: latest
  // YouTube view / like / comment count.
  function formatStat(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  }
</script>

<article
  class="feed-card"
  class:mine={event.authorIsMe}
  class:standalone={isStandalone}
  data-kind={event.kind}
  data-shape={event.kind === "youtube_video" ? "media" : "text"}
  data-testid="feed-card"
  style="--kind-color: var(--k-{event.kind});"
>
  <a class="card-body" href={`/events/${event.id}`}>
    {#if event.kind === "youtube_video"}
      <!-- Media shape: 16:9 thumbnail block at top, kind stripe = 2px left
           border in var(--kind-color). The .media wrapper falls back to a
           centered KindIcon when thumbnailUrl is null (missing-thumb
           fallback per UI-SPEC § "Iconography Contract" — 36px). -->
      <div class="media">
        {#if thumbnailUrl}
          <img
            class="thumbnail"
            src={thumbnailUrl}
            alt={m.feed_card_thumbnail_alt({ title: event.title })}
            referrerpolicy="no-referrer"
            crossorigin="anonymous"
            loading="lazy"
          />
        {:else}
          <div class="icon-anchor thumb-fallback" aria-hidden="true">
            <KindIcon kind={event.kind} size={36} />
          </div>
        {/if}
        <!-- Top overlay: kind label + Inbox + Mine pills. LB-10
             data-testid preserved. pointer-events: none so the overlay
             never intercepts clicks on the wrapping <a>. -->
        <div class="overlay" data-testid="feed-card-overlay">
          <span class="overlay-kind">
            <KindIcon kind={event.kind} size={14} />
            {kindLabel}
          </span>
          {#if isInboxRow}
            <span class="overlay-inbox">{m.inbox_badge()}</span>
          {/if}
          {#if event.authorIsMe}
            <span class="overlay-mine">{m.feed_card_author_is_me_badge()}</span>
          {/if}
        </div>
      </div>
    {/if}

    <!-- Meta row — author avatar + kind icon + kind label + (inbox badge)
         + date. Mine signal lives in .author-avatar.mine (replaces v1's
         4px left border, which collides with the v2 kind stripe). On
         text-shape cards the kind label is the primary kind signal; on
         media-shape it duplicates the overlay-kind pill but reads when
         the thumbnail is scrolled off-screen on tall lists. -->
    <div class="meta-row">
      <span
        class="author-avatar"
        class:mine={event.authorIsMe}
        title={event.authorIsMe ? m.feed_card_author_is_me_badge() : ""}
        aria-hidden="true"
      >
        {event.authorIsMe ? "↻" : "?"}
      </span>
      <KindIcon kind={event.kind} size={18} />
      <span class="kind-label">{kindLabel}</span>
      {#if event.kind !== "youtube_video" && isInboxRow}
        <span class="overlay-inbox">{m.inbox_badge()}</span>
      {/if}
    </div>

    <div class="title-line">
      <h3 class="title">{event.title}</h3>
    </div>

    {#if event.notes}
      <p class="notes">{event.notes}</p>
    {/if}

    {#if event.kind === "youtube_video" && event.stats}
      <div class="stats-line">
        <span class="stat">{formatStat(event.stats.viewCount)} views</span>
        <span class="sep">·</span>
        <span class="stat">{formatStat(event.stats.likeCount)} likes</span>
        <span class="sep">·</span>
        <span class="stat">{formatStat(event.stats.commentCount)} comments</span>
      </div>
    {/if}

    {#if event.kind === "reddit_post"}
      <!-- Reddit-specific render (Phase 03.1 plan 08, D-RDT-SOURCE-DISPLAY +
           D-RDT-BASELINES-DISPLAY). Stats line ↑score 💬comments (upvote%)
           when the worker has drained at least one snapshot; author chip
           (/u/author 🧑) + subreddit chip (/r/sub 🏛) from metadata;
           "Underperforming median" badge when score < median_score_24h AND
           baseline.sample_size >= 5 (insufficient samples hide the badge
           entirely per D-RDT-BASELINES-DISPLAY). -->
      {@const rstats = event.redditEnrichment?.stats ?? null}
      {@const rbaseline = event.redditEnrichment?.baseline ?? null}
      {@const rmd = (event.metadata ?? {}) as { author?: string; subreddit?: string }}
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
        <div class="stats-line">
          <span class="stat"
            >{m.feed_card_reddit_stats({
              score: rstats.score,
              comments: rstats.numComments,
              ratio: Math.round(rstats.upvoteRatio * 100),
            })}</span
          >
        </div>
      {/if}
      {#if rmd.author || rmd.subreddit}
        <div class="chips-line">
          {#if rmd.author}
            <span class="chip" title="Reddit user">
              <span aria-hidden="true" class="chip-prefix">🧑</span>
              /u/{rmd.author}
            </span>
          {/if}
          {#if rmd.subreddit}
            <span class="chip" title="Subreddit">
              <span aria-hidden="true" class="chip-prefix">🏛</span>
              /r/{rmd.subreddit}
            </span>
          {/if}
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

    {#if event.kind === "youtube_video" && (event.channelTitle || source)}
      {@const channelLabel = event.channelTitle ?? source?.channelTitle ?? source?.handleUrl ?? ""}
      <div class="chips-line">
        <!-- Single channel chip for ALL YouTube events.
             event.channelTitle is enriched by the /feed loader from
             youtube_videos cache (works for manual paste; source-level
             cache covers auto-import). The tracked-source variant prefixes
             a small ↻ icon to distinguish auto-imported events from manual
             pastes. Tooltip explains the distinction. -->
        {#if source}
          <span
            class="chip chip-channel chip-channel--tracked"
            title="Auto-imported from tracked source: {channelLabel}"
          >
            <span class="chip-channel__icon" aria-hidden="true">↻</span>
            {channelLabel}
          </span>
        {:else}
          <span class="chip chip-channel" title="YouTube channel">
            {channelLabel}
          </span>
        {/if}
      </div>
    {/if}

    {#if game}
      <div class="games-block">
        <span class="chip chip-game">{game.title}</span>
      </div>
    {/if}
  </a>

  <!-- The inline picker is gated on isInboxRow — it shows ONLY on cards
       where gameIds.length === 0 AND metadata.inbox.dismissed !== true AND
       metadata.triage.standalone !== true. Cards already attached to a
       game OR marked standalone hide the picker entirely (the user's
       triage decision is already recorded; the affordance would be
       noise). On inbox cards the picker uses compact={true} so it reads
       as a quick-action affordance instead of competing with the card's
       primary content. -->
  {#if isInboxRow}
    <div class="picker-line">
      <AttachToGamePicker {event} {games} onChanged={() => onChanged?.()} compact={true} />
      <!-- Inline "Mark standalone" triage button on inbox cards ONLY.
           EXPLICIT exception to the read-only-tile contract — accepted by
           the user. Outside the wrapping <a> so its onclick doesn't trigger
           card navigation. -->
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
</article>

<style>
  /* v2 FeedCard — two-shape rule (UI-SPEC § "Card Contract").
   *
   * `data-shape="media"` (kind=youtube_video) renders 16:9 thumbnail block
   *   + 2px LEFT border in var(--kind-color); kind stripe runs full-height
   *   down the left edge.
   *
   * `data-shape="text"` (every other kind) drops the thumbnail block + uses
   *   a 1px TOP hairline in var(--kind-color); kind stripe runs across the
   *   top of the card.
   *
   * The kind color is injected per-card via inline
   *   `style="--kind-color: var(--k-{kind})"` on the root .feed-card so the
   * stylesheet stays kind-agnostic.
   *
   * Mine signal moved from v1's 4px left border (which collides with the
   * 2px kind stripe) into `.author-avatar.mine` in the meta row — see
   * UI-SPEC § "Card Contract" → "Mine marker". The v1 overlay-mine pill
   * stays as a secondary signal over the thumbnail when present. */
  .feed-card {
    position: relative;
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border-radius: var(--r-md);
    box-shadow: var(--shadow-card);
    border: 1px solid var(--border);
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .feed-card:hover {
    background: var(--surface-2);
  }
  .feed-card[data-shape="media"] {
    border-left: 2px solid var(--kind-color, var(--border));
  }
  .feed-card[data-shape="text"] {
    border-top: 1px solid var(--kind-color, var(--border));
  }
  /* Off-topic / standalone fade — bumped 0.55 (v1) → 0.65 (v2). Reads as
   * "deprioritized but still legible" rather than "ghostly". */
  .feed-card.standalone {
    opacity: 0.65;
  }
  .card-body {
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
    padding: var(--s-4);
    min-width: 0;
    text-decoration: none;
    color: inherit;
    /* Stretches to fill the card so .games-block margin-top:auto reaches
     * the bottom even when notes are short. */
    flex: 1 1 auto;
  }
  .media {
    flex: 0 0 auto;
    width: 100%;
    aspect-ratio: 16 / 9;
    background: var(--surface-2);
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    /* Anchors the absolutely-positioned .overlay child. */
    position: relative;
    /* Margin pulls the media block out of card-body padding so the
     * thumbnail edge meets the card border cleanly. */
    margin: calc(var(--s-4) * -1) calc(var(--s-4) * -1) 0;
  }
  .thumbnail {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .icon-anchor {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--kind-color, var(--text-3));
  }
  /* Top overlay — flex row of dark pills over the image. v2 uses
   * var(--overlay-dark) token for the pill background (replaces v1's
   * inline rgba dark literal). */
  .overlay {
    position: absolute;
    top: var(--s-2);
    left: var(--s-2);
    right: var(--s-2);
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-1);
    /* Don't intercept clicks on the wrapping <a> — the overlay is purely
     * visual; the entire card surface remains the click target. */
    pointer-events: none;
  }
  .overlay-kind,
  .overlay-inbox,
  .overlay-mine {
    background: var(--overlay-dark);
    color: #fff;
    border-radius: var(--r-pill);
    padding: 2px var(--s-2);
    font-size: var(--t-12);
    line-height: 1;
    display: inline-flex;
    align-items: center;
    gap: var(--s-1);
    white-space: nowrap;
  }
  /* LB-11: KindIcon color bridge inside overlay-kind. The kind icon
   * inherits white via currentColor since the parent sets `color: #fff`. */
  .overlay-kind :global(svg.kind) {
    color: #fff;
  }
  /* Meta row — author avatar + kind icon + source handle + date. New in
   * v2; lives at the top of the card body for both media and text shapes
   * (UI-SPEC § "Card Contract" → "Meta row"). */
  .meta-row {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    min-width: 0;
  }
  .author-avatar {
    width: 24px;
    height: 24px;
    border-radius: var(--r-pill);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--surface-2);
    color: var(--text-3);
    font-size: var(--t-12);
    font-weight: var(--w-sb);
    flex: 0 0 auto;
  }
  /* Mine marker — accent-tinted avatar in the meta row. Replaces v1's
   * 4px left border (which collides with the v2 kind stripe). */
  .author-avatar.mine {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .kind-label {
    font-size: var(--t-13);
    color: var(--kind-color, var(--text-3));
    font-weight: var(--w-md);
    white-space: nowrap;
    flex: 0 0 auto;
  }
  .date-label {
    font-size: var(--t-13);
    color: var(--text-3);
    margin-left: auto;
    flex: 0 0 auto;
  }
  .title-line {
    display: flex;
    align-items: flex-start;
    gap: var(--s-2);
    min-width: 0;
  }
  .title {
    flex: 1 1 auto;
    margin: 0;
    font-size: var(--t-15);
    font-weight: var(--w-sb);
    color: var(--text);
    line-height: var(--lh-tight);
    word-break: break-word;
    min-width: 0;
  }
  /* Notes paragraph clipped to 3 lines with ellipsis. */
  .notes {
    margin: 0;
    color: var(--text-2);
    font-size: var(--t-13);
    line-height: var(--lh-body);
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    word-break: break-word;
  }
  /* Latest snapshot stats line — tabular-nums + mono numerics + `·`
   * separators. */
  .stats-line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-1);
    font-family: var(--f-mono);
    font-size: var(--t-12);
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }
  .stats-line .stat {
    white-space: nowrap;
  }
  .stats-line .sep {
    opacity: 0.5;
  }
  .chips-line {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-1);
    align-items: center;
    min-width: 0;
  }
  /* Associated games block at the BOTTOM of the card body.
   * `margin-top: auto` pushes it to the bottom when the .card-body has
   * space remaining; otherwise it sits naturally after the chips-line. */
  .games-block {
    margin-top: auto;
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-1);
    align-items: center;
    min-width: 0;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    background: var(--surface-2);
    color: var(--text-2);
    border: 1px solid var(--border);
    border-radius: var(--r-pill);
    padding: 2px var(--s-2);
    font-size: var(--t-12);
    line-height: 1;
    white-space: nowrap;
  }
  .chip-channel--tracked {
    gap: 4px;
  }
  .chip-channel__icon {
    font-size: 0.85em;
    opacity: 0.7;
  }
  /* Reddit chip emoji prefix (Phase 03.1 plan 08, D-RDT-SOURCE-DISPLAY). */
  .chip-prefix {
    font-size: 0.9em;
    line-height: 1;
    margin-right: 4px;
  }
  /* Underperforming-median badge (D-RDT-BASELINES-DISPLAY). */
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
  /* Game chip stands out a bit more than the source chip (slightly stronger
   * border) since it represents the primary association. */
  .chip-game {
    color: var(--text);
    border-color: var(--text-3);
  }
  .picker-line {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    flex-wrap: wrap;
    min-width: 0;
    padding: 0 var(--s-4) var(--s-3);
  }
  /* Inline "Mark standalone" triage button. */
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
    .standalone-button {
      transition: none;
    }
  }
</style>
