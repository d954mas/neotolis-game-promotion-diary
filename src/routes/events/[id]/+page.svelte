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

  function onEdit(id: string): void {
    // Free-form Edit page (/events/[id]/edit) remains the canonical
    // out-of-place edit destination — Plan 09 EventDetailContent inline
    // drafts cover title / notes / url / authorIsMe; structural edits
    // (kind, occurredAt) still use the legacy form.
    void goto(`/events/${id}/edit`);
  }
</script>

<EventDetailContent
  event={data.event}
  games={data.games}
  sources={data.sources}
  {view}
  hasPrev={false}
  hasNext={false}
  onClose={() => goto("/feed")}
  {onDelete}
  onRestore={view === "trash" ? onRestore : undefined}
  onDeleteForever={view === "trash" ? onDeleteForever : undefined}
  {onUpdate}
  {onEdit}
/>
