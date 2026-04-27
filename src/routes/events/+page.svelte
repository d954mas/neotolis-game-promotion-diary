<script lang="ts">
  // /events — global timeline view (Plan 02-10).
  //
  // Per-game-fetch + JS merge (the global GET /api/events endpoint is a
  // Phase 6 polish item, see +page.server.ts). Renders <EventRow> grouped
  // by month with sticky month headers. Empty state uses Twitter URL
  // example per UI-SPEC.

  import { invalidateAll } from "$app/navigation";
  import { m } from "$lib/paraglide/messages.js";
  import EmptyState from "$lib/components/EmptyState.svelte";
  import EventRow from "$lib/components/EventRow.svelte";
  import InlineError from "$lib/components/InlineError.svelte";
  import type { PageData } from "./$types";

  type EventKind =
    | "conference"
    | "talk"
    | "twitter_post"
    | "telegram_post"
    | "discord_drop"
    | "press"
    | "other";

  type EnrichedEvent = {
    id: string;
    kind: EventKind;
    occurredAt: string;
    title: string;
    url: string | null;
    gameId: string;
    gameTitle: string;
  };

  type GameOpt = { id: string; title: string };

  let { data }: { data: PageData } = $props();

  const events = $derived(data.events as EnrichedEvent[]);
  const games = $derived(data.games as GameOpt[]);

  // Group by YYYY-MM month string for sticky headers.
  const byMonth = $derived.by(() => {
    const groups = new Map<string, EnrichedEvent[]>();
    for (const ev of events) {
      const monthKey = ev.occurredAt.slice(0, 7);
      const arr = groups.get(monthKey);
      if (arr) arr.push(ev);
      else groups.set(monthKey, [ev]);
    }
    return Array.from(groups.entries());
  });

  // -- New event form --
  let showForm = $state(false);
  let formGameId = $state("");
  let formTitle = $state("");
  let formKind = $state<EventKind>("other");
  let formDate = $state(new Date().toISOString().slice(0, 10));
  let formUrl = $state("");
  let creating = $state(false);
  let createError = $state<string | null>(null);

  // Default the dropdown to the first game so the form submits even if
  // the user doesn't touch it.
  $effect(() => {
    if (formGameId === "" && games.length > 0) formGameId = games[0]!.id;
  });

  async function submitNew(e: Event): Promise<void> {
    e.preventDefault();
    if (creating || formTitle.trim().length === 0 || !formGameId) return;
    creating = true;
    createError = null;
    try {
      const res = await fetch("/api/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          gameId: formGameId,
          kind: formKind,
          title: formTitle.trim(),
          occurredAt: new Date(formDate).toISOString(),
          url: formUrl.trim().length > 0 ? formUrl.trim() : null,
        }),
      });
      if (!res.ok) {
        createError = m.error_server_generic();
        return;
      }
      formTitle = "";
      formUrl = "";
      showForm = false;
      await invalidateAll();
    } catch {
      createError = m.error_network();
    } finally {
      creating = false;
    }
  }

  async function deleteEvent(id: string): Promise<void> {
    const res = await fetch(`/api/events/${id}`, { method: "DELETE" });
    if (res.ok || res.status === 204) await invalidateAll();
  }
</script>

<section class="events">
  <header class="head">
    <h1>Events</h1>
    {#if games.length > 0}
      <button type="button" class="cta" onclick={() => (showForm = !showForm)}>
        {m.events_cta_new_event()}
      </button>
    {/if}
  </header>

  {#if showForm}
    <form class="newevent" onsubmit={submitNew}>
      <label class="field">
        <span class="label">Game *</span>
        <select class="input" bind:value={formGameId} required>
          {#each games as g (g.id)}
            <option value={g.id}>{g.title}</option>
          {/each}
        </select>
      </label>
      <label class="field">
        <span class="label">Title *</span>
        <input class="input" type="text" bind:value={formTitle} required maxlength="500" />
      </label>
      <label class="field">
        <span class="label">Kind *</span>
        <select class="input" bind:value={formKind}>
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
        <input class="input" type="date" bind:value={formDate} required />
      </label>
      <label class="field">
        <span class="label">URL</span>
        <input class="input" type="url" bind:value={formUrl} placeholder="https://" />
      </label>
      <div class="actions">
        <button type="button" class="cancel" onclick={() => (showForm = false)}>
          {m.common_cancel()}
        </button>
        <button type="submit" class="submit" disabled={creating || formTitle.trim().length === 0}>
          {m.events_cta_new_event()}
        </button>
      </div>
      {#if createError}<InlineError message={createError} />{/if}
    </form>
  {/if}

  {#if events.length === 0}
    <EmptyState
      heading={m.empty_events_heading()}
      body={m.empty_events_body({
        url: "https://twitter.com/AnnaIndie/status/123456",
      })}
      exampleUrl="https://twitter.com/AnnaIndie/status/123456"
      ctaLabel={games.length > 0 ? m.events_cta_new_event() : undefined}
      onCta={games.length > 0 ? () => (showForm = true) : undefined}
    />
  {:else}
    {#each byMonth as [month, monthEvents] (month)}
      <h2 class="month">{month}</h2>
      <ul class="rows">
        {#each monthEvents as ev (ev.id)}
          <li>
            <a class="game-tag" href={`/games/${ev.gameId}`}>{ev.gameTitle}</a>
            <EventRow event={ev} onDelete={() => deleteEvent(ev.id)} />
          </li>
        {/each}
      </ul>
    {/each}
  {/if}
</section>

<style>
  .events {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
    min-width: 0;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-md);
  }
  .head h1 {
    margin: 0;
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-semibold);
  }
  .cta {
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
  .month {
    margin: var(--space-lg) 0 var(--space-sm) 0;
    font-size: var(--font-size-label);
    font-weight: var(--font-weight-semibold);
    color: var(--color-text-muted);
    position: sticky;
    top: 0;
    background: var(--color-bg);
    padding: var(--space-xs) 0;
    border-bottom: 1px solid var(--color-border);
  }
  .rows {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .game-tag {
    display: inline-block;
    font-size: var(--font-size-label);
    color: var(--color-accent);
    text-decoration: none;
    padding: 2px var(--space-sm);
    border: 1px solid var(--color-border);
    border-radius: 999px;
    margin: var(--space-xs) var(--space-md);
  }
  .game-tag:hover {
    text-decoration: underline;
  }
  .newevent {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
    padding: var(--space-md);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 4px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
  }
  .label {
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
  }
  .input {
    min-height: 44px;
    padding: 0 var(--space-md);
    background: var(--color-bg);
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
</style>
