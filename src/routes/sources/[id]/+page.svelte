<script lang="ts">
  // /sources/[id] page — detail page for a single data_source.
  //
  // Structured into card sections (Status / Coverage / Description /
  // Actions) with an edit-on-demand pattern: view mode shows current state,
  // click «Edit» on a section to swap to inputs.

  import RefreshContentButton from "$lib/components/RefreshContentButton.svelte";
  import SourceCoverageBadge from "$lib/components/SourceCoverageBadge.svelte";
  import { invalidateAll } from "$app/navigation";
  import { m } from "$lib/paraglide/messages.js";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
  const source = $derived(data.source);

  // Same live-refresh loop as /sources list. While cooldown is active
  // (worker processing pull), invalidateAll every 3s so UI shows
  // last_polled_at advancing, events appearing, cooldown countdown ticking
  // without manual reload.
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  $effect(() => {
    const isActive = (data.cooldownSec ?? 0) > 0 || (data.pulling ?? false);
    if (isActive && pollTimer === null) {
      pollTimer = setInterval(() => {
        void invalidateAll();
      }, 3000);
    } else if (!isActive && pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    return () => {
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };
  });
  // Heading prefers canonical channel title from cache (always more
  // identifiable than the user-typed displayName). displayName is legacy
  // — UI doesn't surface it anymore.
  const heading = $derived(source.channelTitle ?? source.handleUrl);

  // ---- date picker (target_since) ----
  const SENTINEL_ISO = "1970-01-01";
  // todayISO used as max in custom date picker below.
  const todayISO = new Date().toISOString().slice(0, 10);
  const isSentinelTarget = $derived(
    source.backfillTargetSince
      ? new Date(source.backfillTargetSince).toISOString().slice(0, 10) === SENTINEL_ISO
      : false,
  );
  const currentTargetIso = $derived(sourceTargetIso(source.backfillTargetSince));

  function sourceTargetIso(d: Date | string | null | undefined): string | null {
    if (!d) return null;
    return new Date(d).toISOString().slice(0, 10);
  }
  function formatDateLong(iso: string | null): string {
    if (iso === null) return "—";
    if (iso === SENTINEL_ISO) return "all available history";
    return iso;
  }

  let saveError = $state<string | null>(null);
  let saving = $state(false);
  let editingPullWindow = $state(false);

  // Preset buttons — each computes a target date. «All» is the sentinel
  // (1970-01-01). A preset is ENABLED only if applying it would widen
  // (proposed ≤ current) — server enforces «can only widen» so we mirror
  // here. Sentinel current → all presets disabled (locked).
  type Preset = { key: "week" | "month" | "year" | "all"; label: string; date: Date };
  function makePresets(): Preset[] {
    const now = Date.now();
    return [
      { key: "week", label: "Last week", date: new Date(now - 7 * 86_400_000) },
      { key: "month", label: "Last month", date: new Date(now - 30 * 86_400_000) },
      { key: "year", label: "Last year", date: new Date(now - 365 * 86_400_000) },
      { key: "all", label: "All history", date: new Date(SENTINEL_ISO + "T00:00:00Z") },
    ];
  }
  const presets = makePresets();
  const currentTargetMs = $derived(
    source.backfillTargetSince ? new Date(source.backfillTargetSince).getTime() : null,
  );
  function isPresetWidening(preset: Preset): boolean {
    if (currentTargetMs === null) return true;
    return preset.date.getTime() < currentTargetMs;
  }

  async function applyPreset(preset: Preset): Promise<void> {
    await applyTargetDate(preset.date);
  }

  async function applyTargetDate(when: Date): Promise<void> {
    saveError = null;
    saving = true;
    try {
      const res = await fetch(`/api/sources/${source.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backfillTargetSince: when.toISOString() }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        saveError = body.error ?? `HTTP ${res.status}`;
        return;
      }
      await invalidateAll();
    } finally {
      saving = false;
    }
  }

  // Custom date input — only shown when expanded, only useful when
  // current is non-sentinel (sentinel is locked).
  let customDateInput = $state(currentTargetIso ?? "");
  let customExpanded = $state(false);

  async function applyCustomDate(): Promise<void> {
    if (!customDateInput) return;
    const picked = new Date(customDateInput);
    if (Number.isNaN(picked.getTime())) {
      saveError = "Invalid date";
      return;
    }
    if (picked.getTime() > Date.now()) {
      saveError = m.source_detail_target_invalid_future();
      return;
    }
    await applyTargetDate(picked);
    customExpanded = false;
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

  // ---- toggles (autoImport + isOwnedByMe) ----
  let editingFlags = $state(false);
  let flagAutoImport = $state(source.autoImport);
  let flagIsOwnedByMe = $state(source.isOwnedByMe);
  let flagSaving = $state(false);
  let flagError = $state<string | null>(null);

  async function saveFlags(): Promise<void> {
    flagError = null;
    flagSaving = true;
    try {
      const res = await fetch(`/api/sources/${source.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          autoImport: flagAutoImport,
          isOwnedByMe: flagIsOwnedByMe,
        }),
      });
      if (!res.ok) {
        flagError = `HTTP ${res.status}`;
        return;
      }
      editingFlags = false;
      await invalidateAll();
    } finally {
      flagSaving = false;
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

  <!-- Pull window — view + Edit toggle. Controls hidden by default. -->
  <article class="card">
    <div class="card__header">
      <h2 class="card__title">Pull window</h2>
      {#if !editingPullWindow && !isSentinelTarget}
        <button type="button" class="card__edit" onclick={() => (editingPullWindow = true)}>
          Edit
        </button>
      {/if}
    </div>
    <p class="card__value">
      Pull from: <strong>{formatDateLong(currentTargetIso)}</strong>
    </p>
    {#if isSentinelTarget}
      <p class="card__hint">
        The pull walks back as far as the platform allows. <strong>Locked</strong> — «all history» is
        the widest possible setting.
      </p>
    {:else if editingPullWindow}
      <p class="card__hint">
        Pick a preset to widen the window. Narrowing is not allowed — only presets that go further
        back than the current target are enabled.
      </p>
      <div class="presets">
        {#each presets as preset (preset.key)}
          {@const enabled = isPresetWidening(preset) && !saving}
          <button
            type="button"
            class="preset-btn"
            class:preset-btn--disabled={!enabled}
            onclick={() => enabled && applyPreset(preset)}
            disabled={!enabled}
            title={enabled
              ? `Set earliest event to ${preset.key === "all" ? "all history" : preset.date.toISOString().slice(0, 10)}`
              : "Narrowing is not allowed"}
          >
            {preset.label}
          </button>
        {/each}
      </div>
      <details class="custom-date" bind:open={customExpanded}>
        <summary>Or pick a custom date…</summary>
        <div class="custom-date__row">
          <input
            type="date"
            class="field__input"
            bind:value={customDateInput}
            min="2005-01-01"
            max={currentTargetIso ?? todayISO}
            disabled={saving}
          />
          <button
            type="button"
            class="btn btn--primary"
            onclick={applyCustomDate}
            disabled={saving || !customDateInput}
          >
            Apply
          </button>
        </div>
        <p class="card__hint">
          Only earlier dates than the current target are allowed (server rejects narrowing).
        </p>
      </details>
      <div class="card__actions">
        <button
          type="button"
          class="btn btn--ghost"
          onclick={() => {
            editingPullWindow = false;
            customExpanded = false;
            saveError = null;
          }}
        >
          Done
        </button>
      </div>
    {/if}
    {#if saveError}<p class="err" role="alert">{saveError}</p>{/if}
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

  <!-- Settings (auto-import + ownership) -->
  <article class="card">
    <div class="card__header">
      <h2 class="card__title">{m.source_detail_settings_title()}</h2>
      {#if !editingFlags}
        <button
          type="button"
          class="card__edit"
          onclick={() => {
            flagAutoImport = source.autoImport;
            flagIsOwnedByMe = source.isOwnedByMe;
            flagError = null;
            editingFlags = true;
          }}
        >
          Edit
        </button>
      {/if}
    </div>
    {#if !editingFlags}
      <p class="card__value">
        {m.source_detail_settings_auto_import()}:
        <strong>{source.autoImport ? "On" : "Off"}</strong>
      </p>
      <p class="card__value">
        {m.source_detail_settings_owned_by_me()}:
        <strong>{source.isOwnedByMe ? "Yes" : "No"}</strong>
      </p>
    {:else}
      <label class="toggle">
        <input type="checkbox" bind:checked={flagAutoImport} disabled={flagSaving} />
        <span>{m.source_detail_settings_auto_import()}</span>
      </label>
      <label class="toggle">
        <input type="checkbox" bind:checked={flagIsOwnedByMe} disabled={flagSaving} />
        <span>{m.source_detail_settings_owned_by_me()}</span>
      </label>
      {#if flagError}<p class="err" role="alert">{flagError}</p>{/if}
      <div class="card__actions">
        <button
          type="button"
          class="btn btn--ghost"
          onclick={() => {
            editingFlags = false;
            flagError = null;
          }}
          disabled={flagSaving}
        >
          {m.common_cancel()}
        </button>
        <button type="button" class="btn btn--primary" onclick={saveFlags} disabled={flagSaving}>
          {m.common_save()}
        </button>
      </div>
    {/if}
  </article>

  <!-- Actions -->
  <article class="card">
    <div class="card__header">
      <h2 class="card__title">Actions</h2>
    </div>
    <RefreshContentButton
      sourceId={source.id}
      sourceKind={source.kind}
      initialCooldownSec={data.cooldownSec ?? 0}
      pulling={data.pulling ?? false}
    />
  </article>
</section>

<style>
  .source-detail {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
    padding: var(--s-4);
    max-width: 720px;
    min-width: 0;
  }

  .hdr {
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
    padding-bottom: var(--s-2);
    border-bottom: 1px solid var(--border-hairline);
  }
  .hdr__title {
    margin: 0;
    font-family: var(--f-sans);
    font-size: var(--t-22);
    font-weight: var(--w-sb);
    line-height: var(--lh-tight);
    color: var(--text);
    word-break: break-word;
  }
  .hdr__handle {
    color: var(--text-3);
    font-size: var(--t-13);
    font-family: var(--f-mono);
    word-break: break-all;
  }
  .hdr__meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-2);
    align-items: center;
    margin-top: var(--s-1);
  }
  .kind-tag {
    display: inline-flex;
    padding: 2px var(--s-2);
    background: var(--surface-2);
    color: var(--text-3);
    border: 1px solid var(--border);
    border-radius: var(--r-pill);
    font-size: var(--t-12);
  }

  .card {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    padding: var(--s-4);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
  }
  .card__header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--s-2);
  }
  .card__title {
    margin: 0;
    font-family: var(--f-sans);
    font-size: var(--t-15);
    font-weight: var(--w-sb);
    color: var(--text);
  }
  .card__edit {
    background: none;
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    padding: 2px var(--s-2);
    color: var(--text);
    font-size: var(--t-13);
    cursor: pointer;
    transition: background var(--m-fast) var(--m-ease);
  }
  .card__edit:hover {
    background: var(--accent-soft);
  }
  .card__value {
    margin: 0;
    font-size: var(--t-14);
    color: var(--text);
  }
  .card__value--text {
    white-space: pre-wrap;
  }
  .card__hint {
    margin: 0;
    color: var(--text-3);
    font-size: var(--t-13);
  }
  .card__actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--s-2);
  }
  .field__input {
    padding: var(--s-2);
    font-family: inherit;
    font-size: var(--t-14);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    background: var(--surface-3);
    color: var(--text);
  }
  .field__input--textarea {
    width: 100%;
    resize: vertical;
  }
  .btn {
    padding: var(--s-1) var(--s-4);
    min-height: var(--hit);
    border-radius: var(--r-sm);
    border: 1px solid transparent;
    font-size: var(--t-14);
    font-family: var(--f-sans);
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .btn--primary {
    background: var(--accent);
    color: var(--accent-text);
    border-color: var(--accent);
    font-weight: var(--w-sb);
  }
  .btn--primary:hover:not(:disabled) {
    background: var(--accent-strong);
    border-color: var(--accent-strong);
  }
  .btn--primary:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .btn--ghost {
    background: transparent;
    color: var(--text);
    border-color: var(--border);
  }
  .btn--ghost:hover {
    background: var(--accent-soft);
  }
  .err {
    margin: 0;
    color: var(--danger);
    font-size: var(--t-13);
  }
  .toggle {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    font-size: var(--t-14);
    color: var(--text);
    cursor: pointer;
  }
  .toggle input {
    cursor: pointer;
  }
  .presets {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-2);
    margin-top: var(--s-1);
  }
  .preset-btn {
    padding: var(--s-1) var(--s-4);
    min-height: var(--hit);
    background: var(--surface-3);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--r-pill);
    font-size: var(--t-13);
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .preset-btn:hover:not(:disabled) {
    background: var(--accent-soft);
    color: var(--accent);
    border-color: var(--accent-strong);
  }
  .preset-btn--disabled,
  .preset-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .custom-date {
    margin-top: var(--s-1);
    font-size: var(--t-13);
  }
  .custom-date summary {
    cursor: pointer;
    color: var(--text-3);
    padding: var(--s-1) 0;
  }
  .custom-date__row {
    display: flex;
    gap: var(--s-2);
    align-items: center;
    margin-top: var(--s-1);
  }
  @media (prefers-reduced-motion: reduce) {
    .btn,
    .preset-btn,
    .card__edit {
      transition: none;
    }
  }
</style>
