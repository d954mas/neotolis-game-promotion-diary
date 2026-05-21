<script lang="ts">
  // /events/new — thin route wrapper around <AddEventForm>.
  //
  // Phase 03.4 Wave 3 (Plan 10 Task 3) — dual-render contract: the same
  // <AddEventForm> mounts here AS A ROUTE and via <AddEventModal> from
  // /feed's "+ Add Event" CTA. The shared form owns field state, URL
  // preview-fetch, and the kind/url validation; the route owns close
  // behavior (navigate to /feed instead of dismissing a modal) and the
  // POST + invalidateAll after save (D-18 / RESEARCH Pitfall 2).
  //
  // The legacy full-page free-form flow remains the canonical entry
  // point for free-form events; the /feed paste flow handles pollable
  // kinds (YouTube + Reddit) for users who already have a URL.

  import { goto, invalidateAll } from "$app/navigation";
  import AddEventForm, {
    type AddEventPayload,
  } from "$lib/components/add-event/AddEventForm.svelte";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  async function onSave(payload: AddEventPayload): Promise<void> {
    const res = await fetch("/api/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        // The /api/events endpoint accepts a single gameId (legacy
        // single-game contract). The form supplies a gameIds[] for
        // future multi-attach — we forward the first id (or null for
        // inbox) until the API endpoint extends to accept the array.
        gameId: payload.gameIds[0] ?? null,
        kind: payload.kind,
        occurredAt: payload.occurredAt,
        title: payload.title,
        url: payload.url,
        notes: payload.notes,
        authorIsMe: payload.authorIsMe,
      }),
    });
    if (res.ok) {
      // RESEARCH Pitfall 2 — without invalidateAll, /feed's loader does
      // not re-run after the POST and the user has to hard-refresh to
      // see the new event.
      await invalidateAll();
      await goto("/feed");
    } else {
      // Surface server errors via the form's own InlineError surface by
      // throwing — AddEventForm catches and shows the generic error
      // (the bare form has no toast surface; that's the modal's role).
      throw new Error("save_failed");
    }
  }
</script>

<AddEventForm
  games={data.games}
  {onSave}
  onCancel={() => goto("/feed")}
/>
