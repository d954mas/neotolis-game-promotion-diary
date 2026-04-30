<script lang="ts">
  // DeletedEventsPanel — expand-toggle panel for soft-deleted events on
  // /feed (Plan 02.1-14 gap closure — VERIFICATION.md Gap 2). Mirrors the
  // /sources soft-deleted-section pattern (Plan 02.1-08) for events.
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
  //     middleware; cross-tenant id throws NotFoundError → 404 (Plan 02.1-14
  //     Task 2 service guarantee).
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
  .deleted-panel {
    margin-top: var(--space-lg);
    padding-top: var(--space-md);
    border-top: 1px solid var(--color-border);
  }
  .toggle {
    background: transparent;
    color: var(--color-text-muted);
    border: none;
    cursor: pointer;
    font-size: var(--font-size-label);
    padding: var(--space-sm);
    text-decoration: underline;
  }
  .toggle:hover {
    color: var(--color-text);
  }
  .rows {
    list-style: none;
    margin: var(--space-md) 0 0 0;
    padding: 0;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-sm);
    padding: var(--space-md);
    border-bottom: 1px solid var(--color-border);
  }
  .title {
    flex: 1 1 auto;
    min-width: 0;
    color: var(--color-text-muted);
    text-decoration: line-through;
    word-break: break-word;
  }
  .restore {
    min-height: 44px;
    padding: 0 var(--space-md);
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-accent);
    border-radius: 4px;
    cursor: pointer;
    font-size: var(--font-size-label);
  }
  .restore:hover {
    filter: brightness(1.05);
  }
  .restore:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
