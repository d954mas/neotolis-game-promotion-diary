<script lang="ts">
  // /sources/[id] page — Phase 03.0.1 Plan 10. Detail page for a single
  // data_source.
  //
  // Phase 03.0.1 (post-review UAT 2026-05-10) — restructured into card
  // sections (Status / Coverage / Description / Actions) with edit-on-
  // demand pattern: view mode shows current state, click «Edit» on a
  // section to swap to inputs. Pre-fix everything was always-editable
  // (textarea + date picker rendered raw) — looked unfinished and
  // ambiguous about what's a label vs an input.

  import RefreshContentButton from "$lib/components/RefreshContentButton.svelte";
  import SourceCoverageBadge from "$lib/components/SourceCoverageBadge.svelte";
  import { invalidateAll } from "$app/navigation";
  import { m } from "$lib/paraglide/messages.js";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
  const source = $derived(data.source);
  // Heading prefers canonical channel title from cache (always more
  // identifiable than the user-typed displayName). displayName is legacy
  // — UI doesn't surface it anymore.
  const heading = $derived(source.channelTitle ?? source.handleUrl);

  // ---- date picker (target_since) ----
  const SENTINEL_ISO = "1970-01-01";
  const todayISO = new Date().toISOString().slice(0, 10);
  const isSentinelTarget = $derived(
    source.backfillTargetSince
      ? new Date(source.backfillTargetSince).toISOString().slice(0, 10) === SENTINEL_ISO
      : false,
  );
  const currentTargetIso = $derived(sourceTargetIso(source.backfillTargetSince));
  // Picker max = current target. Narrowing prohibited (server rejects
  // anyway with 422 'cannot_narrow_window'); UI mirrors the rule so the
  // input physically can't pick a forward-narrowing date. Sentinel
  // sources are locked entirely — Edit button hidden below.
  const pickerMax = $derived(currentTargetIso ?? todayISO);

  function sourceTargetIso(d: Date | string | null | undefined): string | null {
    if (!d) return null;
    return new Date(d).toISOString().slice(0, 10);
  }
  function formatDateLong(iso: string | null): string {
    if (iso === null) return "—";
    if (iso === SENTINEL_ISO) return "all available history";
    return iso;
  }

  let editingTarget = $state(false);
  let targetSinceInput = $state(currentTargetIso ?? "");
  let saveError = $state<string | null>(null);
  let saving = $state(false);

  async function saveTargetSince(): Promise<void> {
    saveError = null;
    if (!targetSinceInput) return;
    const picked = new Date(targetSinceInput);
    if (Number.isNaN(picked.getTime()) || picked.getTime() > Date.now()) {
      saveError = m.source_detail_target_invalid_future();
      return;
    }
    saving = true;
    try {
      const res = await fetch(`/api/sources/${source.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backfillTargetSince: picked.toISOString() }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        saveError = body.error ?? `HTTP ${res.status}`;
        return;
      }
      editingTarget = false;
      await invalidateAll();
    } finally {
      saving = false;
    }
  }

  // ---- description (metadata.description) ----
  const currentDescription = $derived(
    typeof source.metadata?.description === "string" ? source.metadata.description : "",
  );
  let editingDesc = $state(false);
  let descriptionInput = $state(currentDescription);
  let descSaving = $state(false);
  let descError = $state<string | null>(null);

  async function saveDescription(): Promise<void> {
    descError = null;
    descSaving = true;
    try {
      const res = await fetch(`/api/sources/${source.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          metadata: { ...source.metadata, description: descriptionInput.trim() || undefined },
        }),
      });
      if (!res.ok) {
        descError = `HTTP ${res.status}`;
        return;
      }
      editingDesc = false;
      await invalidateAll();
    } finally {
      descSaving = false;
    }
  }

  // ---- coverage badge ----
  const platformStats = $derived(data.quotaPlatforms.find((p) => p.kind === source.kind) ?? null);
  const quotaExhausted = $derived.by(() => {
    if (!platformStats) return false;
    const cap = platformStats.cap;
    if (cap.requestsPerDay !== undefined && platformStats.today.requests >= cap.requestsPerDay) {
      return true;
    }
    if (cap.eventsPerDay !== undefined && platformStats.today.events >= cap.eventsPerDay) {
      return true;
    }
    return false;
  });
</script>

<svelte:head>
  <title>{heading}</title>
</svelte:head>

<section class="source-detail">
  <header class="hdr">
    <h1 class="hdr__title">{heading}</h1>
    <a class="hdr__handle" href={source.handleUrl} target="_blank" rel="noopener noreferrer">
      {source.handleUrl}
    </a>
    <div class="hdr__meta">
      <span class="kind-tag">{source.kind}</span>
      <SourceCoverageBadge
        lastPolledAt={source.lastPolledAt}
        backfillComplete={source.backfillComplete}
        {quotaExhausted}
      />
    </div>
  </header>

  <!-- Pull window — view by default, edit on demand -->
  <article class="card">
    <div class="card__header">
      <h2 class="card__title">Pull window</h2>
      {#if !editingTarget && !isSentinelTarget}
        <button
          type="button"
          class="card__edit"
          onclick={() => {
            targetSinceInput = currentTargetIso ?? todayISO;
            saveError = null;
            editingTarget = true;
          }}
        >
          Edit
        </button>
      {/if}
    </div>
    {#if !editingTarget}
      <p class="card__value">
        Earliest event: <strong>{formatDateLong(currentTargetIso)}</strong>
      </p>
      <p class="card__hint">
        {#if isSentinelTarget}
          The pull walks back as far as the platform allows. <strong>Locked</strong> — «all history» is
          the widest possible setting; narrowing is not permitted.
        {:else}
          The next pull will fetch events back to this date. You can only widen this window (pick an
          earlier date) — narrowing is not allowed.
        {/if}
      </p>
    {:else}
      <label class="field">
        <span class="field__label">{m.source_detail_target_label()}</span>
        <input
          type="date"
          class="field__input"
          bind:value={targetSinceInput}
          min="2005-01-01"
          max={pickerMax}
          disabled={saving}
        />
      </label>
      <p class="card__hint">
        Pick an earlier date to widen the window. Narrowing is blocked at the server.
      </p>
      {#if saveError}<p class="err" role="alert">{saveError}</p>{/if}
      <div class="card__actions">
        <button
          type="button"
          class="btn btn--ghost"
          onclick={() => {
            editingTarget = false;
            saveError = null;
          }}
          disabled={saving}
        >
          Cancel
        </button>
        <button
          type="button"
          class="btn btn--primary"
          onclick={saveTargetSince}
          disabled={saving || !targetSinceInput}
        >
          {m.source_detail_target_save()}
        </button>
      </div>
    {/if}
  </article>

  <!-- Description -->
  <article class="card">
    <div class="card__header">
      <h2 class="card__title">Description</h2>
      {#if !editingDesc}
        <button
          type="button"
          class="card__edit"
          onclick={() => {
            descriptionInput = currentDescription;
            descError = null;
            editingDesc = true;
          }}
        >
          {currentDescription ? "Edit" : "Add"}
        </button>
      {/if}
    </div>
    {#if !editingDesc}
      {#if currentDescription}
        <p class="card__value card__value--text">{currentDescription}</p>
      {:else}
        <p class="card__hint">No description yet.</p>
      {/if}
    {:else}
      <textarea
        class="field__input field__input--textarea"
        rows="3"
        maxlength="500"
        bind:value={descriptionInput}
        disabled={descSaving}
        placeholder="Why are you tracking this? E.g. 'Indie horror channel I'm collaborating with'"
      ></textarea>
      {#if descError}<p class="err" role="alert">{descError}</p>{/if}
      <div class="card__actions">
        <button
          type="button"
          class="btn btn--ghost"
          onclick={() => {
            editingDesc = false;
            descError = null;
          }}
          disabled={descSaving}
        >
          Cancel
        </button>
        <button
          type="button"
          class="btn btn--primary"
          onclick={saveDescription}
          disabled={descSaving}
        >
          Save
        </button>
      </div>
    {/if}
  </article>

  <!-- Actions -->
  <article class="card">
    <div class="card__header">
      <h2 class="card__title">Actions</h2>
    </div>
    <RefreshContentButton sourceId={source.id} sourceKind={source.kind} />
  </article>
</section>

<style>
  .source-detail {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
    padding: var(--space-md);
    max-width: 720px;
  }

  .hdr {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
    padding-bottom: var(--space-sm);
    border-bottom: 1px solid var(--color-border);
  }
  .hdr__title {
    margin: 0;
    font-size: var(--font-size-h1);
    line-height: 1.2;
    word-break: break-word;
  }
  .hdr__handle {
    color: var(--color-text-muted);
    font-size: var(--font-size-label);
    word-break: break-all;
  }
  .hdr__meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-sm);
    align-items: center;
    margin-top: var(--space-xs);
  }
  .kind-tag {
    display: inline-flex;
    padding: 2px var(--space-sm);
    background: var(--color-bg);
    color: var(--color-text-muted);
    border: 1px solid var(--color-border);
    border-radius: 999px;
    font-size: var(--font-size-label);
  }

  .card {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
    padding: var(--space-md);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }
  .card__header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-sm);
  }
  .card__title {
    margin: 0;
    font-size: var(--font-size-h3, 1.05rem);
    font-weight: var(--font-weight-semibold);
  }
  .card__edit {
    background: none;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    padding: 2px var(--space-sm);
    color: var(--color-text);
    font-size: var(--font-size-label);
    cursor: pointer;
  }
  .card__edit:hover {
    background: var(--color-bg);
  }
  .card__value {
    margin: 0;
    font-size: var(--font-size-body);
  }
  .card__value--text {
    white-space: pre-wrap;
  }
  .card__hint {
    margin: 0;
    color: var(--color-text-muted);
    font-size: var(--font-size-label);
  }
  .card__actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-sm);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
  }
  .field__label {
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
  }
  .field__input {
    padding: var(--space-sm);
    font-family: inherit;
    font-size: var(--font-size-body);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-bg);
    color: var(--color-text);
  }
  .field__input--textarea {
    width: 100%;
    resize: vertical;
  }
  .btn {
    padding: var(--space-xs) var(--space-md);
    border-radius: var(--radius-sm);
    border: 1px solid transparent;
    font-size: var(--font-size-body);
    cursor: pointer;
  }
  .btn--primary {
    background: var(--color-accent);
    color: var(--color-on-accent, white);
  }
  .btn--primary:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .btn--ghost {
    background: transparent;
    color: var(--color-text);
    border-color: var(--color-border);
  }
  .err {
    margin: 0;
    color: var(--color-destructive);
    font-size: var(--font-size-label);
  }
</style>
