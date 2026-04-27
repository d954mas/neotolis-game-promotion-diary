<script lang="ts">
  // EventRow — one row on /events and on a game's events timeline panel.
  // KindIcon + occurredAt (relative + absolute on hover via title) + title
  // + optional URL link + edit/delete.

  import { m } from "$lib/paraglide/messages.js";
  import KindIcon from "./KindIcon.svelte";

  type EventKind =
    | "conference"
    | "talk"
    | "twitter_post"
    | "telegram_post"
    | "discord_drop"
    | "press"
    | "other";

  type EventDto = {
    id: string;
    kind: EventKind;
    occurredAt: Date | string;
    title: string;
    url: string | null;
  };

  let {
    event,
    onEdit,
    onDelete,
  }: {
    event: EventDto;
    onEdit?: () => void;
    onDelete?: () => void;
  } = $props();

  const occurredIso = $derived(
    typeof event.occurredAt === "string" ? event.occurredAt : event.occurredAt.toISOString(),
  );
  const occurredHuman = $derived(
    typeof event.occurredAt === "string"
      ? new Date(event.occurredAt).toLocaleDateString()
      : event.occurredAt.toLocaleDateString(),
  );
</script>

<div class="row">
  <KindIcon kind={event.kind} />
  <time class="when" datetime={occurredIso} title={occurredIso}>{occurredHuman}</time>
  <div class="body">
    <span class="title">{event.title}</span>
    {#if event.url}
      <a class="link" href={event.url} target="_blank" rel="noopener noreferrer">↗</a>
    {/if}
  </div>
  <div class="actions">
    {#if onEdit}
      <button type="button" class="action" onclick={onEdit} aria-label={m.common_edit()}>✎</button>
    {/if}
    {#if onDelete}
      <button type="button" class="action danger" onclick={onDelete} aria-label={m.common_delete()}
        >×</button
      >
    {/if}
  </div>
</div>

<style>
  .row {
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: var(--space-sm);
    align-items: center;
    padding: var(--space-md);
    border-bottom: 1px solid var(--color-border);
  }
  .when {
    grid-column: 2;
    grid-row: 1;
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
  }
  .body {
    grid-column: 2;
    grid-row: 2;
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    min-width: 0;
  }
  .title {
    color: var(--color-text);
    word-break: break-word;
  }
  .link {
    color: var(--color-accent);
    text-decoration: none;
  }
  .actions {
    grid-column: 3;
    grid-row: 1 / span 2;
    display: flex;
    gap: var(--space-xs);
    align-items: center;
  }
  .action {
    min-width: 44px;
    min-height: 44px;
    background: transparent;
    color: var(--color-text-muted);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    cursor: pointer;
    font-size: var(--font-size-body);
    line-height: 1;
  }
  .action:hover {
    color: var(--color-text);
  }
  .action.danger:hover {
    color: var(--color-destructive);
    border-color: var(--color-destructive);
  }
  @media (min-width: 768px) {
    .row {
      grid-template-columns: auto 200px 1fr auto;
    }
    .when {
      grid-column: 2;
      grid-row: 1;
    }
    .body {
      grid-column: 3;
      grid-row: 1;
    }
    .actions {
      grid-column: 4;
      grid-row: 1;
    }
  }
</style>
