<script lang="ts">
  // /events/[id]/edit — full event edit form (Plan 02.1-18 — new route).
  //
  // Plan 02.1-18 — round-2 UAT closure: pencil moves from FeedCard to
  // /events/[id] detail; this is its destination. Form mirrors the
  // /events/new shape (kind / occurredAt / title / url / notes / gameId)
  // PLUS an "Author is me" checkbox. Submit → PATCH /api/events/:id
  // (carries authorIsMe, validated by Plan 02.1-17 updateEventSchema)
  // and, IF gameId changed, a separate PATCH /api/events/:id/attach so
  // the dedicated attach endpoint owns gameId mutation (validates game
  // ownership via assertGameOwnedByUser; Pitfall 4 mitigation).
  //
  // Privacy invariants (mirrored in +page.server.ts):
  //   - Anonymous → redirect to /login (loader gate; page-route equivalent
  //     of MUST_BE_PROTECTED).
  //   - Cross-tenant → 404 via NotFoundError → error(404) (PRIV-01).
  //   - PATCH /api/events/:id is mounted under tenantScope
  //     (anonymous-401 sweep covers it; service-layer updateEvent throws
  //     NotFoundError on cross-tenant).
  //   - toEventDto strips userId; no ciphertext on events.

  import { goto, invalidateAll } from "$app/navigation";
  import { m } from "$lib/paraglide/messages.js";
  import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
  import InlineError from "$lib/components/InlineError.svelte";
  import type { PageData } from "./$types";

  type EventKind =
    | "youtube_video"
    | "twitter_post"
    | "telegram_post"
    | "discord_drop"
    | "reddit_post"
    | "conference"
    | "talk"
    | "press"
    | "other"
    | "post";

  type EventDtoLocal = {
    id: string;
    // Plan 02.1-28 (M:N migration): gameIds[] replaces the legacy singular
    // gameId. Plan 02.1-38 (UAT-NOTES.md §5.2 — Path A) swaps the round-3
    // single-select continuity for a multi-select checkbox-list bound
    // directly to gameIds.
    gameIds: string[];
    kind: EventKind;
    authorIsMe: boolean;
    occurredAt: Date | string;
    title: string;
    url: string | null;
    notes: string | null;
    // Plan 02.1-32 (UAT-NOTES.md §4.24.D): metadata.triage.standalone
    // surfaces the "Not game-related" toggle on the edit form. toEventDto
    // already projects metadata so the value reaches the page load function
    // unchanged.
    metadata: unknown;
  };

  type GameOpt = { id: string; title: string };

  let { data }: { data: PageData } = $props();
  const event = $derived(data.event as EventDtoLocal);
  const games = $derived(data.games as GameOpt[]);

  // Initial form state hydrated from the loader. Plan 02.1-18 captures
  // originalGameId so the submit handler can decide whether to call
  // PATCH /api/events/:id/attach (only when the picker actually changed).
  let kind = $state<EventKind>(event.kind);
  let title = $state(event.title);
  let occurredAt = $state(
    (typeof event.occurredAt === "string"
      ? event.occurredAt
      : event.occurredAt.toISOString()
    ).slice(0, 10),
  );
  let url = $state(event.url ?? "");
  let notes = $state(event.notes ?? "");
  // Plan 02.1-38 (UAT-NOTES.md §5.2 — Path A): multi-select via checkbox-list.
  // The round-3 single-select continuity preserved by Plan 02.1-32 is
  // RETIRED — the user can now attach the event to ≥2 games from the UI.
  // Submit sends `{gameIds: [...]}` to PATCH /api/events/:id/attach
  // unchanged (backend set-replacement semantics — Plan 02.1-28).
  let gameIds = $state<string[]>([...event.gameIds]);
  let authorIsMe = $state(event.authorIsMe);
  const originalGameIds = new Set(event.gameIds);

  function toggleGame(id: string, checked: boolean): void {
    if (checked) {
      if (!gameIds.includes(id)) gameIds = [...gameIds, id];
    } else {
      gameIds = gameIds.filter((g) => g !== id);
    }
  }

  // Plan 02.1-32 (UAT-NOTES.md §4.24.D): standalone toggle hydrated from
  // metadata.triage.standalone. The submit handler fires PATCH
  // /api/events/:id/mark-standalone (or /unmark-standalone) ONLY when the
  // toggle's value differs from the loaded value — reuses the existing
  // service surface from Plan 02.1-24 so no new audit verb is added.
  function readStandaloneFromMetadata(md: unknown): boolean {
    if (md === null || typeof md !== "object") return false;
    const triage = (md as { triage?: unknown }).triage;
    if (triage === null || triage === undefined || typeof triage !== "object") return false;
    return (triage as { standalone?: unknown }).standalone === true;
  }
  const initialStandalone = readStandaloneFromMetadata(event.metadata);
  let editStandalone = $state(initialStandalone);

  // Plan 02.1-32 (UAT-NOTES.md §4.24.C — UI guard layer; service-layer 422
  // from Plan 02.1-28 is defense-in-depth): when the form has at least one
  // game attached AND the user toggles standalone=true, surface an inline
  // conflict error and disable Save. The user must clear one or the other.
  // Plan 02.1-38 (UAT-NOTES.md §5.2): predicate now checks gameIds.length —
  // semantics unchanged ("at least one attached game conflicts").
  const hasAttachedGame = $derived(gameIds.length > 0);
  const standaloneConflict = $derived(editStandalone === true && hasAttachedGame);

  let pending = $state(false);
  let errorText = $state<string | null>(null);

  // Plan 02.1-32 (UAT-NOTES.md §4.18.A): Delete button moves from the
  // /events/[id] read-only detail page to this edit form's footer. Uses
  // the existing ConfirmDialog flow (Plan 02.1-14 pattern) + soft-delete
  // semantics (DELETE /api/events/:id → restore-within-60-days).
  let confirmDeleteOpen = $state(false);
  let deleteBusy = $state(false);
  let deleteError = $state<string | null>(null);

  function askDelete(): void {
    confirmDeleteOpen = true;
  }
  function cancelDelete(): void {
    confirmDeleteOpen = false;
  }

  async function confirmDelete(): Promise<void> {
    if (deleteBusy) return;
    deleteBusy = true;
    deleteError = null;
    try {
      const res = await fetch(`/api/events/${event.id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) {
        deleteError = m.error_server_generic();
        return;
      }
      confirmDeleteOpen = false;
      await invalidateAll();
      await goto("/feed");
    } catch {
      deleteError = m.error_network();
    } finally {
      deleteBusy = false;
    }
  }

  function setToday(): void {
    occurredAt = new Date().toISOString().slice(0, 10);
  }
  function setYesterday(): void {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    occurredAt = d.toISOString().slice(0, 10);
  }

  const KINDS: ReadonlyArray<{ value: EventKind; label: string }> = [
    { value: "youtube_video", label: m.event_kind_label_youtube_video() },
    { value: "twitter_post", label: m.event_kind_label_twitter_post() },
    { value: "telegram_post", label: m.event_kind_label_telegram_post() },
    { value: "discord_drop", label: m.event_kind_label_discord_drop() },
    { value: "reddit_post", label: m.event_kind_label_reddit_post() },
    { value: "conference", label: m.event_kind_label_conference() },
    { value: "talk", label: m.event_kind_label_talk() },
    { value: "press", label: m.event_kind_label_press() },
    { value: "other", label: m.event_kind_label_other() },
    { value: "post", label: m.event_kind_label_post() },
  ];

  async function submit(e: Event): Promise<void> {
    e.preventDefault();
    if (pending) return;
    if (title.trim().length === 0) {
      errorText = m.error_server_generic();
      return;
    }
    // Plan 02.1-32 UI guard: prevent submit when standalone+game conflict.
    // The Save button is disabled, but defense-in-depth here too in case the
    // user finds an alternate trigger.
    if (standaloneConflict) {
      return;
    }
    pending = true;
    errorText = null;
    try {
      // 1) PATCH the event (kind, occurredAt, title, url, notes, authorIsMe).
      const patchRes = await fetch(`/api/events/${event.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind,
          occurredAt: new Date(occurredAt).toISOString(),
          title: title.trim(),
          url: url.trim() || null,
          notes: notes.trim() || null,
          authorIsMe,
        }),
      });
      if (!patchRes.ok) {
        let code = "error_server_generic";
        try {
          const body = (await patchRes.json()) as { error?: string };
          if (body.error) code = body.error;
        } catch {
          /* ignore */
        }
        errorText =
          code === "validation_failed" ? m.ingest_error_malformed_url() : m.error_server_generic();
        return;
      }

      // 2) If the gameIds set changed, PATCH /attach as a separate fetch so
      //    the dedicated endpoint validates game ownership (Pitfall 4).
      // Plan 02.1-38 (UAT-NOTES.md §5.2 — Path A): set-difference dirty
      // check (order-agnostic). attachEventToGames is set-replacement
      // semantics on the backend (Plan 02.1-28 — DELETE diff + INSERT
      // diff), so any membership change triggers exactly one PATCH.
      const currentSet = new Set(gameIds);
      const sameSize = currentSet.size === originalGameIds.size;
      const sameMembers = sameSize && [...currentSet].every((id) => originalGameIds.has(id));
      if (!sameMembers) {
        const attachRes = await fetch(`/api/events/${event.id}/attach`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ gameIds }),
        });
        if (!attachRes.ok) {
          errorText = m.error_server_generic();
          return;
        }
      }

      // 3) Plan 02.1-32 (UAT-NOTES.md §4.24.D): if the standalone toggle
      //    differs from the loaded value, fire the dedicated route. Two
      //    PATCHes (instead of folding the toggle into the main updateEvent)
      //    because (a) markStandalone has its own audit verb (forensics
      //    intact — event.marked_standalone / event.unmarked_standalone),
      //    (b) the conflict-guard 422 (Plan 02.1-28) fires correctly only
      //    on the dedicated route, (c) reuses existing service surface.
      if (editStandalone !== initialStandalone) {
        const path = editStandalone ? "mark-standalone" : "unmark-standalone";
        const standaloneRes = await fetch(`/api/events/${event.id}/${path}`, {
          method: "PATCH",
        });
        if (!standaloneRes.ok) {
          errorText = m.error_server_generic();
          return;
        }
      }

      await invalidateAll();
      await goto(`/events/${event.id}`);
    } catch {
      errorText = m.error_network();
    } finally {
      pending = false;
    }
  }
</script>

<nav class="breadcrumb" aria-label="Breadcrumb">
  <a href="/feed">Feed</a>
  <span aria-hidden="true">/</span>
  <a href={`/events/${event.id}`}>Event</a>
  <span aria-hidden="true">/</span>
  <span>Edit</span>
</nav>

<section class="editevent">
  <h1>{m.events_edit_heading()}</h1>
  <form class="form" onsubmit={submit}>
    <label class="field">
      <span class="field-label">Kind *</span>
      <select class="input" bind:value={kind} disabled={pending}>
        {#each KINDS as opt (opt.value)}
          <option value={opt.value}>{opt.label}</option>
        {/each}
      </select>
    </label>

    <label class="field">
      <span class="field-label">Title *</span>
      <input
        class="input"
        type="text"
        bind:value={title}
        required
        maxlength="500"
        disabled={pending}
      />
    </label>

    <div class="field">
      <label for="event-edit-date" class="field-label-wrap">
        <span class="field-label">Date *</span>
      </label>
      <div class="quick-set" role="group" aria-label="Quick date presets">
        <button type="button" class="chip" onclick={setToday} disabled={pending}>
          {m.events_new_date_today()}
        </button>
        <button type="button" class="chip" onclick={setYesterday} disabled={pending}>
          {m.events_new_date_yesterday()}
        </button>
      </div>
      <input
        id="event-edit-date"
        class="input"
        type="date"
        bind:value={occurredAt}
        required
        disabled={pending}
      />
    </div>

    <label class="field checkbox">
      <input type="checkbox" bind:checked={authorIsMe} disabled={pending} />
      <span class="field-label">{m.events_edit_author_is_me()}</span>
    </label>

    <label class="field">
      <span class="field-label">URL</span>
      <input class="input" type="url" bind:value={url} placeholder="https://" disabled={pending} />
    </label>

    <!-- Plan 02.1-38 (UAT-NOTES.md §5.2 — Path A): multi-select Game picker.
         Replaces the single-select <select> with a checkbox-list bound to
         gameIds. The user can attach the event to ≥2 games from the UI;
         submit handler sends `{gameIds: [...]}` via PATCH /api/events/:id/attach
         (backend unchanged — Plan 02.1-28 set-replacement semantics). Empty
         array === detach (move to inbox). -->
    <fieldset class="field game-picker">
      <legend class="field-label">{m.events_edit_games_label()}</legend>
      {#if games.length === 0}
        <p class="hint">{m.events_edit_games_empty()}</p>
      {:else}
        <ul class="game-list">
          {#each games as g (g.id)}
            <li>
              <label class="checkbox-row">
                <input
                  type="checkbox"
                  checked={gameIds.includes(g.id)}
                  disabled={pending}
                  onchange={(e) => toggleGame(g.id, (e.target as HTMLInputElement).checked)}
                />
                <span>{g.title}</span>
              </label>
            </li>
          {/each}
        </ul>
      {/if}
    </fieldset>

    <label class="field">
      <span class="field-label">Notes</span>
      <textarea class="input textarea" bind:value={notes} rows="3" disabled={pending}></textarea>
    </label>

    <!-- Plan 02.1-32 (UAT-NOTES.md §4.24.D): standalone toggle. Submit
         fires PATCH /api/events/:id/mark-standalone (or /unmark-standalone)
         when the toggle differs from the loaded value. The conflict
         warning surfaces when standalone=true AND a game is attached;
         the Save button stays disabled while the conflict is active. -->
    <fieldset class="field standalone-fieldset">
      <label class="field checkbox">
        <input type="checkbox" bind:checked={editStandalone} disabled={pending} />
        <span class="field-label">{m.events_edit_standalone_label()}</span>
      </label>
      <p class="help muted">{m.events_edit_standalone_help()}</p>
      {#if standaloneConflict}
        <p class="conflict-error">{m.events_edit_standalone_conflict()}</p>
      {/if}
    </fieldset>

    <div class="actions">
      <a class="cancel" href={`/events/${event.id}`}>{m.common_cancel()}</a>
      <button
        type="submit"
        class="submit"
        disabled={pending || title.trim().length === 0 || standaloneConflict}
      >
        {m.events_edit_save()}
      </button>
    </div>
    {#if errorText}<InlineError message={errorText} />{/if}

    <!-- Plan 02.1-32 (UAT-NOTES.md §4.18.A): Delete button at the form
         footer. Replaces the Delete on /events/[id] read-only page. Uses
         the existing ConfirmDialog flow (Plan 02.1-14 pattern) +
         soft-delete + restore-within-60-days semantics. -->
    <hr class="section-divider" />
    <div class="footer-actions">
      <button type="button" class="delete-button" onclick={askDelete} disabled={deleteBusy}>
        {m.events_edit_delete_button()}
      </button>
    </div>
    {#if deleteError}<InlineError message={deleteError} />{/if}
  </form>
</section>

<ConfirmDialog
  open={confirmDeleteOpen}
  message={m.confirm_event_delete()}
  confirmLabel={m.common_delete()}
  onConfirm={confirmDelete}
  onCancel={cancelDelete}
/>

<style>
  .breadcrumb {
    display: flex;
    gap: var(--space-xs);
    color: var(--color-text-muted);
    font-size: var(--font-size-label);
    margin-bottom: var(--space-md);
    flex-wrap: wrap;
  }
  .breadcrumb a {
    color: var(--color-accent);
    text-decoration: none;
  }
  .editevent {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
    min-width: 0;
  }
  h1 {
    margin: 0;
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-semibold);
  }
  .form {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
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
  .field.checkbox {
    flex-direction: row;
    align-items: center;
    gap: var(--space-sm);
  }
  .field.checkbox input {
    width: 18px;
    height: 18px;
    min-height: 0;
  }
  .field-label {
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
  .textarea {
    padding: var(--space-sm) var(--space-md);
    min-height: 88px;
    line-height: var(--line-height-body);
    font-family: inherit;
    resize: vertical;
  }
  .actions {
    display: flex;
    gap: var(--space-sm);
    justify-content: flex-end;
    align-items: center;
  }
  .cancel {
    color: var(--color-text-muted);
    text-decoration: underline;
    padding: var(--space-sm);
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
  /* Plan 02.1-32: standalone toggle fieldset wrapping. Reset native
   * <fieldset> default (border/padding/margin) to fit the existing form
   * style. The conflict-error styling uses the destructive accent color
   * to flag the mutual-exclusion violation. */
  .standalone-fieldset {
    border: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
  }
  /* Plan 02.1-38 (UAT-NOTES.md §5.2 — Path A): multi-select Game picker.
   * Mirrors the SourceRow / FiltersSheet checkbox-row visual pattern at
   * 360px the list scrolls vertically inside the form (no horizontal
   * overflow); each <li> is full-width with the checkbox left-aligned. */
  .game-picker {
    border: none;
    padding: 0;
    margin: 0;
  }
  .game-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
    max-height: 320px;
    overflow-y: auto;
  }
  .game-list .checkbox-row {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    min-height: 44px;
    padding: var(--space-xs) var(--space-sm);
    cursor: pointer;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: var(--color-bg);
  }
  .game-list .checkbox-row:hover {
    border-color: var(--color-text);
  }
  .game-list .checkbox-row input[type="checkbox"] {
    width: 18px;
    height: 18px;
    min-height: 0;
  }
  .hint {
    margin: 0;
    color: var(--color-text-muted);
    font-size: var(--font-size-label);
  }
  .help {
    margin: 0;
    color: var(--color-text-muted);
    font-size: var(--font-size-label);
  }
  .conflict-error {
    margin: 0;
    color: var(--color-destructive);
    font-size: var(--font-size-label);
  }
  /* Plan 02.1-32: form footer Delete button. Visually separated by a
   * divider so it reads as a destructive action distinct from the
   * Save / Cancel pair. */
  .section-divider {
    border: none;
    border-top: 1px solid var(--color-border);
    margin: var(--space-md) 0 0 0;
  }
  .footer-actions {
    display: flex;
    justify-content: flex-end;
  }
  .delete-button {
    min-height: 44px;
    padding: 0 var(--space-md);
    background: transparent;
    color: var(--color-destructive);
    border: 1px solid var(--color-destructive);
    border-radius: 4px;
    font-weight: var(--font-weight-semibold);
    cursor: pointer;
  }
  .delete-button:hover:not(:disabled) {
    background: var(--color-destructive);
    color: #fff;
  }
  .delete-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .quick-set {
    display: flex;
    gap: var(--space-sm);
    flex-wrap: wrap;
  }
  .chip {
    min-height: 44px;
    padding: 0 var(--space-md);
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 999px;
    font-size: var(--font-size-label);
    cursor: pointer;
  }
  .chip:hover {
    border-color: var(--color-text);
  }
  .chip:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
