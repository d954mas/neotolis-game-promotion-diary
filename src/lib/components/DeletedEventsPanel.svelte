<script lang="ts">
  // DeletedEventsPanel — expand-toggle panel for soft-deleted events on
  // /feed. Mirrors the /sources soft-deleted-section pattern for events.
  //
  // Visual rhythm: collapsed by default; toggle button reads
  //   "Show {N} deleted events (within {RETENTION_DAYS} days)"
  // Expanded: each row shows KindIcon + strikethrough title + RetentionBadge
  // + Restore button (44px hit area, accent border on hover).
  //
  // Privacy invariants (CLAUDE.md):
  //   - The component receives only `deletedEvents` from SSR (already
  //     projected through toEventDto by the loader). No userId in the props.
  //   - The fetch PATCH /api/events/:id/restore goes through tenantScope
  //     middleware; cross-tenant id throws NotFoundError → 404.
  //   - Renders nothing when deletedEvents.length === 0 (graceful empty case
  //     — no toggle, no header, no footprint on /feed when there's nothing
  //     to recover).

  import { m } from "$lib/paraglide/messages.js";
  import KindIcon from "./KindIcon.svelte";
  import RetentionBadge from "./RetentionBadge.svelte";

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

  type DeletedEventLite = {
    id: string;
    kind: EventKind;
    title: string;
    deletedAt: Date | string | null;
  };

  let {
    deletedEvents,
    retentionDays,
    onChanged,
  }: {
    deletedEvents: DeletedEventLite[];
    retentionDays: number;
    onChanged?: () => void;
  } = $props();

  let expanded = $state(false);
  let pendingId = $state<string | null>(null);

  async function restore(id: string): Promise<void> {
    if (pendingId !== null) return;
    pendingId = id;
    try {
      const res = await fetch(`/api/events/${id}/restore`, { method: "PATCH" });
      if (res.ok) onChanged?.();
    } finally {
      pendingId = null;
    }
  }
</script>

{#if deletedEvents.length > 0}
  <section class="deleted-panel" aria-labelledby="deleted-panel-toggle">
    <button
      id="deleted-panel-toggle"
      type="button"
      class="toggle"
      aria-expanded={expanded}
      onclick={() => (expanded = !expanded)}
    >
      {expanded
        ? m.feed_deleted_panel_toggle_hide()
        : m.feed_deleted_panel_toggle_show({
            count: deletedEvents.length,
            days: retentionDays,
          })}
    </button>

    {#if expanded}
      <ul class="rows">
        {#each deletedEvents as ev (ev.id)}
          <li class="row">
            <KindIcon kind={ev.kind} />
            <span class="title">{ev.title}</span>
            {#if ev.deletedAt !== null}
              <RetentionBadge deletedAt={ev.deletedAt} {retentionDays} />
            {/if}
            <button
              type="button"
              class="restore"
              aria-label={m.feed_deleted_panel_restore_aria()}
              disabled={pendingId === ev.id}
              onclick={() => restore(ev.id)}
            >
              {m.feed_deleted_panel_restore_cta()}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
{/if}

<style>
  /* v2 DeletedEventsPanel — --surface-2 banner with restore actions. */
  .deleted-panel {
    margin-top: var(--s-6);
    padding-top: var(--s-3);
    border-top: 1px solid var(--border-hairline);
  }
  .toggle {
    background: transparent;
    color: var(--text-3);
    border: none;
    cursor: pointer;
    font-family: var(--f-sans);
    font-size: var(--t-13);
    padding: var(--s-2);
    text-decoration: underline;
    transition: color var(--m-fast) var(--m-ease);
  }
  .toggle:hover {
    color: var(--text);
  }
  .rows {
    list-style: none;
    margin: var(--s-3) 0 0 0;
    padding: 0;
    background: var(--surface-2);
    border: 1px solid var(--border-2);
    border-radius: var(--r-md);
    overflow: hidden;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-2);
    padding: var(--s-3) var(--s-4);
    border-bottom: 1px solid var(--border-hairline);
  }
  .row:last-child {
    border-bottom: none;
  }
  .title {
    flex: 1 1 auto;
    min-width: 0;
    color: var(--text-3);
    font-size: var(--t-14);
    text-decoration: line-through;
    word-break: break-word;
  }
  .restore {
    min-height: var(--hit);
    padding: var(--s-1) var(--s-3);
    background: transparent;
    color: var(--accent);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    cursor: pointer;
    font-family: var(--f-sans);
    font-size: var(--t-13);
    font-weight: var(--w-md);
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .restore:hover:not(:disabled) {
    background: var(--accent-soft);
    border-color: var(--accent-strong);
  }
  .restore:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  @media (prefers-reduced-motion: reduce) {
    .toggle,
    .restore {
      transition: none;
    }
  }
</style>
