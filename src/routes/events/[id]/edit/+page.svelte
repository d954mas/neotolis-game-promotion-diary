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
    gameId: string | null;
    kind: EventKind;
    authorIsMe: boolean;
    occurredAt: Date | string;
    title: string;
    url: string | null;
    notes: string | null;
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
  let gameId = $state(event.gameId ?? "");
  let authorIsMe = $state(event.authorIsMe);
  const originalGameId = event.gameId ?? null;

  let pending = $state(false);
  let errorText = $state<string | null>(null);

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
          code === "validation_failed"
            ? m.ingest_error_malformed_url()
            : m.error_server_generic();
        return;
      }

      // 2) If gameId changed, PATCH /attach as a separate fetch so the
      //    dedicated endpoint validates game ownership (Pitfall 4).
      const newGameId = gameId || null;
      if (newGameId !== originalGameId) {
        const attachRes = await fetch(`/api/events/${event.id}/attach`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ gameId: newGameId }),
        });
        if (!attachRes.ok) {
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
      <input
        class="input"
        type="url"
        bind:value={url}
        placeholder="https://"
        disabled={pending}
      />
    </label>

    <label class="field">
      <span class="field-label">Game (optional — leave empty to drop in inbox)</span>
      <select class="input" bind:value={gameId} disabled={pending}>
        <option value="">No game (inbox)</option>
        {#each games as g (g.id)}
          <option value={g.id}>{g.title}</option>
        {/each}
      </select>
    </label>

    <label class="field">
      <span class="field-label">Notes</span>
      <textarea
        class="input textarea"
        bind:value={notes}
        rows="3"
        disabled={pending}
      ></textarea>
    </label>

    <div class="actions">
      <a class="cancel" href={`/events/${event.id}`}>{m.common_cancel()}</a>
      <button
        type="submit"
        class="submit"
        disabled={pending || title.trim().length === 0}
      >
        {m.events_edit_save()}
      </button>
    </div>
    {#if errorText}<InlineError message={errorText} />{/if}
  </form>
</section>

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
