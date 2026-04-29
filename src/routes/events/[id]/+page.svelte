<script lang="ts">
  // /events/[id] — full event detail (Plan 02.1-18 replaces Phase-4 stub).
  //
  // Plan 02.1-18 — round-2 UAT closure: FeedCard becomes a pure preview
  // tile; ALL mutating + destructive actions live HERE. The Phase-4
  // LayerChart placeholder is anchored inline at the bottom (CONTEXT
  // D-07 spirit preserved).
  //
  // Privacy invariants (mirrored in +page.server.ts):
  //   - Anonymous → redirect to /login (loader gate; page-route equivalent
  //     of MUST_BE_PROTECTED).
  //   - Cross-tenant → 404 via NotFoundError → error(404) (PRIV-01).
  //   - Soft-deleted rows surface only when ?deleted=1; Restore button
  //     visible only on those rows.
  //   - toEventDto strips userId; no ciphertext on events.
  //   - DELETE /api/events/:id and PATCH /api/events/:id/restore are
  //     mounted under tenantScope (anonymous-401 sweep covers them).

  import { goto, invalidateAll } from "$app/navigation";
  import { m } from "$lib/paraglide/messages.js";
  import KindIcon from "$lib/components/KindIcon.svelte";
  import EmptyState from "$lib/components/EmptyState.svelte";
  import InlineError from "$lib/components/InlineError.svelte";
  import type { PageData } from "./$types";

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

  type EventDtoLocal = {
    id: string;
    // Plan 02.1-28 (M:N migration): gameIds[] replaces the legacy singular
    // gameId. Round-3 detail page surfaces the first attached game as the
    // primary "game" chip via the loader's primaryGame derivation.
    gameIds: string[];
    sourceId: string | null;
    kind: EventKind;
    authorIsMe: boolean;
    occurredAt: Date | string;
    title: string;
    url: string | null;
    notes: string | null;
    deletedAt: Date | string | null;
  };

  type GameLite = { id: string; title: string };

  let { data }: { data: PageData } = $props();
  const event = $derived(data.event as EventDtoLocal);
  const game = $derived(data.game as GameLite | null);

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
  const isSoftDeleted = $derived(event.deletedAt !== null);

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

  // Plan 02.1-32 (UAT-NOTES.md §4.18.A): Delete moved to /events/[id]/edit
  // form footer; the read-only detail page no longer carries a Delete
  // button. Restore stays here because it only applies on the
  // soft-deleted-events view (?deleted=1) and the edit page intentionally
  // doesn't load soft-deleted rows.
  let restoreBusy = $state(false);
  let restoreError = $state<string | null>(null);

  async function restoreEvent(): Promise<void> {
    if (restoreBusy) return;
    restoreBusy = true;
    restoreError = null;
    try {
      const res = await fetch(`/api/events/${event.id}/restore`, { method: "PATCH" });
      if (!res.ok) {
        restoreError = m.error_server_generic();
        return;
      }
      await invalidateAll();
      // Navigate to the canonical detail URL (drops the ?deleted=1 query).
      await goto(`/events/${event.id}`);
    } catch {
      restoreError = m.error_network();
    } finally {
      restoreBusy = false;
    }
  }
</script>

<nav class="breadcrumb" aria-label="Breadcrumb">
  <a href="/feed">Feed</a>
  <span aria-hidden="true">/</span>
  <span>Event</span>
</nav>

<article class="detail">
  <!-- Plan 02.1-32 (UAT-NOTES.md §4.18.B): Edit pencil moves to the
       top-right corner of the card, mirroring the FeedCard top-right
       overlay placement Plan 02.1-23 established. Hidden when the row
       is soft-deleted (Restore is the only action available there). -->
  {#if !isSoftDeleted}
    <a
      class="edit-pencil"
      href={`/events/${event.id}/edit`}
      aria-label={m.event_edit_aria_label()}
    >
      ✎
    </a>
  {/if}

  <header class="head">
    <KindIcon kind={event.kind} size={48} />
    <div class="meta">
      <span class="kind-tag">{kindLabel}</span>
      <h1 class="title">{event.title}</h1>
      <div class="meta-row">
        <time class="when" datetime={occurredIso} title={occurredIso}>{occurredHuman}</time>
        {#if event.authorIsMe}
          <span class="chip chip-author">{m.feed_card_author_is_me_badge()}</span>
        {/if}
        {#if game}
          <span class="chip">{game.title}</span>
        {/if}
        {#if isSoftDeleted}
          <span class="chip chip-deleted">Deleted</span>
        {/if}
      </div>
    </div>
  </header>

  {#if event.notes}
    <section class="notes">
      <p>{event.notes}</p>
    </section>
  {/if}

  <!-- Plan 02.1-32 (UAT-NOTES.md §4.18.A): Delete REMOVED from this
       read-only detail page. The Delete button now lives at the
       /events/[id]/edit form footer (Plan 02.1-32 Task 1). The Edit
       affordance is the top-right pencil above. The actions row keeps
       Open-original (no-op for events without a URL) and Restore (only
       on soft-deleted rows). -->
  <div class="actions">
    {#if event.url}
      <a class="action" href={event.url} target="_blank" rel="noopener noreferrer">
        {m.events_detail_open_original()} ↗
      </a>
    {/if}
    {#if isSoftDeleted}
      <button
        type="button"
        class="action primary"
        onclick={restoreEvent}
        disabled={restoreBusy}
      >
        {m.events_detail_restore()}
      </button>
    {/if}
  </div>

  {#if restoreError}<InlineError message={restoreError} />{/if}

  <section class="chart-placeholder" aria-label="Phase-4 chart placeholder">
    <EmptyState
      heading={m.events_detail_phase4_heading()}
      body={m.events_detail_phase4_chart_placeholder()}
    />
  </section>
</article>

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
  .detail {
    display: flex;
    flex-direction: column;
    gap: var(--space-lg);
    padding: var(--space-md);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    /* Plan 02.1-32 (UAT-NOTES.md §4.18.B): anchor the absolutely-positioned
     * .edit-pencil (top-right corner) — mirrors the FeedCard top-right
     * overlay anchoring Plan 02.1-23 established. */
    position: relative;
  }
  /* Plan 02.1-32: Edit pencil at the top-right of the card. Sized to a
   * 44x44 touch target so a 360px-viewport tap reaches it without the user
   * fumbling for the small icon (UAT-NOTES.md §4.18.B). z-index: 1 lifts
   * it above the chart placeholder section if the layout overlaps. */
  .edit-pencil {
    position: absolute;
    top: var(--space-md);
    right: var(--space-md);
    z-index: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    text-decoration: none;
    font-size: var(--font-size-body);
    cursor: pointer;
  }
  .edit-pencil:hover {
    background: var(--color-bg);
    border-color: var(--color-text);
  }
  .head {
    display: flex;
    gap: var(--space-md);
    align-items: flex-start;
    min-width: 0;
  }
  .meta {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
    min-width: 0;
    flex: 1 1 auto;
  }
  .kind-tag {
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
    font-weight: var(--font-weight-semibold);
  }
  .title {
    margin: 0;
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-semibold);
    line-height: var(--line-height-body);
    word-break: break-word;
  }
  .meta-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-sm);
    align-items: center;
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
  }
  .when {
    color: var(--color-text-muted);
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
  .chip-deleted {
    color: var(--color-destructive);
    border-color: var(--color-destructive);
  }
  .notes {
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    padding: var(--space-md);
  }
  .notes p {
    margin: 0;
    white-space: pre-wrap;
    line-height: var(--line-height-body);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-sm);
    align-items: center;
  }
  .action {
    min-height: 44px;
    padding: 0 var(--space-md);
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    cursor: pointer;
    font-size: var(--font-size-body);
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    gap: var(--space-xs);
  }
  .action:hover {
    background: var(--color-bg);
  }
  .action.primary {
    background: var(--color-accent);
    color: var(--color-accent-text);
    border-color: var(--color-accent);
  }
  .action.primary:hover {
    opacity: 0.9;
    background: var(--color-accent);
  }
  .action.danger {
    color: var(--color-destructive);
  }
  .action.danger:hover {
    border-color: var(--color-destructive);
  }
  .action:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .chart-placeholder {
    margin-top: var(--space-md);
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
  @media (max-width: 480px) {
    .actions {
      flex-direction: column;
      align-items: stretch;
    }
    .action {
      justify-content: center;
    }
  }
</style>
