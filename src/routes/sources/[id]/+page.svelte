<script lang="ts">
  // /sources/[id] page — Phase 03.0.1 Plan 10. Detail page for a single
  // data_source. Phase 03.0.1 ships the minimal surface needed to host the
  // RefreshContentButton (D-NEW user payoff); future phases extend with
  // SourceDetailHeader / DetailMetricsChart / QuotaTab via the per-kind
  // adapter UI registry (see sources/youtube/ui/ — Plan 09 dual-tree).
  //
  // FUTURE: the Phase 03.1+ migration target is to import getAdapterUI(kind)
  // from $lib/sources/registry-ui.js and dispatch the page header + metrics
  // chart via the per-kind UI surface. v0.1 keeps the page minimal — the
  // button is the load-bearing affordance.

  import RefreshContentButton from "$lib/components/RefreshContentButton.svelte";
  import SourceCoverageBadge from "$lib/components/SourceCoverageBadge.svelte";
  import { invalidateAll } from "$app/navigation";
  import { m } from "$lib/paraglide/messages.js";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
  const source = $derived(data.source);
  const heading = $derived(source.channelTitle ?? source.displayName ?? source.handleUrl);

  // Phase 03.0.1 (post-review UAT) — sentinel detection. backfillTargetSince
  // = 1970-01-01 means «pull all available history». Date picker showing
  // 1970-01-01 is confusing — show «All history» label with override.
  const SENTINEL_ISO = "1970-01-01";
  const isSentinelTarget = $derived(
    source.backfillTargetSince
      ? new Date(source.backfillTargetSince).toISOString().slice(0, 10) === SENTINEL_ISO
      : false,
  );

  // Local override flag — when user clicks «Set specific date instead» on
  // a sentinel source, this flips the UI to picker mode WITHOUT saving.
  // Save fires via the regular saveTargetSince button.
  let overrideSentinel = $state(false);

  // Picker max bound. Server validation enforces: new target_since cannot
  // be LATER than current (narrowing window prohibited — pre-fix discussion
  // 2026-05-10). UI mirrors so user can't pick a forward-narrowing date.
  // Sentinel source — special case: max=today so user CAN narrow from
  // «all» down to a specific date (intentional escape hatch).
  const pickerMax = $derived(
    isSentinelTarget ? todayISO : (sourceTargetIso(source.backfillTargetSince) ?? todayISO),
  );

  function sourceTargetIso(d: Date | string | null | undefined): string | null {
    if (!d) return null;
    return new Date(d).toISOString().slice(0, 10);
  }

  // Description edit (stored in metadata.description).
  let description = $state(
    typeof source.metadata?.description === "string" ? source.metadata.description : "",
  );
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
          metadata: { ...source.metadata, description: description.trim() || undefined },
        }),
      });
      if (!res.ok) {
        descError = `HTTP ${res.status}`;
        return;
      }
      await invalidateAll();
    } finally {
      descSaving = false;
    }
  }

  // Phase 03.0.1 — derive quota-exhausted state from this platform's stats
  // (banner shows full picture; badge needs single boolean).
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

  // Date picker state — initialized from source.backfillTargetSince.
  let targetSinceInput = $state(
    source.backfillTargetSince
      ? new Date(source.backfillTargetSince).toISOString().slice(0, 10)
      : "",
  );
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
        saveError = `HTTP ${res.status}`;
        return;
      }
      await invalidateAll();
    } finally {
      saving = false;
    }
  }

  const todayISO = new Date().toISOString().slice(0, 10);
</script>

<svelte:head>
  <title>{heading}</title>
</svelte:head>

<section class="source-detail">
  <h1 class="source-detail__title">{heading}</h1>
  <p class="source-detail__kind">{source.kind}</p>
  <p class="source-detail__handle">
    <a href={source.handleUrl} target="_blank" rel="noopener noreferrer">{source.handleUrl}</a>
  </p>

  <SourceCoverageBadge
    lastPolledAt={source.lastPolledAt}
    backfillComplete={source.backfillComplete}
    {quotaExhausted}
  />

  <!-- Phase 03.0.1 (post-review UAT) — quota banner REMOVED from detail
       page. Quota status is per-user (cross-source); detail page is per-
       source. Banner stays on /sources list view only. -->

  <!-- Phase 03.0.1 — date picker для backfill target. User changes earliest
       boundary; PATCH stores absolute date. После PATCH user отдельно жмёт
       Refresh для catch-up. UI disables future dates через max=today. -->
  <div class="source-detail__target">
    {#if isSentinelTarget && !overrideSentinel}
      <span class="source-detail__target-label">
        Pulling <strong>all available history</strong> (no date limit).
      </span>
      <button type="button" onclick={() => (overrideSentinel = true)}>
        Set specific date instead
      </button>
    {:else}
      <label class="source-detail__target-label">
        {m.source_detail_target_label()}
        <input
          type="date"
          bind:value={targetSinceInput}
          min="2005-01-01"
          max={pickerMax}
          disabled={saving}
        />
      </label>
      <button type="button" onclick={saveTargetSince} disabled={saving || !targetSinceInput}>
        {m.source_detail_target_save()}
      </button>
      <p class="source-detail__hint">
        You can only widen the window (pick an earlier date). To narrow, the date must be on or
        before the current target.
      </p>
    {/if}
    {#if saveError}
      <p class="source-detail__error" role="alert">{saveError}</p>
    {/if}
  </div>

  <!-- Phase 03.0.1 (post-review UAT) — description edit. User added it
       optionally on /sources/new (replaced displayName); detail page is
       where they can edit / clear it later. metadata.description is the
       store (no schema column — jsonb keeps it simple). -->
  <div class="source-detail__description">
    <label class="source-detail__description-label">
      <span>Description (optional)</span>
      <textarea
        class="source-detail__description-input"
        rows="3"
        maxlength="500"
        bind:value={description}
        disabled={descSaving}
        placeholder="Why are you tracking this? E.g. 'Indie horror channel I'm collaborating with'"
      ></textarea>
    </label>
    <button type="button" onclick={saveDescription} disabled={descSaving}>
      Save description
    </button>
    {#if descError}
      <p class="source-detail__error" role="alert">{descError}</p>
    {/if}
  </div>

  <div class="source-detail__actions">
    <RefreshContentButton sourceId={source.id} sourceKind={source.kind} />
  </div>
</section>

<style>
  .source-detail {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
    padding: var(--space-md);
    max-width: 720px;
  }
  .source-detail__title {
    margin: 0;
    font-size: var(--font-size-h1);
  }
  .source-detail__kind {
    margin: 0;
    color: var(--color-text-muted);
    font-size: var(--font-size-label);
  }
  .source-detail__handle {
    margin: 0;
    font-size: var(--font-size-body);
  }
  .source-detail__actions {
    margin-top: var(--space-md);
  }
  .source-detail__target {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-sm);
    align-items: center;
    padding: var(--space-sm);
    border: 1px solid var(--color-border, #e0e0e0);
    border-radius: var(--radius-md);
    background: var(--color-surface, #f7f7f7);
  }
  .source-detail__target-label {
    display: flex;
    gap: var(--space-xs);
    align-items: center;
    font-size: var(--font-size-label);
  }
  .source-detail__error {
    margin: 0;
    color: var(--color-destructive);
    font-size: var(--font-size-label);
  }
  .source-detail__hint {
    margin: 0;
    color: var(--color-text-muted);
    font-size: var(--font-size-label);
    width: 100%;
  }
  .source-detail__description {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
    padding: var(--space-sm);
    border: 1px solid var(--color-border, #e0e0e0);
    border-radius: var(--radius-md);
    background: var(--color-surface, #f7f7f7);
  }
  .source-detail__description-label {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
    font-size: var(--font-size-label);
  }
  .source-detail__description-input {
    width: 100%;
    padding: var(--space-sm);
    font-family: inherit;
    font-size: var(--font-size-body);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-bg);
    color: var(--color-text);
    resize: vertical;
  }
</style>
