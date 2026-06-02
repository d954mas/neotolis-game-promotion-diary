<script lang="ts">
  // /events/[id] — thin route wrapper around <EventDetailContent>.
  //
  // Phase 03.4 Wave 3 (Plan 10 Task 3) — dual-render contract: the same
  // <EventDetailContent> mounts here AS A ROUTE and via <EventDetailModal>
  // FROM /feed?event=... The shared body owns inline-edit drafts +
  // keyboard navigation + footer actions; the route owns close-behavior
  // (navigate to /feed instead of dismissing a modal).
  //
  // Privacy invariants (mirrored in +page.server.ts):
  //   - Anonymous → /login redirect (loader gate).
  //   - Cross-tenant → NotFoundError → error(404) → SvelteKit 404 page.
  //   - Soft-deleted rows surface only with ?deleted=1; the trash view
  //     (?view=trash on /feed) provides the alternate entry point.
  //
  // The legacy /events/[id]/edit route remains for free-form Edit
  // workflows; this read-only detail page now flows directly through
  // EventDetailContent's inline-edit drafts for the common in-place
  // changes (title / notes / url / authorIsMe).

  import { goto, invalidateAll } from "$app/navigation";
  import EventDetailContent from "$lib/components/event-detail/EventDetailContent.svelte";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  // View flag derived from soft-delete state. The edit-pencil + footer
  // Edit/Delete affordances inside <EventDetailContent> swap to
  // Restore/Delete-forever when view=trash (D-19 + D-21).
  const view = $derived(data.event.deletedAt !== null ? ("trash" as const) : ("feed" as const));

  async function onUpdate(
    id: string,
    patch: Partial<{
      title: string;
      notes: string | null;
      url: string | null;
      authorIsMe: boolean;
    }>,
  ): Promise<void> {
    await fetch(`/api/events/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    await invalidateAll();
  }

  async function onDelete(id: string): Promise<void> {
    await fetch(`/api/events/${id}`, { method: "DELETE" });
    await goto("/feed");
  }

  async function onRestore(id: string): Promise<void> {
    await fetch(`/api/events/${id}/restore`, { method: "PATCH" });
    // Drop the ?deleted=1 query param so the canonical URL reflects the
    // restored state. SvelteKit re-runs the loader without the flag, the
    // event surfaces in /feed at its original position.
    await goto(`/events/${id}`);
  }

  async function onDeleteForever(id: string): Promise<void> {
    await fetch(`/api/events/${id}?force=true`, { method: "DELETE" });
    await goto("/feed?view=trash");
  }
</script>

<!--
  Route-mode wrapper — visually mirrors EventDetailModal's 760px panel
  chrome so /events/[id] reads as the same surface a user opens from the
  feed (D-05 dual-render contract). Without this wrapper EventDetailContent
  stretches to the full viewport width because the route is a regular block
  flow with no max-width / border / radius.
-->
<section class="detail-route-host">
  <EventDetailContent
    event={data.event}
    games={data.games}
    sources={data.sources}
    metricSeries={data.metricSeries}
    {view}
    onClose={() => goto("/feed")}
    {onDelete}
    onRestore={view === "trash" ? onRestore : undefined}
    onDeleteForever={view === "trash" ? onDeleteForever : undefined}
    {onUpdate}
  />
</section>

<style>
  /* Mirrors `.event-detail-modal` from EventDetailModal.svelte (lines
   * 108-119): 760px wide, surface fill, border + radius + soft elevation.
   * No `max-height` here — the route flows naturally inside the document,
   * unlike the modal which is constrained to the viewport. */
  .detail-route-host {
    width: min(760px, calc(100vw - 32px));
    margin: 0 auto;
    background: var(--surface);
    border: 1px solid var(--border-2);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-elev);
    color: var(--text);
    overflow: hidden;
    min-width: 0;
  }
</style>
