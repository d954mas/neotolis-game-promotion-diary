<script lang="ts">
  // /games/[gameId] — detail view (Plan 02-10).
  //
  // Multi-panel layout per UI-SPEC §"/games/[gameId] (NEW — detail)":
  //   - Header panel (title, TBA / release-date badge, tag chips, notes)
  //   - Store-listings panel (one row per game_steam_listings row)
  //   - YouTube channels panel (<ChannelRow> + attach affordance)
  //   - Tracked items panel with <PasteBox> at the top
  //   - Events timeline panel with <EventRow> + new-event form
  //
  // Each panel renders <EmptyState>-style empty branches. Cross-cutting
  // mutations (paste, soft-delete, channel detach, event create) call the
  // /api/* surface and `invalidateAll()` to refresh the loader's data.
  //
  // Tag chips render inline as <span class="chip"> per UI-SPEC FLAG (no
  // standalone TagChip component in P2).

  import { invalidateAll } from "$app/navigation";
  import { m } from "$lib/paraglide/messages.js";
  import EmptyState from "$lib/components/EmptyState.svelte";
  import PasteBox from "$lib/components/PasteBox.svelte";
  import ChannelRow from "$lib/components/ChannelRow.svelte";
  import EventRow from "$lib/components/EventRow.svelte";
  import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
  import InlineError from "$lib/components/InlineError.svelte";
  import type { PageData } from "./$types";

  type GameDto = {
    id: string;
    title: string;
    coverUrl: string | null;
    releaseDate: string | null;
    releaseTba: boolean;
    tags: string[];
    notes: string;
  };

  type ListingDto = {
    id: string;
    appId: number;
    label: string;
    coverUrl: string | null;
    releaseDate: string | null;
    apiKeyId: string | null;
  };

  type ChannelDto = {
    id: string;
    handleUrl: string;
    displayName: string | null;
    isOwn: boolean;
  };

  type ItemDto = {
    id: string;
    title: string | null;
    url: string;
    isOwn: boolean;
    addedAt: string;
  };

  type EventDtoLocal = {
    id: string;
    kind:
      | "conference"
      | "talk"
      | "twitter_post"
      | "telegram_post"
      | "discord_drop"
      | "press"
      | "other";
    occurredAt: string;
    title: string;
    url: string | null;
  };

  let { data }: { data: PageData } = $props();

  const game = $derived(data.game as GameDto);
  const listings = $derived(data.listings as ListingDto[]);
  const channels = $derived(data.channels as ChannelDto[]);
  const items = $derived(data.items as ItemDto[]);
  const events = $derived(data.events as EventDtoLocal[]);

  // -- Item soft-delete dialog --
  let confirmItemOpen = $state(false);
  let pendingItemId = $state<string | null>(null);
  function askDeleteItem(id: string): void {
    pendingItemId = id;
    confirmItemOpen = true;
  }
  async function confirmDeleteItem(): Promise<void> {
    if (!pendingItemId) return;
    const res = await fetch(`/api/items/youtube/${pendingItemId}`, { method: "DELETE" });
    confirmItemOpen = false;
    pendingItemId = null;
    if (res.ok || res.status === 204) await invalidateAll();
  }

  // -- New event inline form --
  let showEventForm = $state(false);
  let newEventTitle = $state("");
  let newEventKind = $state<EventDtoLocal["kind"]>("other");
  let newEventDate = $state(new Date().toISOString().slice(0, 10));
  let newEventUrl = $state("");
  let creatingEvent = $state(false);
  let eventError = $state<string | null>(null);

  async function submitNewEvent(e: Event): Promise<void> {
    e.preventDefault();
    if (creatingEvent || newEventTitle.trim().length === 0) return;
    creatingEvent = true;
    eventError = null;
    try {
      const res = await fetch("/api/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          gameId: game.id,
          kind: newEventKind,
          title: newEventTitle.trim(),
          occurredAt: new Date(newEventDate).toISOString(),
          url: newEventUrl.trim().length > 0 ? newEventUrl.trim() : null,
        }),
      });
      if (!res.ok) {
        eventError = m.error_server_generic();
        return;
      }
      newEventTitle = "";
      newEventUrl = "";
      showEventForm = false;
      await invalidateAll();
    } catch {
      eventError = m.error_network();
    } finally {
      creatingEvent = false;
    }
  }

  async function deleteEvent(id: string): Promise<void> {
    const res = await fetch(`/api/events/${id}`, { method: "DELETE" });
    if (res.ok || res.status === 204) await invalidateAll();
  }

  async function detachChannel(channelId: string): Promise<void> {
    const res = await fetch(`/api/games/${game.id}/youtube-channels/${channelId}`, {
      method: "DELETE",
    });
    if (res.ok || res.status === 204) await invalidateAll();
  }

  async function onPasteSuccess(): Promise<void> {
    await invalidateAll();
  }
</script>

<nav class="breadcrumb" aria-label="Breadcrumb">
  <a href="/games">Games</a>
  <span aria-hidden="true">/</span>
  <span>{game.title}</span>
</nav>

<header class="header">
  <h1>{game.title}</h1>
  <div class="meta">
    {#if game.releaseTba}
      <span class="badge">{m.badge_release_tba()}</span>
    {:else if game.releaseDate}
      <span class="badge">{game.releaseDate}</span>
    {/if}
    {#each game.tags as tag}
      <span class="chip">{tag}</span>
    {/each}
  </div>
  {#if game.notes}
    <p class="notes">{game.notes}</p>
  {/if}
</header>

<div class="panels">
  <!-- Store listings -->
  <section class="panel">
    <h2>Store listings</h2>
    {#if listings.length === 0}
      <p class="empty-inline">No Steam listings attached yet.</p>
    {:else}
      <ul class="listings">
        {#each listings as listing (listing.id)}
          <li class="listing">
            <span class="appid">App {listing.appId}</span>
            <span class="label">{listing.label}</span>
            {#if listing.releaseDate}
              <span class="badge">{listing.releaseDate}</span>
            {/if}
            {#if listing.apiKeyId}
              <span class="chip">key linked</span>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <!-- YouTube channels -->
  <section class="panel">
    <h2>YouTube channels</h2>
    {#if channels.length === 0}
      <p class="empty-inline">No YouTube channels attached yet.</p>
    {:else}
      <ul class="rows">
        {#each channels as ch (ch.id)}
          <li>
            <ChannelRow channel={ch} onRemove={() => detachChannel(ch.id)} />
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <!-- Items + paste box -->
  <section class="panel">
    <h2>Tracked items</h2>
    <PasteBox gameId={game.id} onSuccess={onPasteSuccess} />
    {#if items.length === 0}
      <EmptyState
        heading={m.empty_items_heading()}
        body={m.empty_items_example_youtube_url({
          url: "https://youtube.com/watch?v=dQw4w9WgXcQ",
        })}
        exampleUrl="https://youtube.com/watch?v=dQw4w9WgXcQ"
      />
    {:else}
      <ul class="rows">
        {#each items as it (it.id)}
          <li class="item">
            <a href={it.url} target="_blank" rel="noopener noreferrer" class="item-title">
              {it.title ?? it.url}
            </a>
            <span class="chip">{it.isOwn ? "own" : "blogger"}</span>
            <button
              type="button"
              class="action-danger"
              onclick={() => askDeleteItem(it.id)}
              aria-label={m.common_delete()}
            >
              ×
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <!-- Events timeline -->
  <section class="panel">
    <header class="panel-head">
      <h2>Events</h2>
      <button type="button" class="cta-small" onclick={() => (showEventForm = !showEventForm)}>
        {m.events_cta_new_event()}
      </button>
    </header>

    {#if showEventForm}
      <form class="newevent" onsubmit={submitNewEvent}>
        <label class="field">
          <span class="label">Title *</span>
          <input class="input" type="text" bind:value={newEventTitle} required maxlength="500" />
        </label>
        <label class="field">
          <span class="label">Kind *</span>
          <select class="input" bind:value={newEventKind}>
            <option value="conference">Conference</option>
            <option value="talk">Talk</option>
            <option value="twitter_post">Twitter post</option>
            <option value="telegram_post">Telegram post</option>
            <option value="discord_drop">Discord drop</option>
            <option value="press">Press</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label class="field">
          <span class="label">Date *</span>
          <input class="input" type="date" bind:value={newEventDate} required />
        </label>
        <label class="field">
          <span class="label">URL</span>
          <input class="input" type="url" bind:value={newEventUrl} placeholder="https://" />
        </label>
        <div class="actions">
          <button type="button" class="cancel" onclick={() => (showEventForm = false)}>
            {m.common_cancel()}
          </button>
          <button
            type="submit"
            class="submit"
            disabled={creatingEvent || newEventTitle.trim().length === 0}
          >
            {m.events_cta_new_event()}
          </button>
        </div>
        {#if eventError}<InlineError message={eventError} />{/if}
      </form>
    {/if}

    {#if events.length === 0}
      <EmptyState
        heading={m.empty_events_heading()}
        body={m.empty_events_body({
          url: "https://twitter.com/AnnaIndie/status/123456",
        })}
        exampleUrl="https://twitter.com/AnnaIndie/status/123456"
      />
    {:else}
      <ul class="rows">
        {#each events as ev (ev.id)}
          <li>
            <EventRow event={ev} onDelete={() => deleteEvent(ev.id)} />
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>

<ConfirmDialog
  open={confirmItemOpen}
  message={m.confirm_item_delete()}
  confirmLabel={m.common_delete()}
  onConfirm={confirmDeleteItem}
  onCancel={() => {
    confirmItemOpen = false;
    pendingItemId = null;
  }}
/>

<style>
  .breadcrumb {
    display: flex;
    gap: var(--space-xs);
    color: var(--color-text-muted);
    font-size: var(--font-size-label);
    margin-bottom: var(--space-md);
  }
  .breadcrumb a {
    color: var(--color-accent);
    text-decoration: none;
  }
  .header {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
    margin-bottom: var(--space-lg);
  }
  .header h1 {
    margin: 0;
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-semibold);
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-xs);
  }
  .badge,
  .chip {
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 999px;
    padding: 2px var(--space-sm);
  }
  .notes {
    margin: 0;
    color: var(--color-text-muted);
    line-height: var(--line-height-body);
    white-space: pre-wrap;
  }
  .panels {
    display: flex;
    flex-direction: column;
    gap: var(--space-xl);
    min-width: 0;
  }
  .panel {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    padding: var(--space-md);
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
    min-width: 0;
  }
  .panel h2 {
    margin: 0;
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-semibold);
  }
  .panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-md);
  }
  .empty-inline {
    margin: 0;
    color: var(--color-text-muted);
    font-size: var(--font-size-label);
  }
  .rows {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }
  .listings {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }
  .listing {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-sm);
    align-items: center;
    padding: var(--space-sm);
    border-bottom: 1px solid var(--color-border);
  }
  .appid {
    font-family: var(--font-family-mono);
    color: var(--color-text-muted);
  }
  .label {
    color: var(--color-text);
  }
  .item {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    padding: var(--space-sm);
    border-bottom: 1px solid var(--color-border);
    min-width: 0;
  }
  .item-title {
    flex: 1 1 auto;
    color: var(--color-text);
    text-decoration: none;
    word-break: break-word;
    min-width: 0;
  }
  .item-title:hover {
    text-decoration: underline;
  }
  .action-danger {
    min-width: 44px;
    min-height: 44px;
    background: transparent;
    color: var(--color-text-muted);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    cursor: pointer;
    font-size: var(--font-size-heading);
    line-height: 1;
  }
  .action-danger:hover {
    color: var(--color-destructive);
    border-color: var(--color-destructive);
  }
  .cta-small {
    min-height: 44px;
    padding: 0 var(--space-md);
    background: var(--color-accent);
    color: var(--color-accent-text);
    border: none;
    border-radius: 4px;
    font-size: var(--font-size-body);
    font-weight: var(--font-weight-semibold);
    cursor: pointer;
  }
  .newevent {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
    padding: var(--space-md);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 4px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
  }
  .input {
    min-height: 44px;
    padding: 0 var(--space-md);
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-size: var(--font-size-body);
  }
  .actions {
    display: flex;
    gap: var(--space-sm);
    justify-content: flex-end;
  }
  .cancel {
    background: transparent;
    color: var(--color-text-muted);
    border: none;
    text-decoration: underline;
    cursor: pointer;
  }
  .submit {
    min-height: 44px;
    padding: 0 var(--space-md);
    background: var(--color-accent);
    color: var(--color-accent-text);
    border: none;
    border-radius: 4px;
    font-weight: var(--font-weight-semibold);
    cursor: pointer;
  }
  .submit:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  @media (min-width: 1024px) {
    .panels {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--space-lg);
    }
  }
</style>
