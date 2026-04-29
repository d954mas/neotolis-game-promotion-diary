<script lang="ts">
  // FeedCard — pure preview tile (Plan 02.1-18 round-2 UAT closure).
  //
  // Plan 02.1-18 STRIP: removed Open / Edit / Delete buttons + the
  // surrounding ConfirmDialog. All mutating + destructive actions move to
  // /events/[id]. The card body wraps in <a href="/events/${id}"> so the
  // ENTIRE tile is the click target. AttachToGamePicker stays — it is the
  // primary inbox-clear flow per FEED-01 / INBOX-01 and is non-destructive
  // (the user can re-attach freely). Per UAT round-2 gap "FeedCard becomes
  // a pure preview tile."
  //
  // Visual contract (Plan 02.1-19 — vertical stack at all viewports, sized
  // by /feed's CSS grid cell `repeat(auto-fill, minmax(280px, 1fr))`):
  //
  //   1. Media row — 16:9 thumbnail for kind=youtube_video
  //      (img.youtube.com/vi/{id}/mqdefault.jpg) OR a centered KindIcon in a
  //      muted block for non-thumbnail kinds.
  //   2. Title.
  //   3. Meta row — kind label (text) + InboxBadge + PollingBadge.
  //      DATE IS NOT RENDERED HERE in Plan 02.1-19 — the
  //      <FeedDateGroupHeader> above the group is the date label
  //      (Google Photos / Apple Photos timeline pattern).
  //   4. Chips row — source / game / "Mine" badge for author_is_me=true.
  //   5. Picker row — AttachToGamePicker (the only mutating control on a
  //      tile; OUTSIDE the wrapping <a> so its onclick handlers don't
  //      trigger card navigation).
  //
  // Accessibility:
  //   - Wrapping <a> carries the title text (in .title-line) so a screen
  //     reader reads the link with the title as its accessible name.
  //   - AttachToGamePicker is OUTSIDE the anchor — its keyboard tabbable
  //     controls navigate independently of the card's link target.
  //   - "Mine" badge is a non-interactive <span>, just a visible chip.
  //   - KindIcon stays aria-hidden="true" — kind name is conveyed by the
  //     adjacent .kind-tag span (Plan 02.1-16 Gap 6 path b).
  //
  // Privacy invariants:
  //   - <img referrerpolicy="no-referrer" crossorigin="anonymous"> mirrors
  //     UI-SPEC §"Registry Safety" precedent (Steam appdetails covers,
  //     YouTube oEmbed thumbs).
  //   - Thumbnail URL is deterministic from `externalId` already projected
  //     by toEventDto; no ciphertext / userId leaks through this surface.

  import { m } from "$lib/paraglide/messages.js";
  import KindIcon from "./KindIcon.svelte";
  import AttachToGamePicker from "./AttachToGamePicker.svelte";
  import InboxBadge from "./InboxBadge.svelte";
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
    gameId: string | null;
    sourceId: string | null;
    kind: EventKind;
    authorIsMe: boolean;
    occurredAt: Date | string;
    title: string;
    url: string | null;
    externalId: string | null;
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

  const thumbnailUrl = $derived.by((): string | null => {
    if (event.kind !== "youtube_video") return null;
    if (!event.externalId) return null;
    return `https://img.youtube.com/vi/${event.externalId}/mqdefault.jpg`;
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
    if (event.gameId !== null) return false;
    const md = event.metadata as { inbox?: { dismissed?: boolean } } | null | undefined;
    return md?.inbox?.dismissed !== true;
  });

  const pollingForBadge = $derived({
    kind: event.kind,
    lastPolledAt: event.lastPolledAt as Date | string | null,
  });
</script>

<article class="feed-card" data-kind={event.kind}>
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
    </div>

    <div class="title-line">
      <h3 class="title">{event.title}</h3>
    </div>

    <div class="meta-line">
      <span class="kind-tag">{kindLabel}</span>
      <!-- Plan 02.1-19: inline date display REMOVED — the
           <FeedDateGroupHeader> above each card group is the date label. -->
      {#if isInboxRow}
        <InboxBadge />
      {/if}
      <PollingBadge event={pollingForBadge} />
    </div>

    {#if source || game || event.authorIsMe}
      <div class="chips-line">
        {#if source}
          <span class="chip">{source.displayName ?? source.handleUrl}</span>
        {/if}
        {#if game}
          <span class="chip">{game.title}</span>
        {/if}
        {#if event.authorIsMe}
          <span class="chip chip-author">{m.feed_card_author_is_me_badge()}</span>
        {/if}
      </div>
    {/if}
  </a>

  <div class="picker-line">
    <AttachToGamePicker {event} {games} onChanged={() => onChanged?.()} />
  </div>
</article>

<style>
  /* Plan 02.1-18 layout: card body is a single clickable <a> wrapping
   * media + title + meta + chips. AttachToGamePicker is OUTSIDE the anchor
   * so its menu/buttons stay interactive without nesting an interactive
   * inside an <a>. Plan 02.1-19 grid cell sizing
   * (`repeat(auto-fill, minmax(280px, 1fr))`) preserved — vertical-stack
   * tile at all viewports. */
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
  .card-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
    min-width: 0;
    text-decoration: none;
    color: inherit;
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
  .meta-line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-sm);
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
  }
  .kind-tag {
    font-weight: var(--font-weight-semibold);
    color: var(--color-text);
  }
  .chips-line {
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
  .chip-author {
    color: var(--color-text);
  }
  .picker-line {
    display: flex;
    align-items: center;
    min-width: 0;
  }
</style>
