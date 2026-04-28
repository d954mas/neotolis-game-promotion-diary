<script lang="ts">
  // /events/[id] — Phase-4 stub (Plan 02.1-09; CONTEXT D-07).
  //
  // VIZ-01 (LayerChart-driven event detail with per-event view-count
  // history) lands in Phase 4. UI-SPEC FLAG: "honest, sets expectations,
  // avoids a 404". The page renders a small read-only summary of the event
  // so the user has context, then EmptyState explaining the upcoming
  // detail, then a back-to-feed link.

  import { m } from "$lib/paraglide/messages.js";
  import EmptyState from "$lib/components/EmptyState.svelte";
  import KindIcon from "$lib/components/KindIcon.svelte";
  import type { PageData } from "./$types";

  type EventKind =
    | "youtube_video"
    | "reddit_post"
    | "conference"
    | "talk"
    | "twitter_post"
    | "telegram_post"
    | "discord_drop"
    | "press"
    | "other"
    | "post";

  type EventDtoLocal = {
    id: string;
    kind: EventKind;
    occurredAt: Date | string;
    title: string;
    url: string | null;
  };

  let { data }: { data: PageData } = $props();
  const event = $derived(data.event as EventDtoLocal);

  const occurredIso = $derived(
    typeof event.occurredAt === "string"
      ? event.occurredAt
      : event.occurredAt.toISOString(),
  );
  const occurredHuman = $derived(
    typeof event.occurredAt === "string"
      ? new Date(event.occurredAt).toLocaleDateString()
      : event.occurredAt.toLocaleDateString(),
  );
</script>

<nav class="breadcrumb" aria-label="Breadcrumb">
  <a href="/feed">Feed</a>
  <span aria-hidden="true">/</span>
  <span>Event</span>
</nav>

<section class="summary">
  <KindIcon kind={event.kind} />
  <div class="meta">
    <time class="when" datetime={occurredIso} title={occurredIso}>{occurredHuman}</time>
    <h1 class="title">{event.title}</h1>
    {#if event.url}
      <a class="link" href={event.url} target="_blank" rel="noopener noreferrer">
        Open original ↗
      </a>
    {/if}
  </div>
</section>

<EmptyState
  heading={m.events_detail_phase4_heading()}
  body={m.events_detail_phase4_body()}
/>

<a class="back" href="/feed">Back to feed</a>

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
  .summary {
    display: flex;
    gap: var(--space-md);
    padding: var(--space-md);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    margin-bottom: var(--space-lg);
    align-items: flex-start;
  }
  .meta {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
    min-width: 0;
  }
  .when {
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
  }
  .title {
    margin: 0;
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-semibold);
  }
  .link {
    font-size: var(--font-size-label);
    color: var(--color-accent);
    text-decoration: none;
  }
  .link:hover {
    text-decoration: underline;
  }
  .back {
    display: inline-block;
    margin-top: var(--space-md);
    color: var(--color-accent);
    text-decoration: none;
    padding: var(--space-sm);
  }
  .back:hover {
    text-decoration: underline;
  }
</style>
