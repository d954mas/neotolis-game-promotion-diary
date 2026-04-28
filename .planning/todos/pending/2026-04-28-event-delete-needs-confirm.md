---
created: 2026-04-28T06:25:00.000Z
title: Event delete needs ConfirmDialog (one-click delete is too easy)
area: ui
files:
  - src/routes/games/[gameId]/+page.svelte:144-147 (deleteEvent — direct fetch, no confirm)
  - src/routes/events/+page.svelte:102-105 (deleteEvent — direct fetch, no confirm)
  - src/lib/components/EventRow.svelte (delete button — fires onDelete immediately)
  - src/lib/components/ConfirmDialog.svelte (already exists)
---

## Problem

During Phase 2 manual UAT (2026-04-28), user said: **"Эвент слишком просто удалить"**

Current behavior: one click on the event delete button → immediate DELETE /api/events/:id → row disappears. No confirmation.

Compare to game delete (`/games`): uses `<ConfirmDialog>` with the game title shown ("Delete Hades?"). Event delete should match — events represent real promotion activity (conferences attended, posts made) and accidental deletion loses data.

This applies to BOTH places that delete events:
- `/games/[gameId]` events panel (line 144-147 — `deleteEvent` calls fetch directly)
- `/events` global timeline (line 102-105 — same pattern)

## Solution

Use existing `<ConfirmDialog>` component (already used elsewhere). Match the game-delete pattern:

```svelte
let confirmEventOpen = $state(false);
let pendingEventId = $state<string | null>(null);
let pendingEventTitle = $state("");

function askDeleteEvent(ev: EventDtoLocal): void {
  pendingEventId = ev.id;
  pendingEventTitle = ev.title;
  confirmEventOpen = true;
}

async function confirmDeleteEvent(): Promise<void> {
  if (!pendingEventId) return;
  const res = await fetch(`/api/events/${pendingEventId}`, { method: "DELETE" });
  confirmEventOpen = false;
  pendingEventId = null;
  if (res.ok || res.status === 204) await invalidateAll();
}
```

Plus a new i18n key:
- `confirm_event_delete`: "Delete event "{title}"? This cannot be undone." (or use existing `confirm_game_delete` pattern)

## Tests

- /events integration test: assert delete fires confirm flow + actual DELETE only after confirm
- /games/[id] integration test: same

## Severity

**P1** — data-loss UX risk. Trivial to fix. Bundle into Phase 2.1.

Owner: Phase 2.1 gap closure.
