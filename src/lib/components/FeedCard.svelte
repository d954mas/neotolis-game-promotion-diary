<script lang="ts">
  // FeedCard — pure preview tile (Plan 02.1-18 read-only contract preserved).
  //
  // Plan 02.1-23 RESTRUCTURE per UAT-NOTES.md §1.5-redesign — the user-
  // proposed card layout from round-3 UAT (ASCII mockup drawn by the user).
  // The vertical structure is now (top → bottom):
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
  // Mine treatment (UAT user choice "C and A combined"):
  //   - C: `<span class='overlay-mine'>` pill in the top overlay alongside
  //        kind label and Inbox indicator.
  //   - A: `border-left: 4px solid var(--color-accent)` on the entire card
  //        when `event.authorIsMe === true`. The class:mine={authorIsMe}
  //        toggle on the root <article> drives the CSS rule.
  //
  // Image-source rules per kind (UAT-NOTES.md §1.5-redesign — auto-derived
  // images only; manual upload UI is OUT OF SCOPE for round-3, see TODO):
  //   - kind=youtube_video AND externalId → img.youtube.com/vi/{id}/mqdefault.jpg
  //   - kind=reddit_post / twitter_post / telegram_post → metadata.media.url
  //     (type-safe lookup; falls through if missing)
  //   - all other kinds (conference, talk, press, other, post, discord_drop)
  //     → text fallback (KindIcon centered in the .icon-anchor block)
  //
  // The Inbox indicator is rendered INLINE in the overlay (Plan 02.1-23
  // executor pick — option (b) per <interfaces>): a `<span class='overlay-inbox'>`
  // showing m.inbox_badge() text. The standalone <InboxBadge> component is no
  // longer used here (the overlay needs the dark-pill visual style consistent
  // with overlay-kind / overlay-mine; threading a `variant` prop through
  // InboxBadge would be premature for one consumer). InboxBadge stays
  // exported for potential future contexts.
  //
  // Plan 02.1-18 read-only contract PRESERVED:
  //   - No inline Edit / Delete / Open buttons.
  //   - The wrapping <a href={`/events/${id}`}> stays as the click target.
  //   - AttachToGamePicker is the only mutating control (INBOX-only flow).
  //
  // Plan 02.1-19 date-removal PRESERVED:
  //   - No inline date string on the card. The <FeedDateGroupHeader> above
  //     each card group is the date label (Google Photos / Apple Photos
  //     timeline pattern).
  //
  // TODO Phase 3+: support manual image upload per UAT-NOTES.md §1.5-redesign
  // user quote "Хочется чтобы пользователь мог для каждого такого события сам
  // добавить картинку". Schema would add `cover_url TEXT NULL` on events OR
  // `metadata.image.url` (jsonb path); resolver returns manual upload OR
  // auto-derived per kind. Round-3 ships auto-derived only.
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
  import PollingBadge from "./PollingBadge.svelte";

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
    // Plan 02.1-28: M:N migration — gameIds[] replaces the singular gameId.
    // Empty array === inbox (no attached games); non-empty === at least
    // one attached game. The card renders the first attached game as the
    // primary chip for round-3 UAT continuity (Plan 02.1-32 swaps for the
    // full chip-set render).
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
    lastPolledAt: Date | string | null;
  };
  type SourceLite = {
    id: string;
    displayName: string | null;
    handleUrl: string;
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

  // Type-safe metadata.media.url extraction (Plan 02.1-23 image-source rules).
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

  const thumbnailUrl = $derived.by((): string | null => {
    if (event.kind === "youtube_video") {
      if (!event.externalId) return null;
      return `https://img.youtube.com/vi/${event.externalId}/mqdefault.jpg`;
    }
    if (
      event.kind === "reddit_post" ||
      event.kind === "twitter_post" ||
      event.kind === "telegram_post"
    ) {
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
    // Plan 02.1-28 (M:N migration): inbox criterion = ZERO attached games.
    // The legacy `event.gameId !== null` check is replaced with the
    // `gameIds.length > 0` check on the new EventDto shape.
    if (event.gameIds.length > 0) return false;
    const md = event.metadata as
      | { inbox?: { dismissed?: boolean }; triage?: { standalone?: boolean } }
      | null
      | undefined;
    if (md?.inbox?.dismissed === true) return false;
    // Plan 02.1-24: standalone events are NOT inbox rows — they have a
    // separate triage state. The inline "Mark standalone" button only
    // appears on plain inbox cards (not on already-standalone ones).
    if (md?.triage?.standalone === true) return false;
    return true;
  });

  // Plan 02.1-24 (UAT-NOTES.md §6.1-redesign): standalone events render dimmed
  // in /feed (opacity 0.55) so they don't distract from game-tied events.
  // The user-explicit "not related to any game" state surfaces as a visible
  // muting in the timeline.
  const isStandalone = $derived.by((): boolean => {
    const md = event.metadata as { triage?: { standalone?: boolean } } | null | undefined;
    return md?.triage?.standalone === true;
  });

  // Plan 02.1-24: inline "Mark standalone" handler. Calls the new HTTP
  // endpoint then bubbles onChanged() so /feed's invalidateAll() re-runs the
  // loader. The button is the EXPLICIT user-accepted exception to Plan
  // 02.1-18's read-only-tile contract (UAT round-3 user direction). Errors
  // are swallowed silently in 2.1; phase 6 polish may surface a toast.
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

  const pollingForBadge = $derived({
    kind: event.kind,
    lastPolledAt: event.lastPolledAt as Date | string | null,
  });
</script>

<article
  class="feed-card"
  class:mine={event.authorIsMe}
  class:standalone={isStandalone}
  data-kind={event.kind}
>
  <a class="card-body" href={`/events/${event.id}`}>
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
        <div class="icon-anchor" aria-hidden="true">
          <KindIcon kind={event.kind} size={48} />
        </div>
      {/if}
      <!-- Plan 02.1-23 top overlay: kind label + Inbox + Mine pills.
           Always rendered (kind label is unconditional); Inbox / Mine are
           conditional. pointer-events: none so the overlay never intercepts
           clicks on the wrapping <a>. -->
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

    <div class="title-line">
      <h3 class="title">{event.title}</h3>
    </div>

    {#if event.notes}
      <p class="notes">{event.notes}</p>
    {/if}

    <div class="meta-line">
      <!-- Plan 02.1-19: inline date display REMOVED — the
           <FeedDateGroupHeader> above each card group is the date label.
           Plan 02.1-23: kind label + Inbox indicator moved into the top
           overlay. Mine moved into the overlay too. Only <PollingBadge>
           remains in this row. -->
      <PollingBadge event={pollingForBadge} />
    </div>

    {#if source}
      <div class="chips-line">
        <span class="chip">{source.displayName ?? source.handleUrl}</span>
      </div>
    {/if}

    {#if game}
      <div class="games-block">
        <span class="chip chip-game">{game.title}</span>
      </div>
    {/if}
  </a>

  <div class="picker-line">
    <AttachToGamePicker {event} {games} onChanged={() => onChanged?.()} />
    {#if isInboxRow}
      <!-- Plan 02.1-24 (UAT-NOTES.md §6.1-redesign): inline "Mark standalone"
           triage button on inbox cards ONLY. EXPLICIT exception to the
           Plan 02.1-18 read-only-tile contract — accepted by the user
           during round-3 UAT. Outside the wrapping <a> so its onclick
           doesn't trigger card navigation. -->
      <button
        type="button"
        class="standalone-button"
        onclick={markStandaloneClick}
        disabled={markingStandalone}
      >
        {m.feed_card_mark_standalone_button()}
      </button>
    {/if}
  </div>
</article>

<style>
  /* Plan 02.1-23 layout: card body remains a vertical flex column. The
   * Mine treatment combines a left-border accent (CSS) and a top-overlay
   * Mine pill (DOM). Plan 02.1-19 grid cell sizing
   * (`repeat(auto-fill, minmax(280px, 1fr))`) preserved by /feed's grid;
   * this card sizes to its content within the cell. */
  .feed-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
    padding: var(--space-md);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    min-width: 0;
    max-width: 100%;
    cursor: pointer;
    transition: background 120ms ease;
  }
  .feed-card:hover {
    background: var(--color-bg);
  }
  /* Mine treatment (A): left-border accent on the whole card. Combined with
   * the overlay Mine pill (C) per UAT-NOTES.md §1.5-redesign user choice
   * "C and A combined". */
  .feed-card.mine {
    border-left: 4px solid var(--color-accent);
  }
  /* Plan 02.1-24 (UAT-NOTES.md §6.1-redesign): standalone events render
   * dimmed in /feed so they don't distract from game-tied events. User
   * quote: "такие не связанные с игрой, нужно как-то затемнять, чтобы они
   * не мешали". The reduced opacity is purely visual — the card remains
   * clickable + the wrapping <a> still navigates to /events/[id]. */
  .feed-card.standalone {
    opacity: 0.55;
  }
  .card-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
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
    background: var(--color-bg);
    border-radius: 4px;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    /* Anchors the absolutely-positioned .overlay child. */
    position: relative;
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
    color: var(--color-text-muted);
  }
  /* Plan 02.1-23 top overlay — flex row of dark pills over the image. */
  .overlay {
    position: absolute;
    top: var(--space-xs);
    left: var(--space-xs);
    right: var(--space-xs);
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-xs);
    /* Don't intercept clicks on the wrapping <a> — the overlay is purely
     * visual; the entire card surface remains the click target. */
    pointer-events: none;
  }
  .overlay-kind,
  .overlay-inbox,
  .overlay-mine {
    background: rgb(0 0 0 / 70%);
    color: white;
    border-radius: 999px;
    padding: 2px var(--space-sm);
    font-size: var(--font-size-label);
    line-height: 1;
    display: inline-flex;
    align-items: center;
    gap: var(--space-xs);
    white-space: nowrap;
  }
  /* The kind icon inside .overlay-kind inherits white via currentColor since
   * the parent sets `color: white`. */
  .overlay-kind :global(svg.kind) {
    color: white;
  }
  .title-line {
    display: flex;
    align-items: flex-start;
    gap: var(--space-sm);
    min-width: 0;
  }
  .title {
    flex: 1 1 auto;
    margin: 0;
    font-size: var(--font-size-body);
    font-weight: var(--font-weight-semibold);
    line-height: var(--line-height-body);
    word-break: break-word;
    min-width: 0;
  }
  /* Plan 02.1-23: notes paragraph clipped to 3 lines with ellipsis. The
   * underlying CSS uses the prefixed `-webkit-line-clamp` block trick which
   * is the de facto cross-browser standard for line clamping (Firefox 68+
   * supports the prefixed form). */
  .notes {
    margin: 0;
    color: var(--color-text-muted);
    font-size: var(--font-size-label);
    line-height: var(--line-height-body);
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    word-break: break-word;
  }
  .meta-line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-sm);
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
  }
  .chips-line {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-sm);
    align-items: center;
    min-width: 0;
  }
  /* Plan 02.1-23: associated games block at the BOTTOM of the card body.
   * `margin-top: auto` pushes it to the bottom when the .card-body has
   * space remaining; otherwise it sits naturally after the chips-line. */
  .games-block {
    margin-top: auto;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-sm);
    align-items: center;
    min-width: 0;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    background: var(--color-bg);
    color: var(--color-text-muted);
    border: 1px solid var(--color-border);
    border-radius: 999px;
    padding: 2px var(--space-sm);
    font-size: var(--font-size-label);
    line-height: 1;
    white-space: nowrap;
  }
  /* Game chip stands out a bit more than the source chip (slightly stronger
   * border) since it represents the primary association. */
  .chip-game {
    color: var(--color-text);
    border-color: var(--color-text-muted);
  }
  .picker-line {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    flex-wrap: wrap;
    min-width: 0;
  }
  /* Plan 02.1-24: inline "Mark standalone" triage button. Visual style
   * mirrors the AttachToGamePicker trigger (subtle ghost button) so the
   * two affordances read as a triage pair on inbox cards. */
  .standalone-button {
    min-height: 44px;
    padding: 0 var(--space-md);
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-size: var(--font-size-label);
    cursor: pointer;
  }
  .standalone-button:hover:not(:disabled) {
    background: var(--color-bg);
  }
  .standalone-button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
</style>
