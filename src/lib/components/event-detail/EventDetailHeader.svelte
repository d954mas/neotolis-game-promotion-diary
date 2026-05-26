<script lang="ts">
  // EventDetailHeader — the <header class="detail-head"> strip extracted from
  // EventDetailContent. Contains author avatar, kind icon, kind label, source,
  // date, PollingBadge, overflow menu, and close button.

  import KindIcon from "$lib/components/KindIcon.svelte";
  import AuthorPopover from "$lib/components/shared/AuthorPopover.svelte";
  import PollingBadge from "$lib/components/PollingBadge.svelte";
  import { m } from "$lib/paraglide/messages.js";
  import type { EventDto } from "$lib/server/dto.js";

  let {
    event,
    view = "feed",
    currentUserName = "",
    sourceLabel = "",
    occurredHuman,
    occurredISO,
    todayISO,
    onClose,
    onDelete,
    onRestore,
    onDeleteForever,
    onDateChange,
    onChangeAuthor,
  }: {
    event: EventDto;
    view?: "feed" | "trash";
    currentUserName?: string;
    sourceLabel?: string;
    occurredHuman: string;
    occurredISO: string;
    todayISO: string;
    onClose: () => void;
    onDelete: (id: string) => Promise<void>;
    onRestore?: (id: string) => Promise<void>;
    onDeleteForever?: (id: string) => Promise<void>;
    onDateChange: (iso: string) => Promise<void>;
    onChangeAuthor?: (isMe: boolean) => Promise<void>;
  } = $props();

  const inTrash = $derived(view === "trash");

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

  let authorPopoverOpen = $state(false);
  let authorAvatarEl = $state<HTMLButtonElement | null>(null);
  let overflowOpen = $state(false);

  async function handleChangeAuthor(isMe: boolean): Promise<void> {
    if (onChangeAuthor) await onChangeAuthor(isMe);
    authorPopoverOpen = false;
  }
</script>

<header class="detail-head">
  {#if !inTrash}
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
        onchange={handleChangeAuthor}
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
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M11 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6" />
          <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
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
              }}>{m.event_detail_footer_restore()}</button
            >
          {/if}
          {#if inTrash && onDeleteForever}
            <button
              type="button"
              class="card-menu-item danger"
              onclick={() => {
                overflowOpen = false;
                void onDeleteForever?.(event.id);
              }}>{m.event_detail_footer_delete_forever()}</button
            >
          {:else if !inTrash}
            <button
              type="button"
              class="card-menu-item danger"
              onclick={() => {
                overflowOpen = false;
                void onDelete(event.id);
              }}>{m.events_detail_delete()}</button
            >
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
    title={m.event_detail_modal_close_aria()}>×</button
  >
</header>

<style>
  .detail-head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border-hairline);
    flex-shrink: 0;
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

  .author-avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    background: var(--surface-3);
    color: var(--text-3);
    border: 1px solid var(--border);
    border-radius: 50%;
    font-size: 11px;
    font-weight: var(--w-sb);
    padding: 0;
  }
  .author-avatar[data-mine="1"] {
    background: var(--accent);
    color: var(--accent-text);
    border-color: var(--accent);
  }
  .author-avatar.detail-author-trigger {
    cursor: pointer;
    transition:
      transform var(--m-fast) var(--m-ease),
      box-shadow var(--m-fast) var(--m-ease);
  }
  @media (hover: hover) {
    .author-avatar.detail-author-trigger:hover {
      transform: scale(1.1);
      box-shadow: 0 0 0 2px var(--accent-soft);
    }
  }

  .detail-date-edit {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 6px;
    margin: -2px 0;
    border-radius: var(--r-xs);
    cursor: pointer;
    transition: background var(--m-fast) var(--m-ease);
  }
  .detail-date-pencil {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--text-4);
    opacity: 0.7;
    transition:
      color var(--m-fast),
      opacity var(--m-fast);
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
    position: absolute;
    inset: 0;
    opacity: 0;
    cursor: pointer;
    padding: 0;
    border: 0;
    background: transparent;
    color-scheme: dark;
    font: inherit;
  }
  :global([data-theme="light"]) .detail-date-native {
    color-scheme: light;
  }

  .author-pick-scrim {
    position: fixed;
    inset: 0;
    z-index: 80;
    background: transparent;
  }

  @media (prefers-reduced-motion: reduce) {
    .detail-close-btn,
    .author-avatar.detail-author-trigger {
      transition: none;
    }
  }
</style>
