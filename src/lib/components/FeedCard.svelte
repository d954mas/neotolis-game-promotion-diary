<script lang="ts">
  // FeedCard — media-card replacement for <FeedRow> (Plan 02.1-16 / Gap 3,
  // refined in Plan 02.1-19 round-2 UAT).
  //
  // Visual contract (Plan 02.1-19 — vertical stack at all viewports, sized
  // by /feed's CSS grid cell `repeat(auto-fill, minmax(280px, 1fr))`):
  //
  //   1. Media row — 16:9 thumbnail for kind=youtube_video
  //      (img.youtube.com/vi/{id}/mqdefault.jpg) OR a centered KindIcon in a
  //      muted block for non-thumbnail kinds.
  //   2. Title + open-external icon.
  //   3. Meta row — kind label (text) + InboxBadge + PollingBadge.
  //      DATE IS NOT RENDERED HERE in Plan 02.1-19 — the
  //      <FeedDateGroupHeader> above the group is the date label
  //      (Google Photos / Apple Photos timeline pattern).
  //   4. Chips row — source / game / author_is_me.
  //   5. Actions row — AttachToGamePicker + Open + Edit + Delete (44×44 hit).
  //
  // Plan 02.1-19 layout: card stays vertical-stack at all widths. The Plan
  // 02.1-16 desktop horizontal flexbox layout is RETIRED because grid cells
  // are visually better as tiles.
  //
  // Accessibility (UI-SPEC §"Accessibility Floor delta"):
  //   - Thumbnail <img alt> via m.feed_card_thumbnail_alt({ title }).
  //   - Open / Edit / Delete buttons reuse Plan 02.1-13 keys
  //     m.feed_row_edit_aria() / m.feed_row_delete_aria(); the URL link
  //     uses the new m.feed_card_open_external().
  //   - KindIcon stays aria-hidden="true" — kind name is conveyed by the
  //     adjacent .kind-tag span (Gap 6 path b).
  //
  // Privacy invariants:
  //   - <img referrerpolicy="no-referrer" crossorigin="anonymous"> mirrors
  //     UI-SPEC §"Registry Safety" precedent (Steam appdetails covers,
  //     YouTube oEmbed thumbs).
  //   - Thumbnail URL is deterministic from `externalId` already projected
  //     by toEventDto; no ciphertext / userId leaks through this surface.
  //   - DELETE flow is unchanged from FeedRow: confirm → fetch → onChanged.

  import { goto } from "$app/navigation";
  import { m } from "$lib/paraglide/messages.js";
  import KindIcon from "./KindIcon.svelte";
  import AttachToGamePicker from "./AttachToGamePicker.svelte";
  import InboxBadge from "./InboxBadge.svelte";
  import PollingBadge from "./PollingBadge.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import InlineError from "./InlineError.svelte";

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

  let confirmDeleteOpen = $state(false);
  let deleteError = $state<string | null>(null);
  let deleting = $state(false);

  function askDelete(): void {
    confirmDeleteOpen = true;
  }
  function cancelDelete(): void {
    confirmDeleteOpen = false;
  }
  async function confirmDelete(): Promise<void> {
    if (deleting) return;
    deleting = true;
    deleteError = null;
    try {
      const res = await fetch(`/api/events/${event.id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) {
        deleteError = m.error_server_generic();
        return;
      }
      confirmDeleteOpen = false;
      onChanged?.();
    } catch {
      deleteError = m.error_network();
    } finally {
      deleting = false;
    }
  }

  function gotoEdit(): void {
    void goto(`/events/${event.id}/edit`);
  }
  function gotoOpen(): void {
    void goto(`/events/${event.id}`);
  }
</script>

<article class="feed-card" data-kind={event.kind}>
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

  <div class="body">
    <div class="title-line">
      <h3 class="title">{event.title}</h3>
      {#if event.url}
        <a
          class="link"
          href={event.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={m.feed_card_open_external()}
        >
          ↗
        </a>
      {/if}
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
          <span class="chip chip-author">{m.sources_owned_by_me()}</span>
        {/if}
      </div>
    {/if}

    <div class="actions-line">
      <AttachToGamePicker {event} {games} onChanged={() => onChanged?.()} />
      <button type="button" class="action open" onclick={gotoOpen}>Open</button>
      <button
        type="button"
        class="action icon"
        aria-label={m.feed_row_edit_aria()}
        onclick={gotoEdit}
      >
        ✎
      </button>
      <button
        type="button"
        class="action icon danger"
        aria-label={m.feed_row_delete_aria()}
        onclick={askDelete}
      >
        ×
      </button>
    </div>

    {#if deleteError}
      <InlineError message={deleteError} />
    {/if}
  </div>
</article>

<ConfirmDialog
  open={confirmDeleteOpen}
  message={m.confirm_event_delete()}
  confirmLabel={m.common_delete()}
  onConfirm={confirmDelete}
  onCancel={cancelDelete}
/>

<style>
  /* Plan 02.1-19 layout: FeedCard is sized by its CSS grid CELL on /feed
   * (grid-template-columns: repeat(auto-fill, minmax(280px, 1fr))). Card is
   * always vertical-stack — desktop horizontal layout from Plan 02.1-16 is
   * RETIRED because grid cells are visually better as tiles.
   * AttachToGamePicker (Plan 02.1-18 contract) is the only mutating control. */
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
  .body {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
    min-width: 0;
    flex: 1 1 auto;
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
  .link {
    color: var(--color-accent);
    text-decoration: none;
    min-width: 44px;
    min-height: 44px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
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
  .chips-line,
  .actions-line {
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
  .action {
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    cursor: pointer;
    font-size: var(--font-size-label);
    min-height: 44px;
    padding: 0 var(--space-md);
  }
  .action.icon {
    min-width: 44px;
    padding: 0;
    color: var(--color-text-muted);
    font-size: var(--font-size-body);
  }
  .action.icon:hover {
    color: var(--color-text);
  }
  .action.icon.danger:hover {
    color: var(--color-destructive);
    border-color: var(--color-destructive);
  }
  .action.open {
    color: var(--color-accent);
  }

  /* Plan 02.1-19 RETIRED: Plan 02.1-16's @media (min-width: 768px) horizontal
   * flexbox layout has been removed. The card is vertical-stack at all
   * viewports — see comment above .feed-card. /feed's CSS grid sets the cell
   * width; the card fills its cell as a tile. */
</style>
