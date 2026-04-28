<script lang="ts">
  // FeedRow — single row component used by /feed (chronological pool) and
  // /games/[id] (curated per-game view). One row component, two consumers
  // (UI-SPEC §"Component inventory" + §"/feed row interaction contract").
  //
  // Information architecture (UI-SPEC):
  //   - mobile (<768px) vertical stack:
  //       Line 1: KindIcon + <time> + InboxBadge (if applicable)
  //       Line 2: <div class="title">
  //       Line 3: source chip + game chip + author_is_me badge
  //       Line 4: AttachToGamePicker + Open + Edit + Delete (icon-only,
  //               44×44 hit area; aria-label per Accessibility Floor delta)
  //   - tablet (>=768px) horizontal flexbox: KindIcon · timestamp · title
  //     (flex-grow 1, ellipsis) · chips · author badge · actions cluster.
  //
  // PollingBadge logic (CONTEXT D-05 — unified contract): rendered by the
  // <PollingBadge> child component itself for kind ∈ {youtube_video,
  // reddit_post} AND lastPolledAt === null. Hidden for non-pollable kinds.
  //
  // InboxBadge logic: rendered when game_id IS NULL && metadata.inbox.dismissed
  // !== true. The inbox-dismissed flag stays in the row's metadata jsonb
  // (Plan 02.1-05 dismissFromInbox writer); the rest of the row carries on
  // rendering normally for dismissed-no-game events (just no inbox affordance).
  //
  // Delete affordance: ALWAYS shows ConfirmDialog before invoking
  // DELETE /api/events/:id (UI polish fix per UI-SPEC §"Destructive
  // confirmations" — Phase 2 had one-click delete; 2.1 fixes it).

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

  const occurredIso = $derived(
    typeof event.occurredAt === "string" ? event.occurredAt : event.occurredAt.toISOString(),
  );
  const occurredHuman = $derived(
    typeof event.occurredAt === "string"
      ? new Date(event.occurredAt).toLocaleDateString()
      : event.occurredAt.toLocaleDateString(),
  );

  // InboxBadge condition: game_id IS NULL && metadata.inbox.dismissed !== true.
  const isInboxRow = $derived.by((): boolean => {
    if (event.gameId !== null) return false;
    const md = event.metadata as { inbox?: { dismissed?: boolean } } | null | undefined;
    return md?.inbox?.dismissed !== true;
  });

  // For PollingBadge — pass the event subset it needs.
  const pollingEvent = $derived({
    kind: event.kind,
    lastPolledAt:
      typeof event.lastPolledAt === "string" ? new Date(event.lastPolledAt) : event.lastPolledAt,
  });
  const pollingForBadge = $derived({
    kind: pollingEvent.kind,
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

<article class="feed-row">
  <div class="line line-meta">
    <KindIcon kind={event.kind} />
    <time class="when" datetime={occurredIso} title={occurredIso}>{occurredHuman}</time>
    {#if isInboxRow}
      <InboxBadge />
    {/if}
    <PollingBadge event={pollingForBadge} />
  </div>

  <div class="line line-title">
    <span class="title">{event.title}</span>
    {#if event.url}
      <a
        class="link"
        href={event.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Open external URL">↗</a
      >
    {/if}
  </div>

  {#if source || game || event.authorIsMe}
    <div class="line line-chips">
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

  <div class="line line-actions">
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
</article>

<ConfirmDialog
  open={confirmDeleteOpen}
  message={m.confirm_event_delete()}
  confirmLabel={m.common_delete()}
  onConfirm={confirmDelete}
  onCancel={cancelDelete}
/>

<style>
  .feed-row {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
    padding: var(--space-md);
    min-width: 0;
  }
  .line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-sm);
    min-width: 0;
  }
  .line-meta {
    color: var(--color-text-muted);
  }
  .when {
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
  }
  .title {
    font-size: var(--font-size-body);
    color: var(--color-text);
    word-break: break-word;
    flex: 1 1 auto;
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
  }
  .chip {
    display: inline-flex;
    align-items: center;
    background: var(--color-surface);
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
  .line-actions {
    gap: var(--space-xs);
    margin-top: var(--space-xs);
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
  @media (min-width: 768px) {
    .feed-row {
      flex-direction: row;
      align-items: center;
      flex-wrap: wrap;
    }
    .line-meta {
      flex: 0 0 auto;
    }
    .line-title {
      flex: 1 1 240px;
      min-width: 0;
    }
    .line-chips {
      flex: 0 0 auto;
    }
    .line-actions {
      flex: 0 0 auto;
      margin-top: 0;
    }
  }
</style>
